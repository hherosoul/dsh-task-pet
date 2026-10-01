import test from 'node:test';
import assert from 'node:assert/strict';
import { SceneManager, memoryStorage, SCENES, REMINDER_HOLD_MS } from '../src/scene-manager.js';
import { hhmmOf } from '../src/tasks-model.js';

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
  assert.equal(view.badge, 3); // the open agenda: t1, t2 and the 14:00 review
  assert.equal(view.prompt.key, 'prompt.schedule');
});

test('startup before evening holds the morning scene with a count', () => {
  const m = new SceneManager({ storage: memoryStorage() });
  const view = m.update(input({ event: 'startup' }), local(2026, 9, 30, 9, 0));
  assert.equal(view.scene, 'morning');
  assert.equal(view.bubble.key, 'bubble.morning');
  assert.equal(view.bubble.params.count, 3);
});

test('the morning greeting only opens while it is still morning', () => {
  const doc = { tasks: [{ id: 't', title: '写周报', status: 'pending', due: iso(local(2026, 9, 30, 18, 0)), remind_at: [] }], schedules: [], settings: {} };
  const early = new SceneManager({ storage: memoryStorage() });
  assert.equal(early.update(input({ doc, event: 'startup' }), local(2026, 9, 30, 8, 30)).scene, 'morning');
  // 10:40 is no longer a "good morning": the pet stays in its standby pose.
  const late = new SceneManager({ storage: memoryStorage() });
  const lateView = late.update(input({ doc, event: 'startup' }), local(2026, 9, 30, 10, 40));
  assert.equal(lateView.scene, 'schedule');
  assert.equal(lateView.bubble, null);
  // …and a window opened late in the morning never spills past the morning.
  const m = new SceneManager({ storage: memoryStorage() });
  assert.equal(m.update(input({ doc, event: 'startup' }), local(2026, 9, 30, 9, 50)).scene, 'morning');
  assert.equal(m.update(input({ doc }), local(2026, 9, 30, 10, 1)).scene, 'schedule');
});

test('a due reminder outranks everything and wins the click prompt', () => {
  const m = new SceneManager({ storage: memoryStorage() });
  const view = m.update(input({ event: 'startup' }), local(2026, 9, 30, 10, 5));
  assert.equal(view.scene, 'task-reminder');
  assert.equal(view.badge, 3); // the agenda count is independent of the nudge
  assert.equal(view.bounce, true);
  assert.equal(view.bubble.key, 'bubble.reminder');
  assert.equal(view.bubble.params.task, '提交周报');
  assert.equal(view.prompt.key, 'prompt.reminder');
  assert.equal(view.prompt.params.task, '提交周报');
});

test('a reminder is a nudge: the pose holds, then the companion scene returns', () => {
  const m = new SceneManager({ storage: memoryStorage() });
  const fire = local(2026, 9, 30, 10, 5);
  assert.equal(m.update(input(), fire).bubble.key, 'bubble.reminder');
  const holding = m.update(input(), fire + 15_000);
  assert.equal(holding.scene, 'task-reminder');
  assert.equal(holding.bubble, null);
  assert.equal(holding.badge, 3);
  assert.equal(holding.bounce, false);
  // Past the hold window the machine takes the scene back; the agenda stays.
  const settled = m.update(input(), fire + REMINDER_HOLD_MS + 1);
  assert.equal(settled.scene, 'schedule');
  assert.equal(settled.bubble, null);
  assert.equal(settled.badge, 3);
  assert.equal(settled.prompt.key, 'prompt.reminder');
});

test('looking at the pet stops a reminder from steering the click', () => {
  const m = new SceneManager({ storage: memoryStorage() });
  const fire = local(2026, 9, 30, 10, 5);
  m.update(input(), fire);
  const settled = m.update(input(), fire + REMINDER_HOLD_MS + 1);
  assert.equal(settled.scene, 'schedule');
  assert.equal(settled.prompt.key, 'prompt.reminder');
  assert.equal(m.acknowledge(fire + REMINDER_HOLD_MS + 2), true);
  const seen = m.update(input(), fire + REMINDER_HOLD_MS + 3);
  assert.equal(seen.reminder, null);
  assert.equal(seen.scene, 'schedule');
  assert.equal(seen.prompt.key, 'prompt.schedule');
  assert.equal(seen.badge, 3); // answering a nudge never removes an agenda item
  // Nothing is left to acknowledge on a second look.
  assert.equal(m.acknowledge(fire + REMINDER_HOLD_MS + 4), false);
});

test('a reminder that fires long after its time is reported as overdue', () => {
  const at = local(2026, 9, 30, 18, 0);
  const doc = { tasks: [{ id: 't1', title: '提交周报', status: 'pending', remind_at: [iso(at)] }], schedules: [], settings: {} };
  const m = new SceneManager({ storage: memoryStorage() });
  // Launching three hours later: a restart, a sleep, or a long offline stretch.
  const view = m.update(input({ doc }), at + 3 * 60 * 60_000);
  assert.equal(view.scene, 'task-reminder');
  assert.equal(view.bubble.key, 'bubble.reminderLate');
  assert.equal(view.bubble.params.time, hhmmOf(at));
});

test('reminders that came due together after a restart are reported as a batch', () => {
  const first = local(2026, 9, 30, 15, 0);
  const second = local(2026, 9, 30, 16, 0);
  const doc = {
    tasks: [
      { id: 't1', title: '提交周报', status: 'pending', remind_at: [iso(first)] },
      { id: 't2', title: '回复邮件', status: 'pending', remind_at: [iso(second)] },
    ],
    schedules: [],
    settings: {},
  };
  const m = new SceneManager({ storage: memoryStorage() });
  const view = m.update(input({ doc }), local(2026, 9, 30, 21, 0));
  assert.equal(view.scene, 'task-reminder');
  assert.equal(view.bubble.key, 'bubble.missed');
  assert.equal(view.bubble.params.count, 2);
  assert.equal(view.prompt.key, 'prompt.missed');
  assert.equal(view.badge, 2); // both are still on the agenda
});

test('the badge counts the open agenda, not just today and not just reminders', () => {
  const now = local(2026, 9, 30, 10, 0);
  const doc = {
    tasks: [
      { id: 'today', title: '今天的活', status: 'pending', due: iso(local(2026, 9, 30, 18, 0)), remind_at: [] },
      { id: 'later', title: '下周的活', status: 'pending', due: iso(local(2026, 10, 7, 9, 0)), remind_at: [] },
      { id: 'done', title: '做完了', status: 'completed', completed_at: iso(local(2026, 9, 30, 9, 0)), remind_at: [] },
    ],
    schedules: [
      { id: 'future', title: '下周评审', start: iso(local(2026, 10, 7, 14, 0)), end: iso(local(2026, 10, 7, 15, 0)) },
      { id: 'past', title: '昨天的会', start: iso(local(2026, 9, 29, 14, 0)), end: iso(local(2026, 9, 29, 15, 0)) },
    ],
    settings: {},
  };
  const view = new SceneManager({ storage: memoryStorage() }).update(input({ doc }), now);
  // Adding a schedule shows up right away; finished work and ended events drop off.
  assert.equal(view.badge, 3);
  assert.equal(view.itemTotal, 3);
  assert.deepEqual(view.items.map((item) => item.id), ['today', 'later', 'future']);
  assert.equal(view.items[0].when, '9/30 18:00'); // month, day and clock time
  assert.equal(view.items[1].when, '10/7 09:00');
  assert.equal(view.items[0].kind, 'task');
  assert.equal(view.items[2].kind, 'schedule');
});

test('each remind_at entry nudges on its own (24h before and 1h before)', () => {
  const event = local(2026, 10, 2, 10, 0);
  const dayBefore = event - 24 * 60 * 60_000;
  const hourBefore = event - 60 * 60_000;
  const doc = {
    tasks: [{ id: 'meeting', title: '产品评审会', status: 'pending', due: iso(event), remind_at: [iso(dayBefore), iso(hourBefore)] }],
    schedules: [],
    settings: {},
  };
  const m = new SceneManager({ storage: memoryStorage() });

  // The 24-hour heads-up.
  const early = m.update(input({ doc }), dayBefore + 1);
  assert.equal(early.scene, 'task-reminder');
  assert.equal(early.badge, 1); // the meeting is on the agenda
  assert.equal(early.bubble.params.time, hhmmOf(dayBefore));
  m.acknowledge(dayBefore + 2);
  const answered = m.update(input({ doc }), dayBefore + 3);
  assert.equal(answered.reminder, null); // the nudge is answered...
  assert.equal(answered.badge, 1); // ...but the meeting is still ahead of you

  // A day later the second entry has to nudge by itself; reporting only the
  // earliest due entry per task used to swallow this one entirely.
  const late = m.update(input({ doc }), hourBefore + 1);
  assert.equal(late.scene, 'task-reminder');
  assert.equal(late.badge, 1);
  assert.equal(late.reminder.title, '产品评审会');
  assert.equal(late.bubble.params.time, hhmmOf(hourBefore));
});

test('pomodoro work phase shows focus with a countdown', () => {
  const doc = { ...baseDoc(), settings: { evening_time: '18:30', pomodoro: { running_since: iso(local(2026, 9, 30, 9, 0)), work_min: 25, break_min: 5 } } };
  const m = new SceneManager({ storage: memoryStorage() });
  const view = m.update(input({ doc }), local(2026, 9, 30, 9, 5));
  assert.equal(view.scene, 'focus');
  assert.equal(view.bubble, null);
  assert.ok(view.countdown);
  assert.equal(view.countdown.remainingMs, 20 * 60_000);
  // The widget syncs its per-minute sweep bead to this, so it is part of the view.
  assert.equal(view.countdown.startedMs, local(2026, 9, 30, 9, 0));
  assert.equal(view.prompt.key, 'prompt.focus');
});

test('pomodoro break phase shows the break scene', () => {
  const doc = { ...baseDoc(), settings: { evening_time: '18:30', pomodoro: { running_since: iso(local(2026, 9, 30, 9, 0)), work_min: 25, break_min: 5 } } };
  const m = new SceneManager({ storage: memoryStorage() });
  const view = m.update(input({ doc }), local(2026, 9, 30, 9, 25));
  assert.equal(view.scene, 'break');
  assert.equal(view.bubble.key, 'bubble.break');
  // The break counts down as well: the ring answers "how much rest is left".
  assert.ok(view.countdown, 'the break must carry its own countdown');
  assert.equal(view.countdown.remainingMs, 5 * 60_000);
  assert.equal(view.countdown.totalMs, 5 * 60_000);
  assert.equal(view.countdown.startedMs, local(2026, 9, 30, 9, 25));
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
