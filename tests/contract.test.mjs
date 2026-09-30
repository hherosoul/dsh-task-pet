import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as z from 'zod';
import * as remote from '../lib/remote.js';
import { TASKS_DOCUMENT_SCHEMA } from '../tools/bridge-contract-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('remote.js exports the full contract surface', () => {
  for (const name of ['TASKS_DOCUMENT_SCHEMA', 'TASKPET_DATA_SCHEMA', 'TASKPET_FRAME_SCHEMA', 'TASKPET_WATCH_DESCRIPTOR', 'TASKPET_GETDATA_DESCRIPTOR', 'TYPERT_REMOTE', 'parseTasksDocument', 'emptyTasksDocument', 'ISO_PATTERN']) {
    assert.ok(name in remote, `missing export ${name}`);
  }
});

test('parseTasksDocument defaults omitted fields and strips unknown keys', () => {
  const doc = remote.parseTasksDocument({ tasks: [{ id: 'a', title: 'x' }] });
  assert.equal(doc.tasks[0].status, 'pending');
  assert.deepEqual(doc.tasks[0].remind_at, []);
  assert.equal(doc.settings.pet_name, '知知');
  assert.equal(doc.settings.evening_time, '18:30');
  assert.equal(doc.settings.pomodoro.running_since, null);
  const stripped = remote.parseTasksDocument({ tasks: [{ id: 'a', title: 'x', bogus: 1 }] });
  assert.equal('bogus' in stripped.tasks[0], false);
});

test('emptyTasksDocument is a valid default document', () => {
  const doc = remote.emptyTasksDocument();
  assert.deepEqual(doc.tasks, []);
  assert.deepEqual(doc.schedules, []);
});

test('TASKPET_FRAME_SCHEMA parses baseline/data frames and rejects malformed boundaries', () => {
  const baseline = { type: 'baseline', hostEpoch: 'e', streamSeq: 0, identities: [], data: { mtime: 0, doc: remote.emptyTasksDocument(), error: null } };
  assert.equal(remote.TASKPET_FRAME_SCHEMA.parse(baseline).type, 'baseline');
  const data = { type: 'data', hostEpoch: 'e', streamSeq: 1, data: { mtime: 0, doc: remote.emptyTasksDocument(), error: null } };
  assert.equal(remote.TASKPET_FRAME_SCHEMA.parse(data).type, 'data');
  assert.throws(() => remote.TASKPET_FRAME_SCHEMA.parse({ type: 'turn/end', hostEpoch: 'e', streamSeq: 1, sessionId: 's', seq: 1, time: 0 }));
});

test('TASKPET_FRAME_SCHEMA accepts the host\'s sub-millisecond file mtime', () => {
  // statSync().mtimeMs is fractional on APFS/ext4. An int-only schema rejected
  // every real snapshot, so the client tore the stream down and retried forever
  // while the pet kept rendering from a null document (0 done, night scene).
  const frame = {
    type: 'data', hostEpoch: 'e', streamSeq: 2,
    data: { mtime: 1790772375468.1648, doc: remote.emptyTasksDocument(), error: null },
  };
  assert.equal(remote.TASKPET_FRAME_SCHEMA.parse(frame).data.mtime, 1790772375468.1648);
  const negative = { ...frame, data: { ...frame.data, mtime: -1 } };
  assert.throws(() => remote.TASKPET_FRAME_SCHEMA.parse(negative));
  const notFinite = { ...frame, data: { ...frame.data, mtime: Number.NaN } };
  assert.throws(() => remote.TASKPET_FRAME_SCHEMA.parse(notFinite));
});

test('data/tasks.schema.json mirrors the zod input schema exactly', () => {
  const jsonSchema = z.toJSONSchema(TASKS_DOCUMENT_SCHEMA, { io: 'input' });
  delete jsonSchema.$schema;
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, 'data/tasks.schema.json'), 'utf8'));
  const { $schema, $id, title, description, ...schemaBody } = onDisk;
  assert.equal($schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.equal(title, 'dsh-task-pet tasks.json');
  assert.deepEqual(schemaBody, jsonSchema);
});

test('the shipped example document parses cleanly', () => {
  const example = JSON.parse(fs.readFileSync(path.join(root, 'data/tasks.example.json'), 'utf8'));
  const doc = remote.parseTasksDocument(example);
  assert.equal(doc.tasks.length, 2);
  assert.equal(doc.schedules.length, 1);
  assert.equal(doc.settings.pet_name, '知知');
});
