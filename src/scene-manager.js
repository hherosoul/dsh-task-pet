/** Scene manager: the six-scene state machine (DESIGN §4).
 *
 * Priority: task-reminder > focus/break (pomodoro, session, overtime) >
 * evening > morning > schedule. Wall-clock time and a storage adapter are
 * injected; the only persisted state is client-local bookkeeping
 * (fired-reminder log, daily flags, continuous-focus anchor) — never the
 * tasks document itself (DESIGN §5).
 */
import { completedTodayCount, dayKey, dueReminders, eveningFloorMs, eveningTimeMs, FOCUS_OVERTIME_MS, hhmmOf, pomodoroSegment, todayCount } from './tasks-model.js';

export const SCENES = Object.freeze(['morning', 'task-reminder', 'focus', 'break', 'schedule', 'evening']);
/** Morning scene auto-degrades to standby after this long. */
export const MORNING_HOLD_MS = 30 * 60_000;
/** The reminder bubble shows once per reminder, for this window. */
export const REMINDER_BUBBLE_MS = 10_000;
/** Bounce animation window after a reminder fires. */
export const REMINDER_BOUNCE_MS = 8_000;
/** Data-error bubble window per distinct error string. */
export const ERROR_BUBBLE_MS = 10_000;

/** In-memory storage adapter for tests and the offline preview. */
export function memoryStorage() {
  const map = new Map();
  return {
    read(key) {
      return map.get(key);
    },
    write(key, value) {
      map.set(key, value);
    },
  };
}

const STATE_KEY = 'scene:v1';
const reminderKey = (reminder) => `${reminder.taskId}|${reminder.at}`;

function cleanState(stored) {
  const source = stored && typeof stored === 'object' ? stored : {};
  return {
    firedReminders: source.firedReminders && typeof source.firedReminders === 'object' ? source.firedReminders : {},
    morningDate: typeof source.morningDate === 'string' ? source.morningDate : null,
    morningUntil: Number.isFinite(source.morningUntil) ? source.morningUntil : 0,
    eveningDate: typeof source.eveningDate === 'string' ? source.eveningDate : null,
    lastTurnDate: typeof source.lastTurnDate === 'string' ? source.lastTurnDate : null,
    focusSince: Number.isFinite(source.focusSince) ? source.focusSince : null,
    errorShown: typeof source.errorShown === 'string' ? source.errorShown : null,
    errorAt: Number.isFinite(source.errorAt) ? source.errorAt : 0,
  };
}

export class SceneManager {
  constructor({ storage = memoryStorage() } = {}) {
    this.storage = storage;
    this.state = cleanState(storage.read(STATE_KEY));
  }

  persist() {
    try {
      this.storage.write(STATE_KEY, this.state);
    } catch {
      /* client-local bookkeeping only; never let persistence break the pet */
    }
  }

  /**
   * Advance the machine.
   * @param {object} input - { doc, error, sessionRunning, sessionPending, event }
   *   event: 'startup' | 'turn-start' | 'turn-end' | null (what caused this update)
   * @param {number} now - injected clock.
   */
  update(input, now = Date.now()) {
    const doc = input.doc ?? null;
    const today = dayKey(now);
    const s = this.state;

    // Morning planning: DSH startup / the day's first interaction, before evening.
    const eveningMs = eveningTimeMs(doc, now) ?? (() => {
      const d = new Date(now);
      d.setHours(18, 30, 0, 0);
      return d.getTime();
    })();
    if ((input.event === 'startup' || input.event === 'turn-start') && s.morningDate !== today && now < eveningMs) {
      s.morningDate = today;
      s.morningUntil = now + MORNING_HOLD_MS;
    }
    // The day's first completed turn means work has begun: degrade morning.
    if (input.event === 'turn-end' && s.morningDate === today) s.morningUntil = Math.min(s.morningUntil, now);
    if (input.event === 'turn-start') s.lastTurnDate = today;

    // Evening review: the configured time, or all sessions ended after 17:00.
    const running = input.sessionRunning === true;
    const pending = input.sessionPending === true;
    const quiet = s.lastTurnDate === today && !running && !pending;
    if (s.eveningDate !== today && (now >= eveningMs || (now >= eveningFloorMs(now) && quiet))) {
      s.eveningDate = today;
    }

    // Continuous-focus anchor drives the 50-minute overtime break; the
    // pomodoro drives its own rhythm and resets the anchor.
    const seg = doc ? pomodoroSegment(doc, now) : null;
    if (seg === null) {
      if (running && s.focusSince === null) s.focusSince = now;
      if (!running && s.focusSince !== null) s.focusSince = null;
    } else if (s.focusSince !== null) s.focusSince = null;

    // Fire due reminders once (log pruned to still-due entries: resolved
    // reminders leave the log, re-scheduled ones may fire again).
    const due = doc ? dueReminders(doc, now) : [];
    const live = {};
    for (const reminder of due) {
      const key = reminderKey(reminder);
      if (!(key in s.firedReminders)) s.firedReminders[key] = now;
      live[key] = s.firedReminders[key];
    }
    s.firedReminders = live;

    // Data-error bubble: once per distinct error, cleared on recovery.
    const error = typeof input.error === 'string' && input.error !== '' ? input.error : null;
    if (error && s.errorShown !== error) {
      s.errorShown = error;
      s.errorAt = now;
    } else if (!error && (s.errorShown !== null || s.errorAt !== 0)) {
      s.errorShown = null;
      s.errorAt = 0;
    }

    this.persist();
    return this.view({ doc, due, seg, running, pending, now });
  }

  /** Format the current view (pure w.r.t. the persisted state). */
  view({ doc, due, seg, running, pending, now }) {
    const s = this.state;
    let scene = 'schedule';
    let bubble = null;
    let countdown = null;

    if (due.length > 0) {
      scene = 'task-reminder';
      const earliest = due[0];
      const firedAt = s.firedReminders[reminderKey(earliest)] ?? now;
      if (now - firedAt < REMINDER_BUBBLE_MS) {
        bubble = { key: 'bubble.reminder', params: { time: hhmmOf(earliest.atMs), task: earliest.title } };
      }
    } else if (seg !== null && seg.phase === 'break') {
      scene = 'break';
      bubble = { key: 'bubble.break', params: {} };
    } else if (seg !== null && seg.phase === 'work') {
      scene = 'focus';
      countdown = { remainingMs: seg.remainingMs, totalMs: seg.workMs };
    } else if (running || pending) {
      const overtime = s.focusSince !== null && now - s.focusSince >= FOCUS_OVERTIME_MS;
      if (overtime) {
        scene = 'break';
        bubble = { key: 'bubble.break', params: {} };
      } else scene = 'focus';
    } else if (s.eveningDate === dayKey(now)) {
      scene = 'evening';
      const count = doc ? completedTodayCount(doc, now) : 0;
      bubble = { key: 'bubble.evening', params: { count } };
    } else if (s.morningDate === dayKey(now) && now < s.morningUntil) {
      scene = 'morning';
      const count = doc ? todayCount(doc, now) : 0;
      bubble = count > 0 ? { key: 'bubble.morning', params: { count } } : { key: 'bubble.morning.empty', params: {} };
    }

    // The data-error notice is an overlay: it never changes the scene, and the
    // machine keeps running on the last good snapshot. It yields to any live
    // scene bubble (a reminder outranks an ambient notice).
    if (bubble === null && s.errorShown !== null && now - s.errorAt < ERROR_BUBBLE_MS) {
      bubble = { key: 'bubble.dataError', params: {} };
    }

    // Interaction arbiter ①: a pending due reminder always wins the click.
    const reminder = due.length > 0 ? { taskId: due[0].taskId, title: due[0].title } : null;
    const prompt =
      reminder !== null
        ? { key: 'prompt.reminder', params: { task: reminder.title } }
        : { key: `prompt.${scene}`, params: {} };

    const firedAt = due.length > 0 ? s.firedReminders[reminderKey(due[0])] ?? now : 0;
    return {
      scene,
      bubble,
      badge: due.length > 0 ? due.length : null,
      bounce: due.length > 0 && now - firedAt < REMINDER_BOUNCE_MS,
      countdown,
      prompt,
      reminder,
    };
  }
}
