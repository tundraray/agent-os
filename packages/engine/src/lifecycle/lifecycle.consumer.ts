import { type EventEnvelope, RuntimeEventTypeSchema } from '@agent-os/contracts';
import type { EventConsumer, InvestigationService, RuntimeTx } from '@agent-os/runtime';
import { engineRunsRepository as runs } from '../runs/engine-runs.repository.js';

const { TaskSucceeded, TaskFailed } = RuntimeEventTypeSchema.enum;

/** The `schemaVersion` of the task events this consumer understands; any other is parked by the relay. */
const TASK_EVENT_SCHEMA_VERSION = 1;

/**
 * The engine's consumer `engine.lifecycle` (design-lifecycle.md, KD-1, Flow 3): the end of an investigation's
 * controller task closes the investigation in the delivery transaction of that event — `TaskSucceeded` as
 * `completed`, `TaskFailed` as `failed` — through `InvestigationService.closeInTx`, which also cancels the unfinished
 * tasks. The end of a task that is not its engine investigation's controller task is skipped. A closed or stopped
 * investigation is left as it is, so a repeated delivery changes nothing.
 */
export function createLifecycleConsumer(investigations: Pick<InvestigationService, 'closeInTx'>): EventConsumer {
  return {
    name: 'engine.lifecycle',
    eventTypes: [TaskSucceeded, TaskFailed],
    schemaVersions: [TASK_EVENT_SCHEMA_VERSION],
    async handle(tx: RuntimeTx, event: EventEnvelope): Promise<void> {
      const { taskId, investigationId } = event;
      if (taskId === null) {
        throw new Error(`${event.type} ${event.eventId} names no task`);
      }
      if (!(await runs.isControllerTask(tx, investigationId, taskId))) return;
      await investigations.closeInTx(tx, investigationId, event.type === TaskSucceeded ? 'completed' : 'failed');
    },
  };
}
