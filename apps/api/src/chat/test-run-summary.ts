import {
  roundJudged,
  TEST_RUN_PLAN_REVISIONS_MAX,
  TEST_RUN_TOOLS,
  TRAINER_TOOLS,
  type HistoryEntry,
  type TaskStatus,
  type TestRunSummary,
} from '@agent-os/contracts';
import type { TrainingRow } from '@agent-os/db';
import {
  closedReason,
  messageAfter,
  type PoolTask,
  requestedRound,
  runPhase,
  successfulCalls,
} from '../training/test-run-rules';
import { trainingStatus } from '../training/training-rules';

const [, OFFER_AGENT_TOOL, , PROPOSE_PLAN_TOOL, CREATE_AGENT_TOOL] =
  TEST_RUN_TOOLS;
const PROPOSE_VERSION_TOOL = TRAINER_TOOLS[5];

/** The tools whose successful results `testRunSummary` reads, with the employee's first message after each (live-feed KD-6). */
export const TEST_RUN_SUMMARY_TOOLS = [
  OFFER_AGENT_TOOL,
  PROPOSE_PLAN_TOOL,
  CREATE_AGENT_TOOL,
  PROPOSE_VERSION_TOOL,
];

/** A call's entry and the time of its result. */
type CallEntry = HistoryEntry & { readonly callId: string };

/**
 * The summary of a test run in its conversation's view (create-and-test design-trainer-dialog.md, KD-9; pure-decision.md):
 * the phase and why the composer is closed, the task in progress, the agent, the rounds with the call that started
 * each, and the outcome of the offer and of every plan — all derived from the row, the pool, the run's versions, the
 * spend and the trainer's whole history.
 */
export function testRunSummary(run: {
  readonly row: TrainingRow;
  readonly root: {
    readonly status: TaskStatus;
    readonly finishedAt: Date | null;
  };
  readonly pool: readonly PoolTask[];
  /** The versions the run proposed, version 1 not included. */
  readonly proposed: number;
  readonly spentUsd: number;
  /** The created agent's row, deleted or not; `undefined` without one. */
  readonly agent:
    { readonly name: string; readonly deletedAt: Date | null } | undefined;
  readonly takenAgent: { readonly name: string } | undefined;
  readonly entries: readonly HistoryEntry[];
}): TestRunSummary {
  const { row, root, pool, entries } = run;
  const state = runPhase({
    row,
    rootStatus: root.status,
    pool,
    proposed: run.proposed,
  });
  const reason = closedReason(state, run.spentUsd >= row.capUsd);
  const [created] = successfulCalls(entries, CREATE_AGENT_TOOL);
  const plans = successfulCalls(entries, PROPOSE_PLAN_TOOL);
  return {
    phase: state.phase,
    status: trainingStatus(root.status),
    capped: row.cappedAt !== null,
    canSend: reason === null,
    closedReason: reason,
    step:
      pool.filter((task) => task.status === 'in_progress').at(-1)?.subject ??
      null,
    agent:
      row.agentId === null || run.agent === undefined
        ? null
        : {
            id: row.agentId,
            name: run.agent.name,
            deleted: run.agent.deletedAt !== null,
          },
    rounds: roundsOf(run, created),
    offer: offerOf(run, plans),
    plans: plans.map((plan, index) => {
      const next = plans[index + 1];
      const answer = messageAfter(entries, plan.seq);
      const { callId } = plan;
      const revision = index + 1;
      if (next !== undefined)
        return { callId, revision, state: 'replaced', at: next.createdAt };
      if (row.agentId !== null || revision === TEST_RUN_PLAN_REVISIONS_MAX)
        return {
          callId,
          revision,
          state: 'confirmed',
          at: created?.createdAt ?? plan.createdAt,
        };
      return answer === undefined
        ? { callId, revision, state: 'waiting', at: null }
        : { callId, revision, state: 'answered', at: answer.createdAt };
    }),
    taken:
      row.takenAgentId === null || run.takenAgent === undefined
        ? null
        : {
            agentId: row.takenAgentId,
            name: run.takenAgent.name,
            threadId: row.takenThreadId,
          },
  };
}

/** Round k is on version k: round 1 started by `create_agent`, each next one by a `propose_version`. */
function roundsOf(
  run: Parameters<typeof testRunSummary>[0],
  created: CallEntry | undefined,
): TestRunSummary['rounds'] {
  const { row, pool } = run;
  if (row.baseVersionId === null) return [];
  const starts = [
    created,
    ...successfulCalls(run.entries, PROPOSE_VERSION_TOOL),
  ].slice(0, 1 + run.proposed);
  return starts.map((start, index) => {
    const round = index + 1;
    if (start === undefined)
      throw new Error(
        `Round ${round} of test run ${row.id} has no starting call`,
      );
    const judged = roundJudged(row.tests, round);
    return {
      startCallId: start.callId,
      requested: round > 1 && requestedRound(pool, round),
      passed: judged
        ? row.tests.filter(
            (test) => test.rounds[round - 1]?.verdict === 'passed',
          ).length
        : null,
      total: judged ? row.tests.length : null,
    };
  });
}

/** The offer's outcome: taken, declined by the first plan, answered by a message, or still waiting. */
function offerOf(
  run: Parameters<typeof testRunSummary>[0],
  plans: readonly CallEntry[],
): TestRunSummary['offer'] {
  const { row, entries } = run;
  const [offer] = successfulCalls(entries, OFFER_AGENT_TOOL);
  if (offer === undefined || row.offeredAgentId === null) return null;
  const base = { callId: offer.callId, agentId: row.offeredAgentId };
  if (row.takenAgentId !== null)
    return {
      ...base,
      state: 'taken',
      at: run.root.finishedAt?.toISOString() ?? null,
    };
  const [plan] = plans;
  if (plan !== undefined)
    return { ...base, state: 'declined', at: plan.createdAt };
  const answer = messageAfter(entries, offer.seq);
  return answer === undefined
    ? { ...base, state: 'waiting', at: null }
    : { ...base, state: 'answered', at: answer.createdAt };
}
