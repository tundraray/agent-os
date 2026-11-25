import { Injectable } from '@nestjs/common';
import { reportOf, taskQuestion, TrainingOperations } from '@agent-os/agents';
import {
  TaskStatusSchema,
  type TrainingActivated,
  type TrainingStarted,
  type TrainingState,
  type TrainingView,
} from '@agent-os/contracts';
import {
  type AgentTrainingRow,
  type AgentVersionRow,
  AgentsRepository,
  ConversationsRepository,
  ConversationTasksRepository,
  Db,
  MessagesRepository,
  RuntimeModelCallsRepository,
  type RuntimeTaskRow,
  RuntimeTasksRepository,
  type TrainingRow,
  TrainingsRepository,
} from '@agent-os/db';
import { TaskControl } from '@agent-os/runtime';
import { AuditLog } from '../audit/audit-log';
import { isUuid } from '../common/is-uuid';
import type { AuthUser } from '../identity/auth-user';
import { IdentityDirectory } from '../identity/identity-directory';
import { AUDIT_OBJECT_TYPE } from '../library/library-records';
import { LibraryService } from '../library/library.service';
import type { TrainingTarget } from '../library/library.types';
import { SettingsService } from '../settings/settings.service';
import { runNumbers, sum, versionTexts } from './run-numbers';
import { canTrain, recommendation, trainingStatus } from './training-rules';
import { startRefused, testRunRunning, trainingError } from './training.errors';

/**
 * The training routes (self-learning design-training.md, KD-7, KD-8, Flow 1, Flow 4): every route first finds
 * the agent for the actor (`LibraryService.trainingTarget`) and asks `canTrain`; the state answers without the
 * right too, with nothing about a training in it. The view and the recommendation are computed on read.
 */
@Injectable()
export class TrainingService {
  constructor(
    private readonly db: Db,
    private readonly library: LibraryService,
    private readonly settings: SettingsService,
    private readonly identity: IdentityDirectory,
    private readonly auditLog: AuditLog,
    private readonly operations: TrainingOperations,
    private readonly tasks: TaskControl,
    private readonly trainings: TrainingsRepository,
    private readonly taskRows: RuntimeTasksRepository,
    private readonly agents: AgentsRepository,
    private readonly sessionTasks: ConversationTasksRepository,
    private readonly messages: MessagesRepository,
    private readonly modelCalls: RuntimeModelCallsRepository,
    private readonly conversations: ConversationsRepository,
  ) {}

  /** GET /api/library/:id/training. 404 RECORD_NOT_FOUND. */
  async state(actor: AuthUser, recordId: string): Promise<TrainingState> {
    const target = await this.library.trainingTarget(actor, recordId);
    const capUsd = await this.capUsd();
    if (!canTrain(actor, target))
      return {
        canTrain: false,
        selfLearning: target.selfLearning,
        capUsd,
        running: null,
        lastFinished: null,
      };
    const [running, last] = await Promise.all([
      this.trainings.running(target.agentId),
      this.trainings.latestFinished(target.agentId),
    ]);
    return {
      canTrain: true,
      selfLearning: target.selfLearning,
      capUsd,
      running:
        running === undefined || running.description !== null
          ? null
          : await this.runningOf(running, actor.id),
      lastFinished:
        last === undefined ? null : await this.finishedOf(last, actor.id),
    };
  }

  /** POST /api/library/:id/training (Flow 1). 404, 403, 409 TEST_RUN_RUNNING, SELF_LEARNING_OFF, TRAINING_RUNNING, TRAINING_NO_PAST_TASKS, START_REFUSED. */
  async start(actor: AuthUser, recordId: string): Promise<TrainingStarted> {
    const target = await this.allowedTarget(actor, recordId);
    // Before the flag: the agent of a running test run has it off (design-test-run.md, DC-6).
    const testRun = await this.trainings.running(target.agentId);
    if (testRun?.description != null)
      throw testRunRunning(
        testRun.id,
        (await this.conversations.find(testRun.id))?.title ?? '',
      );
    // A default agent never learns; its flag is off by the library's rules.
    if (target.builtinKey !== null || !target.selfLearning)
      throw trainingError('SELF_LEARNING_OFF');
    const result = await this.operations.start({
      ownerId: actor.id,
      agentId: target.agentId,
      agentName: target.name,
      baseVersion: target.activeVersion,
      capUsd: await this.capUsd(),
    });
    switch (result.kind) {
      case 'started':
        return { trainingId: result.trainingId };
      case 'running':
        throw trainingError('TRAINING_RUNNING');
      case 'no_past_tasks':
        throw trainingError('TRAINING_NO_PAST_TASKS');
      case 'refused':
        throw startRefused(result.reason);
    }
  }

  /** GET /api/library/:id/training/:trainingId, for its starter only (FR-15). 404, 403, 404 TRAINING_NOT_FOUND. */
  async view(
    actor: AuthUser,
    recordId: string,
    trainingId: string,
  ): Promise<TrainingView> {
    const target = await this.allowedTarget(actor, recordId);
    const { training, ownerId } = await this.trainingOf(target, trainingId);
    if (ownerId !== actor.id) throw trainingError('TRAINING_NOT_FOUND');
    const tree = await this.tasks.listTree(training.id, ownerId);
    const root = tree.find((task) => task.taskId === training.id);
    if (root === undefined) throw trainingError('TRAINING_NOT_FOUND');
    const status = trainingStatus(root.status);
    // A past task's text never comes from a deleted one.
    const livePast = await this.livePastTasks(training);
    const [base, proposed, pool, startedBy, spent, texts] = await Promise.all([
      this.agents.findVersion(training.baseVersionId),
      this.agents.findTrainingVersion(training.id),
      this.sessionTasks.list(training.id),
      this.nameOf(ownerId),
      this.modelCalls.sumTree(training.id),
      this.messages.taskTexts(livePast),
    ]);
    if (base === undefined)
      throw new Error(`Base version of training ${training.id} is missing`);
    const replay = async (replayId: string | null) =>
      replayId === null
        ? null
        : {
            conversationId: replayId,
            ...(await runNumbers(
              { messages: this.messages, modelCalls: this.modelCalls },
              tree,
              replayId,
            )),
          };
    const comparisons = await Promise.all(
      training.comparisons.map(async (element) => ({
        task: livePast.includes(element.pastConversationId)
          ? this.textOf(texts, element.pastConversationId)
          : null,
        verdict: element.verdict,
        reason: element.reason,
        base: await replay(element.baseReplayId),
        proposed: await replay(element.proposedReplayId),
      })),
    );
    return {
      agent: { id: target.agentId, name: target.name },
      startedBy,
      startedAt: root.createdAt.toISOString(),
      baseVersion: base.number,
      status,
      failureReason:
        status === 'failed' ? (root.failure?.reason ?? null) : null,
      cappedAt: training.cappedAt?.toISOString() ?? null,
      spentUsd: Number(spent),
      capUsd: training.capUsd,
      pool: pool.map(({ number, subject, status: taskStatus }) => ({
        number,
        subject,
        status: taskStatus,
      })),
      proposal: {
        version: proposed?.number ?? null,
        base: versionTexts(base.content),
        proposed:
          proposed === undefined ? null : versionTexts(proposed.content),
        changes: proposed?.changes ?? null,
        explanation:
          proposed === undefined && root.status === 'completed'
            ? reportOf(root.result)
            : null,
      },
      comparisons,
      totals: {
        base: sum(comparisons.map((element) => element.base)),
        proposed: sum(comparisons.map((element) => element.proposed)),
      },
      recommended: recommendation(
        status,
        proposed !== undefined,
        training.comparisons,
      ),
      activatedAt: training.activatedAt?.toISOString() ?? null,
      activeVersion: target.activeVersion.number,
      canActivate:
        status !== 'running' &&
        proposed !== undefined &&
        training.activatedAt === null &&
        target.activeVersion.id === training.baseVersionId,
    };
  }

  /**
   * POST /api/library/:id/training/:trainingId/activate (KD-7, Flow 4), by the starter only. The checks before the transaction, then
   * one transaction whose first write is the agent's pointer guarded by the base version: `stale` rolls back
   * (409 TRAINING_BASE_CHANGED); then the training's mark and the audit. Memory and documents stay.
   */
  async activate(
    actor: AuthUser,
    recordId: string,
    trainingId: string,
  ): Promise<TrainingActivated> {
    const target = await this.allowedTarget(actor, recordId);
    const { training, root, ownerId } = await this.trainingOf(
      target,
      trainingId,
    );
    // Only the starter has read the diff.
    if (ownerId !== actor.id) throw trainingError('TRAINING_FORBIDDEN');
    // 409 TRAINING_NOT_ACTIVATABLE while it runs, without a version or once activated.
    const [version, base] = await Promise.all([
      this.agents.findTrainingVersion(training.id),
      this.agents.findVersion(training.baseVersionId),
    ]);
    if (
      trainingStatus(TaskStatusSchema.parse(root.status)) === 'running' ||
      version === undefined ||
      training.activatedAt !== null
    )
      throw trainingError('TRAINING_NOT_ACTIVATABLE');
    if (base === undefined)
      throw new Error(`Base version of training ${training.id} is missing`);
    return this.activateFor(actor, target, {
      trainingId: training.id,
      version,
      expectedNumber: base.number,
      testRun: false,
    });
  }

  /**
   * The activation of a training's or a test run's version by its starter after the caller's checks (design-training.md,
   * KD-7; design-trainer-dialog.md, «Маршруты прогона»): one transaction whose first write is the agent's pointer
   * guarded by the expected active version — `stale` rolls back (409 TRAINING_BASE_CHANGED) —, then the mark —
   * once for a training, at every activation for a test run — and the audit.
   */
  async activateFor(
    actor: AuthUser,
    target: TrainingTarget,
    change: {
      readonly trainingId: string;
      readonly version: AgentVersionRow;
      readonly expectedNumber: number;
      readonly testRun: boolean;
    },
  ): Promise<TrainingActivated> {
    const { trainingId, version, expectedNumber } = change;
    return this.db.transaction(async () => {
      const outcome = await this.agents.activateVersion({
        agentId: target.agentId,
        versionId: version.id,
        expectedNumber,
        name: target.name,
        description: target.description,
      });
      if (outcome === 'stale') throw trainingError('TRAINING_BASE_CHANGED');
      if (outcome === 'name_taken')
        throw new Error(
          `Activation of training ${trainingId} found the agent's own name taken`,
        );
      if (change.testRun)
        await this.trainings.markActivated(trainingId, actor.id);
      else if (!(await this.trainings.activate(trainingId, actor.id)))
        throw trainingError('TRAINING_NOT_ACTIVATABLE');
      await this.auditLog.record({
        kind: 'training_activate',
        actor: actor.id,
        objectType: AUDIT_OBJECT_TYPE,
        objectId: target.agentId,
        before: { version: expectedNumber },
        after: { version: version.number, trainingId },
        outcome: 'ok',
      });
      const activated = await this.trainings.find(trainingId);
      if (activated?.activatedAt == null)
        throw new Error(`Training ${trainingId} lost its activation mark`);
      return {
        version: version.number,
        activatedAt: activated.activatedAt.toISOString(),
      };
    });
  }

  /** The agent for the actor, when the rule lets them train it; 404 RECORD_NOT_FOUND, 403 TRAINING_FORBIDDEN. */
  private async allowedTarget(
    actor: AuthUser,
    recordId: string,
  ): Promise<TrainingTarget> {
    const target = await this.library.trainingTarget(actor, recordId);
    if (!canTrain(actor, target)) throw trainingError('TRAINING_FORBIDDEN');
    return target;
  }

  /**
   * The training of this agent with its root task; another agent's, a test run, a missing one or a deleted
   * tree — 404 TRAINING_NOT_FOUND.
   */
  private async trainingOf(
    target: TrainingTarget,
    trainingId: string,
  ): Promise<{
    training: AgentTrainingRow;
    root: RuntimeTaskRow;
    ownerId: string;
  }> {
    const [training, root] = isUuid(trainingId)
      ? await Promise.all([
          this.trainings.find(trainingId),
          this.taskRows.find(trainingId),
        ])
      : [];
    if (
      training === undefined ||
      training.description !== null ||
      training.baseVersionId === null ||
      training.agentId !== target.agentId ||
      root === undefined ||
      root.deletedAt !== null ||
      root.ownerId === null
    )
      throw trainingError('TRAINING_NOT_FOUND');
    return {
      training: {
        ...training,
        agentId: target.agentId,
        baseVersionId: training.baseVersionId,
      },
      root,
      ownerId: root.ownerId,
    };
  }

  private async runningOf(
    training: TrainingRow,
    actorId: string,
  ): Promise<NonNullable<TrainingState['running']>> {
    const root = await this.rootRow(training.id);
    return {
      id: training.id,
      startedBy: await this.nameOf(root.ownerId),
      startedAt: root.createdAt.toISOString(),
      spentUsd: Number(await this.modelCalls.sumTree(training.id)),
      capUsd: training.capUsd,
      startedByMe: root.ownerId === actorId,
    };
  }

  /** The latest finished training for its starter only (FR-15); `null` for anybody else. */
  private async finishedOf(
    training: TrainingRow,
    actorId: string,
  ): Promise<TrainingState['lastFinished']> {
    const [root, version] = await Promise.all([
      this.rootRow(training.id),
      this.agents.findTrainingVersion(training.id),
    ]);
    if (root.ownerId !== actorId) return null;
    const status = trainingStatus(TaskStatusSchema.parse(root.status));
    if (root.finishedAt === null)
      throw new Error(`Finished training ${training.id} has no end time`);
    return {
      id: training.id,
      finishedAt: root.finishedAt.toISOString(),
      status,
      recommended: recommendation(
        status,
        version !== undefined,
        training.comparisons,
      ),
    };
  }

  /** The root task of a training the repository found through it. */
  private async rootRow(trainingId: string): Promise<RuntimeTaskRow> {
    const root = await this.taskRows.find(trainingId);
    if (root === undefined)
      throw new Error(`Training ${trainingId} has no root task`);
    return root;
  }

  private async nameOf(userId: string | null): Promise<string> {
    const [user] = await this.identity.userNames(
      userId === null ? [] : [userId],
    );
    if (user === undefined) throw new Error(`Starter ${userId} is missing`);
    return user.name;
  }

  /** The training's past tasks whose trees their owners have not deleted. */
  private async livePastTasks(training: TrainingRow): Promise<string[]> {
    const rows = await Promise.all(
      training.comparisons.map((element) =>
        this.taskRows.find(element.pastConversationId),
      ),
    );
    return rows.flatMap((row) =>
      row !== undefined && row.deletedAt === null ? [row.taskId] : [],
    );
  }

  private textOf(
    texts: readonly { conversationId: string; text: string }[],
    conversationId: string,
  ): string {
    const found = texts.find((text) => text.conversationId === conversationId);
    if (found === undefined)
      throw new Error(`Past task ${conversationId} has no task entry`);
    return taskQuestion(found.text);
  }

  private async capUsd(): Promise<number> {
    return (await this.settings.read('self_learning_settings')).value
      .trainingCapUsd;
  }
}
