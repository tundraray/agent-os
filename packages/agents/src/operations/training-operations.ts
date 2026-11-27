import type { Logger } from '@agent-os/common';
import {
  CHAT_BUILTIN_KEY,
  CHAT_TASK_TYPE,
  type ChipRecord,
  type ForkRefusalReason,
  TRAINER_BUILTIN_KEY,
  TRAINER_TASK_TYPE,
  testRunPhase,
} from '@agent-os/contracts';
import {
  ConversationsRepository,
  ConversationTasksRepository,
  Db,
  MessagesRepository,
  ToolResultsRepository,
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
import { AgentsError } from '../errors';
import { AgentsProviders } from '../providers/provider-registry';
import type { RecordLibrary } from '../start/record-library';
import {
  auditStartRefusal,
  resolveStart,
  type StartRefusal,
} from '../start/resolve-start';
import { History } from '../store/history';
import { ToolRegistry } from '../tools/tool-registry';
import { POOL_TASKS, TEST_RUN_POOL_TASKS } from '../training/pool';
import { pastTaskIds } from '../training/training-reads';
import {
  copyHistory,
  type CopyHistoryDeps,
  forkTitle,
  readForkRefusal,
} from './fork-history';
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

/**
 * What the start of a test run takes: who starts it, the employee's description — empty only with an origin —,
 * the cap from the settings and the starter's conversation the run forks, if any.
 */
export interface TestRunStartRequest {
  readonly ownerId: string;
  readonly description: string;
  readonly capUsd: number;
  readonly originThreadId?: string;
}

/** How the start of a test run ends (design-trainer-dialog.md, Flow 1). */
export type TestRunStart =
  | { readonly kind: 'started'; readonly testRunId: string }
  | {
      readonly kind: 'running';
      readonly testRunId: string;
      readonly title: string;
    }
  | { readonly kind: 'fork_refused'; readonly reason: ForkRefusalReason }
  | { readonly kind: 'refused'; readonly reason: StartRefusal['reason'] };

/** How «взять» ends (design-trainer-dialog.md, KD-5): the conversation with the taken agent, `null` without a fork. */
export type TestRunTake =
  | { readonly kind: 'taken'; readonly threadId: string | null }
  | { readonly kind: 'no_offer' };

/** The text and chip of a conversation's first entry. */
interface FirstEntry {
  readonly text: string;
  readonly record: ChipRecord | null;
}

/** The starts of a training and a test run: the only ways a `trainer` task is created (design-training.md, KD-1, Flow 1). */
@Injectable()
export class TrainingOperations {
  private readonly logger: Logger;
  private readonly logged: ReturnType<typeof createLogged>;
  private readonly creation: AgentCreationDeps;
  private readonly copying: CopyHistoryDeps;

  constructor(
    @Inject(Db) db: Db,
    @Inject(TaskControl)
    private readonly tasks: Pick<
      TaskControl,
      'create' | 'get' | 'listTree' | 'stop'
    >,
    @Inject(LiveTasks) liveTasks: Pick<LiveTasks, 'adopt'>,
    @Inject(AgentFactory) factory: Pick<AgentFactory, 'createIn'>,
    @Inject(ConversationsRepository)
    private readonly conversationRows: ConversationsRepository,
    @Inject(ConversationTasksRepository)
    private readonly sessionTaskRows: ConversationTasksRepository,
    @Inject(TrainingsRepository)
    private readonly trainingRows: Pick<
      TrainingsRepository,
      | 'insert'
      | 'running'
      | 'runningTestRun'
      | 'find'
      | 'take'
      | 'setTakenThread'
    >,
    /** A forked test run and the conversation «взять» makes copy the inherited history (design-fork.md). */
    @Inject(History) private readonly history: History,
    @Inject(MessagesRepository) messageRows: MessagesRepository,
    @Inject(ToolResultsRepository) toolResultRows: ToolResultsRepository,
    @Inject(RECORD_LIBRARY) private readonly library: RecordLibrary,
    @Inject(ACCESS_GATE) private readonly access: AccessGate,
    @Inject(ToolRegistry)
    private readonly registry: Pick<ToolRegistry, 'declaredMcpTools'>,
    @Inject(AgentsProviders)
    private readonly providers: Pick<AgentsProviders, 'connection'>,
    @Inject(ACCESS_AUDIT) private readonly audit: AccessAudit,
    @Inject(AGENTS_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'agents.training' });
    this.logged = createLogged(this.logger);
    this.creation = { db, tasks, factory, liveTasks };
    this.copying = {
      history,
      messageRows,
      toolResultRows,
      sessionTaskRows,
      sessionRows: conversationRows,
      logger: this.logger,
    };
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
            {
              conversationRows: this.conversationRows,
              access: this.access,
              registry: this.registry,
            },
            ownerId,
            agentId,
          )
        ).slice(0, COMPARISONS_MAX);
        if (compared.length === 0) return { kind: 'no_past_tasks' };

        const resolution = await this.builtinStart(
          ownerId,
          TRAINER_BUILTIN_KEY,
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

  /**
   * The start of a test run (design-trainer-dialog.md, KD-6, KD-8, Flow 1): none of the starter's test runs may be
   * unfinished; with an origin, its fork refusal first; the trainer's start on behalf of the starter; then one
   * transaction: the `trainer` task with `testRun` in its input and no key, its conversation — the origin's first
   * entry and its history copied without the task list, then the description as the employee's message when it
   * is not empty; without an origin the description is the first entry —, the title, the pool and the `trainings`
   * row with neither agent nor base yet.
   */
  startTestRun(request: TestRunStartRequest): Promise<TestRunStart> {
    const { ownerId, description, capUsd, originThreadId } = request;
    const forked = originThreadId !== undefined;
    return this.logged(
      'training.startTestRun',
      { ownerId, capUsd, descriptionChars: description.length, forked },
      async (): Promise<TestRunStart> => {
        const running = await this.trainingRows.runningTestRun(ownerId);
        if (running !== undefined)
          return {
            kind: 'running',
            testRunId: running.id,
            title: running.title ?? '',
          };
        if (originThreadId !== undefined) {
          const reason = await readForkRefusal(
            this.tasks,
            originThreadId,
            ownerId,
          );
          if (reason !== null) return { kind: 'fork_refused', reason };
        }
        const resolution = await this.builtinStart(
          ownerId,
          TRAINER_BUILTIN_KEY,
        );
        if (resolution.kind === 'refused') {
          await auditStartRefusal(this.audit, resolution);
          return { kind: 'refused', reason: resolution.reason };
        }
        const origin =
          originThreadId === undefined
            ? undefined
            : await this.originOf(originThreadId, ownerId);
        const title = origin?.title ?? 'Проверка нового агента';
        const record = origin?.first.record ?? null;
        const { agentId: testRunId } = await createAgent(this.creation, {
          task: { type: TRAINER_TASK_TYPE, ownerId },
          placeOf: (taskId) => ({ rootId: taskId, depth: 0 }),
          input: { testRun: true },
          start: {
            run: resolution.run,
            prompt: origin?.first.text ?? description,
            description: title,
            ...(record === null ? {} : { record }),
          },
          after: async (taskId) => {
            if (originThreadId !== undefined) {
              await copyHistory(this.copying, {
                sourceId: originThreadId,
                targetId: taskId,
                forkedFromId: originThreadId,
                withTasks: false,
              });
              if (description !== '')
                await this.history.append(taskId, [
                  {
                    kind: 'user_message',
                    content: {
                      text: description,
                      record: null,
                      schedule: null,
                    },
                  },
                ]);
            }
            await this.conversationRows.titleRootIfEmpty(
              taskId,
              ownerId,
              title,
            );
            await this.sessionTaskRows.write(taskId, {
              written: TEST_RUN_POOL_TASKS,
              deleted: [],
              lastNumber: TEST_RUN_POOL_TASKS.length,
            });
            await this.trainingRows.insert({
              id: taskId,
              description,
              capUsd,
              comparisons: [],
              tests: [],
            });
          },
        });
        this.logger.info('test run started', {
          ownerId,
          testRunId,
          capUsd,
          descriptionChars: description.length,
          forked,
        });
        return { kind: 'started', testRunId };
      },
      (result) => ({ ...result }),
    );
  }

  /**
   * «Взять» (design-trainer-dialog.md, KD-5, Flow 2), repeatable; the caller checked the run is the owner's and the
   * offered agent still passes the chip rule. A run not taken yet needs its dialog phase, an offer and no plan, and
   * is taken in its own write; then its tree is stopped, and a forked run without the conversation yet gets it in
   * one transaction (`takenThread`).
   */
  takeTestRun(request: {
    readonly ownerId: string;
    readonly testRunId: string;
  }): Promise<TestRunTake> {
    const { ownerId, testRunId } = request;
    return this.logged(
      'training.takeTestRun',
      { ownerId, testRunId },
      async (): Promise<TestRunTake> => {
        const row = await this.trainingRows.find(testRunId);
        if (row === undefined)
          throw new Error(`Test run ${testRunId} has no training row`);
        if (row.takenAgentId === null) {
          const root = await this.tasks.get(testRunId, ownerId);
          // The dialog phase depends on the root, the take and the agent only.
          const { phase } = testRunPhase({
            rootStatus: root.status,
            capped: row.cappedAt !== null,
            agentId: row.agentId,
            takenAgentId: null,
            versions: 0,
            tests: row.tests,
            fixTaskInProgress: false,
          });
          if (
            phase !== 'dialog' ||
            row.offeredAgentId === null ||
            row.plan !== null
          )
            return { kind: 'no_offer' };
          await this.trainingRows.take(testRunId);
          this.logger.info('test run taken', {
            ownerId,
            testRunId,
            agentId: row.offeredAgentId,
          });
        }
        await this.tasks.stop(testRunId, ownerId);
        if (row.takenThreadId !== null)
          return { kind: 'taken', threadId: row.takenThreadId };
        const conversation = await this.conversationRows.root(
          testRunId,
          ownerId,
        );
        if (
          conversation?.forkedFromId == null ||
          conversation.forkedThroughSeq === null
        )
          return { kind: 'taken', threadId: null };
        return {
          kind: 'taken',
          threadId: await this.takenThread(testRunId, ownerId, {
            forkedFromId: conversation.forkedFromId,
            forkedThroughSeq: conversation.forkedThroughSeq,
            title: forkTitle(conversation.forkedFromTitle ?? ''),
          }),
        };
      },
      (result) => ({ ...result }),
    );
  }

  /**
   * The conversation with the taken agent (KD-5), in one transaction: a `chat` root on the chat's active version,
   * waiting for a message, with the run's first entry, the run's inherited history copied without its task list
   * and the fork's title; its id goes into the row.
   */
  private async takenThread(
    testRunId: string,
    ownerId: string,
    fork: {
      readonly forkedFromId: string;
      readonly forkedThroughSeq: number;
      readonly title: string;
    },
  ): Promise<string> {
    const resolution = await this.builtinStart(ownerId, CHAT_BUILTIN_KEY);
    if (resolution.kind === 'refused') {
      await auditStartRefusal(this.audit, resolution);
      throw new AgentsError(
        'START_REFUSED',
        `The chat start of a taken test run is refused: ${resolution.reason}`,
        { refusal: { reason: resolution.reason, model: resolution.model } },
      );
    }
    const first = await this.firstEntry(testRunId);
    const source = await this.conversationRows.find(fork.forkedFromId);
    const { agentId: threadId } = await createAgent(this.creation, {
      task: { type: CHAT_TASK_TYPE, ownerId, waiting: true },
      placeOf: (taskId) => ({ rootId: taskId, depth: 0 }),
      start: {
        run: resolution.run,
        prompt: first.text,
        description: source?.description ?? fork.title,
        ...(first.record === null ? {} : { record: first.record }),
      },
      after: async (taskId) => {
        await copyHistory(this.copying, {
          sourceId: testRunId,
          targetId: taskId,
          forkedFromId: fork.forkedFromId,
          throughSeq: fork.forkedThroughSeq,
          withTasks: false,
        });
        await this.conversationRows.titleRootIfEmpty(
          taskId,
          ownerId,
          fork.title,
        );
        await this.trainingRows.setTakenThread(testRunId, taskId);
      },
    });
    this.logger.info('taken test run conversation created', {
      ownerId,
      testRunId,
      threadId,
    });
    return threadId;
  }

  /** The origin a forked test run copies: its first entry and the fork's title. */
  private async originOf(
    originThreadId: string,
    ownerId: string,
  ): Promise<{ readonly first: FirstEntry; readonly title: string }> {
    const source = await this.conversationRows.root(originThreadId, ownerId);
    if (source === undefined)
      throw new Error(`Conversation ${originThreadId} has no root row`);
    return {
      first: await this.firstEntry(originThreadId),
      title: forkTitle(source.title ?? ''),
    };
  }

  /** The `task` entry a conversation starts with. */
  private async firstEntry(conversationId: string): Promise<FirstEntry> {
    const [first] = await this.history.through(conversationId, 1);
    if (first?.kind !== 'task')
      throw new Error(`Conversation ${conversationId} has no task entry first`);
    return first.content;
  }

  /** The start of a built-in agent — the trainer, the chat — on behalf of the starter. */
  private builtinStart(
    ownerId: string,
    builtinKey: typeof TRAINER_BUILTIN_KEY | typeof CHAT_BUILTIN_KEY,
  ) {
    return resolveStart(
      {
        ownerId,
        source: { kind: 'builtin', builtinKey },
        callerModel: null,
      },
      { library: this.library, access: this.access, providers: this.providers },
    );
  }
}
