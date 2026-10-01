import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// The widget is a DOM component, but the panel's "one section at a time" rule is
// pure bookkeeping. Load the real class with its imports stripped and drive it
// against a hand-rolled panel: no browser, no stubbed copy of the logic.
const source = fs.readFileSync(path.join(root, 'src/widget.js'), 'utf8')
  .replace(/^import .*;$/gm, '')
  .replace(/^export /gm, '');
const TaskPetWidget = new Function(`${source}\nreturn TaskPetWidget;`)();
const proto = TaskPetWidget.prototype;

/** The panel surface the three actions touch: the pomodoro block (which knows its
 * own row), the shared confirmation strip, the title and the pet's outside world. */
function fakePanel() {
  const row = (name) => ({ name, insertAdjacentElement() {} });
  const rows = { pomodoroRow: row('pomodoro-row'), previewRow: row('preview-row'), guideRow: row('guide-row') };
  // Inherit the real methods, override only what talks to the browser.
  const pet = Object.assign(Object.create(proto), {
    translate: (key) => key,
    pomodoroBlock: { hidden: true, contains: (node) => node === rows.pomodoroRow },
    panelTitle: { textContent: 'panel.title' },
    panel: { hidden: false },
    panelConfirm: { hidden: true },
    panelBody: { append() {} },
    workInput: { value: '' },
    breakInput: { value: '' },
    view: { pomodoro: { workMin: 45, breakMin: 10 } },
    pendingPrompt: null,
    positioned: 0,
    ...rows,
  });
  pet.positionPanel = () => { pet.positioned += 1; };
  pet.syncPopover = () => {};
  pet.showPanelConfirm = function showPanelConfirm(visible) { this.panelConfirm.hidden = !visible; };
  pet.state = () => ({
    pomodoro: pet.pomodoroBlock.hidden === false,
    confirm: pet.panelConfirm.hidden === false,
    title: pet.panelTitle.textContent,
  });
  return pet;
}

test('the settings panel keeps exactly one section open', () => {
  const pet = fakePanel();
  const view = () => pet.state();

  // 番茄设置 opens the block and takes over the title.
  pet.togglePomodoro();
  assert.deepEqual(view(), { pomodoro: true, confirm: false, title: 'panel.title.pomodoro' });

  // 预览日程 replaces it instead of stacking under it (the reported bug).
  pet.askToFill('agenda.prompt', pet.previewRow);
  assert.deepEqual(view(), { pomodoro: false, confirm: true, title: 'panel.title' });

  // 使用教程 does the same, and reuses the single confirmation strip.
  pet.askToFill('guide.prompt', pet.guideRow);
  assert.deepEqual(view(), { pomodoro: false, confirm: true, title: 'panel.title' });

  // Opening the settings again dismisses the pending confirmation.
  pet.togglePomodoro();
  assert.deepEqual(view(), { pomodoro: true, confirm: false, title: 'panel.title.pomodoro' });

  // A confirmation asked for from inside the block keeps the block as context.
  pet.askToFill('pomodoro.fill.prompt', pet.pomodoroRow);
  assert.deepEqual(view(), { pomodoro: true, confirm: true, title: 'panel.title.pomodoro' });

  // Closing the panel leaves nothing behind for the next right-click.
  pet.closePanel(false);
  assert.deepEqual(view(), { pomodoro: false, confirm: false, title: 'panel.title' });
  assert.equal(pet.pendingPrompt, null);
});

test('the pomodoro action toggles its own block', () => {
  const pet = fakePanel();
  pet.togglePomodoro();
  pet.togglePomodoro();
  assert.deepEqual(pet.state(), { pomodoro: false, confirm: false, title: 'panel.title' });
  // Prefills from the document, never from an empty box.
  pet.togglePomodoro();
  assert.equal(pet.workInput.value, '45');
  assert.equal(pet.breakInput.value, '10');
  assert.ok(pet.positioned > 0, 'every section change must reposition the panel');
});
