/** Pure derivations from a normalized tasks document. Wall-clock time is
 * injected so every function is deterministic under test. All "today"
 * arithmetic uses the user's LOCAL calendar day (the pet lives on screen). */

/** Local calendar day key, e.g. '2026-09-30'. */
export function dayKey(ms, DateCtor = Date) {
  const d = new DateCtor(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseIso(iso) {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
}

/** Whether an ISO timestamp falls on the local day of `nowMs`. */
export function isToday(iso, nowMs, DateCtor = Date) {
  const ms = parseIso(iso);
  return ms !== null && dayKey(ms, DateCtor) === dayKey(nowMs, DateCtor);
}

/** Pending tasks with at least one remind_at at or before `nowMs`, earliest
 * first. Each entry carries the earliest DUE time (the bubble anchor). */
export function dueReminders(doc, nowMs) {
  const due = [];
  for (const task of doc?.tasks ?? []) {
    if (task.status !== 'pending') continue;
    for (const at of task.remind_at ?? []) {
      const ms = parseIso(at);
      if (ms !== null && ms <= nowMs) {
        due.push({ taskId: task.id, title: task.title, at, atMs: ms });
        break;
      }
    }
  }
  return due.sort((a, b) => a.atMs - b.atMs || String(a.taskId).localeCompare(String(b.taskId)));
}

/** {N} = 今日待办 + 日程数 (DESIGN §4). A pending task counts when it is due
 * today or carries a reminder today; a schedule counts when it starts today. */
export function todayCount(doc, nowMs, DateCtor = Date) {
  const tasks = (doc?.tasks ?? []).filter(
    (task) => task.status === 'pending' && ((task.due && isToday(task.due, nowMs, DateCtor)) || (task.remind_at ?? []).some((at) => isToday(at, nowMs, DateCtor))),
  ).length;
  const schedules = (doc?.schedules ?? []).filter((item) => isToday(item.start, nowMs, DateCtor)).length;
  return tasks + schedules;
}

/** {K} = 今日完成数: tasks completed today by completed_at (local day). */
export function completedTodayCount(doc, nowMs, DateCtor = Date) {
  return (doc?.tasks ?? []).filter((task) => task.status === 'completed' && task.completed_at && isToday(task.completed_at, nowMs, DateCtor)).length;
}

/** Today's local wall-clock moment for settings.evening_time ("HH:mm"). */
export function eveningTimeMs(doc, nowMs) {
  const hhmm = /^(\d{2}):(\d{2})$/.exec(doc?.settings?.evening_time ?? '');
  if (!hhmm) return null;
  const d = new Date(nowMs);
  d.setHours(Number(hhmm[1]), Number(hhmm[2]), 0, 0);
  return d.getTime();
}

/** 17:00 local — the early-evening lower bound (DESIGN §4 scene 6). */
export function eveningFloorMs(nowMs) {
  const d = new Date(nowMs);
  d.setHours(17, 0, 0, 0);
  return d.getTime();
}

/** Local HH:mm for bubble rendering. */
export function hhmmOf(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Pomodoro segment math (client-side, self-driving; the agent only sets or
 * clears settings.pomodoro.running_since). Returns null when not running.
 * Negative elapsed (clock skew just after the write) clamps to work phase 0.
 */
export function pomodoroSegment(doc, nowMs) {
  const pom = doc?.settings?.pomodoro;
  const since = pom?.running_since ? parseIso(pom.running_since) : null;
  if (since === null) return null;
  const workMs = Math.max(1, Math.min(240, Math.floor(pom.work_min ?? 25))) * 60_000;
  const breakMs = Math.max(1, Math.min(240, Math.floor(pom.break_min ?? 10))) * 60_000;
  const cycleMs = workMs + breakMs;
  const elapsed = Math.max(0, nowMs - since);
  const cycleIndex = Math.floor(elapsed / cycleMs);
  const pos = elapsed - cycleIndex * cycleMs;
  const phase = pos < workMs ? 'work' : 'break';
  const segmentStartMs = since + cycleIndex * cycleMs + (phase === 'work' ? 0 : workMs);
  const remainingMs = phase === 'work' ? workMs - pos : cycleMs - pos;
  return { phase, cycleIndex, segmentStartMs, remainingMs, workMs, breakMs };
}

/** Continuous-focus overtime threshold (scene 4 second trigger). */
export const FOCUS_OVERTIME_MS = 50 * 60_000;
