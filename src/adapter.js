import { TaskPetWidget } from './widget.js';
import { normalizeLanguage } from './i18n.js';
import { SessionsProbe } from './sessions-probe.js';
import { SceneManager } from './scene-manager.js';
import { jsonStorage } from './state.js';
import { observeGlobalEvents } from './bridge-client.js';
import { createSuggester } from './suggest.js';

/** Only this file knows DSH's client contract. No private DOM/API routes. */
export function readDshLanguage(locale) {
  try { return normalizeLanguage(locale?.getSnapshot?.().active); } catch { return 'en'; }
}

export function observeDshLanguage(locale, onLanguage) {
  let alive = true, previous;
  const publish = () => {
    if (!alive) return;
    const next = readDshLanguage(locale);
    if (next !== previous) { previous = next; onLanguage(next); }
  };
  const unsubscribe = locale?.subscribe?.(publish) || (() => {});
  publish();
  return () => { if (!alive) return; alive = false; unsubscribe(); };
}

/** Count running/pending MAIN sessions (subagents are internal, never the pet's
 * "focus" signal) from the renderer's status map + session catalog. */
export function statusCounts(statuses, catalog) {
  let running = 0, pending = 0;
  for (const [id, status] of statuses instanceof Map ? statuses : []) {
    if (catalog?.byId?.[id]?.origin === 'subagent') continue;
    const isRunning = typeof status?.running === 'boolean' ? status.running : catalog?.byId?.[id]?.running === true;
    if (isRunning) running++;
    if (status?.pendingInteraction != null) pending++;
  }
  return { running, pending };
}

function getLocalStorage() {
  try { return window.localStorage; } catch { return null; }
}

/**
 * Wire the pure scene machine to the live DSH client: the bridge feeds the
 * tasks document (and session boundaries), the renderer's status hooks feed
 * running/pending, and a 1s ticker keeps reminder windows / the pomodoro
 * countdown fresh. Clicking the pet injects the scene prompt (clipboard
 * fallback with a transient bubble).
 */
export function connectTaskPetState(ctx, widget, getProjection, observeEvents = observeGlobalEvents) {
  const suggest = createSuggester(ctx);
  const probe = new SessionsProbe();
  const sceneManager = new SceneManager({ storage: jsonStorage(getLocalStorage() ?? { getItem: () => null, setItem: () => {} }) });
  let alive = true;
  let doc = null;
  let error = null;
  let clipboardNotice = null;
  let pendingEvent = 'startup';
  /** Whether the pending boundary came from a subagent (never the user's own turn). */
  let pendingInternal = false;
  /** Latest view handed to the widget; the click handler reads its reminder. */
  let currentView = null;
  /** How long a user-requested scene preview outranks the scene machine. */
  const PREVIEW_SCHEDULE_MS = 20_000;
  let previewUntil = 0;
  const now = () => Date.now();

  const publish = () => {
    if (!alive) return;
    const projection = getProjection() || {};
    probe.applyStatus(statusCounts(projection.statuses, projection.catalog));
    const { running, pending } = probe.view();
    const event = pendingEvent;
    const internal = pendingInternal;
    pendingEvent = null;
    pendingInternal = false;
    const view = sceneManager.update({ doc, error, sessionRunning: running, sessionPending: pending, event, internal }, now());
    if (clipboardNotice && now() < clipboardNotice.until && !view.bubble) {
      view.bubble = { key: 'bubble.clipboard', params: {} };
    }
    // An explicitly requested preview wins over the ambient scene, but never over
    // a live reminder nudge: that one is time-critical.
    if (now() < previewUntil && view.scene !== 'task-reminder') {
      view.scene = 'schedule';
      view.bubble = null;
      view.countdown = null;
      view.prompt = { key: 'prompt.schedule', params: {} };
    }
    currentView = view;
    widget.update(view);
  };

  const suggestText = (text, options = {}) => {
    // Clicking the pet while a reminder is unhandled is the user looking at it:
    // the nudge stops and the pet drops back to its companion scene, while the
    // reminder's prompt sits in the composer.
    const hadReminder = currentView?.reminder !== null && currentView?.reminder !== undefined;
    if (hadReminder) sceneManager.acknowledge(now());
    const result = suggest(text, options);
    if (result === 'clipboard') {
      try { navigator.clipboard?.writeText(text); } catch { /* best effort */ }
      clipboardNotice = { until: now() + 5000 };
    }
    if (hadReminder || result === 'clipboard') publish();
    // 'injected' and 'skipped' need no extra UI otherwise: the prompt is in the
    // composer (or the user's unsent edit was left untouched, per arbiter ②).
  };
  widget.onSuggest = suggestText;
  widget.onPreviewSchedule = () => {
    previewUntil = now() + PREVIEW_SCHEDULE_MS;
    publish();
  };
  // Opening the agenda is the user looking at the list: any reminder nudge it
  // answers stops steering the pet's click prompt.
  widget.onAgendaOpen = () => {
    if (sceneManager.acknowledge(now())) publish();
  };
  /**
   * Timer control is the one thing the pet writes itself — a narrow, user-initiated
   * update of settings.pomodoro only. If that call cannot be made (older host, HTTP
   * blocked), the click still lands as a prompt in the composer.
   */
  widget.onTogglePomodoro = (start, minutes = {}, fallback = '') => {
    const body = start === true
      ? { runningSince: new Date().toISOString(), workMin: minutes.workMin, breakMin: minutes.breakMin }
      : { runningSince: null };
    fetch('/task-pet/pomodoro', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-task-pet': '1' },
      body: JSON.stringify(body),
    }).then((response) => {
      if (!response.ok) throw new Error(String(response.status));
    }).catch(() => {
      if (fallback !== '') suggestText(fallback, { force: true });
    });
  };

  publish();

  let stopEvents = () => {};
  try {
    stopEvents = observeEvents(ctx, {
      onData(snapshot) {
        if (snapshot) { doc = snapshot.doc ?? null; error = snapshot.error ?? null; }
        publish();
      },
      onBoundary(event) {
        probe.applyFrame(event);
        pendingEvent = event.type;
        pendingInternal = event.isSubagent === true;
        publish();
      },
      onReset() { publish(); },
      onHealth() {},
    });
  } catch { /* without a bridge the pet still shows the schedule scene */ }

  const timer = setInterval(() => publish(), 1000);

  return {
    publish,
    dispose() {
      if (!alive) return;
      alive = false;
      clearInterval(timer);
      try { stopEvents(); } catch { /* already stopped */ }
    },
  };
}

/** Mount the framework-independent widget into DSH's shell overlay. */
export function createPlugin(require, assets, css) {
  const React = require('react');
  const h = React.createElement;
  // The applied client context, captured for the slot component below: the
  // component is instantiated long after apply() returns, so an apply() parameter
  // is not in scope there. Referencing it throws inside render and the error
  // boundary then renders nothing at all — no pet and no visible error.
  let ctx;

  function TaskPetRoot({ useSessions, useSessionStatus }) {
    const element = React.useRef(null);
    const controller = React.useRef(null);
    const latest = React.useRef({ catalog: null, statuses: null });
    const catalog = useSessions((snapshot) => snapshot);
    const statuses = useSessionStatus((map) => map);
    latest.current = { catalog, statuses };

    React.useEffect(() => {
      const instance = new TaskPetWidget(element.current, {
        assets, css,
        language: readDshLanguage(ctx.locale),
      });
      const connection = connectTaskPetState(ctx, instance, () => latest.current);
      controller.current = connection;
      let stopLanguage = () => {};
      try { stopLanguage = observeDshLanguage(ctx.locale, (lang) => instance.setLanguage(lang)); } catch { instance.setLanguage('en'); }
      return () => {
        stopLanguage();
        connection.dispose();
        if (controller.current === connection) controller.current = null;
        instance.dispose();
      };
    }, []);

    React.useEffect(() => { controller.current?.publish(); }, [catalog, statuses]);

    return h('div', { ref: element, 'data-task-pet': 'connected' });
  }

  class Boundary extends React.Component {
    constructor(props) { super(props); this.state = { failed: false }; }
    static getDerivedStateFromError() { return { failed: true }; }
    render() { return this.state.failed ? null : this.props.children; }
  }

  function PetRoot(props) {
    const supported = typeof props.useSessions === 'function' && typeof props.useSessionStatus === 'function';
    return h(Boundary, null, supported ? h(TaskPetRoot, props) : null);
  }

  return {
    inject: ['slots', 'sessions', 'connection', 'locale', 'remote'],
    apply(pluginCtx) {
      ctx = pluginCtx;
      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay', id: 'task-pet', order: 90,
      }, PetRoot));
    },
  };
}
