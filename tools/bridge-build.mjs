// Bundles tools/bridge-contract-source.mjs (with zod inlined) into lib/remote.js
// and mirrors the file contract into data/tasks.schema.json (agent-facing JSON Schema).
// Pipeline proven by whale-pet: esbuild ESM bundle, no external schema module at runtime.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as z from 'zod';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contractSource = path.join(root, 'tools/bridge-contract-source.mjs');
const remoteOut = path.join(root, 'lib/remote.js');
const schemaOut = path.join(root, 'data/tasks.schema.json');

// 1. lib/remote.js — self-contained ESM bundle (zod inlined).
const result = await build({
  entryPoints: [contractSource],
  bundle: true,
  format: 'esm',
  target: 'es2022',
  minify: true,
  legalComments: 'none',
  write: false,
  logLevel: 'silent',
});
fs.mkdirSync(path.dirname(remoteOut), { recursive: true });
fs.writeFileSync(remoteOut, result.outputFiles[0].text + '\n');

// 2. Load the contract module directly (dev-time zod) for schema mirroring.
const contract = await import(pathToFileURL(contractSource).href);

// z.toJSONSchema(io: 'input') describes what a WRITER must produce:
// defaulted fields are optional and carry their documented default.
const jsonSchema = z.toJSONSchema(contract.TASKS_DOCUMENT_SCHEMA, { io: 'input' });
const documented = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://github.com/…/dsh-task-pet/data/tasks.schema.json',
  title: 'dsh-task-pet tasks.json',
  description:
    'Single source of truth for the task pet. The DSH agent is the ONLY writer ' +
    '(via the task_pet_write tool, or direct file writes validated against this schema). ' +
    'All times are ISO 8601 with timezone. Omitted fields use their "default". ' +
    'After completing a repeat task, the agent creates the next instance. ' +
    'Set settings.pomodoro.running_since to start the pomodoro; clear it to stop.',
  ...jsonSchema,
};
fs.mkdirSync(path.dirname(schemaOut), { recursive: true });
fs.writeFileSync(schemaOut, JSON.stringify(documented, null, 2) + '\n');

// 3. Guard the export block our client build strips and re-wraps.
const text = fs.readFileSync(remoteOut, 'utf8');
const names = text.match(/export\{([^}]+)\};?\s*$/)?.[1]
  .split(',').map((name) => name.replace(/^\S+\s+as\s+/, '').trim()).filter(Boolean).sort();
const expected = ['TASKPET_DATA_SCHEMA', 'TASKPET_FRAME_SCHEMA', 'TASKPET_GETDATA_DESCRIPTOR',
  'TASKPET_WATCH_DESCRIPTOR', 'TASKS_DOCUMENT_SCHEMA', 'TYPERT_REMOTE', 'emptyTasksDocument',
  'ISO_PATTERN', 'parseTasksDocument'].sort();
if (JSON.stringify(names) !== JSON.stringify(expected)) {
  throw new Error(`Unexpected lib/remote.js exports: ${names?.join(', ')}`);
}
console.log(`Built lib/remote.js (${(text.length / 1024).toFixed(1)} KB) and data/tasks.schema.json.`);
