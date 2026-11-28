import type { Logger } from '@agent-os/common';
import type { TaskInterruptHookInput } from '@agent-os/runtime';

import type { ModelClient } from '../model/model-client';
import type { History } from '../store/history';

/** What the partial answer reads and writes through. */
export interface PartialAnswerDeps {
  readonly modelClient: Pick<ModelClient, 'textOf'>;
  readonly history: Pick<History, 'append'>;
  readonly logger: Logger;
}

/** What cut the task's step off: an interrupt, or a stop that ended the task. */
export type PartialAnswerCause = 'interrupt' | 'stop';

/**
 * The text the model had already written in the task's running call, kept as an ordinary answer of the agent
 * (runtime-fixes design-steps.md KD-1, Flow 1): one `model_answer` without tool calls, appended in the
 * transaction of the interrupt or the stop, after the fence and before the interrupt or stop mark. Nothing is
 * written when no text has arrived. The record sends no event of its own: the runtime's signal of the same
 * transaction makes the feed re-read. The log carries the ids and the text's length, never the text.
 */
export async function writePartialAnswer(
  deps: PartialAnswerDeps,
  task: TaskInterruptHookInput,
  cause: PartialAnswerCause,
): Promise<void> {
  const text = deps.modelClient.textOf(task.taskId);
  if (text === '') return;
  await deps.history.append(task.taskId, [
    { kind: 'model_answer', content: { text, toolCalls: [] } },
  ]);
  deps.logger.info('partial answer written', {
    agentId: task.taskId,
    taskId: task.taskId,
    rootId: task.rootId,
    ownerId: task.ownerId,
    type: task.type,
    cause,
    textLength: text.length,
  });
}
