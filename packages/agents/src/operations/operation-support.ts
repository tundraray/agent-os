import type { Logger } from '@agent-os/common';
import { RuntimeError, type Task, type TaskControl } from '@agent-os/runtime';
import { z } from 'zod';

import { AgentsError } from '../errors';
import { isQuestion } from '../task-tree';

/** The part of a confirmation request (`ToolRunner.confirmationRequest`) the operations read. */
export const ConfirmationPayloadSchema = z.object({
  agentId: z.string(),
  description: z.string(),
  callId: z.string(),
  tool: z.string(),
  server: z.string().nullable(),
  args: z.unknown(),
  content: z.unknown(),
});

/** The input of a confirmation question task (`effects.ask`, data-model/design-runtime.md KD-3): the request. */
export const QuestionInputSchema = z.object({
  kind: z.string(),
  payload: ConfirmationPayloadSchema,
});

/** `TASK_NOT_FOUND` of the runtime is `AGENT_NOT_FOUND` here; other runtime codes pass unchanged (Notes 2). */
export async function asAgent<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof RuntimeError && error.code === 'TASK_NOT_FOUND') {
      throw new AgentsError('AGENT_NOT_FOUND', error.message, { cause: error });
    }
    throw error;
  }
}

export function agentNotFound(id: string): AgentsError {
  return new AgentsError('AGENT_NOT_FOUND', `Agent ${id} not found`);
}

/** The owner's agent; `AGENT_NOT_FOUND` for a missing or another owner's one, and for a question task (KD-3). */
export async function agentTask(
  tasks: Pick<TaskControl, 'get'>,
  agentId: string,
  ownerId: string,
): Promise<Task> {
  const task = await asAgent(tasks.get(agentId, ownerId));
  if (isQuestion(task)) throw agentNotFound(agentId);
  return task;
}

/** The parent of a task; `null` for a root. */
export async function parentOf(
  tasks: Pick<TaskControl, 'get'>,
  task: Task,
  ownerId: string,
): Promise<Task | null> {
  return task.parentId === null
    ? null
    : asAgent(tasks.get(task.parentId, ownerId));
}

/** Runs an operation and logs it with its ids, outcome and duration: `agents.<operation> answered` or `failed`. */
export function createLogged(logger: Logger) {
  return async function logged<T>(
    operation: string,
    fields: Record<string, unknown>,
    work: () => Promise<T>,
    outcomeOf: (result: T) => Record<string, unknown> = () => ({}),
    /** The level of the success record: `debug` for an operation called on every runtime event. */
    level: 'info' | 'debug' = 'info',
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await work();
      logger[level](`agents.${operation} answered`, {
        ...fields,
        outcome: 'ok',
        ...outcomeOf(result),
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      logger.warn(`agents.${operation} failed`, {
        ...fields,
        outcome: 'error',
        durationMs: Date.now() - startedAt,
        error,
      });
      throw error;
    }
  };
}
