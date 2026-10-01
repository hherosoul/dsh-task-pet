// dsh-task-pet host half — runs inside the DSH host process.
//
// Responsibilities (the plugin's ONLY three jobs, per DESIGN.md):
//   1. session boundary bridge (whale-pet proven pattern): session/event -> frames
//   2. tasks.json file service: read-only polling with mtime cache + corruption
//      fallback, plus the agent-facing task_pet_read / task_pet_write tools
//   3. scene PNG assets served to the browser over loopback-guarded routes
//
// The data file has exactly ONE writer: the DSH agent (via task_pet_write, or
// its own file tools against the documented schema). This host never writes
// tasks.json on its own initiative; task_pet_write only executes on the
// agent's explicit call. No transcript retention, no model calls, no network.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, watch, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { defineTool } from '@deepseek-ai/dsh-tools';
import Schema from '@deepseek-ai/schemastery';
import { emptyTasksDocument, parseTasksDocument } from '../lib/remote.js';

/** Stable cordis plugin name (naming playbook: bare name, matches patch row id). */
export const name = 'task-pet';
/** agents: session events; tools: agent-facing data service; webServer: PNG routes. */
export const inject = ['agents', 'tools', 'webServer'];

export const BRIDGE_QUEUE_LIMIT = 128;
/** Safety-net poll: the file watcher below reports changes as they happen, so
 * this is only a backstop for a write the watcher missed. It is deliberately
 * long — a stat every 10 minutes costs nothing and the watcher carries the load. */
export const POLL_INTERVAL_MS = 600_000;
/** Poll cadence used when the file watcher could not be installed. */
export const FALLBACK_POLL_MS = 30_000;

/**
 * Deployment configuration. Every value that may differ between deployments is
 * declared here, the defaults live in the schema, and an invalid value fails
 * LOUDLY at load time instead of being silently ignored (the framework
 * validates config before `apply` runs). `dataDir: ''` means `$DSH_HOME/task-pet`.
 */
export const Config = Schema.object({
  dataDir: Schema.string()
    .default('')
    .description('Directory holding tasks.json; empty means $DSH_HOME/task-pet.'),
  pollIntervalMs: Schema.natural()
    .min(1000)
    .max(3_600_000)
    .default(POLL_INTERVAL_MS)
    .description('Safety-net interval for re-reading tasks.json; the file watcher reports changes immediately.'),
  bridgeQueueLimit: Schema.natural()
    .min(2)
    .max(1024)
    .default(BRIDGE_QUEUE_LIMIT)
    .description('Bridge frames buffered per browser client before a watermark replaces them.'),
});

/** Integer clamp that falls back to the schema default for non-numeric input. */
function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

/**
 * Event-driven refresh on top of the safety-net poll. `writeFileAtomic` finishes
 * with a rename, and watching the DIRECTORY catches that rename, so a write lands
 * in the pet immediately instead of waiting for the next poll. Bursts are
 * coalesced, and the whole thing is best-effort: when `watch` is unavailable the
 * caller falls back to the short poll interval.
 * @returns {{ active: boolean, dispose: () => void }}
 */
export function watchDataFile(file, notify, delayMs = 50) {
  let watcher;
  let timer;
  const clear = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
  const dispose = () => {
    clear();
    try {
      watcher?.close();
    } catch {
      /* already closed */
    }
    watcher = undefined;
  };
  try {
    watcher = watch(dirname(file), () => {
      clear();
      timer = setTimeout(() => {
        timer = undefined;
        notify();
      }, delayMs);
      timer.unref?.();
    });
    watcher.on?.('error', dispose);
    watcher.unref?.();
  } catch {
    watcher = undefined;
  }
  if (watcher === undefined) return { active: false, dispose };
  return { active: true, dispose };
}

/** Config with defaults + bounds applied defensively (unit-testable, pure). */
export function resolveRuntimeConfig(config = {}) {
  return {
    dataDir: typeof config?.dataDir === 'string' ? config.dataDir.trim() : '',
    pollIntervalMs: clampInt(config?.pollIntervalMs, 1000, 3_600_000, POLL_INTERVAL_MS),
    bridgeQueueLimit: clampInt(config?.bridgeQueueLimit, 2, 1024, BRIDGE_QUEUE_LIMIT),
  };
}

/** The DSH home directory: $DSH_HOME when set, else ~/.dsh (dpet convention). */
export function resolveDshHome(env = process.env, home = homedir()) {
  const raw = env.DSH_HOME?.trim();
  if (raw === undefined || raw === '') return join(home, '.dsh');
  const expanded = raw === '~' ? home : raw.startsWith('~/') || raw.startsWith('~\\') ? join(home, raw.slice(2)) : raw;
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

/** Nearest package root (holds package.json) above this module. */
export function packageRoot() {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'package.json'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('task-pet: package.json not found above ' + fileURLToPath(import.meta.url));
    dir = parent;
  }
  return dir;
}

/** Atomic write (temp file + rename), creating parent directories (dpet pattern). */
export function writeFileAtomic(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, data);
  renameSync(temp, file);
}

/** Human-readable message for a parse/validation failure. */
export function validationMessage(error) {
  const issues = Array.isArray(error?.issues) ? error.issues : [];
  if (issues.length) {
    const details = issues
      .slice(0, 8)
      .map((issue) => `${issue.path?.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    return `document failed schema validation — ${details}`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read-only view over data/tasks.json with an mtime cache: unchanged files are
 * never re-parsed; a corrupt file keeps the previous good snapshot and records
 * the error until the next successful load (DESIGN §5 corruption handling).
 */
export class TaskDataStore {
  constructor(file) {
    this.file = file;
    this.mtime = 0;
    this.doc = emptyTasksDocument();
    this.error = null;
    this.loadedOnce = false;
  }

  /** Current snapshot (no I/O). `mtime` is floored to whole milliseconds: the
   * bridge contract carries epoch milliseconds, while statSync keeps
   * sub-millisecond precision that change detection still needs. Emitting the
   * raw float made every frame fail client-side validation. */
  snapshot() {
    return { mtime: Math.floor(this.mtime), doc: this.doc, error: this.error };
  }

  /** Stat + (re)load when mtime changed; returns true when the snapshot changed. */
  refresh() {
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(this.file).mtimeMs;
    } catch {
      /* missing file -> empty document, not an error */
    }
    if (this.loadedOnce && mtimeMs === this.mtime) return false;
    const previous = this.loadedOnce ? `${this.mtime}|${this.error}` : null;
    this.mtime = mtimeMs;
    this.loadedOnce = true;
    if (mtimeMs === 0) {
      this.doc = emptyTasksDocument();
      this.error = null;
    } else {
      try {
        this.doc = parseTasksDocument(JSON.parse(readFileSync(this.file, 'utf8')));
        this.error = null;
      } catch (error) {
        this.error = validationMessage(error).slice(0, 200);
      }
    }
    const current = `${this.mtime}|${this.error}`;
    return previous === null || previous !== current;
  }

  /**
   * Owner: the pet's own UI, on an explicit user action (the tomato button and
   * the pomodoro settings). It is deliberately narrow — only `settings.pomodoro`
   * changes; every other field is carried over from the current document — so it
   * can never race the agent's full-document writes into losing your data.
   */
  writePomodoro({ runningSince = null, workMin, breakMin } = {}) {
    const current = this.doc;
    const pomodoro = { ...(current?.settings?.pomodoro ?? {}) };
    pomodoro.running_since = typeof runningSince === 'string' && runningSince !== '' ? runningSince : null;
    if (workMin !== undefined) pomodoro.work_min = clampInt(workMin, 1, 240, 45);
    if (breakMin !== undefined) pomodoro.break_min = clampInt(breakMin, 1, 240, 10);
    return this.write({
      tasks: current?.tasks ?? [],
      schedules: current?.schedules ?? [],
      settings: { ...(current?.settings ?? {}), pomodoro },
    });
  }

  /**
   * Agent-initiated full-document write (the agent's write path). Validates against
   * the shared contract, writes atomically (preserving the raw document as the
   * agent supplied it), and refreshes the cache. Throws on invalid documents.
   */
  write(rawDocument) {
    const doc = parseTasksDocument(rawDocument);
    writeFileAtomic(this.file, `${JSON.stringify(rawDocument, null, 2)}\n`);
    try {
      this.mtime = statSync(this.file).mtimeMs;
    } catch {
      this.mtime = 0;
    }
    this.doc = doc;
    this.error = null;
    this.loadedOnce = true;
    return this.snapshot();
  }
}

/** Whale-pet boundary hub plus task-data frames. */
export class TaskPetHub {
  constructor({ agents, store, epoch = globalThis.crypto.randomUUID(), queueLimit = BRIDGE_QUEUE_LIMIT } = {}) {
    this.agents = agents;
    this.store = store;
    this.hostEpoch = epoch;
    this.streamSeq = 0;
    this.queueLimit = Math.max(2, Math.min(1024, queueLimit));
    this.clients = new Set();
    this.closed = false;
    this.seen = new Map();
  }

  runtimeIdentity(sessionId) {
    try {
      const agent = this.agents?.get(sessionId);
      if (!agent || typeof this.agents.roots !== 'function') return {};
      return { isSubagent: !this.agents.roots().includes(agent) };
    } catch {
      return {};
    }
  }

  baseline() {
    let identities = [];
    try {
      identities = [...this.agents.list()].slice(0, 4096).map((agent) => ({
        sessionId: String(agent.id),
        ...this.runtimeIdentity(agent.id),
      }));
    } catch {
      /* Identity is optional; never invent an ownership classification. */
    }
    return {
      type: 'baseline',
      hostEpoch: this.hostEpoch,
      streamSeq: this.streamSeq,
      identities,
      data: this.store.snapshot(),
    };
  }

  /** Push one data frame (called after any snapshot change). */
  pushData() {
    if (this.closed) return;
    const frame = { type: 'data', hostEpoch: this.hostEpoch, streamSeq: ++this.streamSeq, data: this.store.snapshot() };
    for (const client of this.clients) client.push(frame);
  }

  /** Poll the file and push when the snapshot changed. */
  refreshAndPush() {
    if (this.store.refresh()) this.pushData();
  }

  accept(session, event) {
    if (this.closed || !event || (event.type !== 'turn/start' && event.type !== 'turn/end')) return;
    const sessionId = session?.id;
    if (typeof sessionId !== 'string' || !sessionId || !Number.isSafeInteger(event.seq) || event.seq < 0) return;
    if (event.seq <= (this.seen.get(sessionId) ?? -1)) return;
    this.seen.delete(sessionId);
    this.seen.set(sessionId, event.seq);
    if (this.seen.size > 4096) this.seen.delete(this.seen.keys().next().value);
    const frame = {
      type: event.type,
      hostEpoch: this.hostEpoch,
      streamSeq: ++this.streamSeq,
      sessionId,
      seq: event.seq,
      time: typeof event.time === 'string' ? event.time.slice(0, 64) : Number.isFinite(event.time) ? event.time : Date.now(),
      ...this.runtimeIdentity(sessionId),
    };
    if (event.type === 'turn/end') {
      const kind = event.data?.reason?.kind;
      frame.reason = typeof kind === 'string' ? kind.slice(0, 80) : 'unknown';
    }
    for (const client of this.clients) client.push(frame);
  }

  watch(signal) {
    const hub = this;
    const queue = [];
    let resolveNext;
    let ended = this.closed || signal?.aborted === true;
    const finish = () => {
      if (ended) return;
      ended = true;
      hub.clients.delete(client);
      signal?.removeEventListener('abort', finish);
      queue.length = 0;
      if (resolveNext) {
        const resolve = resolveNext;
        resolveNext = undefined;
        resolve({ done: true });
      }
    };
    const client = {
      push(frame) {
        if (ended) return;
        if (resolveNext) {
          const resolve = resolveNext;
          resolveNext = undefined;
          resolve({ done: false, value: frame });
        } else if (queue.length >= hub.queueLimit) {
          // Drop stale boundaries; send a fresh watermark instead of replaying.
          queue.length = 0;
          queue.push(hub.baseline());
        } else queue.push(frame);
      },
      next() {
        if (queue.length) return Promise.resolve({ done: false, value: queue.shift() });
        if (ended) return Promise.resolve({ done: true });
        if (resolveNext) return Promise.reject(new Error('Only one bridge iterator read may be pending'));
        return new Promise((resolve) => {
          resolveNext = resolve;
        });
      },
      return() {
        finish();
        return Promise.resolve({ done: true });
      },
      [Symbol.asyncIterator]() {
        return this;
      },
      close: finish,
    };
    if (!ended) {
      this.clients.add(client);
      signal?.addEventListener('abort', finish, { once: true });
      client.push(this.baseline());
    }
    return client;
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    for (const client of [...this.clients]) client.close();
    this.seen.clear();
  }
}

/** Scene keys -> shipped PNG files (whitelist; only these are ever served). */
export const SCENE_IMAGES = {
  morning: '晨间规划.png',
  'task-reminder': '任务提醒.png',
  focus: '专注陪伴.png',
  break: '休息提醒.png',
  schedule: '日程预览.png',
  evening: '晚间复盘.png',
};

const isIPv4Loopback = (v4) => {
  const parts = v4.split('.');
  return parts.length === 4 && parts[0] === '127' && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
};
const isLoopbackAddress = (address) => {
  if (address === undefined) return false;
  const a = address.toLowerCase();
  if (a === '::1') return true;
  if (a.startsWith('::ffff:')) return isIPv4Loopback(a.slice(7));
  return isIPv4Loopback(a);
};
const isLoopbackHostname = (hostname) => hostname === 'localhost' || hostname === '[::1]' || isIPv4Loopback(hostname);

/** Loopback-only access check (dpet pattern). */
export function accessProblem(req) {
  if (!isLoopbackAddress(req.socket?.remoteAddress)) return 'loopback-only';
  const host = req.headers?.host;
  if (typeof host !== 'string') return 'missing-host';
  let hostname;
  try {
    hostname = new URL(`http://${host}`).hostname;
  } catch {
    return 'bad-host';
  }
  if (!isLoopbackHostname(hostname)) return 'loopback-only';
  return undefined;
}

/** GET /task-pet/images/<scene-key> — scene PNGs from the package assets. */
export function makeImageRoutes(root) {
  const dir = join(root, 'images');
  const serve = async (req, res) => {
    const problem = accessProblem(req);
    if (problem !== undefined) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: problem }));
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'GET, HEAD' });
      res.end(JSON.stringify({ ok: false, error: 'method-not-allowed' }));
      return;
    }
    let key = '';
    try {
      const path = new URL(req.url ?? '/', 'http://localhost').pathname;
      key = decodeURIComponent(path.split('/').filter(Boolean).pop() ?? '');
    } catch {
      /* fall through to the whitelist miss */
    }
    const file = SCENE_IMAGES[key];
    if (file === undefined) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'unknown-scene' }));
      return;
    }
    let bytes;
    try {
      bytes = readFileSync(join(dir, file));
    } catch {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'missing-asset' }));
      return;
    }
    res.writeHead(200, {
      'content-type': 'image/png',
      'content-length': String(bytes.byteLength),
      'cache-control': 'no-store',
    });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  };
  return [{ kind: 'prefix', path: '/task-pet/images', handler: serve }];
}

/** Read a small JSON request body (capped, so a hostile caller cannot stream forever). */
function readJsonBody(req, limit = 4096) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('body-too-large'));
        req.destroy?.();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

const sendJson = (res, code, payload) => {
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload));
};

/**
 * POST /task-pet/pomodoro — start or stop the pomodoro from the pet's own UI.
 * Loopback-guarded like the image routes, and gated behind a custom header: a
 * cross-site page cannot set one without a preflight this host never answers, so
 * no other local page can drive your timer.
 */
export function makePomodoroRoute(store, hub) {
  const handler = async (req, res) => {
    const problem = accessProblem(req);
    if (problem !== undefined) {
      sendJson(res, 403, { ok: false, error: problem });
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { 'content-type': 'application/json', allow: 'POST' });
      res.end(JSON.stringify({ ok: false, error: 'method-not-allowed' }));
      return;
    }
    if (req.headers?.['x-task-pet'] !== '1') {
      sendJson(res, 400, { ok: false, error: 'missing-client-header' });
      return;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: validationMessage(error) });
      return;
    }
    try {
      const snapshot = store.writePomodoro({
        runningSince: body?.runningSince ?? null,
        workMin: body?.workMin,
        breakMin: body?.breakMin,
      });
      hub.pushData();
      sendJson(res, 200, { ok: true, data: snapshot });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: validationMessage(error) });
    }
  };
  return [{ kind: 'prefix', path: '/task-pet/pomodoro', handler }];
}

/** The two agent-facing tools: the plugin's data access service (DESIGN §1.3). */
export function makeDataTools({ store, hub, schemaPath }) {
  const readTool = defineTool({
    name: 'task_pet_read',
    description:
      'Read the user\'s current task-pet document (tasks, schedules, pomodoro settings) as shown by the desk pet. ' +
      'Call this BEFORE task_pet_write (the pet file is a full-document write) and whenever the user asks about ' +
      'their reminders, tasks, schedules or pomodoro. Do not call for unrelated questions.',
    parameters: {},
    output: {
      // Explicit object nodes MUST declare additionalProperties (dsh-tools raw
      // schema boundary); omitting it throws at defineTool time.
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [
        {
          type: 'text',
          text:
            `task-pet data @ ${value.path} (mtime ${value.mtime})\n` +
            (value.error ? `LAST LOAD ERROR (pet keeps previous snapshot): ${value.error}\n` : '') +
            `${JSON.stringify(value.document, null, 2)}`,
        },
      ],
    },
    async execute(_args, exec) {
      if (exec?.signal?.aborted) throw new Error('aborted');
      store.refresh();
      const snap = store.snapshot();
      return { path: store.file, schema_path: schemaPath, mtime: snap.mtime, error: snap.error, document: snap.doc };
    },
  });

  const writeTool = defineTool({
    name: 'task_pet_write',
    description:
      'Write the FULL task-pet document (the desk pet\'s single data source). Read with task_pet_read first, ' +
      'apply the user\'s requested change, then write the complete document back. Contract highlights: ' +
      'times are ISO 8601 WITH timezone; every task.remind_at entry is an INDEPENDENT reminder — the standing ' +
      'rule for a schedule or meeting is TWO entries, 24 hours and 1 hour before it starts; a reminder only ' +
      'nudges briefly and the user clears it by looking at the pet, so never use one to keep something on screen; ' +
      'completing a task sets status "completed" + completed_at; once a task\'s due or a schedule\'s end has passed ' +
      'the item stops counting on the badge and never nudges again — it only shows up in the agenda-details preview; ' +
      'and for repeat ' +
      'tasks you create the next instance yourself; settings.pomodoro.running_since (ISO timestamp) starts the ' +
      'pomodoro cycle, null stops it; settings.evening_time "HH:mm" (default 18:30) schedules the evening review. ' +
      'Never invent tasks the user did not ask for; the file is the user\'s data.',
    parameters: {
      document: {
        type: 'object',
        additionalProperties: true,
        required: true,
        description:
          'The complete tasks.json document: { tasks: [{id,title,due?,remind_at[],priority?,status,repeat?,created_at?,completed_at?}], ' +
          'schedules: [{id,title,start,end,note?}], settings: {pet_name,evening_time,pomodoro:{work_min,break_min,running_since}} }. ' +
          'Validate against data/tasks.schema.json before writing.',
      },
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [
        {
          type: 'text',
          text: `task-pet document written to ${value.path} (mtime ${value.mtime}): ` +
            `${value.counts.tasks} tasks (${value.counts.pending} pending), ${value.counts.schedules} schedules` +
            (value.counts.reminders ? `, ${value.counts.reminders} upcoming reminders` : '') + '.',
        },
      ],
    },
    async execute(args, exec) {
      if (exec?.signal?.aborted) throw new Error('aborted');
      let snap;
      try {
        snap = store.write(args.document);
      } catch (error) {
        throw new Error(validationMessage(error));
      }
      hub.pushData();
      const doc = snap.doc;
      return {
        path: store.file,
        mtime: snap.mtime,
        counts: {
          tasks: doc.tasks.length,
          pending: doc.tasks.filter((task) => task.status === 'pending').length,
          schedules: doc.schedules.length,
          reminders: doc.tasks.reduce((n, task) => n + task.remind_at.length, 0),
        },
      };
    },
  });

  return [readTool, writeTool];
}

export function apply(ctx, config = {}) {
  const root = packageRoot();
  const { dataDir: configured, pollIntervalMs, bridgeQueueLimit } = resolveRuntimeConfig(config);
  const dataDir = configured !== ''
    ? (isAbsolute(configured) ? configured : resolve(process.cwd(), configured))
    : join(resolveDshHome(), 'task-pet');
  mkdirSync(dataDir, { recursive: true });
  const store = new TaskDataStore(join(dataDir, 'tasks.json'));
  store.refresh();
  const hub = new TaskPetHub({ agents: ctx.get('agents'), store, queueLimit: bridgeQueueLimit });

  const service = {
    watch(signal) {
      store.refresh();
      return hub.watch(signal);
    },
    async getData() {
      store.refresh();
      return store.snapshot();
    },
  };
  // Public Cordis service + the exact visible protocol binding (whale-pet pattern).
  // Strict reflection is contributed separately by ./typert.
  service.typertRemote = Object.freeze({ service, serviceKey: 'taskPet', namespace: 'taskPet' });
  ctx.provide('taskPet', service);
  ctx.on('session/event', (session, event) => hub.accept(session, event), { global: true });

  // File changes ride the watcher; the interval is only a backstop (and the
  // primary path when `watch` is unavailable in this runtime).
  const changes = watchDataFile(store.file, () => hub.refreshAndPush());
  const watchdogMs = changes.active ? pollIntervalMs : Math.min(pollIntervalMs, FALLBACK_POLL_MS);
  const timer = setInterval(() => hub.refreshAndPush(), watchdogMs);
  timer.unref?.();

  const tools = makeDataTools({ store, hub, schemaPath: join(root, 'data', 'tasks.schema.json') });
  for (const tool of tools) ctx.tools.register(tool);

  ctx.effect(() => {
    const disposers = [
      ...makeImageRoutes(root),
      ...makePomodoroRoute(store, hub),
    ].map((route) => ctx.webServer.register(route));
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, 'task-pet: image routes and the pomodoro route');
  ctx.effect(
    () => () => {
      clearInterval(timer);
      changes.dispose();
      hub.dispose();
    },
    'task-pet.hub',
  );
}
