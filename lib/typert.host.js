// Authored strict reflection, validated against the installed DSH Typert loader.
import { TASKPET_WATCH_DESCRIPTOR, TASKPET_GETDATA_DESCRIPTOR, TASKPET_FRAME_SCHEMA, TASKPET_DATA_SCHEMA } from './remote.js';
export const TYPERT = {
  package: 'dsh-task-pet', face: 'host',
  schemas: [
    { name: 'TaskPetFrame', create: () => TASKPET_FRAME_SCHEMA },
    { name: 'TaskPetData', create: () => TASKPET_DATA_SCHEMA },
  ],
  invocations: [TASKPET_WATCH_DESCRIPTOR, TASKPET_GETDATA_DESCRIPTOR],
  model: {
    services: [{
      key: 'taskPet', exportName: 'TaskPetService',
      description: 'Read-only task data and live session turn boundaries; the single data writer is the DSH agent.',
      summary: 'Robin task-pet live data and boundaries', tags: [],
      members: [
        { kind: 'method', name: 'watch', signature: 'watch(signal: AbortSignal): AsyncIterable<TaskPetFrame>' },
        { kind: 'method', name: 'getData', signature: 'getData(): Promise<TaskPetData>' },
      ],
      types: [],
    }],
    events: [], objects: [],
  },
};
export default TYPERT;
