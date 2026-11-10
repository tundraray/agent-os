import { z } from 'zod';

/**
 * Who writes claims and how a call of the checker ended, by fields and definitions, never by an agent's name
 * (design-research-flow.md, «Как корень закрывает расследование», gate 2, and «Утверждения без проверки из-за отказов»).
 * Gate 2 of `research_close` and the self-check's count of claims left unverified by refusals read the same rules.
 */

const CLAIMS_WRITE = 'claims_write';
const CLAIM_ASSESSMENT = 'claim_assessment';

/**
 * The refusals of a call of the checker that count as an attempt (owner decision): the tree had no room for the check.
 * Any other refusal — the per-turn cap, `access_denied`, `invalid_arguments` — is the caller's mistake, and the claim
 * waits for another call.
 */
const ATTEMPTED_REFUSALS: ReadonlySet<string> = new Set(['budget_exhausted', 'children_limit', 'task_limit']);

/**
 * How a call of the checker ended: `checked` — its run ended with an assessment; `unchecked` — the call was attempted
 * and ended without one (one of the refusals above, or `child_failed`); `not_attempted` — any other refusal, or a call
 * that has not ended.
 */
export type CheckerCallEnd = 'checked' | 'unchecked' | 'not_attempted';

export function checkerCallEnd(call: { readonly state: string; readonly reason: string | null }): CheckerCallEnd {
  if (call.state === 'done') return call.reason === 'child_failed' ? 'unchecked' : 'checked';
  if (call.state === 'rejected' && call.reason !== null && ATTEMPTED_REFUSALS.has(call.reason)) return 'unchecked';
  return 'not_attempted';
}

const CheckerCallArgumentsSchema = z.object({ agent: z.string(), assignment: z.string() });

/** The claim a `call_agent` gives to an agent of the form `claim_assessment`; null for any other call. */
export function checkedClaimOf(
  call: { readonly toolName: string; readonly arguments: unknown },
  agents: Readonly<Record<string, { readonly result: string }>>,
): string | null {
  if (call.toolName !== 'call_agent') return null;
  const args = CheckerCallArgumentsSchema.safeParse(call.arguments);
  if (!args.success || !Object.hasOwn(agents, args.data.agent)) return null;
  return agents[args.data.agent]?.result === CLAIM_ASSESSMENT ? args.data.assignment : null;
}

/** The agents that write claims: those whose frozen definition has the `claims_write` tool. */
export function claimWritingAgents(agents: Readonly<Record<string, { readonly tools: readonly string[] }>>): ReadonlySet<string> {
  return new Set(
    Object.entries(agents)
      .filter(([, definition]) => definition.tools.includes(CLAIMS_WRITE))
      .map(([name]) => name),
  );
}
