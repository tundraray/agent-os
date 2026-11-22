import type { Logger } from '@agent-os/common';
import type { Database } from '@agent-os/db';
import { type Runtime, RuntimeError, type Task } from '@agent-os/runtime';
import { z } from 'zod';

import type { AccessAudit, AccessGate } from '../access-gate';
import { AgentsError } from '../errors';
import type { RecordLibrary } from '../start/record-library';
import type { StartDeps } from '../start/resolve-start';
import type { ChildStart, RunStart } from '../store/sessions.repository';
import type { ToolRegistry } from '../tools/tool-registry';

export interface AgentSessionsDeps {
  readonly database: Database;
  readonly runtime: Pick<Runtime, 'tasks' | 'inbox' | 'decisions' | 'trackers'>;
  readonly registry: Pick<ToolRegistry, 'toolOf' | 'displays'>;
  /** `resolveStart` asks it for the record of a start or a restart. */
  readonly library: RecordLibrary;
  readonly access: AccessGate;
  /** `resolveStart` asks it whether the model of a start has a ready provider (model-providers KD-2). */
  readonly providers: StartDeps['providers'];
  readonly audit: AccessAudit;
  /** The class a conversation's root runs as (`ChatAgent`): its task type and the making of its session. */
  readonly chatStart: RunStart;
  /** The class a run under a parent runs as, by its snapshot. */
  readonly childStart: ChildStart;
  /** `createAgentSessions` takes the package's logger and hands the groups of operations its `agents.sessions` child. */
  readonly logger: Logger;
}

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

/** The owner's agent; `AGENT_NOT_FOUND` for a missing or another owner's one. */
export function agentTask(runtime: AgentSessionsDeps['runtime'], agentId: string, ownerId: string): Promise<Task> {
  return asAgent(runtime.tasks.get(agentId, ownerId));
}

/** The parent of a task; `null` for a root. */
export async function parentOf(
  runtime: AgentSessionsDeps['runtime'],
  task: Task,
  ownerId: string,
): Promise<Task | null> {
  return task.parentId === null ? null : asAgent(runtime.tasks.get(task.parentId, ownerId));
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
