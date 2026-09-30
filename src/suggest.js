/** Composer prompt injection (DESIGN §2/§4). The pet never auto-sends: it only
 * fills the DSH main input with the scene's prompt and the user presses Send.
 * This module owns the DSH client contract (conversation.input.for + setDraft),
 * with a clipboard fallback when the composer API is unavailable. */

/** The main session: the one retained by the primary viewport. */
export function selectedSessionId(snapshot) {
  return Object.values(snapshot?.byId || {}).find((row) => (row?.retainedBy?.mainView ?? 0) > 0)?.id;
}

/** Interaction arbiter ② (DESIGN §4): inject only when the composer is empty or
 * still holds the exact text we last injected. A non-empty, different draft is
 * the user's unsent edit — silently skip and never overwrite it. */
export function decideInjection(currentDraft, lastInjected) {
  const draft = typeof currentDraft === 'string' ? currentDraft : '';
  if (draft === '') return 'inject';
  if (draft === lastInjected) return 'inject';
  return 'skip';
}

/** Read the live draft text, tolerating either a plain object or a store. */
function readDraft(input) {
  try {
    const snapshot = input?.snapshot;
    const value = typeof snapshot === 'function' ? snapshot() : snapshot;
    return typeof value?.draft === 'string' ? value.draft : '';
  } catch {
    return '';
  }
}

/**
 * Build a suggester bound to the DSH client context.
 * Returns `suggest(text)` -> 'injected' | 'skipped' | 'clipboard'.
 * 'clipboard' means the composer path was unavailable (not injected, no main
 * session, or a thrown error) and the caller should copy to the clipboard.
 */
export function createSuggester(ctx) {
  let lastInjected = null;
  const sessions = ctx.sessions;
  const mainSessionId = () => {
    try {
      return selectedSessionId(sessions?.list?.getSnapshot?.());
    } catch {
      return undefined;
    }
  };

  return function suggest(text) {
    const sessionId = mainSessionId();
    if (!sessionId) return 'clipboard';
    try {
      const actx = sessions.scope(sessionId);
      const conversation = actx.get('conversation');
      const input = conversation.input.for(actx);
      const draft = readDraft(input);
      if (decideInjection(draft, lastInjected) === 'skip') return 'skipped';
      input.setDraft(text);
      lastInjected = text;
      if (typeof input.focus === 'function') input.focus();
      return 'injected';
    } catch {
      return 'clipboard';
    }
  };
}
