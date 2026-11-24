import type { Logger } from '@agent-os/common';
import { TRAINER_BUILTIN_KEY, TRAINER_TASK_TYPE } from '@agent-os/contracts';
import {
  ConversationsRepository,
  ConversationTasksRepository,
  Db,
  TrainingsRepository,
} from '@agent-os/db';
import { LiveTasks, TaskControl } from '@agent-os/runtime';
import { Inject, Injectable } from '@nestjs/common';

import type { AccessAudit, AccessGate } from '../access-gate';
import { AgentFactory } from '../agent/agent-factory';
import {
  ACCESS_AUDIT,
  ACCESS_GATE,
  AGENTS_LOGGER,
  RECORD_LIBRARY,
} from '../agents.tokens';
import { AgentsProviders } from '../providers/provider-registry';
import type { RecordLibrary } from '../start/record-library';
import {
  auditStartRefusal,
  resolveStart,
  type StartRefusal,
} from '../start/resolve-start';
import { POOL_TASKS } from '../training/pool';
import { pastTaskIds } from '../training/training-reads';
import {
  type AgentCreationDeps,
  createAgent,
  createLogged,
} from './operation-support';

/** At most this many past tasks are compared (design-training.md, KD-2). */
const COMPARISONS_MAX = 5;

/** What the start of a training takes: who starts it, the agent, its active version and the cap from the settings. */
export interface TrainingStartRequest {
  readonly ownerId: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly baseVersion: { readonly id: string; readonly number: number };
  readonly capUsd: number;
}

/** How the start of a training ends (design-training.md, Contract «Операция старта обучения»). */
export type TrainingStart =
  | { readonly kind: 'started'; readonly trainingId: string }
  | { readonly kind: 'running'; readonly trainingId: string }
  | { readonly kind: 'no_past_tasks' }
  | { readonly kind: 'refused'; readonly reason: StartRefusal['reason'] };

/** The start of a training: the only way a `trainer` task is created (design-training.md, KD-1, Flow 1). */
@Injectable()
export class TrainingOperations {
  private readonly logger: Logger;
  private readonly logged: ReturnType<typeof createLogged>;
  private readonly creation: AgentCreationDeps;

  constructor(
    @Inject(Db) db: Db,
    @Inject(TaskControl) tasks: Pick<TaskControl, 'create'>,
    @Inject(LiveTasks) liveTasks: Pick<LiveTasks, 'adopt'>,
    @Inject(AgentFactory) factory: Pick<AgentFactory, 'createIn'>,
    @Inject(ConversationsRepository)
    private readonly conversationRows: Pick<
      ConversationsRepository,
      'pastTasks' | 'serversCalled' | 'titleRootIfEmpty'
    >,
    @Inject(ConversationTasksRepository)
    private readonly sessionTaskRows: Pick<
      ConversationTasksRepository,
      'write'
    >,
    @Inject(TrainingsRepository)
    private readonly trainingRows: Pick<
      TrainingsRepository,
      'insert' | 'running'
    >,
    @Inject(RECORD_LIBRARY) private readonly library: RecordLibrary,
    @Inject(ACCESS_GATE) private readonly access: AccessGate,
    @Inject(AgentsProviders)
    private readonly providers: Pick<AgentsProviders, 'connection'>,
    @Inject(ACCESS_AUDIT) private readonly audit: AccessAudit,
    @Inject(AGENTS_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'agents.training' });
    this.logged = createLogged(this.logger);
    this.creation = { db, tasks, factory, liveTasks };
  }

  /**
   * Before the transaction: the past tasks to compare, then the trainer's start on behalf of the starter. Then
   * one transaction in the engine's write order: the `trainer` task keyed by the agent first, its object and
   * conversation, the title, the pool and the `trainings` row. A taken key writes nothing.
   */
  start(request: TrainingStartRequest): Promise<TrainingStart> {
    const { ownerId, agentId, agentName, baseVersion, capUsd } = request;
    return this.logged(
      'training.start',
      { ownerId, agentId, baseVersionId: baseVersion.id, capUsd },
      async (): Promise<TrainingStart> => {
        const compared = (
          await pastTaskIds(
            { conversationRows: this.conversationRows, access: this.access },
            ownerId,
            agentId,
          )
        ).slice(0, COMPARISONS_MAX);
        if (compared.length === 0) return { kind: 'no_past_tasks' };

        const resolution = await resolveStart(
          {
            ownerId,
            source: { kind: 'builtin', builtinKey: TRAINER_BUILTIN_KEY },
            callerModel: null,
          },
          {
            library: this.library,
            access: this.access,
            providers: this.providers,
          },
        );
        if (resolution.kind === 'refused') {
          await auditStartRefusal(this.audit, resolution);
          return { kind: 'refused', reason: resolution.reason };
        }

        const title = `Обучение «${agentName}»`;
        const created = await createAgent(this.creation, {
          task: { type: TRAINER_TASK_TYPE, ownerId, exclusiveKey: agentId },
          placeOf: (taskId) => ({ rootId: taskId, depth: 0 }),
          start: {
            run: resolution.run,
            prompt: `Обучи агента «${agentName}»: основа — его версия ${baseVersion.number}. Иди по списку задач.`,
            description: title,
          },
          after: async (trainingId) => {
            await this.conversationRows.titleRootIfEmpty(
              trainingId,
              ownerId,
              title,
            );
            await this.sessionTaskRows.write(trainingId, {
              written: POOL_TASKS,
              deleted: [],
              lastNumber: POOL_TASKS.length,
            });
            await this.trainingRows.insert({
              id: trainingId,
              agentId,
              baseVersionId: baseVersion.id,
              capUsd,
              comparisons: compared.map((pastConversationId) => ({
                pastConversationId,
                baseReplayId: null,
                proposedReplayId: null,
                verdict: null,
                reason: null,
              })),
            });
          },
        });
        if (created !== null) {
          this.logger.info('training started', {
            ownerId,
            agentId,
            trainingId: created.agentId,
            baseVersionId: baseVersion.id,
            capUsd,
            comparisons: compared.length,
          });
          return { kind: 'started', trainingId: created.agentId };
        }
        const running = await this.trainingRows.running(agentId);
        if (running === undefined)
          throw new Error(
            `The trainer key of agent ${agentId} is taken, but no training of it runs`,
          );
        return { kind: 'running', trainingId: running.id };
      },
      (result) => ({ ...result }),
    );
  }
}
