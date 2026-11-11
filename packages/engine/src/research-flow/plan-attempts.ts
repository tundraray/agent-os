import { researchAgentToolCalls } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { and, asc, eq, inArray } from 'drizzle-orm';

/** Rejected plan attempts in a row after which `plan_write` checks nothing more (design-catalog-planning.md). */
const PLAN_SOURCE_ATTEMPTS = 3;

/** The refusal of a plan whose branch has no source or a source outside the planner's run sources: an attempt. */
export const PLAN_SOURCES_INVALID = 'plan_sources_invalid';
/** The refusal once the attempts are exhausted: not an attempt. */
export const PLAN_ATTEMPTS_EXHAUSTED = 'plan_attempts_exhausted';

const PLAN_WRITE = 'plan_write';

/**
 * How an ended `plan_write` call counts: `accepted` wrote a revision and ends the series; `sources_rejected` is a rejected
 * attempt; `not_an_attempt` — a `plan_attempts_exhausted` refusal or a refusal of the arguments' schema — neither counts
 * nor breaks the series.
 */
export type PlanWriteOutcome = 'accepted' | 'sources_rejected' | 'not_an_attempt';

/**
 * «Попытки плана исчерпаны» (design-catalog-planning.md, Инструменты расследования): after the last accepted revision,
 * or from the start of the investigation when there is none, `PLAN_SOURCE_ATTEMPTS` attempts in a row were rejected
 * `plan_sources_invalid`. The one definition for `plan_write`, gate 1 of the root's close and the precedence rule.
 */
export function attemptsExhausted(outcomes: readonly PlanWriteOutcome[]): boolean {
  let series = 0;
  for (const outcome of outcomes) {
    if (outcome === 'accepted') series = 0;
    else if (outcome === 'sources_rejected') series += 1;
  }
  return series >= PLAN_SOURCE_ATTEMPTS;
}

function outcomeOf(row: { readonly state: string; readonly reason: string | null }): PlanWriteOutcome {
  if (row.state === 'done') return 'accepted';
  return row.reason === PLAN_SOURCES_INVALID ? 'sources_rejected' : 'not_an_attempt';
}

/** A tool call row as a `collect` step reads it: the investigation's calls of every tool. */
export interface ToolCallRow {
  readonly toolName: string;
  readonly state: string;
  readonly reason: string | null;
}

/**
 * Whether the attempts are exhausted, by the tool call rows a `collect` step read in the order given. With no accepted
 * revision there is no `accepted` outcome, so the order of the rows does not change the answer.
 */
export function attemptsExhaustedIn(calls: readonly ToolCallRow[]): boolean {
  return attemptsExhausted(
    calls.filter((call) => call.toolName === PLAN_WRITE && (call.state === 'done' || call.state === 'rejected')).map(outcomeOf),
  );
}

/**
 * The ended `plan_write` calls of the investigation in the order they ended. Read in a guarded transaction; `plan_write`
 * reads it under the investigation's advisory lock, so two calls do not count the same series at once.
 */
export async function readPlanWriteOutcomes(tx: Pick<RuntimeTx, 'select'>, investigationId: string): Promise<PlanWriteOutcome[]> {
  const rows = await tx
    .select({ state: researchAgentToolCalls.state, reason: researchAgentToolCalls.reason })
    .from(researchAgentToolCalls)
    .where(
      and(
        eq(researchAgentToolCalls.investigationId, investigationId),
        eq(researchAgentToolCalls.toolName, PLAN_WRITE),
        inArray(researchAgentToolCalls.state, ['done', 'rejected']),
      ),
    )
    .orderBy(asc(researchAgentToolCalls.finishedAt), asc(researchAgentToolCalls.createdAt));
  return rows.map(outcomeOf);
}
