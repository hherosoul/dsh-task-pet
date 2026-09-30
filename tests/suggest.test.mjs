import test from 'node:test';
import assert from 'node:assert/strict';
import { decideInjection, selectedSessionId } from '../src/suggest.js';

test('decideInjection protects an unsent draft unless the action forces it', () => {
  assert.equal(decideInjection('', null), 'inject'); // empty composer: always fine
  assert.equal(decideInjection('看看今天的待办和日程', '看看今天的待办和日程'), 'inject'); // still ours
  assert.equal(decideInjection('我自己写了一半', '看看今天的待办和日程'), 'skip'); // the user's edit wins
  // The agenda's confirmed "详情" is the deliberate exception: it replaces the box.
  assert.equal(decideInjection('我自己写了一半', '看看今天的待办和日程', true), 'inject');
  assert.equal(decideInjection('我自己写了一半', null, true), 'inject');
});

test('selectedSessionId finds the session the primary viewport retained', () => {
  const snapshot = { byId: {
    a: { id: 'a', retainedBy: { mainView: 0 } },
    b: { id: 'b', retainedBy: { mainView: 1 } },
  } };
  assert.equal(selectedSessionId(snapshot), 'b');
  assert.equal(selectedSessionId({ byId: {} }), undefined);
  assert.equal(selectedSessionId(undefined), undefined);
});
