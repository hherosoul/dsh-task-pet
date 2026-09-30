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
  constructor(host, { assets, css, language = 'en', storage, onView = () => {}, onSuggest = () => {} } = {}) {
    this.host = host;
    this.language = normalizeLanguage(language);
    this.originalLang = host.getAttribute('lang');
    this.onView = onView;
    this.onSuggest = onSuggest;
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
          <span class="badge" aria-hidden="true" hidden></span>
          <span class="countdown" aria-hidden="true" hidden>
            <svg viewBox="0 0 46 46" focusable="false">
              <circle class="countdown-track" cx="23" cy="23" r="${COUNTDOWN_R}"></circle>
              <circle class="countdown-fill" cx="23" cy="23" r="${COUNTDOWN_R}"></circle>
              <text class="countdown-text" x="23" y="23"></text>
            </svg>
          </span>
        </button>
      </div>
      <section class="panel" role="dialog" hidden>
        <div class="panel-head"><strong data-i18n="panel.title"></strong><button class="close" type="button" aria-label="close"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></div>
        <div class="setting"><label for="taskpet-size"><span data-i18n="panel.size"></span> <output class="size-value"></output></label><input id="taskpet-size" type="range" min="65" max="160" step="5" /></div>
        <div class="setting"><label for="taskpet-motion" data-i18n="panel.motion"></label><input id="taskpet-motion" type="checkbox" role="switch" /></div>
        <div class="panel-actions"><button class="action reset" type="button" data-i18n="panel.reset"></button><button class="action hide" type="button" data-i18n="panel.hide"></button></div>
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
    this.bubble = this.root.querySelector('.bubble');
    this.bubbleText = this.root.querySelector('.bubble-message');
    this.bubbleSurface = attachBubbleSurface(this.bubble, () => this.positionBubble());
    this.cleanups.push(() => this.bubbleSurface.dispose());
    this.panel = this.root.querySelector('.panel');
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
    this.listen(this.root.querySelector('.close'), 'click', () => this.closePanel());
    this.listen(this.root, 'keydown', (e) => {
      if (e.key !== 'Escape' || this.panel.hidden) return;
      e.preventDefault(); e.stopPropagation(); this.closePanel();
    });
    this.listen(document, 'pointerdown', (e) => {
      if (!this.panel.hidden && !e.composedPath().includes(host)) this.closePanel(false);
    });
    this.listen(this.range, 'input', () => {
      this.preferences.scale = Number(this.range.value) / 100; this.applyPreferences(); this.save();
    });
    this.listen(this.motion, 'change', () => {
      this.preferences.motion = this.motion.checked; this.applyPreferences(); this.save();
    });
    this.listen(this.root.querySelector('.reset'), 'click', () => {
      this.preferences.x = null; this.preferences.y = null; this.reposition(); this.save();
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
    this.paint();
    if (!this.panel.hidden) this.positionPanel();
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
    if (this.preferences.hidden) this.closePanel(false);
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
  positionPanel() {
    const size = 156 * this.preferences.scale;
    const width = this.panel.offsetWidth || Math.min(280, window.innerWidth - 24);
    const height = this.panel.offsetHeight || 240;
    const position = clampPosition(this.position.x + size / 2 - width / 2,
      this.position.y - height - 12, width, height, window.innerWidth, window.innerHeight);
    this.panel.style.left = `${position.x}px`; this.panel.style.top = `${position.y}px`;
  }
  openPanel() { this.panel.hidden = false; this.positionPanel(); this.root.querySelector('.close').focus(); }
  closePanel(focus = true) {
    this.panel.hidden = true;
    if (focus) this.button.focus();
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

    const countdown = view.countdown && view.countdown.remainingMs > 0 ? view.countdown : null;
    this.countdown.hidden = !countdown;
    if (countdown) {
      const fraction = Math.max(0, Math.min(1, countdown.remainingMs / countdown.totalMs));
      this.countdownFill.style.strokeDasharray = String(COUNTDOWN_C);
      this.countdownFill.style.strokeDashoffset = String(COUNTDOWN_C * (1 - fraction));
      this.countdownText.textContent = String(Math.max(1, Math.ceil(countdown.remainingMs / 60_000)));
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
