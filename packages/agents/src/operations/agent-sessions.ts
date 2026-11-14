import type { Logger } from '@agent-os/common';
import {
  AGENT_TASK_TYPE,
  AgentMessageKindSchema,
  type DecisionStatus,
  type ToolCallState,
  ToolCallStateSchema,
  TaskStatusSchema,
  WaitReasonSchema,
} from '@agent-os/contracts';
import { agentToolCalls, type Database } from '@agent-os/db';
import { type Runtime, RuntimeError, type ResolveOutcome, type Task } from '@agent-os/runtime';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import { type AgentView, toAgentView } from '../agent-view.js';
import type { AgentsConfig } from '../config.js';
import type { DefinitionCatalog } from '../definitions/catalog.js';
import { AgentsError } from '../errors.js';
import type { HistoryEntry } from '../history/history.js';
import { chooseModel } from '../model/model-choice.js';
import { messagePayload } from '../step/continuation.js';
import { interruptText } from '../step/deliver.js';
import { history } from '../store/history.repository.js';
import { type Session, type SessionInput, sessions } from '../store/sessions.repository.js';
import { toolCalls } from '../store/tool-calls.repository.js';
import type { SessionLimits, ToolDisplay } from '../tools/tool.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { stopEntries } from './stop-entries.js';

/** The largest page of `history` (design-agents.md, «Операции агентов»). */
const HISTORY_LIMIT_MAX = 500;

const { stopped } = TaskStatusSchema.enum;
const { queued, running, waiting } = TaskStatusSchema.enum;
const FINISHED: ReadonlySet<string> = new Set(['completed', 'failed', 'stopped']);
const { user_message: userMessage, interrupt } = AgentMessageKindSchema.enum;

export interface StartRequest {
  readonly ownerId: string;
  /** Without it the agent is a root session, such as a conversation. */
  readonly parentId?: string;
  readonly definition: string;
  readonly prompt: string;
  readonly description: string;
  readonly model?: string;
  readonly limits?: SessionLimits;
}

export interface AgentRef {
  readonly agentId: string;
  readonly ownerId: string;
}

export interface SendRequest extends AgentRef {
  readonly text: string;
}

export interface InterruptRequest extends AgentRef {
  /** Without text the agent is marked «прерван» and waits (KD-3). */
  readonly text?: string;
}

export interface HistoryRequest extends AgentRef {
  /** Entries with a greater `seq`; 0 by default. */
  readonly afterSeq?: number;
  /** At most this many entries, up to {@link HISTORY_LIMIT_MAX}. */
  readonly limit: number;
}

export interface ResolveConfirmationRequest {
  readonly decisionId: string;
  readonly ownerId: string;
  readonly approve: boolean;
  /** The employee's edit of the arguments; only a tool that allows it accepts one. */
  readonly args?: unknown;
}

/** One tool call of a model answer as `history` shows it; an open call carries its state. */
export interface AnswerToolCall extends ToolDisplay {
  readonly callId: string;
  readonly tool: string;
  /** MCP server id; null for built-in and registered tools. */
  readonly server: string | null;
  readonly args: unknown;
  readonly state: ToolCallState;
}

/**
 * An entry of `history` (design-agents.md, HistoryEntry): as stored, except that a `model_answer`
 * carries its tool calls, which the store keeps in `agent_tool_calls`.
 */
export type AgentHistoryEntry =
  | Exclude<HistoryEntry, { kind: 'model_answer' }>
  | {
      readonly seq: number;
      readonly kind: 'model_answer';
      readonly createdAt: Date;
      readonly content: { readonly text: string; readonly toolCalls: readonly AnswerToolCall[] };
    };

/** A confirmation request of a tree in any status (design-chat.md, Confirmation; KD-6). */
export interface AgentConfirmation extends ToolDisplay {
  readonly decisionId: string;
  readonly agentId: string;
  /** The agent's description. */
  readonly description: string;
  /** Decision kind: `agents.tool_confirmation` or the kind of an upper part's tool. */
  readonly kind: string;
  readonly tool: string;
  readonly server: string | null;
  /** The arguments the model requested. */
  readonly args: unknown;
  /** The card content: the tool's `confirmation.content(args)`, or `{ toolDescription }`. */
  readonly content: unknown;
  readonly status: DecisionStatus;
  /** Set when `resolved`: the decision and the arguments the call ran with (edited or requested). */
  readonly resolution: { readonly approve: boolean; readonly args: unknown } | null;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
}

/** The operations of agents (design-agents.md, «Операции агентов»; plan Notes 1, 2). */
export interface AgentSessions {
  start(request: StartRequest): Promise<{ agentId: string }>;
  send(request: SendRequest): Promise<{ messageId: string }>;
  interrupt(request: InterruptRequest): Promise<'interrupted' | 'not_active'>;
  stop(request: AgentRef): Promise<string[]>;
  restart(request: AgentRef): Promise<{ agentId: string }>;
  get(agentId: string, ownerId: string): Promise<AgentView>;
  list(rootId: string, ownerId: string): Promise<AgentView[]>;
  history(request: HistoryRequest): Promise<AgentHistoryEntry[]>;
  confirmations(rootId: string, ownerId: string): Promise<AgentConfirmation[]>;
  resolveConfirmation(request: ResolveConfirmationRequest): Promise<ResolveOutcome>;
}

export interface AgentSessionsDeps {
  readonly database: Database;
  readonly runtime: Pick<Runtime, 'tasks' | 'inbox' | 'decisions' | 'ledger'>;
  readonly catalog: DefinitionCatalog;
  readonly registry: Pick<ToolRegistry, 'toolOf' | 'display'>;
  readonly config: Pick<AgentsConfig, 'maxDepth' | 'defaultModel'>;
  readonly logger: Logger;
}

/** The part of a confirmation request (`ToolRunner.confirmationRequest`) the operations read. */
const ConfirmationPayloadSchema = z.object({
  agentId: z.string(),
  description: z.string(),
  callId: z.string(),
  tool: z.string(),
  server: z.string().nullable(),
  args: z.unknown(),
  content: z.unknown(),
});

/** The resolution `resolveConfirmation` writes: `{ approve, args? }`. */
const ConfirmationResolutionSchema = z.object({ approve: z.boolean(), args: z.unknown().optional() });

const isFinished = (task: Task): boolean => FINISHED.has(task.status);

/** `TASK_NOT_FOUND` of the runtime is `AGENT_NOT_FOUND` here; other runtime codes pass unchanged (Notes 2). */
async function asAgent<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof RuntimeError && error.code === 'TASK_NOT_FOUND') {
      throw new AgentsError('AGENT_NOT_FOUND', error.message, { cause: error });
    }
    throw error;
  }
}

function agentNotFound(id: string): AgentsError {
  return new AgentsError('AGENT_NOT_FOUND', `Agent ${id} not found`);
}

/**
 * The agent operations over the runtime (design-agents.md, Contract «Операции агентов», Security). Each
 * operation calls a runtime operation with `ownerId` first — it checks the owner — and reads `agent_*`
 * only after it, so another owner's agent answers exactly as a missing one (AC-13.3, NFR-06). Every
 * operation is logged with its ids and outcome.
 */
export function createAgentSessions(deps: AgentSessionsDeps): AgentSessions {
  const { database, runtime, catalog, registry, config } = deps;
  const logger = deps.logger.child({ service: 'agents.sessions' });

  async function logged<T>(
    operation: string,
    fields: Record<string, unknown>,
    work: () => Promise<T>,
    outcomeOf: (result: T) => Record<string, unknown> = () => ({}),
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await work();
      logger.info(`agents.${operation} answered`, {
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
  }

  /** The owner's agent; `AGENT_NOT_FOUND` for a missing, another owner's or a non-agent task. */
  async function agentTask(agentId: string, ownerId: string): Promise<Task> {
    const task = await asAgent(runtime.tasks.get(agentId, ownerId));
    if (task.type !== AGENT_TASK_TYPE) throw agentNotFound(agentId);
    return task;
  }

  /** The parent of a task; `null` for a root. */
  async function parentOf(task: Task, ownerId: string): Promise<Task | null> {
    return task.parentId === null ? null : asAgent(runtime.tasks.get(task.parentId, ownerId));
  }

  /** The owner's tree; `AGENT_NOT_FOUND` for another owner's or no tree. */
  async function tree(rootId: string, ownerId: string): Promise<Task[]> {
    const tasks = await runtime.tasks.listTree(rootId, ownerId);
    if (tasks.length === 0) throw agentNotFound(rootId);
    return tasks;
  }

  /** Creates the agent task, then its session in its own transaction (plan Notes 11). */
  async function createAgent(
    ownerId: string,
    parentId: string | null,
    input: SessionInput,
  ): Promise<{ agentId: string }> {
    const agentId = await asAgent(
      runtime.tasks.create({
        type: AGENT_TASK_TYPE,
        ownerId,
        input,
        ...(parentId === null ? {} : { parentId }),
      }),
    );
    // A worker may take the first step before this: it makes the same session (ON CONFLICT DO NOTHING).
    await database.transaction((tx) => sessions.ensureSession(tx, agentId, input, ownerId));
    return { agentId };
  }

  /** Whether an `interrupt` without text waits in the agent's queue (KD-3); only a queued or running agent can have one. */
  async function pendingInterruptWithoutText(task: Task): Promise<boolean> {
    if (task.status !== queued && task.status !== running) return false;
    const pending = await runtime.inbox.listPending(task.taskId, task.ownerId);
    return pending.some(
      (message) => message.kind === interrupt && interruptText(message) === undefined,
    );
  }

  async function view(task: Task, session: Session): Promise<AgentView> {
    return toAgentView(task, session, await pendingInterruptWithoutText(task));
  }

  /** The tool calls of the given answers, by answer and position. */
  async function callsOf(
    agentId: string,
    answerSeqs: readonly number[],
    shownClosed: boolean,
  ): Promise<Map<number, AnswerToolCall[]>> {
    const byAnswer = new Map<number, AnswerToolCall[]>();
    if (answerSeqs.length === 0) return byAnswer;
    const rows = await database
      .select()
      .from(agentToolCalls)
      .where(
        and(eq(agentToolCalls.taskId, agentId), inArray(agentToolCalls.answerSeq, [...answerSeqs])),
      )
      .orderBy(asc(agentToolCalls.answerSeq), asc(agentToolCalls.position));
    for (const row of rows) {
      const calls = byAnswer.get(row.answerSeq) ?? [];
      calls.push({
        callId: row.callId,
        tool: row.tool,
        server: row.server,
        args: row.args,
        // A stopped agent's open calls are shown closed (Flow 7): the stop records follow them.
        state: shownClosed ? ToolCallStateSchema.enum.done : ToolCallStateSchema.parse(row.state),
        ...registry.display(row.tool, row.server),
      });
      byAnswer.set(row.answerSeq, calls);
    }
    return byAnswer;
  }

  /** Finds the open request among the trees of the owner's agents with a call awaiting confirmation (Notes 7). */
  async function openConfirmation(
    decisionId: string,
    ownerId: string,
  ): Promise<z.infer<typeof ConfirmationPayloadSchema> | undefined> {
    const roots = new Set<string>();
    for (const sessionId of await toolCalls.awaitingSessions(database)) {
      try {
        roots.add((await runtime.tasks.get(sessionId, ownerId)).rootId);
      } catch (error) {
        // Another owner's agent is dropped.
        if (error instanceof RuntimeError && error.code === 'TASK_NOT_FOUND') continue;
        throw error;
      }
    }
    for (const rootId of roots) {
      const decisions = await runtime.decisions.listTree(rootId, ownerId);
      const decision = decisions.find(
        (candidate) => candidate.decisionId === decisionId && candidate.status === 'open',
      );
      if (decision !== undefined) return ConfirmationPayloadSchema.parse(decision.payload);
    }
    return undefined;
  }

  /** The edited arguments parsed by the tool's schema; `INVALID_ARGUMENTS` unless the tool allows the edit. */
  function editedArgs(payload: z.infer<typeof ConfirmationPayloadSchema>, args: unknown): unknown {
    // An MCP tool never allows an edit; nor does any tool of this part.
    const tool = payload.server === null ? registry.toolOf(payload.tool) : undefined;
    if (tool?.confirmation?.editableArgs !== true) {
      throw new AgentsError('INVALID_ARGUMENTS', `Tool ${payload.tool} does not allow editing its arguments`);
    }
    const parsed = tool.argsSchema.safeParse(args);
    if (!parsed.success) {
      throw new AgentsError('INVALID_ARGUMENTS', `Arguments of ${payload.tool} rejected by its schema`, {
        cause: parsed.error,
      });
    }
    return parsed.data;
  }

  return {
    start(request) {
      const { ownerId, parentId } = request;
      return logged(
        'start',
        { ownerId, parentId, definition: request.definition },
        async () => {
          const definition = catalog.get(request.definition);
          if (definition === undefined) {
            throw new AgentsError('UNKNOWN_DEFINITION', `No definition ${request.definition} in the catalog`);
          }
          const parent = parentId === undefined ? null : await agentTask(parentId, ownerId);
          const depth = parent === null ? 0 : parent.depth + 1;
          if (depth > config.maxDepth) {
            throw new AgentsError(
              'DEPTH_LIMIT',
              `A child of an agent at depth ${depth - 1} is deeper than AGENT_MAX_DEPTH ${config.maxDepth}`,
            );
          }
          const choice = chooseModel({
            launchModel: request.model ?? null,
            definitionModel: definition.model ?? null,
            defaultModel: config.defaultModel,
            pricedModels: runtime.ledger.pricedModels(),
          });
          if (choice.kind === 'refused') {
            throw new AgentsError(
              'UNKNOWN_MODEL',
              `Model ${request.model ?? definition.model ?? config.defaultModel} has no price in the prices file`,
            );
          }
          return createAgent(ownerId, parent?.taskId ?? null, {
            definition: definition.name,
            description: request.description,
            prompt: request.prompt,
            model: choice.model,
            ...(request.limits === undefined ? {} : { limits: request.limits }),
          });
        },
        ({ agentId }) => ({ agentId }),
      );
    },

    send({ agentId, ownerId, text }) {
      return logged(
        'send',
        { agentId, ownerId },
        async () => {
          const target = await agentTask(agentId, ownerId);
          // Notes 5: a message to a stopped agent carries the `resume` mark; the window between this
          // read and the write is a known low risk.
          const parent = target.status === stopped ? await parentOf(target, ownerId) : null;
          const { messageId } = await asAgent(
            runtime.inbox.enqueue({
              recipientId: agentId,
              ownerId,
              kind: userMessage,
              sender: ownerId,
              payload: messagePayload(text, target, parent),
              revive: true,
            }),
          );
          return { messageId };
        },
        ({ messageId }) => ({ messageId }),
      );
    },

    interrupt({ agentId, ownerId, text }) {
      return logged(
        'interrupt',
        { agentId, ownerId, withText: text !== undefined },
        async () => {
          const task = await agentTask(agentId, ownerId);
          // A free agent (waiting for messages) has no work to cut off: `not_active`, nothing changes (Flow 4).
          if (task.status === waiting && task.waitReason === WaitReasonSchema.enum.messages) return 'not_active';
          // KD-3: always with an `interrupt` message, with the employee's text or without.
          return asAgent(
            runtime.tasks.interrupt(agentId, ownerId, {
              kind: interrupt,
              sender: ownerId,
              payload: text === undefined ? {} : { text },
              revive: false,
            }),
          );
        },
        (outcome) => ({ outcome }),
      );
    },

    stop({ agentId, ownerId }) {
      return logged(
        'stop',
        { agentId, ownerId },
        async () => {
          await agentTask(agentId, ownerId);
          // Flow 7: `tasks.stop` and nothing else; `history` shows the stop records.
          return asAgent(runtime.tasks.stop(agentId, ownerId));
        },
        (stoppedIds) => ({ stoppedIds }),
      );
    },

    restart({ agentId, ownerId }) {
      return logged(
        'restart',
        { agentId, ownerId },
        async () => {
          const task = await agentTask(agentId, ownerId);
          if (!isFinished(task)) {
            throw new AgentsError('NOT_FINISHED', `Agent ${agentId} is ${task.status}, not finished`);
          }
          const session = await sessions.get(database, agentId);
          if (session === undefined) throw new Error(`Finished agent ${agentId} has no session`);
          // AC-09.2: the same definition, task, model, limits and parent; the history starts anew.
          return createAgent(ownerId, task.parentId, {
            definition: session.definition,
            description: session.description,
            prompt: session.prompt,
            model: session.model,
            ...(session.limits === null ? {} : { limits: session.limits }),
          });
        },
        (restarted) => ({ restartedAs: restarted.agentId }),
      );
    },

    get(agentId, ownerId) {
      return logged(
        'get',
        { agentId, ownerId },
        async () => {
          const task = await agentTask(agentId, ownerId);
          // An agent whose session is not written yet (between `tasks.create` and `ensureSession`) is not shown.
          const session = await sessions.get(database, agentId);
          if (session === undefined) throw agentNotFound(agentId);
          return view(task, session);
        },
        ({ status }) => ({ status }),
      );
    },

    list(rootId, ownerId) {
      return logged(
        'list',
        { rootId, ownerId },
        async () => {
          const agents = (await tree(rootId, ownerId)).filter((task) => task.type === AGENT_TASK_TYPE);
          const found = await sessions.getMany(
            database,
            agents.map((task) => task.taskId),
          );
          const views: AgentView[] = [];
          for (const task of agents) {
            const session = found.get(task.taskId);
            if (session !== undefined) views.push(await view(task, session));
          }
          return views;
        },
        (views) => ({ agents: views.length }),
      );
    },

    history({ agentId, ownerId, afterSeq = 0, limit }) {
      return logged(
        'history',
        { agentId, ownerId, afterSeq, limit },
        async () => {
          if (!Number.isInteger(limit) || limit < 1) {
            throw new RangeError(`history limit must be a positive integer, got ${limit}`);
          }
          const pageSize = Math.min(limit, HISTORY_LIMIT_MAX);
          const task = await agentTask(agentId, ownerId);
          const isStopped = task.status === stopped;
          const derived = isStopped
            ? await stopEntries(database, { task, parent: await parentOf(task, ownerId) })
            : [];
          const stored = await history.list(database, agentId, afterSeq, pageSize);
          const answers = stored.filter((entry) => entry.kind === 'model_answer').map((entry) => entry.seq);
          const calls = await callsOf(agentId, answers, isStopped);
          const page: AgentHistoryEntry[] = stored.map((entry) =>
            entry.kind === 'model_answer'
              ? { ...entry, content: { text: entry.content.text, toolCalls: calls.get(entry.seq) ?? [] } }
              : entry,
          );
          page.push(...derived.filter((entry) => entry.seq > afterSeq));
          return page.slice(0, pageSize);
        },
        (entries) => ({ entries: entries.length }),
      );
    },

    confirmations(rootId, ownerId) {
      return logged(
        'confirmations',
        { rootId, ownerId },
        async () => {
          const agentIds = new Set(
            (await tree(rootId, ownerId))
              .filter((task) => task.type === AGENT_TASK_TYPE)
              .map((task) => task.taskId),
          );
          const decisions = await runtime.decisions.listTree(rootId, ownerId);
          return decisions
            .filter((decision) => agentIds.has(decision.taskId))
            .map((decision): AgentConfirmation => {
              const payload = ConfirmationPayloadSchema.parse(decision.payload);
              const resolved =
                decision.status === 'resolved' ? ConfirmationResolutionSchema.parse(decision.resolution) : null;
              return {
                decisionId: decision.decisionId,
                agentId: decision.taskId,
                description: payload.description,
                kind: decision.kind,
                tool: payload.tool,
                server: payload.server,
                args: payload.args,
                content: payload.content,
                status: decision.status,
                resolution:
                  resolved === null
                    ? null
                    : { approve: resolved.approve, args: resolved.args ?? payload.args },
                createdAt: decision.createdAt,
                resolvedAt: decision.resolvedAt,
                ...registry.display(payload.tool, payload.server),
              };
            });
        },
        (confirmations) => ({ confirmations: confirmations.length }),
      );
    },

    resolveConfirmation({ decisionId, ownerId, approve, args }) {
      return logged(
        'resolveConfirmation',
        { decisionId, ownerId, approve, withArgs: args !== undefined },
        async () => {
          if (args === undefined) {
            return runtime.decisions.resolve(decisionId, ownerId, { approve });
          }
          const payload = await openConfirmation(decisionId, ownerId);
          if (payload === undefined) {
            // Not open for this owner: `decisions.resolve` answers `already_resolved` for a resolved or
            // cancelled request and `DECISION_NOT_FOUND` for a missing or another owner's one, and
            // writes nothing (an open request always has its call awaiting confirmation: one commit
            // writes both).
            return runtime.decisions.resolve(decisionId, ownerId, { approve });
          }
          // The tool step reads `{ approve, args? }` and the call id from the request's payload.
          return runtime.decisions.resolve(decisionId, ownerId, {
            approve,
            args: editedArgs(payload, args),
          });
        },
        (outcome) => ({ outcome }),
      );
    },
  };
}
