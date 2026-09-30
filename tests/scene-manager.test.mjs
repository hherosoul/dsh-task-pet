import test from 'node:test';
import assert from 'node:assert/strict';
import { SceneManager, memoryStorage, SCENES } from '../src/scene-manager.js';

const local = (y, mo, d, h, mi, s = 0) => new Date(y, mo - 1, d, h, mi, s, 0).getTime();
const iso = (ms) => new Date(ms).toISOString();

const baseDoc = () => ({
  tasks: [
    { id: 't1', title: '提交周报', status: 'pending', due: iso(local(2026, 9, 30, 18, 0)), remind_at: [iso(local(2026, 9, 30, 10, 0))] },
    { id: 't2', title: '回复客户邮件', status: 'pending', due: iso(local(2026, 9, 30, 17, 0)), remind_at: [iso(local(2026, 9, 30, 11, 30))] },
    { id: 't3', title: '准备晨会材料', status: 'completed', completed_at: iso(local(2026, 9, 30, 9, 30)) },
  ],
  schedules: [{ id: 's1', title: '产品评审会', start: iso(local(2026, 9, 30, 14, 0)), end: iso(local(2026, 9, 30, 15, 0)) }],
  settings: { evening_time: '18:30' },
});

const input = (over = {}) => ({ doc: baseDoc(), error: null, sessionRunning: false, sessionPending: false, event: null, ...over });

test('SCENES lists the six scene keys in design order', () => {
  assert.deepEqual(SCENES, ['morning', 'task-reminder', 'focus', 'break', 'schedule', 'evening']);
});

test('default scene is schedule with no bubble and a schedule prompt', () => {
  const m = new SceneManager({ storage: memoryStorage() });
  const view = m.update(input(), local(2026, 9, 30, 9, 0));
  assert.equal(view.scene, 'schedule');
  assert.equal(view.bubble, null);
  assert.equal(view.badge, null);
  assert.equal(view.prompt.key, 'prompt.schedule');
});

test('startup before evening holds the morning scene with a count', () => {
  const m = new SceneManager({ storage: memoryStorage() });
  const view = m.update(input({ event: 'startup' }), local(2026, 9, 30, 9, 0));
  assert.equal(view.scene, 'morning');
  assert.equal(view.bubble.key, 'bubble.morning');
  assert.equal(view.bubble.params.count, 3);
});

test('a due reminder outranks everything and wins the click prompt', () => {
  const m = new SceneManager({ storage: memoryStorage() });
  const view = m.update(input({ event: 'startup' }), local(2026, 9, 30, 10, 5));
  assert.equal(view.scene, 'task-reminder');
  assert.equal(view.badge, 1);
  assert.equal(view.bounce, true);
  assert.equal(view.bubble.key, 'bubble.reminder');
  assert.equal(view.bubble.params.task, '提交周报');
  assert.equal(view.prompt.key, 'prompt.reminder');
  assert.equal(view.prompt.params.task, '提交周报');
});

test('the reminder bubble expires but the badge persists', () => {
  const m = new SceneManager({ storage: memoryStorage() });
  const fire = local(2026, 9, 30, 10, 5);
  assert.equal(m.update(input(), fire).bubble.key, 'bubble.reminder');
  const later = m.update(input(), fire + 15_000);
  assert.equal(later.scene, 'task-reminder');
  assert.equal(later.bubble, null);
  assert.equal(later.badge, 1);
  assert.equal(later.bounce, false);
});

test('pomodoro work phase shows focus with a countdown', () => {
  const doc = { ...baseDoc(), settings: { evening_time: '18:30', pomodoro: { running_since: iso(local(2026, 9, 30, 9, 0)), work_min: 25, break_min: 5 } } };
  const m = new SceneManager({ storage: memoryStorage() });
  const view = m.update(input({ doc }), local(2026, 9, 30, 9, 5));
  assert.equal(view.scene, 'focus');
  assert.equal(view.bubble, null);
  assert.ok(view.countdown);
  assert.equal(view.countdown.remainingMs, 20 * 60_000);
  assert.equal(view.prompt.key, 'prompt.focus');
});

test('pomodoro break phase shows the break scene', () => {
  const doc = { ...baseDoc(), settings: { evening_time: '18:30', pomodoro: { running_since: iso(local(2026, 9, 30, 9, 0)), work_min: 25, break_min: 5 } } };
  const m = new SceneManager({ storage: memoryStorage() });
  const view = m.update(input({ doc }), local(2026, 9, 30, 9, 25));
  assert.equal(view.scene, 'break');
  assert.equal(view.bubble.key, 'bubble.break');
});

test('a running session shows focus; 50 minutes of continuous focus shows break', () => {
  const quiet = { tasks: [], schedules: [], settings: {} };
  const m = new SceneManager({ storage: memoryStorage() });
  const start = local(2026, 9, 30, 10, 0);
  assert.equal(m.update(input({ doc: quiet, sessionRunning: true }), start).scene, 'focus');
  const overtime = m.update(input({ doc: quiet, sessionRunning: true }), start + 50 * 60_000 + 1);
  assert.equal(overtime.scene, 'break');
  assert.equal(overtime.bubble.key, 'bubble.break');
});

test('evening review triggers after evening_time with the completed count', () => {
  const quiet = { tasks: [{ id: 't1', title: 'done', status: 'completed', completed_at: iso(local(2026, 9, 30, 9, 0)) }], schedules: [], settings: { evening_time: '18:30' } };
  const m = new SceneManager({ storage: memoryStorage() });
  const view = m.update(input({ doc: quiet }), local(2026, 9, 30, 20, 0));
  assert.equal(view.scene, 'evening');
  assert.equal(view.bubble.key, 'bubble.evening');
  assert.equal(view.bubble.params.count, 1);
});

test('a data error overlays a bubble only when no scene bubble exists, and clears on recovery', () => {
  const quiet = { tasks: [], schedules: [], settings: {} };
  const m = new SceneManager({ storage: memoryStorage() });
  const errored = m.update(input({ doc: quiet, error: 'boom' }), local(2026, 9, 30, 10, 0));
  assert.equal(errored.scene, 'schedule');
  assert.equal(errored.bubble.key, 'bubble.dataError');
  const recovered = m.update(input({ doc: quiet, error: null }), local(2026, 9, 30, 10, 1));
  assert.equal(recovered.bubble, null);
});
