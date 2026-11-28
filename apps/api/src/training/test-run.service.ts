import { Injectable } from '@nestjs/common';
import {
  FIX_TASK,
  inRootLaunchSet,
  reportOf,
  TrainingOperations,
} from '@agent-os/agents';
import {
  DeepAgentContentSchema,
  isStartable,
  roundFailed,
  roundJudged,
  type StartTestRunBody,
  TaskStatusSchema,
  type TestRunStarted,
  type TestRunTaken,
  type TestRunView,
  type TrainingActivated,
} from '@agent-os/contracts';
import {
  AgentsRepository,
  ConversationsRepository,
  ConversationTasksRepository,
  MessagesRepository,
  RuntimeModelCallsRepository,
  type RuntimeTaskRow,
  RuntimeTasksRepository,
  type TrainingRow,
  TrainingsRepository,
} from '@agent-os/db';
import { TaskControl } from '@agent-os/runtime';
import { AuditLog } from '../audit/audit-log';
import { forkRefused, threadNotFound } from '../chat/chat.errors';
import { isUuid } from '../common/is-uuid';
import type { AuthUser } from '../identity/auth-user';
import { libraryError } from '../library/library.errors';
import { LibraryService } from '../library/library.service';
import { SettingsService } from '../settings/settings.service';
import { runNumbers, sum, versionTexts } from './run-numbers';
import { closedReason, requestedRound, runPhase } from './test-run-rules';
import { trainingStatus } from './training-rules';
import { TrainingService } from './training.service';
import { startRefused, testRunRunning, trainingError } from './training.errors';

/**
 * The test run's routes (design-test-run.md, KD-6; design-trainer-dialog.md, «Маршруты прогона»): the start by a
 * holder of `trainOwn`, «взять», the result and the activation only for the starter — anybody else, a training's
 * id or a deleted conversation is 404 TRAINING_NOT_FOUND. The view's numbers are counted on read.
 */
@Injectable()
export class TestRunService {
  constructor(
    private readonly operations: TrainingOperations,
    private readonly training: TrainingService,
    private readonly library: LibraryService,
    private readonly settings: SettingsService,
    private readonly auditLog: AuditLog,
    private readonly tasks: TaskControl,
    private readonly trainings: TrainingsRepository,
    private readonly taskRows: RuntimeTasksRepository,
    private readonly agents: AgentsRepository,
    private readonly sessionTasks: ConversationTasksRepository,
    private readonly messages: MessagesRepository,
    private readonly modelCalls: RuntimeModelCallsRepository,
    private readonly conversations: ConversationsRepository,
  ) {}

  /**
   * POST /api/test-runs (Flow 1). 403 TRAINING_FORBIDDEN, 404 THREAD_NOT_FOUND, 409 TEST_RUN_RUNNING, FORK_REFUSED,
   * START_REFUSED; the audit after the start's commit, without the description.
   */
  async start(
    actor: AuthUser,
    { description, originThreadId }: StartTestRunBody,
  ): Promise<TestRunStarted> {
    if (!actor.trainOwn) throw trainingError('TRAINING_FORBIDDEN');
    if (
      originThreadId !== undefined &&
      (await this.conversations.root(originThreadId, actor.id)) === undefined
    )
      throw threadNotFound();
    const capUsd = (await this.settings.read('self_learning_settings')).value
      .trainingCapUsd;
    const result = await this.operations.startTestRun({
      ownerId: actor.id,
      description,
      capUsd,
      ...(originThreadId === undefined ? {} : { originThreadId }),
    });
    if (result.kind === 'running')
      throw testRunRunning(result.testRunId, result.title);
    if (result.kind === 'fork_refused') throw forkRefused(result.reason);
    if (result.kind === 'refused') throw startRefused(result.reason);
    await this.auditLog.record({
      kind: 'test_run_start',
      actor: actor.id,
      objectType: 'test_run',
      objectId: result.testRunId,
      after: {
        capUsd,
        descriptionChars: description.length,
        forked: originThreadId !== undefined,
      },
      outcome: 'ok',
    });
    return { testRunId: result.testRunId };
  }

  /**
   * POST /api/test-runs/:testRunId/take (KD-5), repeatable. 404 TRAINING_NOT_FOUND, 409 TEST_RUN_NO_OFFER, 404
   * RECORD_NOT_FOUND — the agent no longer passes the chip rule.
   */
  async take(actor: AuthUser, testRunId: string): Promise<TestRunTaken> {
    const { row } = await this.testRunOf(actor, testRunId);
    const agentId = row.takenAgentId ?? row.offeredAgentId;
    if (agentId === null) throw trainingError('TEST_RUN_NO_OFFER');
    const resolved = await this.library.resolve(actor.id, agentId);
    // A skill never starts: it answers as a missing record (agent-guidance KD-5).
    if (
      resolved === null ||
      !isStartable(resolved) ||
      !inRootLaunchSet(resolved)
    )
      throw libraryError('RECORD_NOT_FOUND');
    const taken = await this.operations.takeTestRun({
      ownerId: actor.id,
      testRunId: row.id,
    });
    if (taken.kind === 'no_offer') throw trainingError('TEST_RUN_NO_OFFER');
    return {
      threadId: taken.threadId,
      record: { id: resolved.id, kind: resolved.kind, name: resolved.name },
    };
  }

  /** GET /api/test-runs/:testRunId. 404 TRAINING_NOT_FOUND. */
  async view(actor: AuthUser, testRunId: string): Promise<TestRunView> {
    const {
      row,
      root: rootRow,
      description,
    } = await this.testRunOf(actor, testRunId);
    const rootStatus = TaskStatusSchema.parse(rootRow.status);
    const [tree, pool, spent, agent, base, proposed, offered, taken] =
      await Promise.all([
        this.tasks.listTree(row.id, actor.id),
        this.sessionTasks.list(row.id),
        this.modelCalls.sumTree(row.id),
        row.agentId === null ? undefined : this.agents.findAny(row.agentId),
        row.baseVersionId === null
          ? undefined
          : this.agents.findVersion(row.baseVersionId),
        this.agents.trainingVersions(row.id),
        row.offeredAgentId === null
          ? undefined
          : this.agents.findAny(row.offeredAgentId),
        row.takenAgentId === null
          ? undefined
          : this.agents.findAny(row.takenAgentId),
      ]);
    const root = tree.find((task) => task.taskId === row.id);
    if (root === undefined) throw trainingError('TRAINING_NOT_FOUND');
    const status = trainingStatus(rootStatus);
    const finished = status !== 'running';
    const live = agent !== undefined && agent.deletedAt === null;
    const state = runPhase({
      row,
      rootStatus,
      pool,
      proposed: proposed.length,
    });
    const spentUsd = Number(spent);
    const versions = base === undefined ? [] : [base, ...proposed];

    const tests = await Promise.all(
      row.tests.map(async (test) => ({
        task: test.task,
        expected: test.expected,
        rounds: await Promise.all(
          test.rounds.map(async (slot) => ({
            conversationId: live ? slot.runId : null,
            verdict: slot.verdict ?? (finished ? 'unchecked' : null),
            reason: slot.reason,
            ...(slot.runId === null
              ? sum([])
              : await runNumbers(
                  { messages: this.messages, modelCalls: this.modelCalls },
                  tree,
                  slot.runId,
                )),
          })),
        ),
      })),
    );
    const fixed = proposed.length > 0 && !requestedRound(pool, 2);
    const fixClosed =
      pool.find((task) => task.number === FIX_TASK)?.status === 'completed';
    const fixSkipped =
      !roundJudged(row.tests, 1) || fixed
        ? null
        : !roundFailed(row.tests, 1)
          ? 'not_needed'
          : fixClosed
            ? 'nothing_to_fix'
            : null;

    return {
      id: row.id,
      description,
      startedAt: root.createdAt.toISOString(),
      status,
      failureReason:
        status === 'failed' ? (root.failure?.reason ?? null) : null,
      cappedAt: row.cappedAt?.toISOString() ?? null,
      spentUsd,
      capUsd: row.capUsd,
      pool: pool.map(({ number, subject, status: taskStatus }) => ({
        number,
        subject,
        status: taskStatus,
        skipped: number === FIX_TASK && fixSkipped === 'not_needed',
      })),
      phase: state.phase,
      canSend: closedReason(state, spentUsd >= row.capUsd) === null,
      plan:
        row.plan === null
          ? null
          : { ...row.plan, agreed: row.agentId !== null },
      offered:
        offered === undefined
          ? null
          : {
              id: offered.id,
              name: offered.name,
              description: offered.description,
            },
      taken: taken === undefined ? null : { id: taken.id, name: taken.name },
      agent:
        agent === undefined || base === undefined
          ? null
          : {
              id: agent.id,
              name: agent.name,
              description: agent.description,
              deleted: !live,
              // The agent as it is: its active version when that is one of the run's (kept after a delete).
              content: DeepAgentContentSchema.parse(
                (
                  versions.find((version) => version.id === agent.versionId) ??
                  base
                ).content,
              ),
            },
      tests,
      rounds: versions.map((version, index) => {
        const results = tests.flatMap((test) => {
          const result = test.rounds[index];
          return result === undefined ? [] : [result];
        });
        return {
          versionId: version.id,
          version: version.number,
          requested: index > 0 && requestedRound(pool, index + 1),
          passed: results.filter((result) => result.verdict === 'passed')
            .length,
          total: tests.length,
          ...sum(results),
          changes: index === 0 ? null : version.changes,
          texts: versionTexts(version.content),
          canActivate:
            index > 0 &&
            live &&
            state.phase !== 'working' &&
            agent.versionId !== version.id &&
            versions.some((candidate) => candidate.id === agent.versionId) &&
            actor.trainOwn,
        };
      }),
      fixSkipped,
      fixExplanation:
        fixSkipped === 'nothing_to_fix' && rootStatus === 'completed'
          ? reportOf(root.result) || null
          : null,
      activatedAt: row.activatedAt?.toISOString() ?? null,
      activeVersion: live ? agent.version : null,
      canDelete: finished && live,
    };
  }

  /**
   * POST /api/test-runs/:testRunId/activate with the version's number. 404 TRAINING_NOT_FOUND, 404 RECORD_NOT_FOUND,
   * 403 TRAINING_FORBIDDEN, 409 TRAINING_NOT_ACTIVATABLE — the working phase, a version not of this run or already
   * active —, 409 TRAINING_BASE_CHANGED — the active version is not of this run.
   */
  async activate(
    actor: AuthUser,
    testRunId: string,
    number: number,
  ): Promise<TrainingActivated> {
    const { row, root } = await this.testRunOf(actor, testRunId);
    if (row.agentId === null || row.baseVersionId === null)
      throw libraryError('RECORD_NOT_FOUND');
    const target = await this.library.trainingTarget(actor, row.agentId);
    // The starter is the author: the right is trainOwn alone, as canActivate of the view.
    if (!actor.trainOwn) throw trainingError('TRAINING_FORBIDDEN');
    const [base, proposed, pool] = await Promise.all([
      this.agents.findVersion(row.baseVersionId),
      this.agents.trainingVersions(row.id),
      this.sessionTasks.list(row.id),
    ]);
    if (base === undefined)
      throw new Error(`Version 1 of test run ${row.id} is missing`);
    const versions = [base, ...proposed];
    const version = versions.find((candidate) => candidate.number === number);
    const { phase } = runPhase({
      row,
      rootStatus: TaskStatusSchema.parse(root.status),
      pool,
      proposed: proposed.length,
    });
    if (
      phase === 'working' ||
      version === undefined ||
      version.id === target.activeVersion.id
    )
      throw trainingError('TRAINING_NOT_ACTIVATABLE');
    const active = versions.find(
      (candidate) => candidate.id === target.activeVersion.id,
    );
    if (active === undefined) throw trainingError('TRAINING_BASE_CHANGED');
    return this.training.activateFor(actor, target, {
      trainingId: row.id,
      version,
      expectedNumber: active.number,
      testRun: true,
    });
  }

  /** The test run its starter reads; another's, a training, a missing one or a deleted conversation — 404 TRAINING_NOT_FOUND. */
  private async testRunOf(
    actor: AuthUser,
    testRunId: string,
  ): Promise<{ row: TrainingRow; root: RuntimeTaskRow; description: string }> {
    // The root first: a finished root seen here means its last commit is in the row read after it.
    const root = isUuid(testRunId)
      ? await this.taskRows.find(testRunId)
      : undefined;
    const row =
      root === undefined ? undefined : await this.trainings.find(testRunId);
    if (
      row === undefined ||
      row.description === null ||
      root === undefined ||
      root.deletedAt !== null ||
      root.ownerId !== actor.id
    )
      throw trainingError('TRAINING_NOT_FOUND');
    return { row, root, description: row.description };
  }
}
