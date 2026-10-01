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

/** Whether a resolved moment falls on the local day of `nowMs`. */
export function isSameDay(ms, nowMs, DateCtor = Date) {
  return Number.isFinite(ms) && dayKey(ms, DateCtor) === dayKey(nowMs, DateCtor);
}

/** Whether an ISO timestamp falls on the local day of `nowMs`. */
export function isToday(iso, nowMs, DateCtor = Date) {
  return isSameDay(parseIso(iso), nowMs, DateCtor);
}

/** Whether an agenda entry is already over: a task's `due` or a schedule's `end`
 * has passed. Expired entries leave the badge and stop producing reminders — a
 * reminder that could only be delivered after the thing already happened is
 * noise, not help. Entries with no moment at all (an open todo) never expire. */
export function isExpired(entry, nowMs) {
  const moment = parseIso(entry?.end ?? entry?.due);
  return moment !== null && moment < nowMs;
}

/** Every pending task's remind_at entry that is due at or before `nowMs`,
 * earliest first. Each entry is its own reminder: a schedule carrying both
 * "24 hours before" and "1 hour before" nudges twice, independently. (Reporting
 * only the earliest entry per task, as an earlier revision did, silently
 * swallowed every later reminder.) Expired tasks are skipped entirely. */
export function dueReminders(doc, nowMs) {
  const due = [];
  for (const task of doc?.tasks ?? []) {
    if (task.status !== 'pending') continue;
    if (isExpired(task, nowMs)) continue;
    for (const at of task.remind_at ?? []) {
      const ms = parseIso(at);
      if (ms !== null && ms <= nowMs) due.push({ taskId: task.id, title: task.title, at, atMs: ms });
    }
  }
  return due.sort(
    (a, b) => a.atMs - b.atMs || String(a.taskId).localeCompare(String(b.taskId)) || String(a.at).localeCompare(String(b.at)),
  );
}

/**
 * The moment that puts an entry on the calendar: a task's `due`, else its next
 * reminder that is still ahead of us; a schedule's `start`. The agenda rows and
 * the morning count both go through here, so the number the pet says out loud can
 * never disagree with the list behind the badge.
 */
export function entryMoment(entry, kind, nowMs) {
  if (kind === 'schedule') return parseIso(entry?.start);
  const due = parseIso(entry?.due);
  if (due !== null) return due;
  return (entry?.remind_at ?? [])
    .map((at) => parseIso(at))
    .filter((ms) => ms !== null && ms >= nowMs)
    .sort((a, b) => a - b)[0] ?? null;
}

/**
 * {N} = what the agenda would still show for today (DESIGN §4): entries that are
 * not over yet and whose own moment (due / start / next reminder) falls on the
 * local today. An entry that already happened is gone from the list, so it must
 * not be counted either — and a reminder that lands today for something that
 * happens tomorrow belongs to tomorrow's row, not to today's tally.
 */
export function todayCount(doc, nowMs, DateCtor = Date) {
  const tasks = (doc?.tasks ?? []).filter((task) => task.status === 'pending'
    && !isExpired(task, nowMs)
    && isSameDay(entryMoment(task, 'task', nowMs), nowMs, DateCtor)).length;
  const schedules = (doc?.schedules ?? []).filter((item) => !isExpired(item, nowMs)
    && isSameDay(entryMoment(item, 'schedule', nowMs), nowMs, DateCtor)).length;
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

/** How many rows the widget renders at most; anything past this is a hard bound
 * on the DOM, while the window itself shows five rows and scrolls. */
export const AGENDA_LIMIT = 50;

/**
 * The outstanding agenda behind the badge: every pending task that is not yet
 * due plus every schedule that has not ended — "things still ahead of me", so
 * the number shrinks by itself as their moments pass. Each item carries the
 * moment that identifies it: a task's due time, else its next reminder; a
 * schedule's start. Timeless tasks sort last, alphabetically.
 */
export function agendaItems(doc, nowMs, DateCtor = Date) {
  const items = [];
  for (const task of doc?.tasks ?? []) {
    if (task.status !== 'pending') continue;
    if (isExpired(task, nowMs)) continue;
    items.push({ id: String(task.id), title: String(task.title), kind: 'task', atMs: entryMoment(task, 'task', nowMs) });
  }
  for (const entry of doc?.schedules ?? []) {
    if (isExpired(entry, nowMs)) continue;
    items.push({ id: String(entry.id), title: String(entry.title), kind: 'schedule', atMs: entryMoment(entry, 'schedule', nowMs) });
  }
  return items.sort((a, b) => {
    if (a.atMs === null && b.atMs === null) return a.title.localeCompare(b.title);
    if (a.atMs === null) return 1;
    if (b.atMs === null) return -1;
    return a.atMs - b.atMs;
  });
}

/** Local `M/D HH:mm` label for an agenda row: the list can span weeks, so the
 * date matters as much as the clock time. */
export function whenLabel(atMs, DateCtor = Date) {
  if (atMs === null || !Number.isFinite(atMs)) return '';
  const d = new DateCtor(atMs);
  return `${d.getMonth() + 1}/${d.getDate()} ${hhmmOf(atMs)}`;
}
