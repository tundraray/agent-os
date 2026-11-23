import type { Logger } from '@agent-os/common';
import { CHAT_BUILTIN_KEY, CHAT_TASK_TYPE } from '@agent-os/contracts';
import { Db } from '@agent-os/db';
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
  resolveStart,
  type StartSource,
} from '../start/resolve-start';
import type { RunStart } from '../start/run-definition';
import { History } from '../store/history';
import {
  type AgentTaskInput,
  type Session,
  Sessions,
  type SessionStart,
} from '../store/sessions';
import { logStart } from '../tools/system/start-child';
import type { AgentRef, StartRequest } from './agent-sessions';
import { agentTask, asAgent, createLogged } from './operation-support';

/**
 * Where a restart takes its version (data-model design-agents.md, «Старт: версия, имя и модель беседы»): an
 * agent or a root starts anew on the active version of the same agent, as the owner sees it now, under the
 * restarted conversation's name; a subagent and a fork restart on the version, name and model of the
 * restarted conversation.
 */
function restartSource(run: RunStart, session: Session): StartSource {
  if (run.subagent !== null || session.forkedThroughSeq !== null) {
    return { kind: 'restart', run };
  }
  return {
    kind: 'record',
    recordId: run.version.agentId,
    expected: run.version.kind,
    name: run.name,
  };
}

/** The operations that make an agent: the start of a conversation's root and the restart of a finished agent. */
@Injectable()
export class StartOperations {
  private readonly logger: Logger;
  private readonly logged: ReturnType<typeof createLogged>;

  constructor(
    @Inject(Db) private readonly db: Db,
    @Inject(Sessions) private readonly sessions: Sessions,
    /** A restart repeats the assignment of the restarted session's `task` entry (KD-6). */
    @Inject(History) private readonly history: Pick<History, 'taskText'>,
    @Inject(TaskControl)
    private readonly tasks: Pick<TaskControl, 'create' | 'get'>,
    @Inject(LiveTasks) private readonly liveTasks: Pick<LiveTasks, 'adopt'>,
    /** `resolveStart` asks it for the agent of a start or a restart; a restart reads the restarted version. */
    @Inject(RECORD_LIBRARY) private readonly library: RecordLibrary,
    @Inject(ACCESS_GATE) private readonly access: AccessGate,
    /** `resolveStart` asks it whether the model of a start has a ready provider (model-providers KD-2). */
    @Inject(AgentsProviders)
    private readonly providers: Pick<AgentsProviders, 'connection'>,
    @Inject(ACCESS_AUDIT) private readonly audit: AccessAudit,
    /** Makes the object of a started agent with its session, in the transaction that creates its task. */
    @Inject(AgentFactory)
    private readonly factory: Pick<AgentFactory, 'createIn'>,
    @Inject(AGENTS_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'agents.sessions' });
    this.logged = createLogged(this.logger);
  }

  start({
    agentId,
    ownerId,
    prompt,
    description,
    record,
  }: StartRequest): Promise<{ agentId: string }> {
    return this.logged(
      'start',
      { agentId: agentId ?? null, ownerId, recordId: record?.id ?? null },
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
          },
          agentId,
        );
        started.done(created.agentId, created.agentId);
        return created;
      },
      ({ agentId }) => ({ agentId }),
    );
  }

  restart({ agentId, ownerId }: AgentRef): Promise<{ agentId: string }> {
    return this.logged(
      'restart',
      { agentId, ownerId },
      async () => {
        const task = await agentTask(this.tasks, agentId, ownerId);
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
   * Creates an agent outside a step: its task with an empty input, its session written from the start and its
   * object commit together, so whoever sees the task sees the session (KD-8); the object goes to the runtime once
   * the transaction resolved, and the agent's first step runs on it.
   */
  private async create(
    request: {
      readonly type: string;
      readonly ownerId: string;
      readonly parentId?: string;
      readonly taskId?: string;
    },
    placeOf: (taskId: string) => {
      readonly rootId: string;
      readonly depth: number;
    },
    start: SessionStart,
  ): Promise<{ agentId: string }> {
    const { type, ownerId, parentId = null } = request;
    const input: AgentTaskInput = {};
    const { agentId, agent } = await this.db.transaction(async () => {
      const taskId = await this.tasks.create({ ...request, input });
      const agent = await this.factory.createIn(
        type,
        { taskId, ownerId, parentId, ...placeOf(taskId) },
        input,
        start,
      );
      return { agentId: taskId, agent };
    });
    this.liveTasks.adopt(agentId, agent);
    return { agentId };
  }

  /** Creates a root — a chat: of two starts with one `agentId` the second waits for the first and is `TASK_EXISTS`. */
  private createRoot(
    ownerId: string,
    start: SessionStart,
    agentId?: string,
  ): Promise<{ agentId: string }> {
    return this.create(
      {
        type: CHAT_TASK_TYPE,
        ownerId,
        ...(agentId === undefined ? {} : { taskId: agentId }),
      },
      (taskId) => ({ rootId: taskId, depth: 0 }),
      start,
    );
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
      this.create(
        { type: childTypeOf(start.run), ownerId, parentId },
        () => ({ rootId, depth }),
        start,
      ),
    );
  }
}
