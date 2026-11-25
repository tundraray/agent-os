import { FIX_TASK, requestedRoundSubject } from '@agent-os/agents';
import {
  SessionTaskStatusSchema,
  TEST_RUN_TOOLS,
  testRunPhase,
  ToolOutcomeSchema,
  type SessionTaskStatus,
  type TaskStatus,
  type TestRunPlan,
  type TestRunSummary,
} from '@agent-os/contracts';
import type { TrainingRow } from '@agent-os/db';
import { z } from 'zod';

/**
 * The test run's rules the tools, its view and the conversation's summary share (create-and-test
 * design-trainer-dialog.md, KD-1, KD-3, KD-9; pure-decision.md): pure functions over the row, the pool and the
 * trainer's history.
 */

const PROPOSE_PLAN_TOOL = TEST_RUN_TOOLS[3];

/** An entry of the trainer's history, as any read of it gives one. */
interface TrainerEntry {
  readonly seq: number;
  readonly kind: string;
  readonly content: unknown;
}

/** A task of the test run's pool. */
export interface PoolTask {
  readonly number: number;
  readonly subject: string;
  readonly status: SessionTaskStatus;
}

const CallResultSchema = z.object({
  callId: z.string(),
  tool: z.string(),
  outcome: z.string(),
});

/** The successful calls of `tool` in the trainer's history, in order, with their call ids. */
export function successfulCalls<E extends TrainerEntry>(
  entries: readonly E[],
  tool: string,
): (E & { readonly callId: string })[] {
  return entries.flatMap((entry) => {
    if (entry.kind !== 'tool_result') return [];
    const result = CallResultSchema.safeParse(entry.content);
    return result.success &&
      result.data.tool === tool &&
      result.data.outcome === ToolOutcomeSchema.enum.success
      ? [{ ...entry, callId: result.data.callId }]
      : [];
  });
}

/** The employee's first message after the entry `seq`. */
export function messageAfter<E extends TrainerEntry>(
  entries: readonly E[],
  seq: number,
): E | undefined {
  return entries.find(
    (entry) => entry.kind === 'user_message' && entry.seq > seq,
  );
}

/**
 * The employee answered the latest plan (KD-3): the history holds one successful `propose_plan` per revision — a
 * plan written in the same step is not there yet — and a message of the employee after the last one.
 */
export function planAnswered(
  entries: readonly TrainerEntry[],
  plan: TestRunPlan | null,
): boolean {
  const plans = successfulCalls(entries, PROPOSE_PLAN_TOOL);
  const last = plans.at(-1);
  return (
    plan !== null &&
    last !== undefined &&
    plans.length === plan.revision &&
    messageAfter(entries, last.seq) !== undefined
  );
}

/** The phase of a test run (KD-1) from its row, its root's status, its pool and the number of versions it proposed. */
export function runPhase(run: {
  readonly row: TrainingRow;
  readonly rootStatus: TaskStatus;
  readonly pool: readonly PoolTask[];
  readonly proposed: number;
}): ReturnType<typeof testRunPhase> {
  const { row } = run;
  return testRunPhase({
    rootStatus: run.rootStatus,
    capped: row.cappedAt !== null,
    agentId: row.agentId,
    takenAgentId: row.takenAgentId,
    versions: (row.baseVersionId === null ? 0 : 1) + run.proposed,
    tests: row.tests,
    fixTaskInProgress: run.pool.some(
      (task) =>
        task.number === FIX_TASK &&
        task.status === SessionTaskStatusSchema.enum.in_progress,
    ),
  });
}

/** Why the conversation takes no message now (UXRD MC-4), or `null`: the dialog and the result below the cap take one. */
export function closedReason(
  state: ReturnType<typeof testRunPhase>,
  overCap: boolean,
): TestRunSummary['closedReason'] {
  if (state.phase === 'ended') return state.reason;
  if (state.phase === 'working' || state.phase === 'taken') return state.phase;
  return overCap ? 'capped' : null;
}

/** Round `round` was asked for by the employee: the pool holds the task it adds (KD-7, plan Notes 3.7). */
export function requestedRound(
  pool: readonly PoolTask[],
  round: number,
): boolean {
  return pool.some((task) => task.subject === requestedRoundSubject(round));
}
