import type { AgentTurnResult } from '../model/model-gateway.js';
import type { AgentToolChoice, AgentToolDefinition } from '../model/role-agent.js';
import { type ForcedEndCode, isForcedEndCode } from './result-forms.js';
import type { WindowStage } from './session-window.js';

/**
 * The rules of a turn of an agent run (design-agent-core.md, C4 «один ход», steps 1 and 6): pure decisions over numbers
 * and outcomes; `AgentRunHandler` glues them to the session, the gateway and the executor. Nothing here reads the text
 * of the model or of the session.
 */

const FINISH = 'finish';

/** The failure codes a turn decision may end a run with; each goes through the form's forced end first (DC-21). */
export type TurnFailureCode =
  | 'run_tokens_exhausted'
  | 'investigation_tokens_exhausted'
  | 'not_after'
  | 'turn_limit'
  | 'model_unavailable'
  | 'context_overflow';

/** What comes before a turn: the turn with its number, or the run's end by a limit, or the attempt's yield. */
export type NextTurn =
  | { readonly kind: 'turn'; readonly turn: number; readonly last: boolean }
  | { readonly kind: 'fail'; readonly code: 'turn_limit' | 'not_after' }
  | { readonly kind: 'yield' };

/**
 * Before a turn (DC-14, DC-27, KD-6): a run that took `maxTurns` turns without a result ends `turn_limit`; no turn
 * starts with less than `AGENT_TURN_MS` left to `notAfter` (`not_after`); an attempt past `AGENT_ATTEMPT_SLICE_MS`
 * gives its slot up (`yield`). Otherwise the next turn, the last one when its number is `maxTurns`.
 */
export function decideNextTurn(input: {
  readonly turnsTaken: number;
  readonly maxTurns: number;
  readonly now: Date;
  readonly notAfter: Date;
  readonly turnMs: number;
  readonly attemptStartedAt: Date;
  readonly attemptSliceMs: number;
}): NextTurn {
  if (input.turnsTaken >= input.maxTurns) return { kind: 'fail', code: 'turn_limit' };
  if (input.notAfter.getTime() - input.now.getTime() < input.turnMs) return { kind: 'fail', code: 'not_after' };
  if (input.now.getTime() - input.attemptStartedAt.getTime() >= input.attemptSliceMs) return { kind: 'yield' };
  const turn = input.turnsTaken + 1;
  return { kind: 'turn', turn, last: turn === input.maxTurns };
}

/** The tools of a turn: all of the definition's, the model choosing; on the last turn `finish` alone, forced (DC-14). */
export function toolsOfTurn(
  tools: readonly AgentToolDefinition[],
  last: boolean,
): { readonly tools: readonly AgentToolDefinition[]; readonly toolChoice: AgentToolChoice } {
  if (!last) return { tools, toolChoice: 'auto' };
  return { tools: tools.filter((tool) => tool.name === FINISH), toolChoice: { toolName: FINISH } };
}

/** A view the estimate says does not fit even at stage 4 goes to no gateway: the run ends `context_overflow` (DC-30). */
export function decideView(view: { readonly fits: boolean }): { readonly kind: 'send' } | { readonly kind: 'fail'; readonly code: 'context_overflow' } {
  return view.fits ? { kind: 'send' } : { kind: 'fail', code: 'context_overflow' };
}

/** How a turn goes on after the gateway's answer. */
export type AnswerStep =
  | { readonly kind: 'record'; readonly notice: 'no_tool_call' | null }
  | { readonly kind: 'next_stage'; readonly stage: WindowStage }
  | { readonly kind: 'yield' }
  | { readonly kind: 'abandon'; readonly cause: 'cancelled' | 'fenced' }
  | { readonly kind: 'fail'; readonly code: TurnFailureCode };

/**
 * The gateway's answer of a turn sent at `stage` (DC-2, DC-30, KD-6, Error Handling): an answer is recorded — one
 * without a call gets the notice `no_tool_call` and counts as a turn; a counted input over the window sends the same turn
 * again at the next stage, and at stage 4 ends the run `context_overflow`; a busy reserve past its limit yields; a call
 * cut at `notAfter` is `not_after`; a cancel or a lost attempt ends it without a write.
 */
export function decideAnswer(result: AgentTurnResult, stage: WindowStage): AnswerStep {
  switch (result.outcome) {
    case 'answered':
      return { kind: 'record', notice: result.answer.toolCalls.length === 0 ? 'no_tool_call' : null };
    case 'fenced':
      return { kind: 'abandon', cause: 'fenced' };
    case 'failed':
      return { kind: 'fail', code: result.code };
    case 'no_answer':
      switch (result.reason) {
        case 'window_exceeded':
          return stage < 4 ? { kind: 'next_stage', stage: (stage + 1) as WindowStage } : { kind: 'fail', code: 'context_overflow' };
        case 'busy_wait_exhausted':
          return { kind: 'yield' };
        case 'deadline':
          return { kind: 'fail', code: 'not_after' };
        case 'cancelled':
          return { kind: 'abandon', cause: 'cancelled' };
      }
  }
}

/** What a turn's executed calls lead to. */
export type AfterTurn =
  | { readonly kind: 'complete'; readonly finish: { readonly callId: string; readonly result: unknown } }
  | { readonly kind: 'wait'; readonly waitFor: readonly string[] }
  | { readonly kind: 'next' }
  | { readonly kind: 'fail'; readonly code: 'turn_limit' };

/**
 * After the calls of a turn (step 6, DC-14, DC-17): a lone `finish` whose result was accepted completes the run — the
 * executor returns `finish` only when it is the turn's one call; calls of class `task` wait for their tasks; a last turn
 * that did not end the run fails `turn_limit`; otherwise the next turn.
 */
export function decideAfterTurn(input: {
  readonly finish: { readonly callId: string; readonly result: unknown } | null;
  readonly waitFor: readonly string[];
  readonly turn: number;
  readonly maxTurns: number;
}): AfterTurn {
  if (input.finish !== null) return { kind: 'complete', finish: input.finish };
  if (input.waitFor.length > 0) return { kind: 'wait', waitFor: input.waitFor };
  if (input.turn >= input.maxTurns) return { kind: 'fail', code: 'turn_limit' };
  return { kind: 'next' };
}

/** Where a failure of the run goes: the form's forced end for its code, or the failure itself. */
export type FailureRoute = { readonly kind: 'forced_end'; readonly code: ForcedEndCode } | { readonly kind: 'fail' };

/**
 * A failure the handler would end the run with (DC-21, DC-30): when the form has a forced end for its code — one of the
 * six, `context_overflow` among them — the forced end runs first; otherwise, and for the prologue's own codes, the run
 * fails with it.
 */
export function routeFailure(code: string, form: { readonly forcedEnd?: Readonly<Partial<Record<string, unknown>>> }): FailureRoute {
  return isForcedEndCode(code) && form.forcedEnd?.[code] !== undefined ? { kind: 'forced_end', code } : { kind: 'fail' };
}
