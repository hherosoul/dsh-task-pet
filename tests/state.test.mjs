import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STORAGE_KEY, cleanPreferences, jsonStorage, loadPreferences, savePreferences, clampPosition,
} from '../src/state.js';
import { SessionsProbe } from '../src/sessions-probe.js';

test('cleanPreferences clamps scale and normalizes fields', () => {
  assert.deepEqual(cleanPreferences(null), { scale: 1, hidden: false, motion: true, x: null, y: null });
  assert.deepEqual(cleanPreferences({ scale: 5, hidden: true, motion: false, x: 10, y: 'z' }),
    { scale: 1.6, hidden: true, motion: false, x: 10, y: null });
  assert.deepEqual(cleanPreferences({ scale: 0.1 }), { scale: 0.65, hidden: false, motion: true, x: null, y: null });
});

test('jsonStorage round-trips JSON and tolerates corruption', () => {
  const map = new Map();
  const backing = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
  const store = jsonStorage(backing);
  assert.equal(store.read('missing'), undefined);
  store.write('k', { a: 1 });
  assert.deepEqual(store.read('k'), { a: 1 });
  map.set('bad', '{oops');
  assert.equal(store.read('bad'), undefined);
});

test('loadPreferences/savePreferences round-trip via STORAGE_KEY', () => {
  const map = new Map();
  const backing = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v) };
  const store = jsonStorage(backing);
  assert.deepEqual(loadPreferences(store), cleanPreferences(null));
  savePreferences(store, { scale: 1.2, hidden: false, motion: true, x: 3, y: 4 });
  assert.equal(loadPreferences(store).x, 3);
  assert.equal(loadPreferences(store).scale, 1.2);
  assert.equal(map.has(STORAGE_KEY), true);
});

test('clampPosition keeps the pet on screen with margin and top clearance', () => {
  assert.deepEqual(clampPosition(-100, -100, 100, 100, 800, 600, 56), { x: 12, y: 56 });
  assert.deepEqual(clampPosition(1000, 1000, 100, 100, 800, 600, 56), { x: 800 - 100 - 12, y: 600 - 100 - 12 });
});

test('SessionsProbe merges bridge frames and hook status counts', () => {
  const probe = new SessionsProbe();
  assert.deepEqual(probe.view(), { running: false, pending: false });
  probe.applyFrame({ type: 'turn/start', sessionId: 'a' });
  assert.equal(probe.view().running, true);
  probe.applyStatus({ running: 2, pending: 1 });
  assert.deepEqual(probe.view(), { running: true, pending: true });
  probe.applyFrame({ type: 'turn/end', sessionId: 'a' });
  assert.equal(probe.view().running, true); // hook still reports running
  probe.applyStatus({ running: 0, pending: 0 });
  assert.deepEqual(probe.view(), { running: false, pending: false });
});
