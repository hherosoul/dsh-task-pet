import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const widget = fs.readFileSync(path.join(root, 'src/widget.js'), 'utf8');
const template = widget.slice(widget.indexOf('template.innerHTML'), widget.indexOf('this.root.append(template'));

/** A root-scoped `querySelector('.x')` silently binds to the FIRST match in the
 * whole shadow tree. Two elements sharing a class therefore break the widget at
 * construction time (that is exactly how the tutorial panel once shipped dead:
 * the settings button was already `class="action guide"`). */
test('every root-scoped class query matches exactly one template element', () => {
  const names = [...widget.matchAll(/this\.root\.querySelector\('\.([a-z][a-z-]*)'\)/g)].map((m) => m[1]);
  assert.ok(names.length > 0, 'expected root-scoped class queries to exist');
  const tokens = [...template.matchAll(/class="([^"]*)"/g)]
    .flatMap((match) => match[1].split(/\s+/).filter(Boolean));
  for (const name of names) {
    const hits = tokens.filter((token) => token === name).length;
    assert.equal(hits, 1, `class .${name} must appear exactly once in the widget template, found ${hits}`);
  }
});

test('the widget template is balanced and carries the panel blocks', () => {
  assert.ok(template.includes('class="pomodoro"'), 'pomodoro settings block missing');
  assert.ok(template.includes('class="panel-confirm confirm"'), 'settings confirmation missing');
  assert.ok(template.includes('class="agenda-confirm confirm"'), 'agenda confirmation missing');
  assert.ok(!template.includes('guide-backdrop'), 'the floating tutorial layer must stay gone');
  for (const tag of ['section', 'ul', 'div']) {
    const open = (template.match(new RegExp(`<${tag}[\\s>]`, 'g')) ?? []).length;
    const close = (template.match(new RegExp(`</${tag}>`, 'g')) ?? []).length;
    assert.equal(open, close, `<${tag}> must be balanced in the widget template`);
  }
});

test('the countdown drain animation matches the ring circumference', () => {
  const css = fs.readFileSync(path.join(root, 'src/pet.css'), 'utf8');
  const widget = fs.readFileSync(path.join(root, 'src/widget.js'), 'utf8');
  const radius = Number(/const COUNTDOWN_R = (\d+)/.exec(widget)[1]);
  const literal = Number(/stroke-dashoffset:var\(--countdown-c,([\d.]+)\)/.exec(css)[1]);
  assert.equal(literal, Number((2 * Math.PI * radius).toFixed(3)), 'the drain keyframe must travel exactly one circumference');
});
