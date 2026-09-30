// Authored strict Typert contract for dsh-task-pet.
// Single source of truth for:
//   - the data/tasks.json file contract (agent-facing, mirrored to data/tasks.schema.json at build time)
//   - the Host -> Client bridge frames (baseline / turn/start / turn/end / data)
//   - the Typert service descriptors (watch stream + unary getData)
// Bundled into lib/remote.js so the browser needs no external schema module.
// API surface follows zod v4 classic; whale-pet proved this bundling pipeline.
import * as z from 'zod';

/** ISO 8601 date or date-time; a time part must carry a timezone offset. */
export const ISO_PATTERN =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const isoString = z
  .string()
  .max(40)
  .regex(ISO_PATTERN, 'ISO 8601 with timezone required')
  .refine((value) => !Number.isNaN(Date.parse(value)), 'unrepresentable calendar date');

/** Local wall-clock time HH:mm (00:00-23:59). */
const hhmm = z
  .string()
  .regex(/^\d{2}:\d{2}$/, 'HH:mm required')
  .refine((value) => Number(value.slice(0, 2)) <= 23 && Number(value.slice(3)) <= 59, 'HH:mm out of range');

const minutes = z.number().int().min(1).max(240);

/**
 * data/tasks.json document. Unknown keys are tolerated (stripped from the
 * plugin's normalized view but preserved on disk by the write tool), and every
 * omitted field carries its documented default.
 */
export const TASKS_DOCUMENT_SCHEMA = z.object({
  tasks: z
    .array(
      z.object({
        id: z.string().min(1).max(128),
        title: z.string().min(1).max(300),
        due: isoString.optional(),
        remind_at: z.array(isoString).max(16).default([]),
        priority: z.enum(['low', 'med', 'high']).optional(),
        status: z.enum(['pending', 'completed', 'deleted']).default('pending'),
        repeat: z.enum(['daily', 'weekdays', 'weekly', 'monthly', 'yearly']).optional(),
        created_at: isoString.optional(),
        completed_at: isoString.optional(),
      }),
    )
    .max(2000)
    .default([]),
  schedules: z
    .array(
      z.object({
        id: z.string().min(1).max(128),
        title: z.string().min(1).max(300),
        start: isoString,
        end: isoString,
        note: z.string().max(500).optional(),
      }),
    )
    .max(2000)
    .default([]),
  settings: z
    .object({
      pet_name: z.string().min(1).max(40).default('知知'),
      evening_time: hhmm.default('18:30'),
      pomodoro: z
        .object({
          work_min: minutes.default(45),
          break_min: minutes.default(10),
          running_since: isoString.nullable().default(null),
        })
        .default({}),
    })
    .default({}),
});

/** Snapshot payload carried by baseline/data frames and the getData call. */
export const TASKPET_DATA_SCHEMA = z.object({
  /** File mtime in epoch ms; 0 when the file does not exist yet. statSync
   * reports sub-millisecond precision, so this is a finite non-negative number
   * rather than a strict integer: requiring an int rejected every real snapshot
   * and silently starved the pet of its document. */
  mtime: z.number().finite().min(0),
  /** Last good (validated + defaulted) document. Empty document when none. */
  doc: TASKS_DOCUMENT_SCHEMA,
  /** Non-empty when the latest load failed (parse/validation); the plugin then
   * keeps `doc` as the previous good snapshot and surfaces the error. */
  error: z.string().min(1).max(200).nullable(),
});

const sequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const sessionId = z.string().min(1).max(512);
const identity = z.object({ sessionId, isSubagent: z.boolean().optional() });
const shared = {
  hostEpoch: z.string().min(1).max(128),
  streamSeq: sequence,
};
const boundary = {
  ...shared,
  sessionId,
  seq: sequence,
  time: z.union([z.string().max(64), z.number()]),
  isSubagent: z.boolean().optional(),
};

/** Bridge frames: whale-pet session boundaries plus task-data pushes. */
export const TASKPET_FRAME_SCHEMA = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('baseline'), ...shared, identities: z.array(identity).max(4096), data: TASKPET_DATA_SCHEMA }),
  z.strictObject({ type: z.literal('turn/start'), ...boundary }),
  z.strictObject({ type: z.literal('turn/end'), ...boundary, reason: z.string().max(80) }),
  z.strictObject({ type: z.literal('data'), ...shared, data: TASKPET_DATA_SCHEMA }),
]);

export const TASKPET_WATCH_DESCRIPTOR = {
  id: 'dsh-task-pet#taskPet/watch', service: 'taskPet', namespace: 'taskPet', method: 'watch',
  mode: 'stream', invocation: { kind: 'direct' }, parameters: [],
  cancellation: { parameter: 'signal' },
  result: { mode: 'strict', typeSymbol: 'dsh-task-pet#TaskPetFrame', create: () => TASKPET_FRAME_SCHEMA },
};
export const TASKPET_GETDATA_DESCRIPTOR = {
  id: 'dsh-task-pet#taskPet/getData', service: 'taskPet', namespace: 'taskPet', method: 'getData',
  invocation: { kind: 'direct' }, parameters: [],
  result: { mode: 'strict', typeSymbol: 'dsh-task-pet#TaskPetData', create: () => TASKPET_DATA_SCHEMA },
};
export const TYPERT_REMOTE = {
  package: 'dsh-task-pet',
  descriptors: [TASKPET_WATCH_DESCRIPTOR, TASKPET_GETDATA_DESCRIPTOR],
};

/** Validate + normalize a raw parsed document. Throws on contract violation. */
export function parseTasksDocument(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...raw } : {};
  // Tolerate explicit nulls / missing nested objects (treated as absent) and
  // force them to {} so zod deep-fills their inner defaults (pet_name,
  // evening_time, pomodoro) instead of returning a bare {}.
  if (input.settings == null) {
    input.settings = {};
  }
  if (typeof input.settings === 'object' && !Array.isArray(input.settings) && input.settings.pomodoro == null) {
    input.settings = { ...input.settings, pomodoro: {} };
  }
  return TASKS_DOCUMENT_SCHEMA.parse(input);
}

/** The document view used before any file exists / after a corrupt load. */
export function emptyTasksDocument() {
  return parseTasksDocument({});
}
