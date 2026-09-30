/** Client-local preferences and shared storage helpers (whale-pet mechanism).
 * The tasks document NEVER lives here — only pet preferences and the scene
 * machine's bookkeeping do (DESIGN §5). */
export const STORAGE_KEY = 'dsh-task-pet:v1';

export const DEFAULTS = Object.freeze({ scale: 1, hidden: false, motion: true, x: null, y: null });

export function cleanPreferences(value) {
  const source = value && typeof value === 'object' ? value : {};
  const finite = (v) => typeof v === 'number' && Number.isFinite(v);
  return {
    scale: finite(source.scale) ? Math.min(1.6, Math.max(0.65, source.scale)) : 1,
    hidden: source.hidden === true,
    motion: source.motion !== false,
    x: finite(source.x) ? source.x : null,
    y: finite(source.y) ? source.y : null,
  };
}

/** JSON read/write adapter over Storage (localStorage in the app, a Map in tests). */
export function jsonStorage(backing) {
  return {
    read(key) {
      try {
        const raw = backing.getItem(key);
        return raw === null ? undefined : JSON.parse(raw);
      } catch {
        return undefined;
      }
    },
    write(key, value) {
      backing.setItem(key, JSON.stringify(value));
    },
  };
}

export function loadPreferences(backing) {
  let stored;
  try {
    stored = backing.read?.(STORAGE_KEY);
  } catch {
    stored = undefined;
  }
  return cleanPreferences(stored);
}

export function savePreferences(backing, prefs) {
  try {
    backing.write?.(STORAGE_KEY, prefs);
  } catch {
    /* preferences are best-effort; never block the pet on storage errors */
  }
}

/** Keep the pet fully on screen with a 12px margin and below the top chrome. */
export function clampPosition(x, y, width, height, viewportWidth, viewportHeight, top = 56) {
  const margin = 12;
  const maxX = Math.max(margin, viewportWidth - width - margin);
  const maxY = Math.max(margin, viewportHeight - height - margin);
  return {
    x: Math.min(maxX, Math.max(margin, x)),
    y: Math.min(maxY, Math.max(Math.min(top, maxY), y)),
  };
}
