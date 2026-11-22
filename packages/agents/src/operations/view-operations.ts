import {
  AGENT_TASK_TYPES,
  AgentMessageKindSchema,
  DELEGATION_ANSWER_MAX_CHARS,
  DELEGATION_ITEM_MAX_CHARS,
  type DelegationStatus,
  type DelegationView,
  ToolCallStateSchema,
  TaskStatusSchema,
} from '@agent-os/contracts';
import type { Task, TrackerTask } from '@agent-os/runtime';
import { z } from 'zod';

import { type AgentView, toAgentView } from '../agent-view';
import { ConfirmationResolutionSchema } from '../agent/tool-step';
import { readDeepAgentRun } from '../deep/deep-agent-run';
import { foldCalls } from '../history/call-state';
import { history, type PageEntry } from '../store/history.repository';
import { sessionTasks } from '../store/session-tasks.repository';
import { type Session, sessionInputOf, sessions } from '../store/sessions.repository';
import type {
  AgentConfirmation,
  AgentHistoryEntry,
  AgentSessions,
  AnswerToolCall,
  ShownResult,
  StoredResult,
} from './agent-sessions';
import {
  agentNotFound,
  type AgentSessionsDeps,
  agentTask,
  ConfirmationPayloadSchema,
  createLogged,
  parentOf,
} from './operation-support';
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
export function createViewOperations(
  deps: AgentSessionsDeps,
): Pick<
  AgentSessions,
  | 'snapshot'
  | 'get'
  | 'list'
  | 'history'
  | 'confirmations'
  | 'taskList'
  | 'run'
  | 'root'
  | 'rootOwner'
  | 'roots'
> {
  const { database, runtime, registry } = deps;
  const logged = createLogged(deps.logger);

  /** The owner's tree; `AGENT_NOT_FOUND` for another owner's or no tree. */
  async function tree(rootId: string, ownerId: string): Promise<Task[]> {
    const tasks = await runtime.tasks.listTree(rootId, ownerId);
    if (tasks.length === 0) throw agentNotFound(rootId);
    return tasks;
  }

  /**
   * The tasks of the agent's trackers in order, each with its subagent's session and the task of the list its
   * `task` call named (the call's `tool_sent`). A task whose session is not written yet is left out.
   */
  async function delegationsOf(agentId: string, ownerId: string): Promise<DelegationView[]> {
    const trackers = await runtime.trackers.list(agentId, ownerId);
    const tasks = trackers.flatMap((tracker) => tracker.tasks);
    if (tasks.length === 0) return [];
    const [found, entries] = await Promise.all([
      sessions.getMany(
        database,
        tasks.map((task) => task.taskId),
      ),
      history.all(database, agentId),
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

  const operations: ReturnType<typeof createViewOperations> = {
    snapshot(agentId, ownerId) {
      return logged(
        'snapshot',
        { agentId, ownerId },
        async () => {
          const task = await agentTask(runtime, agentId, ownerId);
          return AGENT_TASK_TYPES.includes(task.type) ? sessionInputOf(task.input).snapshot : null;
        },
        (snapshot) => ({ kind: snapshot?.kind ?? null }),
      );
    },

    get(agentId, ownerId) {
      return logged(
        'get',
        { agentId, ownerId },
        async () => {
          const task = await agentTask(runtime, agentId, ownerId);
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
          const task = await agentTask(runtime, agentId, ownerId);
          const isStopped = task.status === stopped;
          const derived = isStopped
            ? await stopEntries(database, { task, parent: await parentOf(runtime, task, ownerId) })
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

    taskList(agentId, ownerId) {
      return logged(
        'taskList',
        { agentId, ownerId },
        async () => {
          // The owner check first: the list is read only for the owner's session (AC-17.1).
          await agentTask(runtime, agentId, ownerId);
          const [tasks, delegations] = await Promise.all([
            sessionTasks.list(database, agentId),
            delegationsOf(agentId, ownerId),
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
    },

    run(agentId, ownerId) {
      return logged(
        'run',
        { agentId, ownerId },
        () => readDeepAgentRun(operations, agentId, ownerId),
        (run) => ({ steps: run.steps.length, limitRefusals: run.limitRefusals.length }),
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
  };
  return operations;
}
