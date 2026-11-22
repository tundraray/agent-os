import type { Logger } from '@agent-os/common';
import {
  AGENT_TASK_TYPES,
  AgentMessageKindSchema,
  type AgentTasksView,
  DELEGATION_ANSWER_MAX_CHARS,
  DELEGATION_ITEM_MAX_CHARS,
  type DelegationStatus,
  type DelegationView,
  ToolCallStateSchema,
  TaskStatusSchema,
} from '@agent-os/contracts';
import {
  AgentMessagesRepository,
  AgentSessionsRepository,
  AgentSessionTasksRepository,
  DATABASE,
  type Database,
  type RootSession,
} from '@agent-os/db';
import { Decisions, Inbox, type Task, TaskControl, Trackers, type TrackerTask } from '@agent-os/runtime';
import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';

import { type AgentView, toAgentView } from '../agent-view';
import { ConfirmationResolutionSchema } from '../agent/tool-step';
import { AGENTS_LOGGER } from '../agents.tokens';
import { type DeepAgentRun, readDeepAgentRun } from '../deep/deep-agent-run';
import { foldCalls } from '../history/call-state';
import type { RunSnapshot } from '../start/snapshot';
import { History, type PageEntry } from '../store/history';
import { type Session, sessionInputOf, Sessions } from '../store/sessions';
import { ToolRegistry } from '../tools/tool-registry';
import type {
  AgentConfirmation,
  AgentHistoryEntry,
  AnswerToolCall,
  HistoryRequest,
  RootsRequest,
  ShownResult,
  StoredResult,
} from './agent-sessions';
import { agentNotFound, agentTask, ConfirmationPayloadSchema, createLogged, parentOf } from './operation-support';
import { stopEntries } from './stop-entries';

const { queued, running, stopped, completed, failed } = TaskStatusSchema.enum;
const { interrupt } = AgentMessageKindSchema.enum;

function shownResult(entry: StoredResult): ShownResult {
  const { childTaskId: _childTaskId, ...content } = entry.content;
  return { ...entry, content };
}

/** The report of a completed agent task: `{ report }`. */
const ReportSchema = z.object({ report: z.string() });

/** The status of a delegation (design-task.md, «Запись и маршрут»): the runtime task's, in four. */
function delegationStatus(status: TrackerTask['status']): DelegationStatus {
  switch (status) {
    case completed:
      return 'completed';
    case failed:
      return 'failed';
    case stopped:
      return 'cancelled';
    default:
      return 'running';
  }
}

/** A delegation row: the tracker task, its subagent's session and the task of the list its call named. */
function delegationView(task: TrackerTask, session: Session, listTask: number | null): DelegationView {
  const status = delegationStatus(task.status);
  return {
    agentId: task.taskId,
    subagent: session.origin.subagent ?? session.name,
    item: session.description.slice(0, DELEGATION_ITEM_MAX_CHARS),
    taskId: listTask,
    status,
    answer:
      status === 'completed' ? ReportSchema.parse(task.result).report.slice(0, DELEGATION_ANSWER_MAX_CHARS) : null,
    reason: status === 'failed' ? (task.failure?.reason ?? null) : null,
  };
}

/**
 * The operations that only read: an agent, its tree, history, confirmations, task list and run view, and the
 * owner's root sessions.
 */
@Injectable()
export class ViewOperations {
  private readonly logged: ReturnType<typeof createLogged>;

  constructor(
    @Inject(DATABASE) private readonly database: Database,
    /** The sessions, the history and the task lists the operations read after the runtime's owner check. */
    @Inject(Sessions) private readonly sessions: Sessions,
    @Inject(AgentSessionsRepository) private readonly sessionRows: AgentSessionsRepository,
    @Inject(History) private readonly entries: History,
    @Inject(AgentMessagesRepository) private readonly messageRows: AgentMessagesRepository,
    @Inject(AgentSessionTasksRepository) private readonly sessionTaskRows: AgentSessionTasksRepository,
    @Inject(TaskControl) private readonly tasks: Pick<TaskControl, 'get' | 'listTree'>,
    @Inject(Inbox) private readonly inbox: Pick<Inbox, 'listPending'>,
    @Inject(Decisions) private readonly decisions: Pick<Decisions, 'listTree'>,
    @Inject(Trackers) private readonly trackers: Pick<Trackers, 'list'>,
    @Inject(ToolRegistry) private readonly registry: Pick<ToolRegistry, 'displays'>,
    @Inject(AGENTS_LOGGER) logger: Logger,
  ) {
    this.logged = createLogged(logger.child({ service: 'agents.sessions' }));
  }

  /** The run's snapshot, for the view of a run; `null` when the task is not an agent. */
  snapshot(agentId: string, ownerId: string): Promise<RunSnapshot | null> {
    return this.logged(
      'snapshot',
      { agentId, ownerId },
      async () => {
        const task = await agentTask(this.tasks, agentId, ownerId);
        return AGENT_TASK_TYPES.includes(task.type) ? sessionInputOf(task.input).snapshot : null;
      },
      (snapshot) => ({ kind: snapshot?.kind ?? null }),
    );
  }

  get(agentId: string, ownerId: string): Promise<AgentView> {
    return this.logged(
      'get',
      { agentId, ownerId },
      async () => {
        const task = await agentTask(this.tasks, agentId, ownerId);
        // A child whose session is not written yet (between `tasks.create` and `ensureSession`) is not shown.
        const session = await this.sessions.get(this.database, agentId);
        if (session === undefined) throw agentNotFound(agentId);
        return this.view(task, session);
      },
      ({ status }) => ({ status }),
    );
  }

  list(rootId: string, ownerId: string): Promise<AgentView[]> {
    return this.logged(
      'list',
      { rootId, ownerId },
      async () => {
        const agents = await this.tree(rootId, ownerId);
        const found = await this.sessions.getMany(
          this.database,
          agents.map((task) => task.taskId),
        );
        const views: AgentView[] = [];
        for (const task of agents) {
          const session = found.get(task.taskId);
          if (session !== undefined) views.push(await this.view(task, session));
        }
        return views;
      },
      (views) => ({ agents: views.length }),
    );
  }

  history({ agentId, ownerId, afterSeq = 0, limit }: HistoryRequest): Promise<AgentHistoryEntry[]> {
    return this.logged(
      'history',
      { agentId, ownerId, afterSeq, limit },
      async () => {
        const task = await agentTask(this.tasks, agentId, ownerId);
        const isStopped = task.status === stopped;
        const derived = isStopped
          ? await stopEntries({ history: this.entries, messageRows: this.messageRows }, this.database, {
              task,
              parent: await parentOf(this.tasks, task, ownerId),
            })
          : [];
        // The page is cut by the query after the call records are left out, so a page shorter than
        // `limit` is the end of the history.
        const stored = await this.entries.page(this.database, agentId, afterSeq, limit);
        const answers = stored.filter((entry) => entry.kind === 'model_answer');
        const calls = await this.callsOf(agentId, answers, isStopped);
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
  }

  confirmations(rootId: string, ownerId: string): Promise<AgentConfirmation[]> {
    return this.logged(
      'confirmations',
      { rootId, ownerId },
      async () => {
        // `AGENT_NOT_FOUND` for another owner's or no tree.
        await this.tree(rootId, ownerId);
        const decisions = await this.decisions.listTree(rootId, ownerId);
        const requests = decisions.map((decision) => ({
          decision,
          payload: ConfirmationPayloadSchema.parse(decision.payload),
        }));
        const displays = await this.registry.displays(requests.map(({ payload }) => payload));
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
  }

  /**
   * The task list of the session by number (design-task-list.md, `GET /api/agents/:agentId/tasks`), the root
   * included, and the tasks of its trackers in order (design-task.md, «Запись и маршрут»); each empty when there
   * is none. A missing and another owner's agent are alike `AGENT_NOT_FOUND`.
   */
  taskList(agentId: string, ownerId: string): Promise<AgentTasksView> {
    return this.logged(
      'taskList',
      { agentId, ownerId },
      async () => {
        // The owner check first: the list is read only for the owner's session (AC-17.1).
        await agentTask(this.tasks, agentId, ownerId);
        const [tasks, delegations] = await Promise.all([
          this.sessionTaskRows.list(this.database, agentId),
          this.delegationsOf(agentId, ownerId),
        ]);
        return {
          delegations,
          tasks: tasks.map((task) => ({
            id: task.number,
            subject: task.subject,
            description: task.description,
            activeForm: task.activeForm,
            status: task.status,
            owner: task.owner,
            blockedBy: [...task.blockedBy],
          })),
        };
      },
      (view) => ({ tasks: view.tasks.length, delegations: view.delegations.length }),
    );
  }

  /**
   * The run view of a deep agent (deep-agents KD-2): its record, brief, team, steps and limit refusals.
   * A missing agent, another owner's and one that is not a deep agent are alike `RUN_NOT_FOUND`.
   */
  run(agentId: string, ownerId: string): Promise<DeepAgentRun> {
    return this.logged(
      'run',
      { agentId, ownerId },
      () => readDeepAgentRun(this, agentId, ownerId),
      (run) => ({ steps: run.steps.length, limitRefusals: run.limitRefusals.length }),
    );
  }

  /**
   * The owner's root session — the conversation the employee sees; `undefined` for a missing one,
   * another owner's and a session that is not a root.
   */
  root(rootId: string, ownerId: string): Promise<RootSession | undefined> {
    return this.logged(
      'root',
      { rootId, ownerId },
      () => this.sessionRows.root(this.database, rootId, ownerId),
      (found) => ({ found: found !== undefined }),
    );
  }

  /** The owner of a root session, whoever it is: for a signal of a tree that carries no owner. */
  rootOwner(rootId: string): Promise<string | undefined> {
    return this.logged(
      'rootOwner',
      { rootId },
      () => this.sessionRows.rootOwner(this.database, rootId),
      (ownerId) => ({ ownerId: ownerId ?? null }),
      // The live hub asks on every runtime event of every running agent.
      'debug',
    );
  }

  /** The owner's root sessions, last changed first (`updatedAt` DESC, then `rootId` DESC). */
  roots({ ownerId, after, limit }: RootsRequest): Promise<RootSession[]> {
    return this.logged(
      'roots',
      { ownerId, afterRootId: after?.rootId ?? null, limit: limit ?? null },
      () =>
        this.sessionRows.roots(this.database, ownerId, {
          ...(after === undefined ? {} : { after }),
          ...(limit === undefined ? {} : { limit }),
        }),
      (found) => ({ roots: found.length }),
    );
  }

  /** The owner's tree; `AGENT_NOT_FOUND` for another owner's or no tree. */
  private async tree(rootId: string, ownerId: string): Promise<Task[]> {
    const tasks = await this.tasks.listTree(rootId, ownerId);
    if (tasks.length === 0) throw agentNotFound(rootId);
    return tasks;
  }

  /**
   * The tasks of the agent's trackers in order, each with its subagent's session and the task of the list its
   * `task` call named (the call's `tool_sent`). A task whose session is not written yet is left out.
   */
  private async delegationsOf(agentId: string, ownerId: string): Promise<DelegationView[]> {
    const trackers = await this.trackers.list(agentId, ownerId);
    const tasks = trackers.flatMap((tracker) => tracker.tasks);
    if (tasks.length === 0) return [];
    const [found, entries] = await Promise.all([
      this.sessions.getMany(
        this.database,
        tasks.map((task) => task.taskId),
      ),
      this.entries.all(this.database, agentId),
    ]);
    const listTaskOf = new Map<string, number>();
    for (const entry of entries) {
      if (entry.kind !== 'tool_sent' || entry.content.taskId === undefined) continue;
      for (const taskId of entry.content.taskIds ?? []) listTaskOf.set(taskId, entry.content.taskId);
    }
    return tasks.flatMap((task) => {
      const session = found.get(task.taskId);
      return session === undefined ? [] : [delegationView(task, session, listTaskOf.get(task.taskId) ?? null)];
    });
  }

  /** Whether an `interrupt` waits in the agent's queue (KD-3); only a queued or running agent can have one. */
  private async pendingInterrupt(task: Task): Promise<boolean> {
    if (task.status !== queued && task.status !== running) return false;
    const pending = await this.inbox.listPending(task.taskId, task.ownerId);
    return pending.some((message) => message.kind === interrupt);
  }

  private async view(task: Task, session: Session): Promise<AgentView> {
    return toAgentView(task, session, await this.pendingInterrupt(task));
  }

  /** The tool calls of the given answers with their state, by answer and position. */
  private async callsOf(
    agentId: string,
    answers: readonly Extract<PageEntry, { kind: 'model_answer' }>[],
    shownClosed: boolean,
  ): Promise<Map<number, AnswerToolCall[]>> {
    const byAnswer = new Map<number, AnswerToolCall[]>();
    const callIds = answers.flatMap((answer) => answer.content.toolCalls.map((call) => call.callId));
    // Only the records of the page's calls are read, by `(task_id, call_id)`; the answers go first.
    const calls = foldCalls([...answers, ...(await this.entries.callRecords(this.database, agentId, callIds))]);
    const displays = await this.registry.displays(calls);
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
}
