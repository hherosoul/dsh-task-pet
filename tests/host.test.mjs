import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveDshHome, validationMessage, writeFileAtomic, TaskDataStore,
  accessProblem, SCENE_IMAGES, Config, resolveRuntimeConfig, watchDataFile, POLL_INTERVAL_MS, makePomodoroRoute,
} from '../src/host.js';

test('resolveDshHome honors $DSH_HOME with ~ expansion and a home fallback', () => {
  assert.equal(resolveDshHome({}, '/home/u'), path.join('/home/u', '.dsh'));
  assert.equal(resolveDshHome({ DSH_HOME: '~' }, '/home/u'), '/home/u');
  assert.equal(resolveDshHome({ DSH_HOME: '~/data' }, '/home/u'), path.join('/home/u', 'data'));
  assert.equal(resolveDshHome({ DSH_HOME: '/abs/path' }, '/home/u'), '/abs/path');
  assert.equal(resolveDshHome({ DSH_HOME: '  ' }, '/home/u'), path.join('/home/u', '.dsh'));
});

test('Config is a schema that applies defaults and rejects out-of-range values', () => {
  const defaults = Config({});
  assert.equal(defaults.dataDir, '');
  assert.equal(defaults.pollIntervalMs, 600_000); // safety net only; the watcher carries changes
  assert.equal(defaults.bridgeQueueLimit, 128);
  assert.equal(Config({ dataDir: '/tmp/pet', pollIntervalMs: 5000 }).dataDir, '/tmp/pet');
  assert.throws(() => Config({ pollIntervalMs: 10 }));
  assert.throws(() => Config({ bridgeQueueLimit: 1 }));
  assert.throws(() => Config({ dataDir: 42 }));
});

test('resolveRuntimeConfig clamps and tolerates a partially invalid config', () => {
  assert.deepEqual(resolveRuntimeConfig(), { dataDir: '', pollIntervalMs: POLL_INTERVAL_MS, bridgeQueueLimit: 128 });
  assert.equal(resolveRuntimeConfig({ dataDir: '  /tmp/x  ' }).dataDir, '/tmp/x');
  assert.equal(resolveRuntimeConfig({ pollIntervalMs: 10 }).pollIntervalMs, 1000);
  assert.equal(resolveRuntimeConfig({ pollIntervalMs: 9e9 }).pollIntervalMs, 3_600_000);
  assert.equal(resolveRuntimeConfig({ bridgeQueueLimit: 0 }).bridgeQueueLimit, 2);
  assert.equal(resolveRuntimeConfig({ bridgeQueueLimit: 4096 }).bridgeQueueLimit, 1024);
  assert.equal(resolveRuntimeConfig({ pollIntervalMs: 'nonsense' }).pollIntervalMs, POLL_INTERVAL_MS);
});

test('validationMessage surfaces zod issues and plain errors', () => {
  const message = validationMessage({ issues: [{ path: ['tasks', 0, 'title'], message: 'Too long' }] });
  assert.match(message, /document failed schema validation/);
  assert.match(message, /tasks\.0\.title: Too long/);
  assert.equal(validationMessage(new Error('boom')), 'boom');
  assert.equal(validationMessage('raw'), 'raw');
});

test('writeFileAtomic creates parent directories and writes content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskpet-'));
  const file = path.join(dir, 'nested', 'deep', 'tasks.json');
  writeFileAtomic(file, 'hello');
  assert.equal(fs.readFileSync(file, 'utf8'), 'hello');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('TaskDataStore handles missing, valid, corrupt and recovered files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskpet-'));
  const file = path.join(dir, 'tasks.json');
  const store = new TaskDataStore(file);

  // Missing file -> empty document; first refresh reports a change, second is a no-op.
  assert.equal(store.refresh(), true);
  assert.equal(store.snapshot().mtime, 0);
  assert.equal(store.snapshot().error, null);
  assert.equal(store.snapshot().doc.tasks.length, 0);
  assert.equal(store.refresh(), false);

  // Valid file -> parsed document.
  fs.writeFileSync(file, JSON.stringify({ tasks: [{ id: 'a', title: 'x' }] }));
  assert.equal(store.refresh(), true);
  assert.equal(store.snapshot().doc.tasks.length, 1);
  assert.equal(store.snapshot().error, null);

  // Corrupt file -> keep the previous good snapshot + record the error.
  fs.writeFileSync(file, '{ not json');
  assert.equal(store.refresh(), true);
  assert.equal(store.snapshot().doc.tasks.length, 1);
  assert.notEqual(store.snapshot().error, null);

  // Recovery clears the error.
  fs.writeFileSync(file, JSON.stringify({ tasks: [] }));
  assert.equal(store.refresh(), true);
  assert.equal(store.snapshot().error, null);
  assert.equal(store.snapshot().doc.tasks.length, 0);

  fs.rmSync(dir, { recursive: true, force: true });
});

test('TaskDataStore.write validates and writes the full document', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskpet-'));
  const file = path.join(dir, 'tasks.json');
  const store = new TaskDataStore(file);
  const snap = store.write({ tasks: [{ id: 'a', title: 'x', status: 'pending' }], schedules: [], settings: {} });
  assert.equal(snap.doc.tasks.length, 1);
  assert.equal(snap.error, null);
  assert.ok(fs.existsSync(file));
  assert.throws(() => store.write({ tasks: [{ id: 'a' }] })); // missing title violates the contract
  fs.rmSync(dir, { recursive: true, force: true });
});

test('TaskDataStore emits a whole-millisecond mtime so bridge frames validate', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskpet-'));
  const file = path.join(dir, 'tasks.json');
  const store = new TaskDataStore(file);
  fs.writeFileSync(file, JSON.stringify({ tasks: [] }));
  assert.equal(store.refresh(), true);
  // statSync keeps sub-millisecond precision; the snapshot contract (and every
  // frame carrying it) does not, so a fractional mtime must never be emitted.
  assert.ok(Number.isInteger(store.snapshot().mtime), `refresh mtime ${store.snapshot().mtime} must be an integer`);
  const snap = store.write({ tasks: [], schedules: [], settings: {} });
  assert.ok(Number.isInteger(snap.mtime), `write mtime ${snap.mtime} must be an integer`);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('watchDataFile reports a written file and stops on dispose', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskpet-watch-'));
  const file = path.join(dir, 'tasks.json');
  const seen = [];
  const watch_ = watchDataFile(file, () => seen.push(Date.now()), 10);
  try {
    if (!watch_.active) return; // watch() unavailable here: the poll covers it
    fs.writeFileSync(file, '{}');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.ok(seen.length > 0, 'a write must notify');
    watch_.dispose();
    const settled = seen.length;
    fs.writeFileSync(file, '{"tasks":[]}');
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(seen.length, settled, 'a disposed watcher stays silent');
  } finally {
    watch_.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fakeReq({ method = 'POST', remoteAddress = '127.0.0.1', host = 'localhost:1', headers = {}, body = '' } = {}) {
  const listeners = new Map();
  const req = {
    method,
    socket: { remoteAddress, destroy() {} },
    headers: { host, ...headers },
    on(event, handle) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handle);
      return req;
    },
  };
  setTimeout(() => {
    for (const handle of listeners.get('data') ?? []) handle(Buffer.from(body));
    for (const handle of listeners.get('end') ?? []) handle();
  }, 0);
  return req;
}

function fakeRes() {
  const res = { code: null, payload: '' };
  res.writeHead = (code) => { res.code = code; return res; };
  res.end = (data) => { res.payload += data ?? ''; return res; };
  return res;
}

test('writePomodoro touches only the pomodoro block and clamps the minutes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskpet-pomo-'));
  const store = new TaskDataStore(path.join(dir, 'tasks.json'));
  store.write({ tasks: [{ id: 't', title: '别动我', status: 'pending' }], schedules: [], settings: { pet_name: '知知' } });
  store.writePomodoro({ runningSince: '2026-09-30T22:00:00+08:00', workMin: 999, breakMin: 0 });
  let doc = store.snapshot().doc;
  assert.equal(doc.settings.pomodoro.work_min, 240);
  assert.equal(doc.settings.pomodoro.break_min, 1);
  assert.equal(doc.settings.pomodoro.running_since, '2026-09-30T22:00:00+08:00');
  assert.equal(doc.tasks[0].title, '别动我');
  assert.equal(doc.settings.pet_name, '知知');
  store.writePomodoro({ runningSince: null });
  doc = store.snapshot().doc;
  assert.equal(doc.settings.pomodoro.running_since, null);
  assert.equal(doc.tasks.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writePomodoro preserves unknown keys the agent kept on disk', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskpet-pomo-raw-'));
  const file = path.join(dir, 'tasks.json');
  const store = new TaskDataStore(file);
  // Unknown keys are tolerated by the contract and promised to survive on disk;
  // the pomodoro write must merge into the RAW file, not the stripped snapshot.
  const raw = {
    tasks: [{ id: 't', title: 'x', status: 'pending', my_note: 'keep me' }],
    schedules: [],
    settings: { pet_name: '知知' },
  };
  store.write(raw);
  store.writePomodoro({ runningSince: '2026-10-01T09:00:00+08:00', workMin: 25, breakMin: 5 });
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(disk.tasks[0].my_note, 'keep me', 'unknown task keys must survive a pomodoro write');
  assert.equal(disk.settings.pomodoro.work_min, 25);
  assert.equal(disk.settings.pet_name, '知知');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writePomodoro on a corrupt file falls back to the last good snapshot', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskpet-pomo-corr-'));
  const file = path.join(dir, 'tasks.json');
  const store = new TaskDataStore(file);
  store.write({ tasks: [{ id: 't', title: 'safe', status: 'pending' }], schedules: [], settings: {} });
  fs.writeFileSync(file, '{ not json');
  store.refresh(); // error recorded, snapshot keeps the last good document
  store.writePomodoro({ runningSince: '2026-10-01T09:00:00+08:00' });
  const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(disk.tasks[0].title, 'safe');
  assert.equal(disk.settings.pomodoro.running_since, '2026-10-01T09:00:00+08:00');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the pomodoro route starts the timer and pushes a frame', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskpet-route-'));
  const store = new TaskDataStore(path.join(dir, 'tasks.json'));
  store.write({ tasks: [], schedules: [], settings: {} });
  let pushes = 0;
  const [route] = makePomodoroRoute(store, { pushData: () => { pushes += 1; } });
  assert.equal(route.path, '/task-pet/pomodoro');
  const res = fakeRes();
  await route.handler(fakeReq({
    headers: { 'x-task-pet': '1', 'content-type': 'application/json' },
    body: JSON.stringify({ runningSince: '2026-09-30T22:30:00+08:00', workMin: 45, breakMin: 10 }),
  }), res);
  assert.equal(res.code, 200);
  assert.equal(store.snapshot().doc.settings.pomodoro.work_min, 45);
  assert.equal(store.snapshot().doc.settings.pomodoro.running_since, '2026-09-30T22:30:00+08:00');
  assert.equal(pushes, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the pomodoro route refuses other origins, methods and callers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskpet-route2-'));
  const store = new TaskDataStore(path.join(dir, 'tasks.json'));
  const [route] = makePomodoroRoute(store, { pushData: () => {} });
  const cases = [
    ['non-loopback', fakeReq({ remoteAddress: '8.8.8.8', headers: { 'x-task-pet': '1' } }), 403],
    ['foreign host', fakeReq({ host: 'evil.example', headers: { 'x-task-pet': '1' } }), 403],
    ['GET', fakeReq({ method: 'GET', headers: { 'x-task-pet': '1' } }), 405],
    ['no client header', fakeReq({ body: '{}' }), 400],
  ];
  for (const [label, req, code] of cases) {
    const res = fakeRes();
    await route.handler(req, res);
    assert.equal(res.code, code, label);
  }
  assert.equal(store.snapshot().mtime, 0, 'nothing was written');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('SCENE_IMAGES maps the six scene keys to shipped PNG files', () => {
  assert.deepEqual(Object.keys(SCENE_IMAGES).sort(), ['break', 'evening', 'focus', 'morning', 'schedule', 'task-reminder']);
  for (const file of Object.values(SCENE_IMAGES)) assert.match(file, /\.png$/);
});

test('accessProblem only allows loopback with a loopback Host header', () => {
  assert.equal(accessProblem({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'localhost:8080' } }), undefined);
  assert.equal(accessProblem({ socket: { remoteAddress: '::1' }, headers: { host: '[::1]:8080' } }), undefined);
  assert.equal(accessProblem({ socket: { remoteAddress: '8.8.8.8' }, headers: { host: 'localhost' } }), 'loopback-only');
  assert.equal(accessProblem({ socket: { remoteAddress: '127.0.0.1' }, headers: { host: 'evil.com' } }), 'loopback-only');
  assert.equal(accessProblem({ socket: { remoteAddress: '127.0.0.1' }, headers: {} }), 'missing-host');
});

test('apply() registers both tools, the taskPet service and the image routes, honoring config', async () => {
  const { apply, Config } = await import('../src/host.js');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taskpet-apply-'));
  const registered = [];
  const provided = {};
  const routes = [];
  const disposers = [];
  const ctx = {
    get: () => ({ get: () => undefined, list: () => [], roots: () => [] }),
    provide: (key, value) => { provided[key] = value; },
    on: () => {},
    effect: (fn) => { disposers.push(fn()); },
    tools: { register: (tool) => { registered.push(tool); } },
    webServer: { register: (route) => { routes.push(route); return () => {}; } },
  };
  apply(ctx, Config({ dataDir, pollIntervalMs: 5000 }));
  try {
    assert.deepEqual(registered.map((tool) => tool.name).sort(), ['task_pet_read', 'task_pet_write']);
    assert.equal(typeof provided.taskPet.watch, 'function');
    assert.equal(typeof provided.taskPet.getData, 'function');
    assert.equal(routes[0].path, '/task-pet/images');
    const file = path.join(dataDir, 'tasks.json');
    const read = registered.find((tool) => tool.name === 'task_pet_read');
    const value = await read.execute({}, { signal: { aborted: false } });
    assert.equal(value.path, file);
    assert.deepEqual(value.document.tasks, []);
    assert.deepEqual(value.document.schedules, []);
    assert.equal(value.document.settings.evening_time, '18:30');
  } finally {
    for (const dispose of disposers) {
      try { if (typeof dispose === 'function') dispose(); } catch { /* ignore */ }
    }
  }
});
