import { Logger } from '@nestjs/common';
import type { EventEnvelope, RuntimeEventType } from '@agent-os/contracts';
import type { EventConsumer, RuntimeTx } from '@agent-os/runtime';
import { withFields } from '../common/log-fields.js';
import { type LaunchAction, nextLaunchState } from './launch-state.js';
import { researchLaunchRepository as launches } from './research-launch.repository.js';

/** Name of the consumer, stored in `research_event_deliveries.consumer` (design-chat-entry.md, KD-4). */
export const RESEARCH_ANSWER_CONSUMER = 'chat-entry.answers';

/** The final events of a task, as the action they are for the launch whose controller task it is. */
const ACTION_OF: Readonly<Partial<Record<RuntimeEventType, LaunchAction>>> = {
  TaskSucceeded: 'task_succeeded',
  TaskFailed: 'task_failed',
  TaskCancelled: 'task_cancelled',
};

const logger = new Logger('ResearchAnswerConsumer');

/**
 * Moves the launch whose `controllerTaskId` is the event's task (design-chat-entry.md, KD-4, Flow 3): `TaskSucceeded`
 * to `answer_pending`, `TaskFailed` to `failed`, `TaskCancelled` to `stopped`, with the event's time as the completion
 * time that orders the thread's answers (invariant 5). It only writes in the delivery transaction — the answer itself
 * is written by the delivery loop. Events of other tasks (children of the controller, investigations not started from
 * a thread) match no launch; a redelivered event finds the row already moved and changes nothing.
 */
export const researchAnswerConsumer: EventConsumer = {
  name: RESEARCH_ANSWER_CONSUMER,
  eventTypes: ['TaskSucceeded', 'TaskFailed', 'TaskCancelled'],
  schemaVersions: [1],
  async handle(tx: RuntimeTx, event: EventEnvelope): Promise<void> {
    const action = ACTION_OF[event.type];
    if (action === undefined || event.taskId === null) return;
    const row = await launches.findByControllerTaskId(tx, event.taskId);
    if (row === undefined) return;
    const to = nextLaunchState(row, action);
    if (to === null) return;
    const moved = await launches.transition(tx, {
      launchKey: row.launchKey,
      from: row.state,
      to,
      set: { finishedAt: new Date(event.createdAt) },
    });
    if (moved === undefined) return;
    logger.log(
      withFields('research launch moved', {
        launchKey: moved.launchKey,
        threadId: moved.threadId,
        investigationId: moved.investigationId ?? undefined,
        from: row.state,
        state: moved.state,
      }),
    );
  },
};
