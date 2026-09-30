/** Session activity probe: merges the two complementary running sources —
 * the bridge's session.turn frames (every session in the app) and the
 * renderer's session status hooks (the live session list) — into the booleans
 * the scene machine needs. Pure: no clock, no storage. */
export class SessionsProbe {
  constructor() {
    this.frameRunning = new Set();
    this.hookRunning = 0;
    this.hookPending = 0;
  }

  /** Apply one bridge frame (only turn boundaries matter). */
  applyFrame(frame) {
    if (!frame || typeof frame !== 'object') return;
    if (frame.type === 'turn/start') this.frameRunning.add(frame.sessionId);
    else if (frame.type === 'turn/end') this.frameRunning.delete(frame.sessionId);
  }

  /** Apply the renderer's sessionStatus snapshot counts, when available. */
  applyStatus({ running = 0, pending = 0 } = {}) {
    this.hookRunning = Math.max(0, Math.floor(Number(running) || 0));
    this.hookPending = Math.max(0, Math.floor(Number(pending) || 0));
  }

  view() {
    return {
      running: this.frameRunning.size > 0 || this.hookRunning > 0,
      pending: this.hookPending > 0,
    };
  }
}
