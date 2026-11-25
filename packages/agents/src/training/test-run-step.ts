import {
  roundFailed,
  roundJudged,
  SessionTaskStatusSchema,
  type TestRunTest,
  type TestVerdict,
} from '@agent-os/contracts';
import type {
  AgentVersionRow,
  SessionTask,
  SessionTasksWrite,
  TrainingRow,
} from '@agent-os/db';
import {
  isFinished,
  type StepContext,
  type StepEffects,
  type StepResult,
} from '@agent-os/runtime';

import { agentOwner } from '../agent/agent-owner';
import type { SessionHistory } from '../agent/agent-state';
import type { BaseAgent } from '../agent/base-agent';
import { entriesOf, reportOf } from '../agent/deliver';
import { withPrelude } from '../agent/prelude';
import type { StepPrelude } from '../agent/step-common';
import { briefJson } from '../deep/start-deep-agent';
import {
  auditStartRefusal,
  resolveStart,
  type StartResolution,
} from '../start/resolve-start';
import { judgeAnswer } from './judge';
import { FIX_TASK, TEST_RUN_POOL_TASKS, testRunPoolWrite } from './pool';
import {
  lastAnswerText,
  reportDocument,
  type TrainerDeps,
} from './trainer-step';

const FIRST_ROUND_TASK = 2;
const SUMMARY_TASK = 4;

const { completed, in_progress: inProgress } = SessionTaskStatusSchema.enum;

/** What the trainer of a test run does next (design-trainer-dialog.md, «Фазы и передача хода»). */
export type TestRunMove =
  | { readonly kind: 'model' }
  | {
      readonly kind: 'round';
      readonly round: number;
      /** A round the employee asked for: it starts after the summary task is closed (KD-7). */
      readonly requested: boolean;
    }
  | { readonly kind: 'nothing_to_fix' }
  | { readonly kind: 'taken' };

/**
 * The hand-over between the model and code, by the six rules in their order: (1) taken — the code's end; (2) no
 * agent — the model; (3) a test of round k, k the number of the run's versions, unjudged or not started — round k
 * on version k; (4) one round judged with a failure and the fix task open — the model; (5) the fix task closed
 * without a version and the summary task open — the code's end; (6) otherwise the model. The fix task closed
 * while round 1 was still running is reopened by the step that judged round 1 last, so a closed fix task here is
 * always closed after it.
 */
export function testRunMove(state: {
  readonly takenAgentId: string | null;
  readonly agentId: string | null;
  readonly tests: readonly TestRunTest[];
  /** The run's versions, version 1 included. */
  readonly versions: number;
  readonly fixClosed: boolean;
  readonly summaryClosed: boolean;
}): TestRunMove {
  const { tests, versions, fixClosed, summaryClosed } = state;
  if (state.takenAgentId !== null) return { kind: 'taken' };
  if (state.agentId === null) return { kind: 'model' };
  if (!roundJudged(tests, versions))
    return {
      kind: 'round',
      round: versions,
      requested: versions > 1 && summaryClosed,
    };
  if (versions === 1 && roundFailed(tests, 1) && !fixClosed)
    return { kind: 'model' };
  if (versions === 1 && fixClosed && !summaryClosed)
    return { kind: 'nothing_to_fix' };
  return { kind: 'model' };
}

/** The test run's row, the versions it proposed by number, its pool and the move the rules decide, read before each model step. */
export async function nextTestRunMove(
  deps: TrainerDeps,
  ctx: StepContext,
): Promise<{
  readonly row: TrainingRow;
  readonly proposed: readonly AgentVersionRow[];
  readonly pool: readonly SessionTask[];
  readonly move: TestRunMove;
}> {
  const [row, proposed, pool] = await Promise.all([
    deps.trainingRows.find(ctx.rootId),
    deps.agentRows.trainingVersions(ctx.taskId),
    deps.sessionTaskRows.list(ctx.taskId),
  ]);
  if (row === undefined)
    throw new Error(`Test run ${ctx.taskId} has no training row`);
  const closed = (number: number) =>
    pool.find((task) => task.number === number)?.status === completed;
  return {
    row,
    proposed,
    pool,
    move: testRunMove({
      takenAgentId: row.takenAgentId,
      agentId: row.agentId,
      tests: row.tests,
      versions: (row.baseVersionId === null ? 0 : 1) + proposed.length,
      fixClosed: closed(FIX_TASK),
      summaryClosed: closed(SUMMARY_TASK),
    }),
  };
}

/** The one test this step judged. */
interface Judged {
  readonly index: number;
  readonly verdict: TestVerdict;
  readonly reason: string;
}

/**
 * The tests with this step's verdicts: a refused start fails every test of the round not started yet, the
 * judged test gets its verdict in its empty place; a verdict once written stays.
 */
function withVerdicts(
  tests: readonly TestRunTest[],
  round: number,
  refusal: string | undefined,
  judged: Judged | undefined,
): TestRunTest[] {
  return tests.map((test, index) => {
    const slot = test.rounds[round - 1];
    if (slot === undefined && refusal !== undefined)
      return withRound(test, round, {
        runId: null,
        verdict: 'failed',
        reason: `The run could not start: ${refusal}.`,
      });
    if (slot !== undefined && slot.verdict === null && judged?.index === index)
      return withRound(test, round, {
        ...slot,
        verdict: judged.verdict,
        reason: judged.reason,
      });
    return test;
  });
}

/** The test with its slot of the round set. */
function withRound(
  test: TestRunTest,
  round: number,
  slot: TestRunTest['rounds'][number],
): TestRunTest {
  return { ...test, rounds: test.rounds.toSpliced(round - 1, 1, slot) };
}

/** The judged round as data for the trainer's model: its totals and each test's verdict with its reason. */
function roundNote(
  round: number,
  version: number,
  tests: readonly TestRunTest[],
): string {
  const slots = tests.map((test) => test.rounds[round - 1]);
  const passed = slots.filter((slot) => slot?.verdict === 'passed').length;
  return [
    `Round ${round} on version ${version} is judged: passed ${passed} of ${tests.length}.`,
    ...slots.map(
      (slot, index) =>
        `Test ${index + 1}: ${slot?.verdict} — ${slot?.reason ?? ''}`,
    ),
  ].join('\n');
}

/**
 * The pool write of round k's own task: task 2 for round 1, task 3 for the automatic fix, and for a requested round
 * the task it adds — the one in progress above the pool, or else a new one after the last number (KD-7).
 */
function roundTaskWrite(
  move: Extract<TestRunMove, { kind: 'round' }>,
  pool: readonly SessionTask[],
  status: typeof completed | typeof inProgress,
): SessionTasksWrite {
  if (!move.requested)
    return testRunPoolWrite([
      [move.round === 1 ? FIRST_ROUND_TASK : FIX_TASK, status],
    ]);
  const added = pool.filter((task) => task.number > TEST_RUN_POOL_TASKS.length);
  const number =
    added.find((task) => task.status === inProgress)?.number ??
    Math.max(TEST_RUN_POOL_TASKS.length, ...added.map((task) => task.number)) +
      1;
  return testRunPoolWrite([], { number, round: move.round, status });
}

/**
 * The trainer's code step of a test run (design-test-run.md, KD-4, KD-5, Flow 3; design-trainer-dialog.md,
 * «Фазы и передача хода»), built as `runTrainerStep`.
 *
 * - `taken` → the trainer completes with the model's last answer, no model call.
 * - `nothing_to_fix` → task 3 gets its description, task 4 completed, the trainer completes with the model's
 *   last answer.
 * - Round k, before the commit: one start of version k under the agent's name, on the version's model or else
 *   the default chat model, checked by `resolveStart` on behalf of the starter for its tests not started; one
 *   decision on one finished run without a verdict — `completed` goes to the judge with the employee's
 *   description or else the agent's, any other end fails the test with its outcome.
 * - In the commit: the tests read again, the runs started as children (`test:{n}:{k}`), a refused start failing
 *   its tests, the verdict written into its empty place, the whole list written back, the pool moved. The round's
 *   task is in progress until its last verdict. The last verdict of round 1 closes task 2 and either reopens task 3
 *   with a notice of the round or, with no failure, skips it and completes; the last verdict of the automatic fix
 *   closes tasks 3 and 4 and completes; that of a requested round closes the task it added and completes.
 *
 * A step lost before its commit is repeated from the start and starts or judges nothing twice.
 */
export async function runTestRunStep(
  deps: TrainerDeps,
  trainer: Pick<BaseAgent, 'caller' | 'definition'>,
  ctx: StepContext,
  { row, proposed, pool, move }: Awaited<ReturnType<typeof nextTestRunMove>>,
  view: SessionHistory,
  prelude: StepPrelude | undefined,
): Promise<StepResult> {
  const delivered = await entriesOf(deps, ctx);
  const close = { turns: 0, closed: true };

  if (move.kind !== 'round') {
    ctx.logger.info(
      move.kind === 'taken'
        ? 'test run ended: agent taken'
        : 'test run ended without a fix',
      { trainingId: row.id, takenAgentId: row.takenAgentId },
    );
    return withPrelude(
      deps,
      ctx,
      {
        outcome: 'complete',
        result: { report: lastAnswerText(view), document: null },
        commit: async () => {
          await deps.history.append(ctx.taskId, delivered);
          if (move.kind === 'nothing_to_fix')
            await deps.sessionTaskRows.write(
              ctx.taskId,
              testRunPoolWrite([
                [FIX_TASK, completed, 'Тренер не нашёл, что исправить.'],
                [SUMMARY_TASK, completed],
              ]),
            );
          await deps.sessionRows.update(ctx.taskId, close);
        },
      },
      prelude,
    );
  }

  const { round, requested } = move;
  const agent = await deps.agentRows.findAny(row.agentId!);
  if (agent === undefined)
    throw new Error(`Test run ${row.id} has no agent ${row.agentId}`);
  const resolution = row.tests.some(
    (test) => test.rounds[round - 1] === undefined,
  )
    ? await roundStart(
        deps,
        ctx,
        round === 1 ? row.baseVersionId! : proposed[round - 2]!.id,
        agent.name,
      )
    : undefined;
  const refusal =
    resolution?.kind === 'refused' ? resolution.reason : undefined;
  const next = await judgeNext(
    deps,
    trainer,
    ctx,
    row,
    round,
    row.description || agent.description,
  );
  if (next === undefined) return { outcome: 'continue' };
  const { judged, moreReady } = next;

  const settled = withVerdicts(row.tests, round, refusal, judged);
  const done = roundJudged(settled, round);
  const failed = roundFailed(settled, 1);
  const first = round === 1;
  const note = roundNote(
    round,
    first ? 1 : proposed[round - 2]!.number,
    settled,
  );

  const commit = async (effects: StepEffects) => {
    await deps.history.append(ctx.taskId, delivered);
    const fresh = (await deps.trainingRows.find(row.id))!;
    const tests = withVerdicts(fresh.tests, round, refusal, judged);
    if (resolution?.kind === 'started') {
      for (const [index, test] of tests.entries()) {
        if (test.rounds[round - 1] !== undefined) continue;
        const child = await deps.startChild({
          effects,
          caller: trainer.caller,
          callId: `test:${index + 1}:${round}`,
        })({
          run: resolution.run,
          // A deep agent's task is a brief (start_deep_agent): the run view reads it back.
          prompt: briefJson({
            question: test.task,
            boundaries: '',
            result: '',
          }),
          description: `Тест ${index + 1}`,
        });
        ctx.logger.info('test run started', {
          trainingId: row.id,
          test: index + 1,
          round,
          requested,
          runId: child.agentId,
          model: resolution.run.model,
        });
        tests[index] = withRound(test, round, {
          runId: child.agentId,
          verdict: null,
          reason: null,
        });
      }
    }
    if (resolution?.kind === 'refused')
      await auditStartRefusal(deps.audit, resolution);
    await deps.trainingRows.writeTests(row.id, tests);
    if (judged !== undefined)
      ctx.logger.info('test judged', {
        trainingId: row.id,
        test: judged.index + 1,
        round,
        verdict: judged.verdict,
      });
    if (!done) {
      await deps.sessionTaskRows.write(
        ctx.taskId,
        roundTaskWrite(move, pool, inProgress),
      );
      return;
    }
    ctx.logger.info('test run round judged', {
      trainingId: row.id,
      round,
      requested,
      passed: tests.filter(
        (test) => test.rounds[round - 1]?.verdict === 'passed',
      ).length,
      total: tests.length,
    });
    await deps.history.append(ctx.taskId, [
      { kind: 'notice', content: { text: note } },
    ]);
    if (first && failed) {
      await deps.sessionTaskRows.write(
        ctx.taskId,
        testRunPoolWrite([
          [FIRST_ROUND_TASK, completed],
          [FIX_TASK, inProgress],
        ]),
      );
      return;
    }
    await deps.sessionTaskRows.write(
      ctx.taskId,
      requested
        ? roundTaskWrite(move, pool, completed)
        : testRunPoolWrite(
            first
              ? [
                  [FIRST_ROUND_TASK, completed],
                  [FIX_TASK, completed, 'Не понадобилось: все тесты прошли.'],
                  [SUMMARY_TASK, completed],
                ]
              : [
                  [FIX_TASK, completed],
                  [SUMMARY_TASK, completed],
                ],
          ),
    );
    await deps.sessionRows.update(ctx.taskId, close);
  };

  if (done && !(first && failed))
    return withPrelude(
      deps,
      ctx,
      {
        outcome: 'complete',
        result: { report: note, document: null },
        commit,
      },
      prelude,
    );
  return withPrelude(
    deps,
    ctx,
    { outcome: done || moreReady ? 'continue' : 'wait', commit },
    prelude,
  );
}

/**
 * The start of the round's runs: the round's version under the agent's name, on the version's model or else the
 * default chat model, as a run already resolved on behalf of the starter.
 */
async function roundStart(
  deps: TrainerDeps,
  ctx: StepContext,
  versionId: string,
  name: string,
): Promise<StartResolution> {
  const roundVersion = await deps.start.library.version(versionId);
  const model =
    roundVersion.content.model ?? (await deps.start.access.defaultChatModel());
  if (model === null)
    return {
      kind: 'refused',
      reason: 'model_not_configured',
      model: null,
      denied: null,
    };
  return resolveStart(
    {
      ownerId: agentOwner(ctx),
      source: {
        kind: 'restart',
        run: { version: roundVersion, name, subagent: null, model },
      },
      callerModel: null,
    },
    deps.start,
  );
}

/**
 * The decision on one finished run of the round without a verdict (KD-5): `completed` — one judge call on its
 * report or short answer against `description`; any other end fails the test with its outcome, without the judge.
 * `moreReady` — another such run is left for the next step. `undefined` — the step was cut off by a stop or the cap.
 */
async function judgeNext(
  deps: TrainerDeps,
  trainer: Pick<BaseAgent, 'caller' | 'definition'>,
  ctx: StepContext,
  row: TrainingRow,
  round: number,
  description: string,
): Promise<{ judged: Judged | undefined; moreReady: boolean } | undefined> {
  let judged: Judged | undefined;
  for (const [index, test] of row.tests.entries()) {
    const slot = test.rounds[round - 1];
    if (slot === undefined || slot.runId === null || slot.verdict !== null)
      continue;
    const run = await deps.tasks.get(slot.runId, agentOwner(ctx));
    if (!isFinished(run.status)) continue;
    if (judged !== undefined) return { judged, moreReady: true };
    const decision =
      run.status === 'completed'
        ? await judgeAnswer(
            deps.modelClient,
            ctx,
            {
              ownerId: agentOwner(ctx),
              rootId: ctx.rootId,
              taskId: ctx.taskId,
              agentName: trainer.definition.name,
              model: trainer.caller.run.model,
              streamsText: false,
              signal: ctx.signal,
              logger: ctx.logger,
              training: true,
            },
            {
              description,
              task: test.task,
              expected: test.expected,
              answer:
                (await reportDocument(deps, run.taskId)) ??
                reportOf(run.result),
            },
          )
        : {
            verdict: 'failed' as const,
            reason: `The run ended ${run.status}${run.failure === null || run.failure === undefined ? '' : `: ${run.failure.message}`}.`,
          };
    if (decision === undefined) return undefined;
    judged = { index, ...decision };
  }
  return { judged, moreReady: false };
}
