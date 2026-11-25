import type { Logger } from '@agent-os/common';
import {
  CHAT_BUILTIN_KEY,
  CHAT_TASK_TYPE,
  THREAD_TITLE_MAX_LENGTH,
} from '@agent-os/contracts';
import {
  ConversationsRepository,
  ConversationTasksRepository,
  Db,
  MessagesRepository,
  ToolResultsRepository,
} from '@agent-os/db';
import { isFinished, LiveTasks, TaskControl } from '@agent-os/runtime';
import { Inject, Injectable } from '@nestjs/common';

import type { AccessAudit, AccessGate } from '../access-gate';
import { AgentFactory, childTypeOf } from '../agent/agent-factory';
import {
  ACCESS_AUDIT,
  ACCESS_GATE,
  AGENTS_LOGGER,
  RECORD_LIBRARY,
} from '../agents.tokens';
import { AgentsError } from '../errors';
import { AgentsProviders } from '../providers/provider-registry';
import type { RecordLibrary } from '../start/record-library';
import {
  auditStartRefusal,
  chainModel,
  resolveStart,
  type StartSource,
} from '../start/resolve-start';
import type { RunStart } from '../start/run-definition';
import { History } from '../store/history';
import { type Session, Sessions, type SessionStart } from '../store/sessions';
import { logStart } from '../tools/system/start-child';
import { inTrainingTree } from '../training/training-tree';
import type { AgentRef, ForkResult, StartRequest } from './agent-sessions';
import {
  copyHistory,
  type CopyHistoryDeps,
  forkTitle,
  readForkRefusal,
} from './fork-history';
import {
  type AgentCreationDeps,
  agentNotFound,
  agentTask,
  asAgent,
  createAgent,
  createLogged,
} from './operation-support';

/**
 * Where a restart takes its version (data-model design-agents.md, «Старт: версия, имя и модель беседы»): an
 * agent or a root starts anew on the active version of the same agent, as the owner sees it now, under the
 * restarted conversation's name; a subagent and a forked child restart on the version, name and model of the
 * restarted conversation. A forked root starts anew like any root.
 */
function restartSource(run: RunStart, session: Session): StartSource {
  if (
    run.subagent !== null ||
    (session.parentId !== null && session.forkedThroughSeq !== null)
  ) {
    return { kind: 'restart', run };
  }
  return {
    kind: 'record',
    recordId: run.version.agentId,
    expected: run.version.kind,
    name: run.name,
  };
}

/**
 * The operations that make an agent: the start of a conversation's root, the restart of a finished agent and
 * the fork of a conversation.
 */
@Injectable()
export class StartOperations {
  private readonly logger: Logger;
  private readonly logged: ReturnType<typeof createLogged>;
  private readonly creation: AgentCreationDeps;
  private readonly copying: CopyHistoryDeps;

  constructor(
    @Inject(Db) db: Db,
    @Inject(Sessions) private readonly sessions: Sessions,
    /** A restart repeats the assignment of the restarted session's `task` entry (KD-6); a fork copies the history. */
    @Inject(History) private readonly history: History,
    @Inject(TaskControl)
    private readonly tasks: Pick<TaskControl, 'create' | 'get' | 'listTree'>,
    @Inject(ConversationsRepository)
    private readonly sessionRows: ConversationsRepository,
    @Inject(MessagesRepository) messageRows: MessagesRepository,
    @Inject(ToolResultsRepository) toolResultRows: ToolResultsRepository,
    @Inject(ConversationTasksRepository)
    sessionTaskRows: ConversationTasksRepository,
    @Inject(LiveTasks) liveTasks: Pick<LiveTasks, 'adopt'>,
    /** `resolveStart` asks it for the agent of a start or a restart; a restart reads the restarted version. */
    @Inject(RECORD_LIBRARY) private readonly library: RecordLibrary,
    @Inject(ACCESS_GATE) private readonly access: AccessGate,
    /** `resolveStart` asks it whether the model of a start has a ready provider (model-providers KD-2). */
    @Inject(AgentsProviders)
    private readonly providers: Pick<AgentsProviders, 'connection'>,
    @Inject(ACCESS_AUDIT) private readonly audit: AccessAudit,
    /** Makes the object of a started agent with its session, in the transaction that creates its task. */
    @Inject(AgentFactory) factory: Pick<AgentFactory, 'createIn'>,
    @Inject(AGENTS_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'agents.sessions' });
    this.logged = createLogged(this.logger);
    this.creation = { db, tasks, factory, liveTasks };
    this.copying = {
      history,
      messageRows,
      toolResultRows,
      sessionTaskRows,
      sessionRows,
      logger: this.logger,
    };
  }

  /**
   * Starts a conversation's root — a chat. A schedule's start carries its mark, which goes to the root's `task`
   * entry, and the title, written in the transaction that creates the root (schedules KD-5, KD-6).
   */
  start({
    agentId,
    ownerId,
    prompt,
    description,
    record,
    schedule,
    title,
  }: StartRequest): Promise<{ agentId: string }> {
    return this.logged(
      'start',
      {
        agentId: agentId ?? null,
        ownerId,
        recordId: record?.id ?? null,
        scheduleId: schedule?.scheduleId ?? null,
      },
      async () => {
        const started = await this.startRun(
          ownerId,
          { kind: 'builtin', builtinKey: CHAT_BUILTIN_KEY },
          { parentId: null, callerModel: null },
        );
        const created = await this.createRoot(
          ownerId,
          {
            run: started.run,
            prompt,
            description,
            ...(record === undefined ? {} : { record }),
            ...(schedule === undefined ? {} : { schedule }),
          },
          {
            ...(agentId === undefined ? {} : { agentId }),
            ...(title === undefined
              ? {}
              : {
                  after: async (rootId: string) => {
                    await this.sessionRows.titleRootIfEmpty(
                      rootId,
                      ownerId,
                      title.slice(0, THREAD_TITLE_MAX_LENGTH),
                    );
                  },
                }),
          },
        );
        started.done(created.agentId, created.agentId);
        return created;
      },
      ({ agentId }) => ({ agentId }),
    );
  }

  /**
   * The model a new chat conversation of the owner would start on (schedules KD-4), by the chain of a root's
   * start (KD-3): the chat version's model, else the system model — a root has no caller. Nothing is started
   * and the model's rights are not checked: the caller asks the access gate itself. `null` while neither is
   * set — the start would be refused `model_not_configured`.
   */
  newChatModel(ownerId: string): Promise<string | null> {
    return this.logged(
      'newChatModel',
      { ownerId },
      async () => {
        const chat = await this.library.resolveBuiltin(CHAT_BUILTIN_KEY);
        return chainModel(chat.content.model, null, this.access);
      },
      (model) => ({ model }),
    );
  }

  restart({ agentId, ownerId }: AgentRef): Promise<{ agentId: string }> {
    return this.logged(
      'restart',
      { agentId, ownerId },
      async () => {
        const task = await agentTask(this.tasks, agentId, ownerId);
        // A training tree is not resumed (self-learning design-training.md KD-3, place 5).
        if (await inTrainingTree(this.tasks, task))
          throw agentNotFound(agentId);
        if (!isFinished(task.status)) {
          throw new AgentsError(
            'NOT_FINISHED',
            `Agent ${agentId} is ${task.status}, not finished`,
          );
        }
        const session = await this.sessions.get(agentId);
        if (session === undefined)
          throw new Error(`Finished agent ${agentId} has no session`);
        const restarted: RunStart = {
          version: await this.library.version(session.versionId),
          name: session.name,
          subagent: session.origin.subagent,
          model: session.model,
        };
        // AC-09.2: the same assignment and parent; the version by the table of «Старт», the model by the chain
        // with the same parent (KD-3). The history starts anew, and a restarted fork does not inherit its parent's.
        const started = await this.startRun(
          ownerId,
          restartSource(restarted, session),
          {
            parentId: task.parentId,
            callerModel: await this.parentModel(task.parentId),
          },
        );
        // A restarted child keeps the call that started the agent it replaces.
        const restartStart: SessionStart = {
          run: started.run,
          description: session.description,
          prompt: await this.history.taskText(agentId),
          ...(session.startCallId === null
            ? {}
            : { startCallId: session.startCallId }),
        };
        const created =
          task.parentId === null
            ? await this.createRoot(ownerId, restartStart)
            : await this.createChild(
                {
                  ownerId,
                  parentId: task.parentId,
                  rootId: task.rootId,
                  depth: task.depth,
                },
                restartStart,
              );
        started.done(created.agentId, task.rootId);
        return created;
      },
      (restarted) => ({ restartedAs: restarted.agentId }),
    );
  }

  /**
   * Forks the owner's conversation (create-and-test design-fork.md, Flow 1): the refusal by its tree (KD-4),
   * then one transaction — a `chat` root on the source root's start, waiting for a message, with the source's
   * first entry, its history copied and its title (KD-2, KD-3). The model is not called.
   */
  fork({
    threadId,
    ownerId,
  }: {
    readonly threadId: string;
    readonly ownerId: string;
  }): Promise<ForkResult> {
    return this.logged(
      'fork',
      { threadId, ownerId },
      async (): Promise<ForkResult> => {
        const reason = await readForkRefusal(this.tasks, threadId, ownerId);
        if (reason !== null) return { kind: 'refused', reason };
        const session = await this.sessions.get(threadId);
        const source = await this.sessionRows.root(threadId, ownerId);
        if (session === undefined || source === undefined)
          throw new Error(`Conversation ${threadId} has no root session`);
        const run: RunStart = {
          version: await this.library.version(session.versionId),
          name: session.name,
          subagent: session.origin.subagent,
          model: session.model,
        };
        const started = await this.startRun(
          ownerId,
          { kind: 'restart', run },
          { parentId: null, callerModel: null },
        );
        const [first] = await this.history.through(threadId, 1);
        if (first?.kind !== 'task')
          throw new Error(`Conversation ${threadId} has no task entry first`);
        const { agentId } = await createAgent(this.creation, {
          task: { type: CHAT_TASK_TYPE, ownerId, waiting: true },
          placeOf: (taskId) => ({ rootId: taskId, depth: 0 }),
          start: {
            run: started.run,
            prompt: first.content.text,
            description: session.description,
            ...(first.content.record === null
              ? {}
              : { record: first.content.record }),
            ...(first.content.schedule === null
              ? {}
              : { schedule: first.content.schedule }),
          },
          after: async (forkId) => {
            await copyHistory(this.copying, {
              sourceId: threadId,
              targetId: forkId,
              forkedFromId: threadId,
              withTasks: true,
            });
            await this.sessionRows.titleRootIfEmpty(
              forkId,
              ownerId,
              forkTitle(source.title ?? ''),
            );
          },
        });
        started.done(agentId, agentId);
        return { kind: 'forked', threadId: agentId };
      },
      (result) =>
        result.kind === 'forked'
          ? { forkId: result.threadId }
          : { refusal: result.reason },
    );
  }

  /** The model of the parent's conversation, the second link of the chain (KD-3); `null` for a root. */
  private async parentModel(parentId: string | null): Promise<string | null> {
    if (parentId === null) return null;
    const parent = await this.sessions.get(parentId);
    if (parent === undefined)
      throw new Error(`Parent agent ${parentId} has no session`);
    return parent.model;
  }

  /**
   * The version, name and model of a start by `resolveStart` on behalf of the owner (KD-2), and the log of the
   * start once its agent exists; a refusal is logged and is `START_REFUSED` with its reason and model, and no
   * agent is made. Only a refusal of the access gate writes an `access_denied` record.
   */
  private async startRun(
    ownerId: string,
    source: StartSource,
    place: {
      readonly parentId: string | null;
      readonly callerModel: string | null;
    },
  ): Promise<{
    run: RunStart;
    done: (agentId: string, rootId: string) => void;
  }> {
    const startedAt = Date.now();
    const { parentId, callerModel } = place;
    const resolution = await resolveStart(
      { ownerId, source, callerModel },
      { library: this.library, access: this.access, providers: this.providers },
    );
    const entry = {
      ownerId,
      parentId,
      source: source.kind,
      resolution,
      startedAt,
    };
    if (resolution.kind === 'refused') {
      await auditStartRefusal(this.audit, resolution);
      logStart(this.logger, {
        ...entry,
        rootId: null,
        agentId: null,
        refusal: resolution.reason,
      });
      throw new AgentsError(
        'START_REFUSED',
        `A start from source ${source.kind} is refused: ${resolution.reason}`,
        {
          refusal: { reason: resolution.reason, model: resolution.model },
        },
      );
    }
    return {
      run: resolution.run,
      done: (agentId, rootId) =>
        logStart(this.logger, { ...entry, rootId, agentId, refusal: null }),
    };
  }

  /**
   * Creates a root — a chat: of two starts with one `agentId` the second waits for the first and is `TASK_EXISTS`;
   * `after` writes in the same transaction.
   */
  private createRoot(
    ownerId: string,
    start: SessionStart,
    options: {
      readonly agentId?: string;
      readonly after?: (rootId: string) => Promise<void>;
    } = {},
  ): Promise<{ agentId: string }> {
    const { agentId, after } = options;
    return createAgent(this.creation, {
      task: {
        type: CHAT_TASK_TYPE,
        ownerId,
        ...(agentId === undefined ? {} : { taskId: agentId }),
      },
      placeOf: (taskId) => ({ rootId: taskId, depth: 0 }),
      start,
      ...(after === undefined ? {} : { after }),
    });
  }

  /** Creates an agent of its run's type in the place of a finished one under its parent. */
  private createChild(
    place: {
      readonly ownerId: string;
      readonly parentId: string;
      readonly rootId: string;
      readonly depth: number;
    },
    start: SessionStart,
  ): Promise<{ agentId: string }> {
    const { ownerId, parentId, rootId, depth } = place;
    return asAgent(
      createAgent(this.creation, {
        task: { type: childTypeOf(start.run), ownerId, parentId },
        placeOf: () => ({ rootId, depth }),
        start,
      }),
    );
  }
}
