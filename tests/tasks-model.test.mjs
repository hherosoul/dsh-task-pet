import test from 'node:test';
import assert from 'node:assert/strict';
import {
  dayKey, isToday, dueReminders, todayCount, completedTodayCount,
  eveningTimeMs, eveningFloorMs, hhmmOf, pomodoroSegment, FOCUS_OVERTIME_MS,
} from '../src/tasks-model.js';

const local = (y, mo, d, h, mi, s = 0) => new Date(y, mo - 1, d, h, mi, s, 0).getTime();
const iso = (ms) => new Date(ms).toISOString();

test('dayKey formats a local calendar day', () => {
  assert.equal(dayKey(local(2026, 9, 30, 9, 0)), '2026-09-30');
  assert.equal(dayKey(local(2026, 1, 5, 0, 0)), '2026-01-05');
});

test('isToday matches the local day and rejects non-ISO', () => {
  const now = local(2026, 9, 30, 12, 0);
  assert.equal(isToday(iso(local(2026, 9, 30, 8, 0)), now), true);
  assert.equal(isToday(iso(local(2026, 9, 29, 23, 59)), now), false);
  assert.equal(isToday('not-a-date', now), false);
});

test('dueReminders returns pending tasks with a remind_at <= now, earliest first', () => {
  const doc = { tasks: [
    { id: 't1', title: 'first', status: 'pending', remind_at: [iso(local(2026, 9, 30, 9, 0))] },
    { id: 't2', title: 'second', status: 'pending', remind_at: [iso(local(2026, 9, 30, 9, 30))] },
    { id: 't3', title: 'future', status: 'pending', remind_at: [iso(local(2026, 9, 30, 11, 0))] },
    { id: 't4', title: 'done', status: 'completed', remind_at: [iso(local(2026, 9, 30, 8, 0))] },
    { id: 't5', title: 'none', status: 'pending', remind_at: [] },
  ] };
  const due = dueReminders(doc, local(2026, 9, 30, 10, 0));
  assert.deepEqual(due.map((r) => r.taskId), ['t1', 't2']);
  assert.equal(due[0].title, 'first');
  assert.equal(due[0].atMs, local(2026, 9, 30, 9, 0));
});

test('todayCount counts pending tasks due/reminded today plus schedules today', () => {
  const now = local(2026, 9, 30, 10, 0);
  const doc = {
    tasks: [
      { id: 'a', title: 'due today', status: 'pending', due: iso(local(2026, 9, 30, 18, 0)), remind_at: [] },
      { id: 'b', title: 'remind today', status: 'pending', remind_at: [iso(local(2026, 9, 30, 9, 0))] },
      { id: 'c', title: 'due tomorrow', status: 'pending', due: iso(local(2026, 10, 1, 18, 0)), remind_at: [] },
      { id: 'd', title: 'done today', status: 'completed', due: iso(local(2026, 9, 30, 18, 0)), completed_at: iso(local(2026, 9, 30, 11, 0)), remind_at: [] },
    ],
    schedules: [
      { id: 's1', title: 'today', start: iso(local(2026, 9, 30, 14, 0)), end: iso(local(2026, 9, 30, 15, 0)) },
      { id: 's2', title: 'tomorrow', start: iso(local(2026, 10, 1, 14, 0)), end: iso(local(2026, 10, 1, 15, 0)) },
    ],
  };
  assert.equal(todayCount(doc, now), 3);
  assert.equal(completedTodayCount(doc, now), 1);
});

test('pomodoroSegment derives work/break phases and remaining time from running_since', () => {
  const start = local(2026, 9, 30, 9, 0);
  const doc = { settings: { pomodoro: { running_since: iso(start), work_min: 25, break_min: 5 } } };
  const work = pomodoroSegment(doc, local(2026, 9, 30, 9, 5));
  assert.equal(work.phase, 'work');
  assert.equal(work.remainingMs, 20 * 60_000);
  assert.equal(work.cycleIndex, 0);
  const brk = pomodoroSegment(doc, local(2026, 9, 30, 9, 25));
  assert.equal(brk.phase, 'break');
  assert.equal(brk.remainingMs, 5 * 60_000);
  // 31 min in -> second cycle, back to work.
  const next = pomodoroSegment(doc, local(2026, 9, 30, 9, 31));
  assert.equal(next.phase, 'work');
  assert.equal(next.cycleIndex, 1);
  assert.equal(next.remainingMs, 24 * 60_000);
  // Not running -> null.
  assert.equal(pomodoroSegment({ settings: { pomodoro: {} } }, local(2026, 9, 30, 9, 5)), null);
  assert.equal(pomodoroSegment({ settings: { pomodoro: { running_since: null } } }, local(2026, 9, 30, 9, 5)), null);
});

test('eveningTimeMs / eveningFloorMs / hhmmOf derive local wall-clock moments', () => {
  const now = local(2026, 9, 30, 10, 0);
  const e = new Date(eveningTimeMs({ settings: { evening_time: '18:30' } }, now));
  assert.equal(e.getHours(), 18);
  assert.equal(e.getMinutes(), 30);
  assert.equal(eveningTimeMs({ settings: {} }, now), null);
  const floor = new Date(eveningFloorMs(now));
  assert.equal(floor.getHours(), 17);
  assert.equal(floor.getMinutes(), 0);
  assert.equal(hhmmOf(local(2026, 9, 30, 9, 5)), '09:05');
});

test('FOCUS_OVERTIME_MS is 50 minutes', () => {
  assert.equal(FOCUS_OVERTIME_MS, 50 * 60_000);
});
