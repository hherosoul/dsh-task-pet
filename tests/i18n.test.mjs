import test from 'node:test';
import assert from 'node:assert/strict';
import { MESSAGES, normalizeLanguage, createTranslator, FALLBACK_LOCALE } from '../src/i18n.js';

test('normalizeLanguage maps any zh* locale to zh and everything else to en', () => {
  assert.equal(normalizeLanguage('zh-CN'), 'zh');
  assert.equal(normalizeLanguage('zh_CN'), 'zh');
  assert.equal(normalizeLanguage('zh'), 'zh');
  assert.equal(normalizeLanguage('en-US'), 'en');
  assert.equal(normalizeLanguage('ja-JP'), 'en');
  assert.equal(normalizeLanguage(undefined), 'en');
  assert.equal(FALLBACK_LOCALE, 'en');
});

test('zh and en tables carry identical keys', () => {
  assert.deepEqual(Object.keys(MESSAGES.zh).sort(), Object.keys(MESSAGES.en).sort());
});

test('createTranslator fills placeholders and falls back for unknown keys', () => {
  const t = createTranslator('zh');
  assert.equal(t('bubble.morning', { count: 3 }), '啾啾早安！今天有 3 件事');
  assert.equal(t('bubble.reminder', { time: '10:00', task: '提交周报' }), '啾！10:00了，该提交周报了');
  assert.equal(t('no.such.key'), 'no.such.key');
  // en translator falls back to en for a known key.
  assert.equal(createTranslator('en')('bubble.break'), 'Chirp… time for a glass of water');
});

test('every placeholder in every message is fillable', () => {
  for (const [locale, table] of Object.entries(MESSAGES)) {
    for (const [key, msg] of Object.entries(table)) {
      const placeholders = [...msg.matchAll(/\{(\w+)\}/g)].map((m) => m[1]);
      if (placeholders.length === 0) continue;
      const params = Object.fromEntries(placeholders.map((p) => [p, 'X']));
      const out = createTranslator(locale)(key, params);
      assert.equal(out.includes('{'), false, `${locale}.${key} left an unfilled placeholder`);
    }
  }
});
