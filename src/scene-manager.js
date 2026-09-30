/** Scene manager: the six-scene state machine (DESIGN §4).
 *
 * Priority: task-reminder > focus/break (pomodoro, session, overtime) >
 * evening > morning > schedule. Wall-clock time and a storage adapter are
 * injected; the only persisted state is client-local bookkeeping
 * (fired-reminder log, daily flags, continuous-focus anchor) — never the
 * tasks document itself (DESIGN §5).
 */
import { AGENDA_LIMIT, agendaItems, completedTodayCount, dayKey, dueReminders, eveningFloorMs, eveningTimeMs, FOCUS_OVERTIME_MS, hhmmOf, pomodoroSegment, todayCount, whenLabel } from './tasks-model.js';

export const SCENES = Object.freeze(['morning', 'task-reminder', 'focus', 'break', 'schedule', 'evening']);
/** Morning scene auto-degrades to standby after this long. */
export const MORNING_HOLD_MS = 30 * 60_000;
/** The reminder bubble shows once per reminder, for this window. */
export const REMINDER_BUBBLE_MS = 10_000;
/** The reminder pose holds this long, then the scene machine takes over again.
 * A reminder is a nudge, never a takeover: what keeps an un-acknowledged
 * reminder visible past this window is the badge, not a frozen scene. */
export const REMINDER_HOLD_MS = 60_000;
/** Bounce animation window after a reminder fires. */
export const REMINDER_BOUNCE_MS = 8_000;
/** Data-error bubble window per distinct error string. */
export const ERROR_BUBBLE_MS = 10_000;
/** A reminder that fires this long after its own time is reported as overdue
 * rather than as "it is 10:00 now" — which is what a catch-up nudge after a
 * restart, a sleep, or a long offline stretch always is. */
export const REMINDER_LATE_MS = 5 * 60_000;

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
    acknowledged: source.acknowledged && typeof source.acknowledged === 'object' ? source.acknowledged : {},
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
    /** Reminders that were due on the latest update; the click handler acks these. */
    this.lastDue = [];
  }

  /** The user looked at the pet: every reminder currently due stops nudging and
   * the machine returns to its companion scene. Bookkeeping stays client-local
   * (DESIGN §5), and the caller prunes it to still-due keys, so re-scheduling a
   * reminder lets it nudge again. */
  acknowledge(now = Date.now()) {
    let changed = false;
    for (const reminder of this.lastDue) {
      const key = reminderKey(reminder);
      if (!(key in this.state.acknowledged)) {
        this.state.acknowledged[key] = now;
        changed = true;
      }
    }
    if (changed) this.persist();
    return changed;
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

    // Fire due reminders once each (both logs are pruned to still-due entries:
    // resolved reminders leave them, re-scheduled ones may nudge again).
    const due = doc ? dueReminders(doc, now) : [];
    const live = {};
    const seen = {};
    for (const reminder of due) {
      const key = reminderKey(reminder);
      if (!(key in s.firedReminders)) s.firedReminders[key] = now;
      live[key] = s.firedReminders[key];
      if (key in s.acknowledged) seen[key] = s.acknowledged[key];
    }
    s.firedReminders = live;
    s.acknowledged = seen;
    this.lastDue = due;

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

    // Reminders are nudges, not a takeover: each one shows its own bubble and
    // holds the pose briefly, then the scene machine takes over again. Whatever
    // is still un-acknowledged rides the badge until the user looks at the pet.
    const unhandled = due.filter((reminder) => !(reminderKey(reminder) in s.acknowledged));
    let newest = null;
    const live = [];
    for (const reminder of unhandled) {
      const firedAt = s.firedReminders[reminderKey(reminder)] ?? now;
      if (newest === null || firedAt >= newest.firedAt) newest = { reminder, firedAt };
      if (now - firedAt < REMINDER_BUBBLE_MS) live.push({ reminder, firedAt });
    }

    if (newest !== null && now - newest.firedAt < REMINDER_HOLD_MS) {
      scene = 'task-reminder';
      // A restart, a sleep or a long offline stretch can make several reminders
      // due at once: report the batch instead of silently showing just one.
      if (live.length > 1) {
        bubble = { key: 'bubble.missed', params: { count: live.length } };
      } else if (live.length === 1) {
        const { reminder } = live[0];
        bubble =
          now - reminder.atMs > REMINDER_LATE_MS
            ? { key: 'bubble.reminderLate', params: { time: hhmmOf(reminder.atMs), task: reminder.title } }
            : { key: 'bubble.reminder', params: { time: hhmmOf(reminder.atMs), task: reminder.title } };
      }
    } else if (seg !== null && seg.phase === 'break') {
      scene = 'break';
      bubble = { key: 'bubble.break', params: {} };
      // The break counts down too: "how much rest is left" is the question the
      // ring answers, and it is the same question during either phase.
      countdown = { remainingMs: seg.remainingMs, totalMs: seg.breakMs, startedMs: seg.segmentStartMs };
    } else if (seg !== null && seg.phase === 'work') {
      scene = 'focus';
      countdown = { remainingMs: seg.remainingMs, totalMs: seg.workMs, startedMs: seg.segmentStartMs };
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

    // Interaction arbiter ①: an unhandled reminder always wins the click — and
    // that same click is the user looking at it, which clears the nudge. When a
    // batch came due together, the click offers the batch, not one of them.
    const batched = unhandled.filter((reminder) => now - (s.firedReminders[reminderKey(reminder)] ?? now) < REMINDER_HOLD_MS).length > 1;
    const reminder = newest !== null ? { taskId: newest.reminder.taskId, title: newest.reminder.title } : null;
    let prompt;
    if (reminder === null) prompt = { key: `prompt.${scene}`, params: {} };
    else if (batched) prompt = { key: 'prompt.missed', params: {} };
    else prompt = { key: 'prompt.reminder', params: { task: reminder.title } };

    // The badge is the agenda, not the reminder queue: however many things are
    // still ahead of the user is the number on the bird's head — it shrinks by
    // itself as their moments pass — and the widget turns the badge into the way
    // into that list.
    const pomodoro = doc?.settings?.pomodoro ?? null;
    const agenda = doc ? agendaItems(doc, now) : [];
    const items = agenda.slice(0, AGENDA_LIMIT).map((item) => ({ ...item, when: whenLabel(item.atMs) }));

    return {
      scene,
      bubble,
      badge: agenda.length > 0 ? agenda.length : null,
      items,
      itemTotal: agenda.length,
      // The settings panel edits these locally and hands the numbers to the agent.
      pomodoro: {
        workMin: Number.isFinite(pomodoro?.work_min) ? pomodoro.work_min : null,
        breakMin: Number.isFinite(pomodoro?.break_min) ? pomodoro.break_min : null,
        running: seg !== null,
      },
      bounce: newest !== null && now - newest.firedAt < REMINDER_BOUNCE_MS,
      countdown,
      prompt,
      reminder,
    };
  }
}
