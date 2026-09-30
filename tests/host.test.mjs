import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveDshHome, validationMessage, writeFileAtomic, TaskDataStore,
  accessProblem, SCENE_IMAGES, Config, resolveRuntimeConfig,
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
  assert.equal(defaults.pollIntervalMs, 30_000);
  assert.equal(defaults.bridgeQueueLimit, 128);
  assert.equal(Config({ dataDir: '/tmp/pet', pollIntervalMs: 5000 }).dataDir, '/tmp/pet');
  assert.throws(() => Config({ pollIntervalMs: 10 }));
  assert.throws(() => Config({ bridgeQueueLimit: 1 }));
  assert.throws(() => Config({ dataDir: 42 }));
});

test('resolveRuntimeConfig clamps and tolerates a partially invalid config', () => {
  assert.deepEqual(resolveRuntimeConfig(), { dataDir: '', pollIntervalMs: 30_000, bridgeQueueLimit: 128 });
  assert.equal(resolveRuntimeConfig({ dataDir: '  /tmp/x  ' }).dataDir, '/tmp/x');
  assert.equal(resolveRuntimeConfig({ pollIntervalMs: 10 }).pollIntervalMs, 1000);
  assert.equal(resolveRuntimeConfig({ pollIntervalMs: 9e9 }).pollIntervalMs, 3_600_000);
  assert.equal(resolveRuntimeConfig({ bridgeQueueLimit: 0 }).bridgeQueueLimit, 2);
  assert.equal(resolveRuntimeConfig({ bridgeQueueLimit: 4096 }).bridgeQueueLimit, 1024);
  assert.equal(resolveRuntimeConfig({ pollIntervalMs: 'nonsense' }).pollIntervalMs, 30_000);
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
