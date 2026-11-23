import {
  ChipRecordSchema,
  ModelIdSchema,
  RecordKindSchema,
  type RunOrigin,
} from '@agent-os/contracts';
import {
  type ConversationRow,
  ConversationsRepository,
  type RootConversationRow,
} from '@agent-os/db';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { RunStart } from '../start/run-definition';

/** A field of the answer a `task` call asks its subagent for (deep-agents/design-task.md KD-7). */
export const AnswerFieldSchema = z.strictObject({
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .describe('The key of the field in the JSON answer'),
  description: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe('What the field holds'),
});

/**
 * The input of an `agent` task (data-model design-agents.md, KD-6): the request of the start — the version by
 * id, the run's name, the team member of a subagent run, the model the start chose — the assignment, the
 * description, a fork's link to its parent's history, at a conversation's root the chip of its first message,
 * for a child the id of the tool call in its parent's conversation that started it and, for a subagent a
 * `task` call started, the fields its answer must have. No definition: the version is its one copy. The
 * conversation's row is made from it once.
 */
export const AgentTaskInputSchema = z.object({
  versionId: z.uuid(),
  name: z.string().min(1),
  subagent: z.string().min(1).nullable(),
  model: ModelIdSchema,
  prompt: z.string(),
  description: z.string(),
  forkedFrom: z
    .object({
      agentId: z.string().min(1),
      throughSeq: z.number().int().nonnegative(),
    })
    .optional(),
  record: ChipRecordSchema.optional(),
  /** The parent's tool call that started this child; absent on a root (data-model design-schema.md R3). */
  startCallId: z.string().min(1).optional(),
  answerFields: z.array(AnswerFieldSchema).optional(),
});
export type SessionInput = z.infer<typeof AgentTaskInputSchema>;

/** The input of an agent task, parsed: the one way steps, tools and operations read what the start wrote. */
export function sessionInputOf(input: unknown): SessionInput {
  return AgentTaskInputSchema.parse(input);
}

/** The fields of a task input that name the run's start: its version by id, name, team member and model. */
export function startFieldsOf(
  run: RunStart,
): Pick<SessionInput, 'versionId' | 'name' | 'subagent' | 'model'> {
  return {
    versionId: run.version.id,
    name: run.name,
    subagent: run.subagent,
    model: run.model,
  };
}

/** A `conversations` row: the run's name, parent, origin read through its version, and first-run mark. */
export interface Session {
  readonly taskId: string;
  /** `null` for a root session. */
  readonly parentId: string | null;
  readonly ownerId: string;
  /** The run's name, as its start gave it. */
  readonly name: string;
  /**
   * The agent the run's version is of (KD-6): its current name and owner, the version's number; a root
   * session carries the default agent `chat`.
   */
  readonly origin: RunOrigin;
  /** The owner had no earlier conversation with this agent; never set on a root session. */
  readonly firstRun: boolean;
  readonly description: string;
  readonly model: string;
  /** The parent's tool call that started this session; `null` on a root. */
  readonly startCallId: string | null;
  /** Set on a fork: the parent's history up to this entry precedes this session's. */
  readonly forkedThroughSeq: number | null;
  readonly turns: number;
  readonly interrupted: boolean;
  readonly closed: boolean;
  readonly lastInputTokens: number | null;
  readonly createdAt: Date;
}

/** A root session as its owner lists it: the conversation it is to the employee. */
export interface RootSession {
  readonly rootId: string;
  readonly ownerId: string;
  /** Empty until a title is written. */
  readonly title: string;
  readonly createdAt: Date;
  /** The last change, in milliseconds: the key of the owner's list. */
  readonly updatedAt: Date;
}

/** Reads a root's row as a root session; a row without a title or a list time is not a root's. */
export function toRootSession(row: RootConversationRow): RootSession {
  if (row.title === null || row.updatedAt === null) {
    throw new Error(`Session ${row.rootId} is not a root session`);
  }
  return { ...row, title: row.title, updatedAt: row.updatedAt };
}

/** The task a session is written for: its owner and parent are copied into the row. */
export interface SessionTask {
  readonly taskId: string;
  readonly ownerId: string;
  /** `null` for a root. */
  readonly parentId: string | null;
}

function originOf(row: ConversationRow): RunOrigin {
  return {
    recordId: row.agentId,
    kind: RecordKindSchema.parse(row.agentKind),
    version: row.versionNumber,
    name: row.agentName,
    author:
      row.agentOwnerId === null
        ? null
        : { id: row.agentOwnerId, name: z.string().parse(row.agentOwnerName) },
    builtinKey: row.builtinKey,
    subagent: row.subagent,
  };
}

function toSession(row: ConversationRow): Session {
  return {
    taskId: row.id,
    parentId: row.parentId,
    ownerId: row.ownerId,
    name: row.name,
    origin: originOf(row),
    firstRun: row.firstRun,
    description: row.description,
    model: row.model,
    startCallId: row.startCallId,
    forkedThroughSeq: row.forkedThroughSeq,
    turns: row.turns,
    interrupted: row.interrupted,
    closed: row.closed,
    lastInputTokens: row.lastInputTokens,
    createdAt: row.createdAt,
  };
}

/**
 * The sessions of agents as the package makes and reads them, over the queries of
 * `ConversationsRepository`, inside the caller's transaction: a row is made from the task input and
 * read back as a `Session`. Every other read and write of `conversations` goes to the repository
 * directly.
 */
@Injectable()
export class Sessions {
  constructor(
    @Inject(ConversationsRepository)
    private readonly rows: ConversationsRepository,
  ) {}

  /**
   * Creates the session and its `task` entry with `seq` 1 unless the session exists (plan Notes 11):
   * the starter calls it in the transaction that creates the task, and the first step of an agent left
   * without a session calls it again — `ON CONFLICT DO NOTHING` keeps a repeat safe. The version, the name,
   * the team member and the model come from the input, the parent and the root from the task; `first_run` is
   * set when the owner had no earlier conversation with the version's agent. A root session starts with an
   * empty title and its list time. `true` — this call created the session: the caller
   * (`BaseAgent.createSession`) then runs the agent's `sessionCreated` in the same transaction.
   */
  async ensureSession(
    task: SessionTask,
    input: SessionInput,
    agentId: string,
  ): Promise<boolean> {
    const { taskId, ownerId } = task;
    const root = task.parentId === null;
    const firstRun = root
      ? false
      : !(await this.rows.ranBefore(ownerId, agentId, taskId));
    return this.rows.create(
      {
        id: taskId,
        parentId: task.parentId,
        ownerId,
        startCallId: input.startCallId ?? null,
        name: input.name,
        description: input.description,
        model: input.model,
        agentVersionId: input.versionId,
        subagent: input.subagent,
        firstRun,
        forkedThroughSeq: input.forkedFrom?.throughSeq ?? null,
      },
      // The chip of a conversation's first message stays on the root's task (plan Notes 9а).
      { text: input.prompt, record: input.record ?? null },
    );
  }

  /** The session of the agent; `undefined` when it has none yet. */
  async get(taskId: string): Promise<Session | undefined> {
    const row = await this.rows.find(taskId);
    return row === undefined ? undefined : toSession(row);
  }

  /** The sessions of the given agents by task id; an agent without a session is absent. */
  async getMany(taskIds: readonly string[]): Promise<Map<string, Session>> {
    const rows = await this.rows.findMany(taskIds);
    return new Map(rows.map((row) => [row.id, toSession(row)]));
  }
}
