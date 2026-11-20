import type { Logger } from '@agent-os/common';
import {
  AGENT_TASK_TYPE,
  AgentMessageKindSchema,
  CHAT_BUILTIN_KEY,
  type ChipRecord,
  type DecisionStatus,
  type ToolCallState,
  ToolCallStateSchema,
  TaskStatusSchema,
  WaitReasonSchema,
} from '@agent-os/contracts';
import type { Database } from '@agent-os/db';
import {
  isFinished,
  type Runtime,
  RuntimeError,
  type ResolveOutcome,
  type Task,
} from '@agent-os/runtime';
import { z } from 'zod';

import type { AccessAudit, AccessGate } from '../access-gate.js';
import { type AgentView, toAgentView } from '../agent-view.js';
import { AgentsError } from '../errors.js';
import { foldCalls } from '../history/call-state.js';
import { messagePayload } from '../step/continuation.js';
import { ConfirmationResolutionSchema } from '../step/tool-step.js';
import { history, type PageEntry } from '../store/history.repository.js';
import type { RecordLibrary } from '../start/record-library.js';
import {
  auditStartRefusal,
  resolveStart,
  type StartDeps,
  type StartSource,
} from '../start/resolve-start.js';
import type { RunSnapshot } from '../start/snapshot.js';
import {
  type RootPosition,
  type RootSession,
  type Session,
  type SessionInput,
  sessionInputOf,
  sessions,
} from '../store/sessions.repository.js';
import { logStart } from '../tools/builtin/start-child.js';
import type { ToolDisplay } from '../tools/tool.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import { stopEntries } from './stop-entries.js';

const { queued, running, waiting, stopped } = TaskStatusSchema.enum;
const { user_message: userMessage, interrupt } = AgentMessageKindSchema.enum;

/** The root of a conversation (design-runtime.md, «Операции `agents`»): it runs the `chat` record. */
export interface StartRequest {
  /** The id of the new root, a UUID; a new one when absent. A taken id is the runtime's `TASK_EXISTS`. */
  readonly agentId?: string;
  readonly ownerId: string;
  readonly prompt: string;
  readonly description: string;
  /** The chip of the conversation's first message: it stays on the root's `task` entry. */
  readonly record?: ChipRecord;
}

export interface AgentRef {
  readonly agentId: string;
  readonly ownerId: string;
}

export interface SendRequest extends AgentRef {
  readonly text: string;
  /** The message's chip (KD-4): the model and the history get it with the text. */
  readonly record?: ChipRecord;
}

/** A page of the owner's root sessions: strictly after `after`, at most `limit`; all without either. */
export interface RootsRequest {
  readonly ownerId: string;
  readonly after?: RootPosition;
  readonly limit?: number;
}

export interface HistoryRequest extends AgentRef {
  /** Entries with a greater `seq`; 0 by default. */
  readonly afterSeq?: number;
  /** At most this many entries. */
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

type StoredResult = Extract<PageEntry, { kind: 'tool_result' }>;

/** A `tool_result` as `history` shows it: without the started child's id, kept for incident analysis only. */
type ShownResult = Omit<StoredResult, 'content'> & {
  readonly content: Omit<StoredResult['content'], 'childTaskId'>;
};

function shownResult(entry: StoredResult): ShownResult {
  const { childTaskId: _childTaskId, ...content } = entry.content;
  return { ...entry, content };
}

/**
 * An entry of `history` (design-agents.md, HistoryEntry): as stored, except that each tool call of a
 * `model_answer` carries its state, folded from the call's records, which are not entries of their own.
 */
export type AgentHistoryEntry =
  | Exclude<PageEntry, { kind: 'model_answer' | 'tool_result' }>
  | ShownResult
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
  /** Marks the agent «прерван»: it closes its open calls and waits for a message (KD-3). */
  interrupt(request: AgentRef): Promise<'interrupted' | 'not_active'>;
  stop(request: AgentRef): Promise<string[]>;
  restart(request: AgentRef): Promise<{ agentId: string }>;
  /** The run's snapshot, for the view of a run; `null` when the task is not an agent. */
  snapshot(agentId: string, ownerId: string): Promise<RunSnapshot | null>;
  get(agentId: string, ownerId: string): Promise<AgentView>;
  list(rootId: string, ownerId: string): Promise<AgentView[]>;
  history(request: HistoryRequest): Promise<AgentHistoryEntry[]>;
  confirmations(rootId: string, ownerId: string): Promise<AgentConfirmation[]>;
  resolveConfirmation(request: ResolveConfirmationRequest): Promise<ResolveOutcome>;
  /**
   * The owner's root session — the conversation the employee sees; `undefined` for a missing one,
   * another owner's and a session that is not a root.
   */
  root(rootId: string, ownerId: string): Promise<RootSession | undefined>;
  /** The owner of a root session, whoever it is: for a signal of a tree that carries no owner. */
  rootOwner(rootId: string): Promise<string | undefined>;
  /** The owner's root sessions, last changed first (`updatedAt` DESC, then `rootId` DESC). */
  roots(request: RootsRequest): Promise<RootSession[]>;
  /** Moves the owner's root session to the top of the list. */
  touchRoot(rootId: string, ownerId: string): Promise<void>;
  /** Sets the title and moves the root session up; `undefined` as in `root`. */
  renameRoot(rootId: string, ownerId: string, title: string): Promise<RootSession | undefined>;
  /** Writes a generated title only into an empty one; `true` when it was written. */
  titleRootIfEmpty(rootId: string, ownerId: string, title: string): Promise<boolean>;
}

export interface AgentSessionsDeps {
  readonly database: Database;
  readonly runtime: Pick<Runtime, 'tasks' | 'inbox' | 'decisions'>;
  readonly registry: Pick<ToolRegistry, 'toolOf' | 'displays'>;
  /** `resolveStart` asks it for the record of a start or a restart. */
  readonly library: RecordLibrary;
  readonly access: AccessGate;
  /** `resolveStart` asks it whether the model of a start has a ready provider (model-providers KD-2). */
  readonly providers: StartDeps['providers'];
  readonly audit: AccessAudit;
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
  const { database, runtime, registry } = deps;
  const logger = deps.logger.child({ service: 'agents.sessions' });

  async function logged<T>(
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
  }

  /** The owner's agent; `AGENT_NOT_FOUND` for a missing or another owner's one. */
  function agentTask(agentId: string, ownerId: string): Promise<Task> {
    return asAgent(runtime.tasks.get(agentId, ownerId));
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

  /**
   * The snapshot of a start by `resolveStart` on behalf of the owner (KD-2), and the log of the start
   * once its agent exists; a refusal is logged and is `START_REFUSED` with its reason and model, and no
   * agent is made. Only a refusal of the access gate writes an `access_denied` record.
   */
  async function startSnapshot(
    ownerId: string,
    source: StartSource,
    parentId: string | null,
  ): Promise<{ snapshot: RunSnapshot; done: (agentId: string, rootId: string) => void }> {
    const startedAt = Date.now();
    const resolution = await resolveStart({ ownerId, source }, deps);
    const entry = { ownerId, parentId, source: source.kind, resolution, startedAt };
    if (resolution.kind === 'refused') {
      await auditStartRefusal(deps.audit, resolution);
      logStart(logger, { ...entry, rootId: null, agentId: null, refusal: resolution.reason });
      throw new AgentsError('START_REFUSED', `A start from source ${source.kind} is refused: ${resolution.reason}`, {
        refusal: { reason: resolution.reason, model: resolution.model },
      });
    }
    return {
      snapshot: resolution.snapshot,
      done: (agentId, rootId) => logStart(logger, { ...entry, rootId, agentId, refusal: null }),
    };
  }

  /**
   * Where a restart takes its snapshot (KD-2): a record starts anew by its id, as the owner sees it now;
   * an executor and a fork restart on their own snapshot.
   */
  function restartSource(snapshot: RunSnapshot, session: Session): StartSource {
    if (snapshot.kind === 'executor' || session.forkedFromTaskId !== null) {
      return { kind: 'restart', snapshot };
    }
    return { kind: 'record', recordId: snapshot.origin.recordId, expected: snapshot.origin.kind };
  }

  /**
   * Creates a root: its task and its session commit together, so whoever sees the task sees the
   * session, and of two starts with one `agentId` the second waits for the first and is `TASK_EXISTS`.
   */
  async function createRoot(
    ownerId: string,
    input: SessionInput,
    agentId?: string,
  ): Promise<{ agentId: string }> {
    return database.transaction(async (tx) => {
      const taskId = await runtime.tasks.create(
        { type: AGENT_TASK_TYPE, ownerId, input, ...(agentId === undefined ? {} : { taskId: agentId }) },
        tx,
      );
      await sessions.ensureSession(tx, { taskId, ownerId, parentId: null, rootId: taskId }, input);
      return { agentId: taskId };
    });
  }

  /** Creates the agent task under its parent, then its session in its own transaction (plan Notes 11). */
  async function createChild(
    parent: { readonly ownerId: string; readonly parentId: string; readonly rootId: string },
    input: SessionInput,
  ): Promise<{ agentId: string }> {
    const { ownerId, parentId, rootId } = parent;
    const agentId = await asAgent(runtime.tasks.create({ type: AGENT_TASK_TYPE, ownerId, input, parentId }));
    // A worker may take the first step before this: it makes the same session (ON CONFLICT DO NOTHING).
    await database.transaction((tx) =>
      sessions.ensureSession(tx, { taskId: agentId, ownerId, parentId, rootId }, input),
    );
    return { agentId };
  }

  /** Whether an `interrupt` waits in the agent's queue (KD-3); only a queued or running agent can have one. */
  async function pendingInterrupt(task: Task): Promise<boolean> {
    if (task.status !== queued && task.status !== running) return false;
    const pending = await runtime.inbox.listPending(task.taskId, task.ownerId);
    return pending.some((message) => message.kind === interrupt);
  }

  async function view(task: Task, session: Session): Promise<AgentView> {
    return toAgentView(task, session, await pendingInterrupt(task));
  }

  /** The tool calls of the given answers with their state, by answer and position. */
  async function callsOf(
    agentId: string,
    answers: readonly Extract<PageEntry, { kind: 'model_answer' }>[],
    shownClosed: boolean,
  ): Promise<Map<number, AnswerToolCall[]>> {
    const byAnswer = new Map<number, AnswerToolCall[]>();
    const callIds = answers.flatMap((answer) => answer.content.toolCalls.map((call) => call.callId));
    // Only the records of the page's calls are read, by `(task_id, call_id)`; the answers go first.
    const calls = foldCalls([...answers, ...(await history.callRecords(database, agentId, callIds))]);
    const displays = await registry.displays(calls);
    for (const [index, call] of calls.entries()) {
      const ofAnswer = byAnswer.get(call.answerSeq) ?? [];
      ofAnswer.push({
        callId: call.callId,
        tool: call.tool,
        server: call.server,
        args: call.args,
        // A stopped agent's open calls are shown closed (Flow 7): the stop records follow them.
        state: shownClosed ? ToolCallStateSchema.enum.done : call.state,
        ...displays[index],
      });
      byAnswer.set(call.answerSeq, ofAnswer);
    }
    return byAnswer;
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
    start({ agentId, ownerId, prompt, description, record }) {
      return logged(
        'start',
        { agentId: agentId ?? null, ownerId, recordId: record?.id ?? null },
        async () => {
          const started = await startSnapshot(ownerId, { kind: 'builtin', builtinKey: CHAT_BUILTIN_KEY }, null);
          const created = await createRoot(
            ownerId,
            {
              snapshot: started.snapshot,
              prompt,
              description,
              ...(record === undefined ? {} : { record }),
            },
            agentId,
          );
          started.done(created.agentId, created.agentId);
          return created;
        },
        ({ agentId }) => ({ agentId }),
      );
    },

    send({ agentId, ownerId, text, record }) {
      return logged(
        'send',
        { agentId, ownerId, recordId: record?.id ?? null },
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
              payload: {
                ...messagePayload(text, target, parent),
                ...(record === undefined ? {} : { record }),
              },
              revive: true,
            }),
          );
          return { messageId };
        },
        ({ messageId }) => ({ messageId }),
      );
    },

    interrupt({ agentId, ownerId }) {
      return logged(
        'interrupt',
        { agentId, ownerId },
        async () => {
          const task = await agentTask(agentId, ownerId);
          // A free agent (waiting for messages) has no work to cut off: `not_active`, nothing changes (Flow 4).
          if (task.status === waiting && task.waitReason === WaitReasonSchema.enum.messages) return 'not_active';
          // KD-3: the `interrupt` message makes the agent's next step close its calls and wait.
          return asAgent(
            runtime.tasks.interrupt(agentId, ownerId, {
              kind: interrupt,
              sender: ownerId,
              payload: {},
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
          if (!isFinished(task.status)) {
            throw new AgentsError('NOT_FINISHED', `Agent ${agentId} is ${task.status}, not finished`);
          }
          const session = await sessions.get(database, agentId);
          if (session === undefined) throw new Error(`Finished agent ${agentId} has no session`);
          const { snapshot } = sessionInputOf(task.input);
          // AC-09.2: the same assignment and parent on the snapshot of KD-2; the history starts anew,
          // and a restarted fork does not inherit its parent's.
          const started = await startSnapshot(ownerId, restartSource(snapshot, session), task.parentId);
          const input = {
            snapshot: started.snapshot,
            description: session.description,
            prompt: session.prompt,
          };
          const created =
            task.parentId === null
              ? await createRoot(ownerId, input)
              : await createChild({ ownerId, parentId: task.parentId, rootId: task.rootId }, input);
          started.done(created.agentId, task.rootId);
          return created;
        },
        (restarted) => ({ restartedAs: restarted.agentId }),
      );
    },

    snapshot(agentId, ownerId) {
      return logged(
        'snapshot',
        { agentId, ownerId },
        async () => {
          const task = await agentTask(agentId, ownerId);
          return task.type === AGENT_TASK_TYPE ? sessionInputOf(task.input).snapshot : null;
        },
        (snapshot) => ({ kind: snapshot?.kind ?? null }),
      );
    },

    get(agentId, ownerId) {
      return logged(
        'get',
        { agentId, ownerId },
        async () => {
          const task = await agentTask(agentId, ownerId);
          // A child whose session is not written yet (between `tasks.create` and `ensureSession`) is not shown.
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
          const agents = await tree(rootId, ownerId);
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
          const task = await agentTask(agentId, ownerId);
          const isStopped = task.status === stopped;
          const derived = isStopped
            ? await stopEntries(database, { task, parent: await parentOf(task, ownerId) })
            : [];
          // The page is cut by the query after the call records are left out, so a page shorter than
          // `limit` is the end of the history.
          const stored = await history.page(database, agentId, afterSeq, limit);
          const answers = stored.filter((entry) => entry.kind === 'model_answer');
          const calls = await callsOf(agentId, answers, isStopped);
          const page: AgentHistoryEntry[] = stored.map((entry) => {
            if (entry.kind === 'tool_result') return shownResult(entry);
            return entry.kind === 'model_answer'
              ? { ...entry, content: { text: entry.content.text, toolCalls: calls.get(entry.seq) ?? [] } }
              : entry;
          });
          page.push(...derived.filter((entry) => entry.seq > afterSeq));
          return page.slice(0, limit);
        },
        (entries) => ({ entries: entries.length }),
      );
    },

    confirmations(rootId, ownerId) {
      return logged(
        'confirmations',
        { rootId, ownerId },
        async () => {
          // `AGENT_NOT_FOUND` for another owner's or no tree.
          await tree(rootId, ownerId);
          const decisions = await runtime.decisions.listTree(rootId, ownerId);
          const requests = decisions.map((decision) => ({
            decision,
            payload: ConfirmationPayloadSchema.parse(decision.payload),
          }));
          const displays = await registry.displays(requests.map(({ payload }) => payload));
          return requests.map(({ decision, payload }, index): AgentConfirmation => {
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
                resolved === null ? null : { approve: resolved.approve, args: resolved.args ?? payload.args },
              createdAt: decision.createdAt,
              resolvedAt: decision.resolvedAt,
              ...displays[index],
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
          // The edit is checked only against an open request of this owner. For any other one
          // `decisions.resolve` answers `already_resolved` (resolved or cancelled) or
          // `DECISION_NOT_FOUND` (missing or another owner's) and writes nothing.
          const decision =
            args === undefined ? undefined : await runtime.decisions.get(decisionId, ownerId);
          const edited =
            decision?.status === 'open'
              ? { args: editedArgs(ConfirmationPayloadSchema.parse(decision.payload), args) }
              : {};
          // The tool step reads `{ approve, args? }` and the call id from the request's payload.
          return runtime.decisions.resolve(decisionId, ownerId, { approve, ...edited });
        },
        (outcome) => ({ outcome }),
      );
    },

    root(rootId, ownerId) {
      return logged(
        'root',
        { rootId, ownerId },
        () => sessions.root(database, rootId, ownerId),
        (found) => ({ found: found !== undefined }),
      );
    },

    rootOwner(rootId) {
      return logged(
        'rootOwner',
        { rootId },
        () => sessions.rootOwner(database, rootId),
        (ownerId) => ({ ownerId: ownerId ?? null }),
        // The live hub asks on every runtime event of every running agent.
        'debug',
      );
    },

    roots({ ownerId, after, limit }) {
      return logged(
        'roots',
        { ownerId, afterRootId: after?.rootId ?? null, limit: limit ?? null },
        () =>
          sessions.roots(database, ownerId, {
            ...(after === undefined ? {} : { after }),
            ...(limit === undefined ? {} : { limit }),
          }),
        (found) => ({ roots: found.length }),
      );
    },

    touchRoot(rootId, ownerId) {
      return logged('touchRoot', { rootId, ownerId }, () => sessions.touchRoot(database, rootId, ownerId));
    },

    renameRoot(rootId, ownerId, title) {
      return logged(
        'renameRoot',
        { rootId, ownerId },
        () => sessions.renameRoot(database, rootId, ownerId, title),
        (renamed) => ({ found: renamed !== undefined }),
      );
    },

    titleRootIfEmpty(rootId, ownerId, title) {
      return logged(
        'titleRootIfEmpty',
        { rootId, ownerId },
        () => sessions.titleRootIfEmpty(database, rootId, ownerId, title),
        (written) => ({ written }),
      );
    },
  };
}
