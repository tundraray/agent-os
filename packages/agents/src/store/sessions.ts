import {
  ChipRecordSchema,
  RecordKindSchema,
  type RunOrigin,
} from '@agent-os/contracts';
import {
  type AgentSessionRow,
  AgentSessionsRepository,
  type RootSessionRow,
} from '@agent-os/db';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { RunSnapshotSchema } from '../start/snapshot';
import { snapshotDefinition } from '../start/snapshot-definition';

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
 * The input of an `agent` task (design-runtime.md, Data Model; ADR-0017): the snapshot, the assignment,
 * the description, a fork's link to its parent's history, at a conversation's root the chip of its
 * first message and, for a subagent a `task` call started, the fields its answer must have. The snapshot
 * is written here once and only here; the session is made from it.
 */
export const AgentTaskInputSchema = z.object({
  snapshot: RunSnapshotSchema,
  prompt: z.string(),
  description: z.string(),
  forkedFrom: z
    .object({
      agentId: z.string().min(1),
      throughSeq: z.number().int().nonnegative(),
    })
    .optional(),
  record: ChipRecordSchema.optional(),
  answerFields: z.array(AnswerFieldSchema).optional(),
});
export type SessionInput = z.infer<typeof AgentTaskInputSchema>;

/**
 * The input of an agent task, parsed (run-snapshot.md, «Чтение»): the one way steps, tools and operations
 * read the snapshot and the assignment written at the start.
 */
export function sessionInputOf(input: unknown): SessionInput {
  return AgentTaskInputSchema.parse(input);
}

/** An `agent_sessions` row: the run's name, parent, origin and first-run mark; the snapshot stays in the task input. */
export interface Session {
  readonly taskId: string;
  /** `null` for a root session. */
  readonly parentId: string | null;
  readonly ownerId: string;
  /** The run's name from its snapshot. */
  readonly name: string;
  /** The record the run started from; a root session carries the builtin record `chat`. */
  readonly origin: RunOrigin;
  /** The owner had no earlier session with this record; never set on a root session. */
  readonly firstRun: boolean;
  readonly description: string;
  readonly model: string;
  readonly prompt: string;
  readonly forkedFromTaskId: string | null;
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
export function toRootSession(row: RootSessionRow): RootSession {
  if (row.title === null || row.updatedAt === null) {
    throw new Error(`Session ${row.rootId} is not a root session`);
  }
  return { ...row, title: row.title, updatedAt: row.updatedAt };
}

/** The task a session is written for: its place in the tree is copied into the row. */
export interface SessionTask {
  readonly taskId: string;
  readonly ownerId: string;
  /** `null` for a root. */
  readonly parentId: string | null;
  /** The task's own id for a root. */
  readonly rootId: string;
}

function originOf(row: AgentSessionRow): RunOrigin {
  return {
    recordId: row.recordId,
    kind: RecordKindSchema.parse(row.recordKind),
    version: row.recordVersion,
    name: row.recordName,
    author:
      row.authorId === null
        ? null
        : { id: row.authorId, name: z.string().parse(row.authorName) },
    builtinKey: row.builtinKey,
    subagent: row.subagent,
  };
}

function toSession(row: AgentSessionRow): Session {
  return {
    taskId: row.taskId,
    parentId: row.parentId,
    ownerId: row.ownerId,
    name: row.name,
    origin: originOf(row),
    firstRun: row.firstRun,
    description: row.description,
    model: row.model,
    prompt: row.prompt,
    forkedFromTaskId: row.forkedFromTaskId,
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
 * `AgentSessionsRepository`, inside the caller's transaction: a row is made from the run's snapshot and
 * read back as a `Session`. Every other read and write of `agent_sessions` goes to the repository
 * directly.
 */
@Injectable()
export class Sessions {
  constructor(
    @Inject(AgentSessionsRepository)
    private readonly rows: AgentSessionsRepository,
  ) {}

  /**
   * Creates the session and its `task` entry with `seq` 1 unless the session exists (plan Notes 11):
   * the starter calls it in the transaction that creates the task, and the first step of an agent left
   * without a session calls it again — `ON CONFLICT DO NOTHING` keeps a repeat safe. The name, the model and the origin come from the snapshot, the parent and the root from the
   * task; `first_run` is set when the owner had no earlier session with the record. A root session
   * starts with an empty title and its list time. `true` — this call created the session: the caller
   * (`BaseAgent.createSession`) then runs the agent's `sessionCreated` in the same transaction.
   */
  async ensureSession(
    task: SessionTask,
    input: SessionInput,
  ): Promise<boolean> {
    const { taskId, ownerId } = task;
    const root = task.parentId === null;
    const { origin } = input.snapshot;
    const firstRun = root
      ? false
      : !(await this.rows.ranBefore(ownerId, origin.recordId, taskId));
    return this.rows.create(
      {
        taskId,
        parentId: task.parentId,
        rootId: task.rootId,
        ownerId,
        name: input.snapshot.name,
        description: input.description,
        model: snapshotDefinition(input.snapshot).model,
        prompt: input.prompt,
        recordId: origin.recordId,
        recordKind: origin.kind,
        recordVersion: origin.version,
        recordName: origin.name,
        authorId: origin.author?.id ?? null,
        authorName: origin.author?.name ?? null,
        builtinKey: origin.builtinKey,
        subagent: origin.subagent,
        firstRun,
        forkedFromTaskId: input.forkedFrom?.agentId ?? null,
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
    return new Map(rows.map((row) => [row.taskId, toSession(row)]));
  }
}
