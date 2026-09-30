import * as TaskPetContract from '../lib/remote.js';

/** Last rejected-frame detail, so a permanent contract mismatch is reported
 * once per distinct cause instead of vanishing into the retry loop. A frame
 * that fails contract validation is still fail-closed (the stream is torn down
 * and retried), but it can no longer look like a healthy but frozen pet. */
let lastFrameRejection = null;
function warnFrameRejection(error) {
  const detail = Array.isArray(error?.issues)
    ? error.issues.map((issue) => `${issue.path?.join('.') || '(root)'}: ${issue.message}`).join('; ')
    : String(error?.message ?? error);
  if (detail === lastFrameRejection) return;
  lastFrameRejection = detail;
  try {
    console.warn(`[dsh-task-pet] bridge frame rejected (pet keeps the last snapshot): ${detail}`);
  } catch {
    /* a missing console must never break the pet */
  }
}

// Shared only for overlapping mounts of this widget; never duplicate a Remote method.
const taskPetRemoteMounts = new WeakMap();
function acquireTaskPetRemote(ctx, remote) {
  const owner = ctx.root ?? remote;
  let entry = taskPetRemoteMounts.get(owner);
  if (!entry || entry.closed || entry.failed) {
    const previous = entry?.closing;
    entry = { refs: 0, closed: false, failed: false };
    entry.ready = Promise.resolve(previous).catch(() => {}).then(() => remote.$mount(TaskPetContract.TYPERT_REMOTE)).catch(() => {
      entry.failed = true;
      throw new Error('Local task-pet mount failed');
    });
    entry.ready.catch(() => {});
    taskPetRemoteMounts.set(owner, entry);
  }
  entry.refs += 1;
  let released = false;
  return {
    ready: entry.ready,
    get failed() { return entry.failed; },
    release() {
      if (released) return;
      released = true;
      entry.refs -= 1;
      if (entry.refs !== 0) return;
      entry.closing = Promise.resolve(entry.closing).then(() => entry.ready).then(async (unmount) => {
        if (entry.refs !== 0 || entry.closed) return;
        entry.closed = true;
        await unmount();
      }).catch(() => {}).finally(() => {
        if ((entry.closed || entry.failed) && taskPetRemoteMounts.get(owner) === entry) taskPetRemoteMounts.delete(owner);
      });
    },
  };
}

function acquireTaskPetNamespace(ctx, abort) {
  return new Promise((resolve, reject) => {
    let fiber, disposed = false, closing;
    const dispose = () => {
      if (disposed) return closing;
      disposed = true;
      abort.signal.removeEventListener('abort', cancelled);
      closing = Promise.resolve(fiber?.dispose());
      return closing;
    };
    const cancelled = () => {
      reject(new Error('Task-pet namespace unavailable'));
      Promise.resolve(dispose()).catch(() => {});
    };
    if (abort.signal.aborted) { cancelled(); return; }
    abort.signal.addEventListener('abort', cancelled, { once: true });
    try {
      fiber = ctx.inject(['remote.taskPet'], (scope) => {
        if (disposed || abort.signal.aborted) return;
        scope.effect(() => () => abort.abort(), 'task-pet.namespace');
        resolve({ service: scope.remote.taskPet, dispose });
      });
      if (disposed) Promise.resolve(fiber.dispose()).catch(() => {});
      Promise.resolve(fiber).catch((error) => { reject(error); Promise.resolve(dispose()).catch(() => {}); });
    } catch (error) {
      reject(error);
      Promise.resolve(dispose()).catch(() => {});
    }
  });
}

/**
 * Observe the live task-pet stream: session turn boundaries plus the data
 * frames the host pushes on tasks.json changes. Returns synchronous, idempotent
 * cleanup. Callbacks:
 *   onBoundary({sessionId,id,seq,type,reason?,time,hostEpoch,streamSeq,isSubagent?})
 *   onData({mtime,doc,error})                 — the latest data snapshot
 *   onReset({reason?})                        — stream dropped; discard unplayed state
 *   onHealth(boolean)                         — this completion stream's health only
 */
export function observeGlobalEvents(ctx, { onBoundary, onData, onReset, onHealth } = {}) {
  let disposed = false;
  let generationKey;
  let revision = 0;
  let run;
  let retry;
  let retryDelay = 1000;
  let health;
  const subscriptions = [];
  const call = (fn, value) => { if (!disposed) { try { fn?.(value); } catch { /* UI callbacks cannot poison transport. */ } } };
  const reset = (value) => call(onReset, value);
  const setHealth = (value) => { if (health !== value) { health = value; call(onHealth, value); } };
  const remote = ctx.remote;
  if (!remote || typeof remote.$mount !== 'function') {
    setHealth(false);
    reset({ reason: 'unavailable' });
    return () => { disposed = true; };
  }
  let lease = acquireTaskPetRemote(ctx, remote);
  const connected = () => ctx.connection?.state?.getSnapshot?.() === 'connected';
  const retire = () => {
    revision += 1;
    if (retry !== undefined) { clearTimeout(retry); retry = undefined; }
    if (run) {
      const old = run; run = undefined;
      old.abort.abort();
      try { Promise.resolve(old.handle?.dispose?.()).catch(() => {}); } catch { /* already withdrawn */ }
    }
  };
  const start = () => {
    if (disposed || !connected()) return;
    retire();
    const token = revision;
    const current = { abort: new AbortController(), handle: undefined };
    run = current;
    setHealth(false);
    reset({ reason: 'connecting' });
    const active = () => !disposed && token === revision && connected();
    void (async () => {
      let epoch;
      let watermark = -1;
      try {
        if (lease.failed) {
          lease.release();
          lease = acquireTaskPetRemote(ctx, remote);
        }
        await lease.ready;
        if (!active()) return;
        const waiting = setTimeout(() => current.abort.abort(), 3000);
        try { current.scope = await acquireTaskPetNamespace(ctx, current.abort); }
        finally { clearTimeout(waiting); }
        if (!active() || current.abort.signal.aborted) return;
        current.handle = current.scope.service.watch(current.abort.signal);
        for await (const value of current.handle) {
          if (!active()) return;
          let frame;
          try {
            frame = TaskPetContract.TASKPET_FRAME_SCHEMA.parse(value);
          } catch (error) {
            warnFrameRejection(error);
            throw error;
          }
          if (frame.type === 'baseline') {
            epoch = frame.hostEpoch;
            watermark = frame.streamSeq;
            call(onData, frame.data);
            reset({ reason: 'baseline' });
            setHealth(true);
            retryDelay = 1000;
            continue;
          }
          if (epoch === undefined || frame.hostEpoch !== epoch) throw new Error('Bridge baseline required');
          if (frame.streamSeq <= watermark) continue;
          if (frame.streamSeq !== watermark + 1) throw new Error('Bridge sequence gap');
          watermark = frame.streamSeq;
          if (frame.type === 'data') call(onData, frame.data);
          else call(onBoundary, { ...frame, id: `${epoch}:${frame.streamSeq}` });
        }
      } catch { /* Fail closed and retry without forwarding errors or raw frames. */ }
      finally {
        current.abort.abort();
        try { await current.handle?.dispose?.(); } catch { /* already closed */ }
        try { await current.scope?.dispose(); } catch { /* already withdrawn */ }
        if (active()) {
          run = undefined;
          setHealth(false);
          reset({ reason: 'stream-ended' });
          retry = setTimeout(() => { retry = undefined; start(); }, retryDelay);
          retryDelay = Math.min(10000, retryDelay * 2);
        }
      }
    })();
  };
  const reconcile = () => {
    if (disposed) return;
    const key = connected() ? (ctx.connection?.generation?.getSnapshot?.() ?? true) : null;
    if (key === generationKey) return;
    generationKey = key;
    retryDelay = 1000;
    retire();
    setHealth(false);
    reset({ reason: key === null ? 'disconnected' : 'generation' });
    if (key !== null) start();
  };
  for (const store of [ctx.connection?.state, ctx.connection?.generation]) {
    if (typeof store?.subscribe === 'function') subscriptions.push(store.subscribe(reconcile));
  }
  reconcile();
  return () => {
    if (disposed) return;
    disposed = true;
    retire();
    for (const unsubscribe of subscriptions) unsubscribe();
    lease.release();
  };
}
