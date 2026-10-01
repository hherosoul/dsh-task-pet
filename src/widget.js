import { STORAGE_KEY, cleanPreferences, clampPosition, jsonStorage, loadPreferences, savePreferences } from './state.js';
import { createTranslator, normalizeLanguage } from './i18n.js';
import { bubbleLayout } from './bubble-layout.js';
import { attachBubbleSurface } from './bubble-surface.js';

/** The three pre-scaled artwork widths (DESIGN §3). Display widths above the
 * largest tier fall back to the original PNG (the host serves it full-size). */
const TIERS = [48, 72, 128];

/** Pre-scaled artwork tiers. Each source PNG is decoded once and drawn to small
 * canvases at the three tiers; paint picks the smallest tier that covers the
 * rendered width (browser downscaling of a huge PNG is avoided). */
export class ArtworkCache {
  constructor() {
    this.map = new Map(); // source URL -> { image, tiers: Map(tier -> dataURL), ready }
  }
  _entry(source) {
    let entry = this.map.get(source);
    if (!entry) {
      entry = { image: new Image(), tiers: new Map(), ready: false };
      this.map.set(source, entry);
      entry.image.decoding = 'async';
      entry.image.onload = () => {
        if (!entry.image.naturalWidth) return;
        for (const tier of TIERS) entry.tiers.set(tier, drawScaled(entry.image, tier));
        entry.ready = true;
      };
      entry.image.src = source;
    }
    return entry;
  }
  /** Best-fit source for the given CSS width in pixels. */
  pick(source, widthPx) {
    const entry = this._entry(source);
    const tier = TIERS.find((t) => t >= widthPx);
    if (tier === undefined) return source;
    return entry.tiers.get(tier) ?? source;
  }
  /** Run `onReady` once the first decode has produced the tier set. */
  onReady(source, onReady) {
    const entry = this._entry(source);
    if (entry.ready) { onReady(); return; }
    const previous = entry.image.onload;
    entry.image.onload = () => { previous?.(); onReady(); };
  }
}

function drawScaled(img, width) {
  const height = Math.max(1, Math.round(width * (img.naturalHeight / img.naturalWidth)));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL('image/png');
}

const noStorage = { getItem: () => null, setItem: () => {} };
const COUNTDOWN_R = 20;
const COUNTDOWN_C = 2 * Math.PI * COUNTDOWN_R;

/** Framework-independent UI shared by the real plugin and the offline preview. */
export class TaskPetWidget {
  constructor(host, { assets, css, language = 'en', storage, onView = () => {}, onSuggest = () => {}, onPreviewSchedule = () => {}, onAgendaOpen = () => {}, onTogglePomodoro = () => {} } = {}) {
    this.host = host;
    this.language = normalizeLanguage(language);
    // A usable translator from the very first line: applyPreferences() runs
    // before setLanguage() and can already close the panel, which restores the
    // base title through this.translate.
    this.translate = createTranslator(this.language);
    this.originalLang = host.getAttribute('lang');
    this.onView = onView;
    this.onSuggest = onSuggest;
    this.onPreviewSchedule = onPreviewSchedule;
    this.onAgendaOpen = onAgendaOpen;
    this.onTogglePomodoro = onTogglePomodoro;
    this.assets = assets ?? {};
    this.cleanups = [];
    this.disposed = false;
    this.view = { scene: 'schedule', bubble: null, badge: null, bounce: false, countdown: null, prompt: { key: 'prompt.schedule', params: {} } };
    this.artwork = new ArtworkCache();
    if (storage === undefined) { try { storage = window.localStorage; } catch { storage = null; } }
    this.preferenceStore = jsonStorage(storage ?? noStorage);
    this.preferences = loadPreferences(this.preferenceStore);
    this.root = host.shadowRoot || host.attachShadow({ mode: 'open' });
    this.root.replaceChildren();
    const sheet = document.createElement('style');
    sheet.textContent = css;
    this.root.append(sheet);
    const template = document.createElement('template');
    template.innerHTML = `
      <div class="pet" data-scene="schedule">
        <div class="bubble" aria-hidden="true"><span class="bubble-message"></span></div><span class="ground"></span>
        <button type="button" class="pet-button" aria-label="Task companion" aria-keyshortcuts="Enter Space ArrowUp ArrowDown ArrowLeft ArrowRight">
          <span class="pet-art"><img class="pet-image" alt="" draggable="false" /></span>
          <span class="countdown" aria-hidden="true" hidden>
            <svg viewBox="0 0 46 46" focusable="false">
              <circle class="countdown-track" cx="23" cy="23" r="${COUNTDOWN_R}"></circle>
              <circle class="countdown-fill" cx="23" cy="23" r="${COUNTDOWN_R}"></circle>
              <text class="countdown-text" x="23" y="23"></text>
            </svg>
          </span>
        </button>
        <button type="button" class="badge" hidden></button>
        <button type="button" class="tomato" data-i18n-aria="tomato.aria"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path class="tomato-leaf" d="M12 7.1 8.7 3.4l3.5 1.1L14 1.8l1.8 2.7 3.5-1.1-3.3 3.7z"/><circle class="tomato-body" cx="12" cy="14.2" r="7.6"/><path class="tomato-shine" d="M8.3 12.4c.4-1.7 1.5-2.9 3.1-3.4"/></svg></button>
      </div>
      <section class="panel" role="dialog" hidden>
        <div class="panel-head"><strong class="panel-title" data-i18n="panel.title"></strong><button class="close" type="button" aria-label="close"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
        <div class="panel-body">
          <div class="setting"><label for="taskpet-size"><span data-i18n="panel.size"></span> <output class="size-value"></output></label><input id="taskpet-size" type="range" min="65" max="160" step="5" /></div>
          <div class="setting"><label for="taskpet-motion" data-i18n="panel.motion"></label><input id="taskpet-motion" type="checkbox" role="switch" /></div>
          <div class="panel-actions"><button class="action pomodoro-open" type="button" data-i18n="panel.pomodoro"></button><button class="action preview" type="button" data-i18n="panel.preview"></button></div>
          <div class="panel-actions"><button class="action guide-open" type="button" data-i18n="panel.guide"></button><button class="action hide" type="button" data-i18n="panel.hide"></button></div>
          <div class="pomodoro" hidden>
            <div class="setting"><label for="taskpet-work" data-i18n="pomodoro.work"></label><input id="taskpet-work" type="number" min="1" max="240" step="5" inputmode="numeric" /></div>
            <div class="setting"><label for="taskpet-break" data-i18n="pomodoro.break"></label><input id="taskpet-break" type="number" min="1" max="240" step="5" inputmode="numeric" /></div>
            <div class="panel-actions"><button class="action pomodoro-fill" type="button" data-i18n="pomodoro.fill"></button><button class="action pomodoro-start" type="button" data-i18n="pomodoro.start"></button><button class="action pomodoro-stop" type="button" data-i18n="pomodoro.stop" hidden></button></div>
          </div>
        </div>
        <div class="panel-confirm confirm" hidden>
          <p class="confirm-text" data-i18n="confirm.body"></p>
          <div class="confirm-actions"><button class="action cancel" type="button" data-i18n="confirm.cancel"></button><button class="action accept" type="button" data-i18n="confirm.accept"></button></div>
        </div>
      </section>
      <section class="agenda" role="dialog" data-i18n-aria="agenda.title" hidden>
        <div class="panel-head"><strong data-i18n="agenda.title"></strong><button class="close" type="button" aria-label="close"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
        <p class="agenda-section" data-i18n="agenda.upcoming"></p>
        <ul class="agenda-list"></ul>
        <p class="agenda-empty" data-i18n="agenda.empty" hidden></p>
        <p class="agenda-note" hidden></p>
        <div class="agenda-actions"><button class="action agenda-preview" type="button" data-i18n="agenda.preview"></button></div>
        <div class="agenda-confirm confirm" hidden>
          <p class="confirm-text" data-i18n="confirm.body"></p>
          <div class="confirm-actions"><button class="action cancel" type="button" data-i18n="confirm.cancel"></button><button class="action accept" type="button" data-i18n="confirm.accept"></button></div>
        </div>
      </section>
      <button class="restore" type="button" hidden data-i18n-aria="action.restore" data-i18n="action.restore"></button>`;
    this.root.append(template.content.cloneNode(true));
    this.pet = this.root.querySelector('.pet');
    this.button = this.root.querySelector('.pet-button');
    this.image = this.root.querySelector('.pet-image');
    this.badge = this.root.querySelector('.badge');
    this.countdown = this.root.querySelector('.countdown');
    this.countdownFill = this.root.querySelector('.countdown-fill');
    this.countdownText = this.root.querySelector('.countdown-text');
    /** Phase whose one-minute sweep is currently synced to the clock. */
    this.countdownPhase = null;
    this.bubble = this.root.querySelector('.bubble');
    this.bubbleText = this.root.querySelector('.bubble-message');
    this.bubbleSurface = attachBubbleSurface(this.bubble, () => this.positionBubble());
    this.cleanups.push(() => this.bubbleSurface.dispose());
    this.panel = this.root.querySelector('.panel');
    this.agenda = this.root.querySelector('.agenda');
    this.agendaList = this.root.querySelector('.agenda-list');
    this.agendaEmpty = this.root.querySelector('.agenda-empty');
    this.agendaNote = this.root.querySelector('.agenda-note');
    this.agendaActions = this.root.querySelector('.agenda-actions');
    this.agendaConfirm = this.root.querySelector('.agenda-confirm');
    this.panelBody = this.panel.querySelector('.panel-body');
    this.panelConfirm = this.panel.querySelector('.panel-confirm');
    this.pomodoroBlock = this.panel.querySelector('.pomodoro');
    this.workInput = this.panel.querySelector('#taskpet-work');
    this.breakInput = this.panel.querySelector('#taskpet-break');
    this.tomato = this.root.querySelector('.tomato');
    this.panelTitle = this.panel.querySelector('.panel-title');
    this.pomodoroRow = this.panel.querySelector('.pomodoro .panel-actions');
    this.previewRow = this.panel.querySelector('.preview').closest('.panel-actions');
    this.guideRow = this.panel.querySelector('.guide-open').closest('.panel-actions');
    this.pomodoroStart = this.panel.querySelector('.pomodoro-start');
    this.pomodoroStop = this.panel.querySelector('.pomodoro-stop');
    /** Prompt waiting behind the settings confirmation. */
    this.pendingPrompt = null;
    /** Signature of the rendered rows: paint() ticks every second and must not
     * rebuild the list (or steal focus) when nothing about it changed. */
    this.agendaSignature = null;
    this.restore = this.root.querySelector('.restore');
    this.range = this.root.querySelector('#taskpet-size');
    this.motion = this.root.querySelector('#taskpet-motion');

    this.listen(this.image, 'load', () => this.positionBubble());
    this.listen(this.button, 'pointerdown', (e) => this.pointerDown(e));
    this.listen(this.button, 'pointermove', (e) => this.pointerMove(e));
    this.listen(this.button, 'pointerup', (e) => this.pointerEnd(e));
    this.listen(this.button, 'pointercancel', (e) => this.pointerEnd(e, true));
    this.listen(this.button, 'lostpointercapture', () => { this.drag = null; delete this.pet.dataset.dragging; });
    this.listen(this.button, 'click', (e) => {
      if (this.suppressClick) { this.suppressClick = false; return; }
      if (e.detail === 0) this.openPanel();
      else this.suggest();
    });
    this.listen(this.button, 'contextmenu', (e) => { e.preventDefault(); this.openPanel(); });
    // The number on the bird's head is the way into the agenda list; the settings
    this.listen(this.badge, 'click', () => this.toggleAgenda());
    // One detail action for the whole window, behind a confirmation: it replaces
    // whatever the composer holds, so the user says so explicitly first.
    this.listen(this.agendaActions.querySelector('.agenda-preview'), 'click', () => this.confirmPreview(true));
    this.listen(this.agendaConfirm.querySelector('.cancel'), 'click', () => this.confirmPreview(false));
    this.listen(this.agendaConfirm.querySelector('.accept'), 'click', () => {
      this.onSuggest(this.translate('agenda.prompt'), { force: true });
      this.confirmPreview(false);
      this.closeAgenda(false);
    });
    this.listen(this.button, 'keydown', (e) => {
      const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      if (directions[e.key]) {
        e.preventDefault();
        const [dx, dy] = directions[e.key];
        const step = e.shiftKey ? 20 : 5;
        this.preferences.x = this.position.x + dx * step;
        this.preferences.y = this.position.y + dy * step;
        this.reposition(); this.save();
      }
    });
    this.listen(this.panel.querySelector('.close'), 'click', () => this.closePanel());
    this.listen(this.agenda.querySelector('.close'), 'click', () => this.closeAgenda(true));
    this.listen(this.root, 'keydown', (e) => {
      if (e.key !== 'Escape') return;
      const open = !this.panel.hidden || !this.agenda.hidden;
      if (!open) return;
      e.preventDefault(); e.stopPropagation();
      this.closePanel(false); this.closeAgenda(false); this.button.focus();
    });
    this.listen(document, 'pointerdown', (e) => {
      if (e.composedPath().includes(host)) return;
      this.closePanel(false); this.closeAgenda(false);
    });
    this.listen(this.range, 'input', () => {
      this.preferences.scale = Number(this.range.value) / 100; this.applyPreferences(); this.save();
    });
    this.listen(this.motion, 'change', () => {
      this.preferences.motion = this.motion.checked; this.applyPreferences(); this.save();
    });
    // Every panel action ends the same way: a confirmation, then the prompt in
    // the composer. The pet never writes your data, so intent travels as text.
    this.listen(this.panel.querySelector('.preview'), 'click', () => {
      this.onPreviewSchedule();
      this.askToFill(this.translate('agenda.prompt'), this.previewRow);
    });
    this.listen(this.panel.querySelector('.guide-open'), 'click', () => this.askToFill(this.translate('guide.prompt'), this.guideRow));
    this.listen(this.panel.querySelector('.pomodoro-open'), 'click', () => this.togglePomodoro());
    this.listen(this.panel.querySelector('.pomodoro-fill'), 'click', () => {
      this.askToFill(
        this.translate('pomodoro.fill.prompt', { work: this.readMinutes(this.workInput, 45), break: this.readMinutes(this.breakInput, 10) }),
        this.pomodoroRow,
      );
    });
    // Timer control is direct: the pet asks the host to write the run state, and
    // falls back to a prompt only when that call cannot be made.
    this.listen(this.panel.querySelector('.pomodoro-start'), 'click', () => this.startPomodoro());
    this.listen(this.panel.querySelector('.pomodoro-stop'), 'click', () => this.stopPomodoro());
    this.listen(this.tomato, 'click', () => {
      if (this.view.pomodoro?.running === true) this.stopPomodoro();
      else this.startPomodoro();
    });
    this.listen(this.panelConfirm.querySelector('.cancel'), 'click', () => this.showPanelConfirm(false));
    this.listen(this.panelConfirm.querySelector('.accept'), 'click', () => {
      const text = this.pendingPrompt;
      this.showPanelConfirm(false);
      this.pendingPrompt = null;
      this.closePanel(false);
      if (typeof text === 'string' && text !== '') this.onSuggest(text, { force: true });
    });
    this.listen(this.root.querySelector('.hide'), 'click', () => {
      this.preferences.hidden = true; this.closePanel(false); this.applyPreferences(); this.save(); this.restore.focus();
    });
    this.listen(this.restore, 'click', () => {
      this.preferences.hidden = false; this.applyPreferences(); this.save(); this.button.focus(); this.paint();
    });
    this.listen(window, 'resize', () => this.reposition());
    this.listen(window, 'storage', (e) => {
      if (e.key !== STORAGE_KEY && e.key !== null) return;
      let preferences;
      try { preferences = cleanPreferences(JSON.parse(e.newValue || 'null')); } catch { return; }
      this.preferences = preferences; this.applyPreferences(); this.paint();
    });
    this.applyPreferences(); this.setLanguage(this.language);
    // Position the bubble once the first scene's tiers are decoded (natural size known).
    this.artwork.onReady(this.assets[this.view.scene], () => { if (!this.disposed) this.positionBubble(); });
  }
  setLanguage(language) {
    if (this.disposed) return;
    this.language = normalizeLanguage(language);
    this.translate = createTranslator(this.language);
    this.host.setAttribute('lang', this.language);
    for (const element of this.root.querySelectorAll('[data-i18n]')) {
      element.textContent = this.translate(element.dataset.i18n);
    }
    for (const element of this.root.querySelectorAll('[data-i18n-aria]')) {
      element.setAttribute('aria-label', this.translate(element.dataset.i18nAria));
    }
    this.agendaSignature = null; // rows are built in JS, so they need the new table
    this.paint();
    if (!this.panel.hidden) this.positionPanel();
    if (!this.agenda.hidden) this.positionAgenda();
  }
  listen(target, event, callback, options) {
    target.addEventListener(event, callback, options);
    this.cleanups.push(() => target.removeEventListener(event, callback, options));
  }
  save() { savePreferences(this.preferenceStore, this.preferences); }
  applyPreferences() {
    this.range.value = String(Math.round(this.preferences.scale * 100));
    this.root.querySelector('.size-value').textContent = `${this.range.value}%`;
    this.range.setAttribute('aria-valuetext', `${this.range.value}%`);
    this.range.style.setProperty('--range-progress', `${(Number(this.range.value) - Number(this.range.min)) / (Number(this.range.max) - Number(this.range.min)) * 100}%`);
    this.motion.checked = this.preferences.motion;
    this.host.dataset.motion = String(this.preferences.motion);
    this.host.dataset.paused = String(this.preferences.hidden);
    this.pet.hidden = this.preferences.hidden; this.restore.hidden = !this.preferences.hidden;
    if (this.preferences.hidden) { this.closePanel(false); this.closeAgenda(false); }
    this.reposition();
  }
  suggest() {
    const prompt = this.view?.prompt ?? { key: 'prompt.schedule', params: {} };
    const text = this.translate(prompt.key, prompt.params);
    this.onSuggest(text);
  }
  reposition() {
    const size = 156 * this.preferences.scale;
    this.pet.style.width = `${size}px`; this.pet.style.height = `${size}px`;
    const top = Math.max(56, parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dsh-frame-top-clearance')) || 0);
    this.position = clampPosition(this.preferences.x ?? window.innerWidth - size - 24,
      this.preferences.y ?? window.innerHeight - size - 90, size, size, window.innerWidth, window.innerHeight, top);
    this.pet.style.left = `${this.position.x}px`; this.pet.style.top = `${this.position.y}px`;
    this.positionBubble();
    if (!this.panel.hidden) this.positionPanel();
    if (!this.agenda.hidden) this.positionAgenda();
  }
  positionBubble() {
    if (this.disposed || !this.position || this.preferences.hidden || this.bubble.hidden) return;
    this.bubbleSurface.update();
    const size = 156 * this.preferences.scale;
    const button = getComputedStyle(this.button);
    const bottomInset = parseFloat(button.paddingBottom) || 0;
    const artWidth = size - (parseFloat(button.paddingLeft) || 0) - (parseFloat(button.paddingRight) || 0);
    const availableHeight = size - (parseFloat(button.paddingTop) || 0) - bottomInset;
    const ratio = this.image.naturalWidth > 0 && this.image.naturalHeight > 0 ? this.image.naturalWidth / this.image.naturalHeight : 1;
    const layout = bubbleLayout({
      x: this.position.x, y: this.position.y, size,
      width: this.bubble.offsetWidth, height: this.bubble.offsetHeight,
      visibleHeight: Math.min(availableHeight, artWidth / ratio), bottomInset,
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight,
      topClearance: Math.max(56, parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dsh-frame-top-clearance')) || 0),
    });
    this.bubble.style.left = `${layout.left - this.position.x}px`;
    this.bubble.style.top = `${layout.top - this.position.y}px`;
    this.bubble.style.bottom = 'auto';
    this.bubble.style.setProperty('--tail-x', `${layout.tailX}px`);
    this.bubble.dataset.side = layout.side;
  }
  /** Place a popover above the pet, clamped to the viewport. */
  positionPopover(element) {
    const size = 156 * this.preferences.scale;
    const width = element.offsetWidth || Math.min(280, window.innerWidth - 24);
    const height = element.offsetHeight || 240;
    const position = clampPosition(this.position.x + size / 2 - width / 2,
      this.position.y - height - 12, width, height, window.innerWidth, window.innerHeight);
    element.style.left = `${position.x}px`; element.style.top = `${position.y}px`;
  }
  positionPanel() { this.positionPopover(this.panel); }
  positionAgenda() { this.positionPopover(this.agenda); }
  /** The bubble shares the space above the pet with the popovers. */
  syncPopover() {
    if (this.panel.hidden && this.agenda.hidden) delete this.pet.dataset.popover;
    else this.pet.dataset.popover = 'true';
  }
  openPanel() {
    this.closeAgenda(false);
    this.panel.hidden = false;
    this.positionPanel();
    this.syncPopover();
    this.panel.querySelector('.close').focus();
  }
  closePanel(focus = true) {
    this.panel.hidden = true;
    // Reopening always starts from the base menu: the pomodoro settings and a
    // pending confirmation belong to this visit, they are not sticky state.
    this.panelConfirm.hidden = true;
    this.pendingPrompt = null;
    this.setPomodoroOpen(false);
    this.syncPopover();
    if (focus) this.button.focus();
  }
  /** The pomodoro block is one section of the panel, never a mode: showing or
   * hiding it also owns the panel title. */
  setPomodoroOpen(visible) {
    this.pomodoroBlock.hidden = !visible;
    this.panelTitle.textContent = this.translate(visible ? 'panel.title.pomodoro' : 'panel.title');
  }
  /** Pomodoro settings live behind their own action; opening prefills the inputs
   * from the document rather than from every repaint, so typing is never eaten. */
  togglePomodoro() {
    const open = this.pomodoroBlock.hidden;
    // One section at a time: the settings dismiss a pending confirmation instead
    // of stacking above it.
    this.showPanelConfirm(false);
    this.pendingPrompt = null;
    this.setPomodoroOpen(open);
    if (!open) {
      this.positionPanel();
      return;
    }
    const pomodoro = this.view.pomodoro ?? {};
    // The document always carries the contract defaults (25 / 10); fall back anyway.
    this.workInput.value = String(Number.isFinite(pomodoro.workMin) ? pomodoro.workMin : 25);
    this.breakInput.value = String(Number.isFinite(pomodoro.breakMin) ? pomodoro.breakMin : 10);
    this.positionPanel();
  }
  /** Minutes from a number input, clamped to the contract's 1..240. An empty or
   * unusable box falls back to the pet default, never to zero. */
  readMinutes(input, fallback) {
    const raw = String(input?.value ?? '').trim();
    const value = raw === '' ? Number.NaN : Math.trunc(Number(raw));
    return Number.isFinite(value) ? Math.min(240, Math.max(1, value)) : fallback;
  }
  /** Ask before filling, right under the action that asked: nothing jumps away,
   * so it stays obvious which setting is being confirmed. */
  askToFill(text, anchor = null) {
    // One section at a time: a confirmation asked for from the base menu puts the
    // pomodoro settings away, while one asked for from inside the pomodoro block
    // keeps that block open as its own context.
    if (!anchor || !this.pomodoroBlock.contains(anchor)) this.setPomodoroOpen(false);
    this.pendingPrompt = text;
    if (anchor !== null && anchor !== undefined) anchor.insertAdjacentElement('afterend', this.panelConfirm);
    else this.panelBody.append(this.panelConfirm);
    this.showPanelConfirm(true);
  }
  showPanelConfirm(visible) {
    this.panelConfirm.hidden = !visible;
    if (visible) this.panelConfirm.querySelector('.accept').focus();
    this.positionPanel();
  }
  /** Start (or restart) the timer. The visible settings block carries the minutes
   * the user just typed — those win over the document, so setting the time in the
   * panel and pressing start actually applies it. The quick toggle (tomato button,
   * block hidden) runs on the document's configured minutes. */
  startPomodoro() {
    const pomodoro = this.view.pomodoro ?? {};
    const docWork = Number.isFinite(pomodoro.workMin) ? pomodoro.workMin : null;
    const docBreak = Number.isFinite(pomodoro.breakMin) ? pomodoro.breakMin : null;
    const work = this.pomodoroBlock.hidden
      ? (docWork ?? this.readMinutes(this.workInput, 45))
      : this.readMinutes(this.workInput, docWork ?? 45);
    const rest = this.pomodoroBlock.hidden
      ? (docBreak ?? this.readMinutes(this.breakInput, 10))
      : this.readMinutes(this.breakInput, docBreak ?? 10);
    this.onTogglePomodoro(true, { workMin: work, breakMin: rest }, this.translate('pomodoro.quick.prompt', { work, break: rest }));
  }
  stopPomodoro() {
    this.onTogglePomodoro(false, {}, this.translate('pomodoro.stop.prompt'));
  }
  /** The badge toggles the agenda list; only one popover is ever open. */
  toggleAgenda() {
    if (this.agenda.hidden) this.openAgenda();
    else this.closeAgenda(true);
  }
  /** Open the list and focus its close button (keyboard users need a landing
   * spot inside the freshly opened dialog). */
  openAgenda() {
    this.closePanel(false);
    this.confirmPreview(false);
    this.agenda.hidden = false;
    this.positionAgenda();
    this.syncPopover();
    this.onAgendaOpen();
    this.agenda.querySelector('.close').focus();
  }
  closeAgenda(focus = true) {
    if (this.agenda.hidden) return;
    this.agenda.hidden = true;
    this.syncPopover();
    if (focus) this.button.focus();
  }
  /** Show or hide the "this replaces the composer" confirmation strip. */
  confirmPreview(visible) {
    this.agendaActions.hidden = visible;
    this.agendaConfirm.hidden = !visible;
    if (visible) this.agendaConfirm.querySelector('.accept').focus();
  }
  /** One row: time, title, kind. There is no per-row action — see confirmPreview. */
  buildRow(item) {
    const row = document.createElement('li');
    row.className = 'agenda-item';
    const when = document.createElement('span');
    when.className = 'agenda-when';
    when.textContent = item.when;
    const title = document.createElement('span');
    title.className = 'agenda-title';
    title.textContent = item.title; // document data: text, never markup
    title.title = item.title;
    const kind = document.createElement('span');
    kind.className = 'agenda-kind';
    kind.textContent = this.translate(item.kind === 'schedule' ? 'agenda.kind.schedule' : 'agenda.kind.task');
    row.append(when, title, kind);
    return row;
  }
  /** Rebuild the list only when its content actually changed. */
  renderAgenda(items, total) {
    const key = (item) => `${item.id}\u0000${item.kind}\u0000${item.when}\u0000${item.title}`;
    const signature = `${this.language}\u0001${items.map(key).join('\u0002')}`;
    if (signature === this.agendaSignature) return;
    this.agendaSignature = signature;
    this.agendaList.replaceChildren(...items.map((item) => this.buildRow(item)));
    this.agendaEmpty.hidden = items.length > 0;
    const unlisted = Math.max(0, total - items.length);
    this.agendaNote.textContent = unlisted > 0 ? this.translate('agenda.more', { count: unlisted }) : '';
    this.agendaNote.hidden = unlisted === 0;
  }
  pointerDown(e) {
    if (e.button !== 0 || !e.isPrimary) return;
    this.suppressClick = false;
    this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, originX: this.position.x, originY: this.position.y, moved: false };
    this.button.setPointerCapture(e.pointerId);
  }
  pointerMove(e) {
    if (!this.drag || this.drag.id !== e.pointerId) return;
    const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
    if (Math.hypot(dx, dy) > 4) this.drag.moved = true;
    if (!this.drag.moved) return;
    this.pet.dataset.dragging = 'true';
    this.preferences.x = this.drag.originX + dx; this.preferences.y = this.drag.originY + dy;
    this.reposition();
  }
  pointerEnd(e, cancelled = false) {
    if (!this.drag || this.drag.id !== e.pointerId) return;
    this.suppressClick = this.drag.moved || cancelled;
    if (this.drag.moved) {
      this.preferences.x = this.position.x; this.preferences.y = this.position.y; this.save();
    }
    this.drag = null; delete this.pet.dataset.dragging;
    if (this.button.hasPointerCapture(e.pointerId)) this.button.releasePointerCapture(e.pointerId);
  }
  update(view) {
    if (this.disposed) return;
    this.view = view ?? this.view;
    this.paint();
  }
  paint() {
    if (this.disposed) return;
    const view = this.view;
    const scene = view.scene ?? 'schedule';
    const source = this.assets[scene];
    if (this.pet.dataset.scene !== scene) this.pet.dataset.scene = scene;
    if (source && this.image.dataset.scene !== scene) {
      this.image.dataset.scene = scene;
      // Pick the tier matching the rendered art width (× device pixel ratio).
      const artWidth = (156 * this.preferences.scale) - 18;
      const target = artWidth * (window.devicePixelRatio || 1);
      this.image.src = this.artwork.pick(source, target);
    }
    const hasBubble = Boolean(view.bubble);
    this.bubble.hidden = !hasBubble;
    if (hasBubble) this.bubbleText.textContent = this.translate(view.bubble.key, view.bubble.params);
    else this.bubbleText.textContent = '';
    this.pet.dataset.notice = String(hasBubble);
    this.pet.dataset.bounce = String(Boolean(view.bounce && scene === 'task-reminder'));

    const badge = Number.isFinite(view.badge) && view.badge > 0 ? view.badge : 0;
    this.badge.hidden = badge === 0;
    if (badge > 0) this.badge.textContent = badge > 99 ? '99+' : String(badge);
    this.renderAgenda(view.items ?? [], Number.isFinite(view.itemTotal) ? view.itemTotal : (view.items ?? []).length);
    const running = view.pomodoro?.running === true;
    this.pomodoroStart.hidden = running;
    this.pomodoroStop.hidden = !running;
    if (this.pet.dataset.pomodoro !== String(running)) this.pet.dataset.pomodoro = String(running);
    this.tomato.setAttribute('aria-pressed', String(running));

    const countdown = view.countdown && view.countdown.remainingMs > 0 ? view.countdown : null;
    this.countdown.hidden = !countdown;
    if (countdown) {
      // The ring is a one-minute sweep: full at :00, eaten clockwise from twelve
      // o'clock, empty as it comes back round, then full again. A 45-minute arc
      // moved ~1/2700 per second and simply read as frozen; the minute sweep is
      // what makes progress visible, while the label keeps carrying the real
      // remaining minutes. CSS drives it per frame; the inline offset below is the
      // one-second fallback used when animations are switched off.
      const phase = Number.isFinite(countdown.startedMs) ? countdown.startedMs : null;
      const elapsed = phase === null ? 0 : Math.max(0, (Date.now() - phase) / 1000);
      const second = elapsed % 60;
      this.countdownFill.style.strokeDasharray = String(COUNTDOWN_C);
      this.countdownFill.style.setProperty('--countdown-c', String(COUNTDOWN_C));
      this.countdownFill.style.strokeDashoffset = String((COUNTDOWN_C * second) / 60);
      this.countdownText.textContent = String(Math.max(1, Math.ceil(countdown.remainingMs / 60_000)));
      if (phase !== this.countdownPhase) {
        this.countdownPhase = phase;
        this.countdownFill.style.animationDelay = `-${second}s`;
      }
    } else {
      this.countdownPhase = null;
    }

    const minutes = countdown ? Math.ceil(countdown.remainingMs / 60_000) : 0;
    this.button.setAttribute('aria-label', this.translate('aria.pet'));
    this.badge.setAttribute('aria-label', badge > 0 ? this.translate('aria.badge', { count: badge }) : '');
    this.countdown.setAttribute('aria-label', countdown ? this.translate('aria.countdown', { minutes }) : '');
    this.positionBubble();
    this.onView(view);
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const cleanup of this.cleanups.splice(0).reverse()) cleanup();
    this.root.replaceChildren();
    delete this.host.dataset.paused; delete this.host.dataset.motion;
    if (this.originalLang === null) this.host.removeAttribute('lang');
    else this.host.setAttribute('lang', this.originalLang);
  }
}
