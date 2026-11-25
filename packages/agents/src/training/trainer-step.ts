import {
  type Comparison,
  type SessionTaskStatus,
  SessionTaskStatusSchema,
} from '@agent-os/contracts';
import type {
  AgentsRepository,
  AgentTrainingRow,
  AgentVersionRow,
  DocumentsRepository,
  SessionTasksWrite,
  TrainingsRepository,
} from '@agent-os/db';
import {
  isFinished,
  type StepContext,
  type StepEffects,
  type StepResult,
  type Task,
} from '@agent-os/runtime';

import type { AgentDeps } from '../agent/agent-deps';
import { agentOwner } from '../agent/agent-owner';
import type { SessionHistory } from '../agent/agent-state';
import type { BaseAgent } from '../agent/base-agent';
import { entriesOf, reportOf } from '../agent/deliver';
import { withPrelude } from '../agent/prelude';
import type { StepPrelude } from '../agent/step-common';
import {
  auditStartRefusal,
  resolveStart,
  type StartDeps,
  type StartRefusal,
} from '../start/resolve-start';
import type { RunStart } from '../start/run-definition';
import type { StartChild } from '../tools/tool';
import type { StartChildScope } from '../tools/tool-runner';
import { judgePair, type Decision } from './judge';
import { POOL_TASKS } from './pool';
import { reAsksOf } from './training-reads';

/** What the trainer works with: an agent's, its training, the documents of runs and the start of its replays. */
export type TrainerDeps = AgentDeps & {
  readonly trainingRows: Pick<
    TrainingsRepository,
    'find' | 'writeComparisons' | 'writeTests'
  >;
  readonly agentRows: Pick<
    AgentsRepository,
    'findTrainingVersion' | 'trainingVersions' | 'findAny'
  >;
  readonly documentRows: Pick<
    DocumentsRepository,
    'latestReport' | 'findInRun'
  >;
  readonly start: StartDeps;
  readonly startChild: (scope: StartChildScope) => StartChild;
};

/** The pool's task the model ends its work with: the proposal (design-training.md, «Пул задач тренера»). */
export const PROPOSAL_TASK = 4;
const REPLAY_TASK = 5;
const SUMMARY_TASK = 6;
const PAST_DELETED = 'The past task was deleted.';

const { completed, in_progress: inProgress } = SessionTaskStatusSchema.enum;

/** A pair's two replays to start, or why they cannot start. */
type ReplayStart =
  | {
      readonly kind: 'start';
      readonly base: RunStart;
      readonly proposed: RunStart;
      readonly prompt: string;
      readonly description: string;
    }
  | { readonly kind: 'refused'; readonly refusal: StartRefusal }
  | { readonly kind: 'deleted' };

/** The one pair this step decided. */
interface Judged {
  readonly index: number;
  readonly decision: Decision;
}

/** The pool's tasks with new statuses; the other tasks stay, the trainer adds none. */
function poolWrite(
  statuses: readonly (readonly [number, SessionTaskStatus])[],
): SessionTasksWrite {
  return {
    written: statuses.map(([number, status]) => ({
      ...POOL_TASKS[number - 1]!,
      status,
    })),
    deleted: [],
    lastNumber: POOL_TASKS.length,
  };
}

function needsStart(comparison: Comparison): boolean {
  return comparison.baseReplayId === null && comparison.verdict === null;
}

/**
 * The list with this step's verdicts: a refused start or a deleted past task decides its element `not_compared`,
 * the judged pair gets its decision, an element decided already keeps its verdict. Replay ids stay as given.
 */
function withVerdicts(
  comparisons: readonly Comparison[],
  starts: ReadonlyMap<number, ReplayStart>,
  judged: Judged | undefined,
): Comparison[] {
  return comparisons.map((comparison, index) => {
    if (comparison.verdict !== null) return comparison;
    const start = needsStart(comparison) ? starts.get(index) : undefined;
    if (start?.kind === 'refused')
      return {
        ...comparison,
        verdict: 'not_compared',
        reason: `The replays could not start: ${start.refusal.reason}.`,
      };
    if (start?.kind === 'deleted')
      return {
        ...comparison,
        verdict: 'not_compared',
        reason: PAST_DELETED,
      };
    return judged?.index === index
      ? { ...comparison, ...judged.decision }
      : comparison;
  });
}

/** The text of the model's last answer — the one that carries its closing call: its explanation when it proposed no version. */
export function lastAnswerText(view: SessionHistory): string {
  const answer = view.entries.findLast(
    (entry) => entry.kind === 'model_answer',
  );
  return answer?.kind === 'model_answer' ? answer.content.text : '';
}

/** The summary of a training whose pairs are all decided: the counts of the verdicts. */
function summaryOf(
  version: number,
  comparisons: readonly Comparison[],
): string {
  const count = (verdict: Comparison['verdict']) =>
    comparisons.filter((comparison) => comparison.verdict === verdict).length;
  return `Version ${version} proposed. Compared on ${comparisons.length} past tasks: better ${count('proposed_better')}, worse ${count('base_better')}, equal ${count('equal')}, not compared ${count('not_compared')}.`;
}

/**
 * The trainer's step once the model proposed a version or closed the proposal task (design-training.md, KD-3,
 * KD-4, «Пул задач тренера», Flow 2): code only, no call of the trainer's model.
 *
 * - No version proposed → tasks 5 and 6 completed, the trainer completes with the model's last answer.
 * - Otherwise, before the commit: the two replays of every element not started yet — the base and the proposed
 *   version, the past run's name and task, the version's model or else the past run's, one `resolveStart` on
 *   behalf of the starter for both; a past task deleted meanwhile is not replayed — and one judge call for one
 *   pair whose two replays have finished.
 * - In the commit: the comparison list read again after the task row is held, the replays started as children
 *   (`replay:{n}:base` / `replay:{n}:proposed` as their start call) and their ids, this step's verdicts, the whole
 *   list written back, task 4 completed. Then all pairs decided → tasks 5 and 6 completed and the trainer
 *   completes; another pair ready → the next step judges it; else task 5 in progress and the trainer waits: each
 *   replay's `child_finished` wakes it.
 *
 * Only this step writes the list and steps of one task never overlap, so a step repeated after a lost commit
 * starts nothing twice and a decision is written once. A step cut off by a stop or the cap leaves without writes.
 */
export async function runTrainerStep(
  deps: TrainerDeps,
  trainer: Pick<BaseAgent, 'caller' | 'definition'>,
  ctx: StepContext,
  version: AgentVersionRow | undefined,
  view: SessionHistory,
  prelude: StepPrelude | undefined,
): Promise<StepResult> {
  const row = await deps.trainingRows.find(ctx.rootId);
  if (row === undefined)
    throw new Error(`Trainer ${ctx.taskId} has no training row`);
  const { agentId, baseVersionId } = row;
  if (agentId === null || baseVersionId === null)
    throw new Error(`Training ${row.id} has no agent`);
  const training = { ...row, agentId, baseVersionId };
  const delivered = await entriesOf(deps, ctx);
  const close = { turns: 0, closed: true };

  if (version === undefined) {
    ctx.logger.info('training ended without a version', {
      trainingId: training.id,
      agentId: training.agentId,
    });
    return withPrelude(
      deps,
      ctx,
      {
        outcome: 'complete',
        result: { report: lastAnswerText(view), document: null },
        commit: async () => {
          await deps.history.append(ctx.taskId, delivered);
          await deps.sessionTaskRows.write(
            ctx.taskId,
            poolWrite([
              [REPLAY_TASK, completed],
              [SUMMARY_TASK, completed],
            ]),
          );
          await deps.sessionRows.update(ctx.taskId, close);
        },
      },
      prelude,
    );
  }

  const starts = await replayStarts(deps, ctx, training, version.id);
  const next = await judgeNext(deps, trainer, ctx, training);
  if (next === undefined) return { outcome: 'continue' };
  const { judged, moreReady } = next;

  const settled = withVerdicts(training.comparisons, starts, judged);
  const done = settled.every((comparison) => comparison.verdict !== null);
  const commit = async (effects: StepEffects) => {
    await deps.history.append(ctx.taskId, delivered);
    const fresh = (await deps.trainingRows.find(training.id))!;
    const comparisons = withVerdicts(fresh.comparisons, starts, judged);
    for (const [index, comparison] of comparisons.entries()) {
      const start = needsStart(comparison) ? starts.get(index) : undefined;
      if (start?.kind !== 'start') continue;
      const startChild = (kind: 'base' | 'proposed') =>
        deps.startChild({
          effects,
          caller: trainer.caller,
          callId: `replay:${index + 1}:${kind}`,
        })({
          run: start[kind],
          prompt: start.prompt,
          description: start.description,
        });
      const base = await startChild('base');
      const proposed = await startChild('proposed');
      ctx.logger.info('replays started', {
        trainingId: training.id,
        pair: index + 1,
        baseReplayId: base.agentId,
        proposedReplayId: proposed.agentId,
        model: start.base.model,
      });
      comparisons[index] = {
        ...comparison,
        baseReplayId: base.agentId,
        proposedReplayId: proposed.agentId,
      };
    }
    for (const start of starts.values())
      if (start.kind === 'refused')
        await auditStartRefusal(deps.audit, start.refusal);
    await deps.trainingRows.writeComparisons(training.id, comparisons);
    for (const [index, comparison] of comparisons.entries()) {
      if (
        comparison.verdict !== null &&
        fresh.comparisons[index]!.verdict === null
      )
        ctx.logger.info('pair decided', {
          trainingId: training.id,
          pair: index + 1,
          verdict: comparison.verdict,
        });
    }
    await deps.sessionTaskRows.write(
      ctx.taskId,
      poolWrite(
        done
          ? [
              [PROPOSAL_TASK, completed],
              [REPLAY_TASK, completed],
              [SUMMARY_TASK, completed],
            ]
          : [
              [PROPOSAL_TASK, completed],
              [REPLAY_TASK, inProgress],
            ],
      ),
    );
    if (done) await deps.sessionRows.update(ctx.taskId, close);
  };

  const count = (kind: ReplayStart['kind']) =>
    [...starts.values()].filter((start) => start.kind === kind).length;
  ctx.logger.info('trainer step', {
    trainingId: training.id,
    replaysStarted: count('start'),
    startsRefused: count('refused'),
    pastDeleted: count('deleted'),
    pairJudged: judged === undefined ? null : judged.index + 1,
    moreReady,
    done,
  });
  if (done)
    return withPrelude(
      deps,
      ctx,
      {
        outcome: 'complete',
        result: { report: summaryOf(version.number, settled), document: null },
        commit,
      },
      prelude,
    );
  return withPrelude(
    deps,
    ctx,
    { outcome: moreReady ? 'continue' : 'wait', commit },
    prelude,
  );
}

/**
 * The replays of the elements not started yet (KD-3): a deep agent's run of the past task on the base and on the
 * proposed version, under the past run's name and description, on the base version's model or else the past
 * run's — the same for both, since a proposal changes only prompts and scripts — checked once by `resolveStart`
 * on behalf of the starter, as a run already resolved. A past task its owner deleted is not replayed.
 */
async function replayStarts(
  deps: TrainerDeps,
  ctx: StepContext,
  training: AgentTrainingRow,
  proposedVersionId: string,
): Promise<Map<number, ReplayStart>> {
  const starts = new Map<number, ReplayStart>();
  if (!training.comparisons.some(needsStart)) return starts;
  const [baseVersion, proposedVersion] = await Promise.all([
    deps.start.library.version(training.baseVersionId),
    deps.start.library.version(proposedVersionId),
  ]);
  for (const [index, comparison] of training.comparisons.entries()) {
    if (!needsStart(comparison)) continue;
    const live = await deps.sessionRows.pastTasks(training.agentId, {
      limit: 1,
      conversationId: comparison.pastConversationId,
    });
    if (live.length === 0) {
      starts.set(index, { kind: 'deleted' });
      continue;
    }
    const past = await deps.sessions.get(comparison.pastConversationId);
    if (past === undefined)
      throw new Error(
        `Past task ${comparison.pastConversationId} has no session`,
      );
    const base: RunStart = {
      version: baseVersion,
      name: past.name,
      subagent: null,
      model: baseVersion.content.model ?? past.model,
    };
    const resolution = await resolveStart(
      {
        ownerId: agentOwner(ctx),
        source: { kind: 'restart', run: base },
        callerModel: null,
      },
      deps.start,
    );
    starts.set(
      index,
      resolution.kind === 'refused'
        ? { kind: 'refused', refusal: resolution }
        : {
            kind: 'start',
            base: resolution.run,
            proposed: { ...resolution.run, version: proposedVersion },
            prompt: await deps.history.taskText(comparison.pastConversationId),
            description: past.description,
          },
    );
  }
  return starts;
}

/**
 * The decision on one pair whose two replays have finished and that has no verdict (KD-4): a replay that ended
 * neither completed nor failed — stopped — decides its pair `not_compared`; otherwise one judge call. `moreReady`
 * — another such pair is left for the next step. `undefined` — the step was cut off by a stop or the cap.
 */
async function judgeNext(
  deps: TrainerDeps,
  trainer: Pick<BaseAgent, 'caller' | 'definition'>,
  ctx: StepContext,
  training: AgentTrainingRow,
): Promise<{ judged: Judged | undefined; moreReady: boolean } | undefined> {
  let judged: Judged | undefined;
  for (const [index, comparison] of training.comparisons.entries()) {
    const { baseReplayId, proposedReplayId, verdict } = comparison;
    if (verdict !== null || baseReplayId === null || proposedReplayId === null)
      continue;
    const [base, proposed] = await Promise.all(
      [baseReplayId, proposedReplayId].map((id) =>
        deps.tasks.get(id, agentOwner(ctx)),
      ),
    );
    if (!isFinished(base!.status) || !isFinished(proposed!.status)) continue;
    if (judged !== undefined) return { judged, moreReady: true };
    const stopped = [base!, proposed!].find(
      (task) => task.status !== 'completed' && task.status !== 'failed',
    );
    const past =
      stopped === undefined
        ? await pastOf(deps, comparison.pastConversationId)
        : undefined;
    const decision =
      stopped !== undefined
        ? {
            verdict: 'not_compared' as const,
            reason: `A replay ended ${stopped.status}.`,
          }
        : past === undefined
          ? { verdict: 'not_compared' as const, reason: PAST_DELETED }
          : await judgePair(
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
                ...past,
                base: await replayAnswer(deps, base!),
                proposed: await replayAnswer(deps, proposed!),
              },
            );
    if (decision === undefined) return undefined;
    judged = { index, decision };
  }
  return { judged, moreReady: false };
}

/** A run's report document — the newest marked report since its start (design-notepad.md KD-4) — if it has one. */
export async function reportDocument(
  deps: Pick<TrainerDeps, 'documentRows'>,
  runId: string,
): Promise<string | undefined> {
  const report = await deps.documentRows.latestReport(runId);
  return report === undefined
    ? undefined
    : (await deps.documentRows.findInRun(runId, report.id))?.text;
}

/**
 * What the judge sees of a past task: its task, its report or else its short answer, and the employee's re-asks;
 * `undefined` once its owner has deleted it.
 */
async function pastOf(
  deps: TrainerDeps,
  pastId: string,
): Promise<{ task: string; original: string; reAsks: string[] } | undefined> {
  const past = await deps.sessions.get(pastId);
  if (past === undefined) return undefined;
  const task = await deps.tasks.get(pastId, past.ownerId);
  return {
    task: await deps.history.taskText(pastId),
    original:
      (await reportDocument(deps, pastId)) ??
      (task.status === 'completed'
        ? reportOf(task.result)
        : (task.failure?.message ?? '')),
    reAsks:
      past.parentId === null
        ? []
        : await reAsksOf(deps.history, past.parentId, pastId),
  };
}

/** A replay as the judge sees it: its report document, or the text of its failure. */
async function replayAnswer(deps: TrainerDeps, replay: Task): Promise<string> {
  if (replay.status === 'failed')
    return `The run failed: ${replay.failure?.message ?? ''}`;
  return (await reportDocument(deps, replay.taskId)) ?? reportOf(replay.result);
}
