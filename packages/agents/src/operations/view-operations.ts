import type { Logger } from '@agent-os/common';
import {
  AGENT_TASK_TYPES,
  AgentMessageKindSchema,
  type AgentVersion,
  type AgentTasksView,
  type ConfirmationStatus,
  type DeepAgentContent,
  DELEGATION_ANSWER_MAX_CHARS,
  DELEGATION_ITEM_MAX_CHARS,
  type DelegationStatus,
  type DelegationView,
  scriptNameOf,
  ToolCallStateSchema,
  TaskStatusSchema,
  WaitReasonSchema,
} from '@agent-os/contracts';
import {
  MessagesRepository,
  ConversationsRepository,
  ConversationTasksRepository,
} from '@agent-os/db';
import { Inbox, type Task, TaskControl } from '@agent-os/runtime';
import { Inject, Injectable } from '@nestjs/common';

import { type AgentView, toAgentView } from '../agent-view';
import { reportOf } from '../agent/deliver';
import { ConfirmationResolutionSchema } from '../agent/tool-step';
import { AGENTS_LOGGER, RECORD_LIBRARY } from '../agents.tokens';
import { type DeepAgentRun, readDeepAgentRun } from '../deep/deep-agent-run';
import { foldCalls } from '../history/call-state';
import type { RecordLibrary } from '../start/record-library';
import { History, type PageEntry } from '../store/history';
import {
  type RootSession,
  type Session,
  Sessions,
  toRootSession,
} from '../store/sessions';
import type { ToolDisplay } from '../tools/tool';
import { ToolRegistry, type ToolTarget } from '../tools/tool-registry';
import type {
  AgentConfirmation,
  AgentHistoryEntry,
  AnswerToolCall,
  HistoryRequest,
  RootsRequest,
  ShownResult,
  StoredResult,
} from './agent-sessions';
import {
  agentNotFound,
  agentTask,
  createLogged,
  parentOf,
  QuestionInputSchema,
} from './operation-support';
import { stopEntries } from './stop-entries';
import { agentOwner } from '../agent/agent-owner';
import { agentTasksOf, hasOpenQuestion, isQuestion } from '../task-tree';

const { queued, running, waiting, stopped, completed, failed } =
  TaskStatusSchema.enum;
const { children } = WaitReasonSchema.enum;
const { interrupt } = AgentMessageKindSchema.enum;

function shownResult(entry: StoredResult): ShownResult {
  const { childTaskId: _childTaskId, ...content } = entry.content;
  return { ...entry, content };
}

/** The status of a delegation (design-task.md, «Запись и маршрут»): the runtime task's, in four. */
function delegationStatus(status: Task['status']): DelegationStatus {
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

/** The status of a confirmation from its question task: open while it waits, cancelled when stopped. */
function confirmationStatus(status: Task['status']): ConfirmationStatus {
  switch (status) {
    case completed:
      return 'resolved';
    case stopped:
    case failed:
      return 'cancelled';
    default:
      return 'open';
  }
}

/** A delegation row: the subagent's task, its session and the task of the list its call named. */
function delegationView(
  task: Task,
  session: Session,
  listTask: number | null,
): DelegationView {
  const status = delegationStatus(task.status);
  return {
    agentId: task.taskId,
    subagent: session.origin.subagent ?? session.name,
    item: session.description.slice(0, DELEGATION_ITEM_MAX_CHARS),
    taskId: listTask,
    status,
    answer:
      status === 'completed'
        ? reportOf(task.result).slice(0, DELEGATION_ANSWER_MAX_CHARS)
        : null,
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
    /** The sessions, the history and the task lists the operations read after the runtime's owner check. */
    @Inject(Sessions) private readonly sessions: Sessions,
    @Inject(ConversationsRepository)
    private readonly sessionRows: ConversationsRepository,
    @Inject(History) private readonly entries: History,
    @Inject(MessagesRepository)
    private readonly messageRows: MessagesRepository,
    @Inject(ConversationTasksRepository)
    private readonly sessionTaskRows: ConversationTasksRepository,
    @Inject(TaskControl)
    private readonly tasks: Pick<TaskControl, 'get' | 'listTree'>,
    @Inject(Inbox) private readonly inbox: Pick<Inbox, 'listPending'>,
    @Inject(ToolRegistry)
    private readonly registry: Pick<ToolRegistry, 'displays'>,
    /** The version a run's session names, for the view of a run. */
    @Inject(RECORD_LIBRARY)
    private readonly library: Pick<RecordLibrary, 'version'>,
    @Inject(AGENTS_LOGGER) logger: Logger,
  ) {
    this.logged = createLogged(logger.child({ service: 'agents.sessions' }));
  }

  /**
   * The version the agent runs on and the team member it is, read from its session (KD-8), for the view of a
   * run; `null` when the task is not an agent.
   */
  version(
    agentId: string,
    ownerId: string,
  ): Promise<{ version: AgentVersion; subagent: string | null } | null> {
    return this.logged(
      'version',
      { agentId, ownerId },
      async () => {
        const task = await agentTask(this.tasks, agentId, ownerId);
        if (!AGENT_TASK_TYPES.includes(task.type)) return null;
        const session = await this.sessions.get(agentId);
        if (session === undefined)
          throw new Error(`Agent ${agentId} has no session`);
        return {
          version: await this.library.version(session.versionId),
          subagent: session.origin.subagent,
        };
      },
      (run) => ({
        versionId: run?.version.id ?? null,
        kind: run?.version.kind ?? null,
      }),
    );
  }

  get(agentId: string, ownerId: string): Promise<AgentView> {
    return this.logged(
      'get',
      { agentId, ownerId },
      async () => {
        const task = await agentTask(this.tasks, agentId, ownerId);
        // A task without a session — not an agent's, or a defect (KD-8) — is not shown.
        const session = await this.sessions.get(agentId);
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
        const tree = await this.tree(rootId, ownerId);
        const agents = agentTasksOf(tree);
        const found = await this.sessions.getMany(
          agents.map((task) => task.taskId),
        );
        const views: AgentView[] = [];
        for (const task of agents) {
          const session = found.get(task.taskId);
          if (session !== undefined)
            views.push(await this.view(task, session, tree));
        }
        return views;
      },
      (views) => ({ agents: views.length }),
    );
  }

  history({
    agentId,
    ownerId,
    afterSeq = 0,
    limit,
  }: HistoryRequest): Promise<AgentHistoryEntry[]> {
    return this.logged(
      'history',
      { agentId, ownerId, afterSeq, limit },
      async () => {
        const task = await agentTask(this.tasks, agentId, ownerId);
        const isStopped = task.status === stopped;
        const derived = isStopped
          ? await stopEntries(
              { history: this.entries, messageRows: this.messageRows },
              {
                task,
                parent: await parentOf(this.tasks, task, ownerId),
              },
            )
          : [];
        // The page is cut by the query after the call records are left out, so a page shorter than
        // `limit` is the end of the history.
        const stored = await this.entries.page(agentId, afterSeq, limit);
        const answers = stored.filter((entry) => entry.kind === 'model_answer');
        const calls = await this.callsOf(agentId, answers, isStopped);
        const page: AgentHistoryEntry[] = stored.map((entry) => {
          if (entry.kind === 'tool_result') return shownResult(entry);
          return entry.kind === 'model_answer'
            ? {
                ...entry,
                content: {
                  text: entry.content.text,
                  toolCalls: calls.get(entry.seq) ?? [],
                },
              }
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
        // `AGENT_NOT_FOUND` for another owner's or no tree. A confirmation is a question task of the tree
        // (data-model/design-runtime.md, KD-3): its input is the request, its result the decision.
        const questions = (await this.tree(rootId, ownerId)).filter(isQuestion);
        const requests = questions.map((question) => ({
          question,
          ...QuestionInputSchema.parse(question.input),
        }));
        const displays = await this.withScripts(
          requests.map(({ payload }) => payload),
        );
        return requests.map(
          ({ question, kind, payload }, index): AgentConfirmation => {
            const status = confirmationStatus(question.status);
            const resolved =
              status === 'resolved'
                ? ConfirmationResolutionSchema.parse(question.result)
                : null;
            return {
              decisionId: question.taskId,
              agentId: payload.agentId,
              description: payload.description,
              kind,
              tool: payload.tool,
              server: payload.server,
              args: payload.args,
              content: payload.content,
              status,
              resolution:
                resolved === null
                  ? null
                  : {
                      approve: resolved.approve,
                      args: resolved.args ?? payload.args,
                    },
              createdAt: question.createdAt,
              resolvedAt: status === 'resolved' ? question.finishedAt : null,
              ...displays[index],
            };
          },
        );
      },
      (confirmations) => ({ confirmations: confirmations.length }),
    );
  }

  /**
   * The task list of the session by number (design-task-list.md, `GET /api/agents/:agentId/tasks`), the root
   * included, and its delegations in call order (design-task.md, «Запись и маршрут»); each empty when there
   * is none. A missing and another owner's agent are alike `AGENT_NOT_FOUND`.
   */
  taskList(agentId: string, ownerId: string): Promise<AgentTasksView> {
    return this.logged(
      'taskList',
      { agentId, ownerId },
      async () => {
        // The owner check first: the list is read only for the owner's session (AC-17.1).
        const agent = await agentTask(this.tasks, agentId, ownerId);
        const [tasks, delegations] = await Promise.all([
          this.sessionTaskRows.list(agentId),
          this.delegationsOf(agent, ownerId),
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
      (view) => ({
        tasks: view.tasks.length,
        delegations: view.delegations.length,
      }),
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
      (run) => ({
        steps: run.steps.length,
        limitRefusals: run.limitRefusals.length,
      }),
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
      async () => {
        const row = await this.sessionRows.root(rootId, ownerId);
        return row === undefined ? undefined : toRootSession(row);
      },
      (found) => ({ found: found !== undefined }),
    );
  }

  /** The owner of a root session, whoever it is: for a signal of a tree that carries no owner. */
  rootOwner(rootId: string): Promise<string | undefined> {
    return this.logged(
      'rootOwner',
      { rootId },
      () => this.sessionRows.rootOwner(rootId),
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
      async () => {
        const rows = await this.sessionRows.roots(ownerId, {
          ...(after === undefined ? {} : { after }),
          ...(limit === undefined ? {} : { limit }),
        });
        return rows.map(toRootSession);
      },
      (found) => ({ roots: found.length }),
    );
  }

  /** The owner's live forks of the conversation, newest first. */
  forks(rootId: string, ownerId: string): Promise<RootSession[]> {
    return this.logged(
      'forks',
      { rootId, ownerId },
      async () =>
        (await this.sessionRows.forks(rootId, ownerId)).map(toRootSession),
      (found) => ({ forks: found.length }),
    );
  }

  /** The owner's tree; `AGENT_NOT_FOUND` for another owner's or no tree. */
  private async tree(rootId: string, ownerId: string): Promise<Task[]> {
    const tasks = await this.tasks.listTree(rootId, ownerId);
    if (tasks.length === 0) throw agentNotFound(rootId);
    return tasks;
  }

  /**
   * The delegations of an agent (data-model/design-runtime.md, «Делегирования»): the children in `taskIds` of
   * every `tool_sent` of its `task` calls, in call order, with the status, answer and reason of their tasks from
   * the tree and the task of the list the call named. The calls are found through the children's sessions,
   * which keep the call that started them; a child whose session is not written yet is left out.
   */
  private async delegationsOf(
    agent: Task,
    ownerId: string,
  ): Promise<DelegationView[]> {
    const tree = await this.tasks.listTree(agent.rootId, ownerId);
    const children = tree.filter((task) => task.parentId === agent.taskId);
    if (children.length === 0) return [];
    const found = await this.sessions.getMany(
      children.map((task) => task.taskId),
    );
    const callIds = new Set(
      [...found.values()].flatMap((session) =>
        session.startCallId === null ? [] : [session.startCallId],
      ),
    );
    const records = await this.entries.callRecords(agent.taskId, [...callIds]);
    const byId = new Map(children.map((task) => [task.taskId, task]));
    return records.flatMap((record) => {
      if (record.kind !== 'tool_sent') return [];
      const listTask = record.content.taskId ?? null;
      return (record.content.taskIds ?? []).flatMap((childId) => {
        const task = byId.get(childId);
        const session = found.get(childId);
        return task === undefined || session === undefined
          ? []
          : [delegationView(task, session, listTask)];
      });
    });
  }

  /** Whether an `interrupt` waits in the agent's queue (KD-3); only a queued or running agent can have one. */
  private async pendingInterrupt(task: Task): Promise<boolean> {
    if (task.status !== queued && task.status !== running) return false;
    const pending = await this.inbox.listPending(task.taskId, agentOwner(task));
    return pending.some((message) => message.kind === interrupt);
  }

  /**
   * Whether a question of the agent waits for the employee (data-model/design-runtime.md, «Статус агента»); only
   * an agent waiting for its children can have one. `tree` — the agent's tree when the caller has read it.
   */
  private async openQuestion(
    task: Task,
    tree?: readonly Task[],
  ): Promise<boolean> {
    if (task.status !== waiting || task.waitReason !== children) return false;
    const tasks =
      tree ?? (await this.tasks.listTree(task.rootId, agentOwner(task)));
    return hasOpenQuestion(tasks, task.taskId);
  }

  private async view(
    task: Task,
    session: Session,
    tree?: readonly Task[],
  ): Promise<AgentView> {
    return toAgentView(task, session, {
      pendingInterrupt: await this.pendingInterrupt(task),
      openQuestion: await this.openQuestion(task, tree),
    });
  }

  /**
   * How the given calls read for the employee (`ToolRegistry.displays`), with a saved script's description as
   * the `toolTitle` and its code as the `scriptCode` of its call (self-learning scripts, «История и веб»): from
   * the version of the calling agent's session, read once per agent; the history never holds them.
   */
  private async withScripts(
    calls: readonly (ToolTarget & { readonly agentId: string })[],
  ): Promise<ToolDisplay[]> {
    const displays = await this.registry.displays(calls);
    const scripts = new Map<string, Promise<DeepAgentContent['scripts']>>();
    const scriptsOf = (agentId: string) => {
      const found = scripts.get(agentId) ?? this.versionScripts(agentId);
      scripts.set(agentId, found);
      return found;
    };
    return Promise.all(
      calls.map(async (call, index): Promise<ToolDisplay> => {
        const display = displays[index];
        const name = scriptNameOf(call.tool, call.server);
        if (name === null) return display;
        const script = (await scriptsOf(call.agentId)).find(
          (candidate) => candidate.name === name,
        );
        return script === undefined
          ? display
          : {
              ...display,
              toolTitle: script.description,
              scriptCode: script.code,
            };
      }),
    );
  }

  /** The scripts of the version the agent's session names; none for a version that is not a deep agent's. */
  private async versionScripts(
    agentId: string,
  ): Promise<DeepAgentContent['scripts']> {
    const session = await this.sessions.get(agentId);
    if (session === undefined)
      throw new Error(`Agent ${agentId} has no session`);
    const version = await this.library.version(session.versionId);
    return version.kind === 'deep_agent' ? version.content.scripts : [];
  }

  /** The tool calls of the given answers with their state, by answer and position. */
  private async callsOf(
    agentId: string,
    answers: readonly Extract<PageEntry, { kind: 'model_answer' }>[],
    shownClosed: boolean,
  ): Promise<Map<number, AnswerToolCall[]>> {
    const byAnswer = new Map<number, AnswerToolCall[]>();
    const callIds = answers.flatMap((answer) =>
      answer.content.toolCalls.map((call) => call.callId),
    );
    // Only the records of the page's calls are read, by `(conversation_id, call_id)`; the answers go first.
    const calls = foldCalls([
      ...answers,
      ...(await this.entries.callRecords(agentId, callIds)),
    ]);
    const displays = await this.withScripts(
      calls.map((call) => ({ ...call, agentId })),
    );
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
