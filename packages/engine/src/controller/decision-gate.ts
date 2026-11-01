import { type Capability, DECISION_KINDS, type DecisionKind, decisionsOpenedBy } from '../config/capabilities.js';
import type { SourceSchema } from '@agent-os/sources';
import type { ProcessConfig } from '../config/process-config.schema.js';
import { parseModelArgs } from '../model/model-args.js';
import { type Decision, DecisionSchema, isDecisionKind, TASK_CREATING_KINDS } from './decision.schema.js';

/** The runtime refuses a task deadline below this; a decision creating tasks needs more time left (DC-3). */
const MIN_TASK_DEADLINE_MS = 1_000;

/** Why a controller output is not a step (written to `research_decisions.rejection_reason`). */
export type RejectionReason =
  | 'kind_unknown'
  | 'capability_disabled'
  | 'invalid_structure'
  | 'invalid_model_output'
  | 'fan_out_exceeded'
  | 'plan_revisions_exhausted'
  | 'no_novelty'
  | 'verify_rounds_exhausted'
  | 'deadline_too_close'
  | 'nothing_to_wait_for'
  | 'source_not_allowed'
  | 'invalid_args';

/** What the limits look like at this step; the handler reads it from the engine rows and the runtime. */
export interface GateState {
  readonly capabilities: readonly Capability[];
  readonly limits: Pick<ProcessConfig['limits'], 'maxPlanRevisions' | 'noveltyWindow' | 'maxFanOut' | 'maxVerifyRounds'>;
  /** Accepted `replan` decisions so far: the plan has this many revisions beyond the first. */
  readonly replans: number;
  /** Accepted `requestVerification` decisions so far. */
  readonly verifyRounds: number;
  /** Trailing accepted steps that brought no new evidence and no new claim revision. */
  readonly stepsWithoutNovelty: number;
  readonly msUntilNotAfter: number;
  /** Tasks of the investigation other than the controller that are not in a final status. */
  readonly openTasks: number;
}

export type GateVerdict =
  | { readonly verdict: 'accepted'; readonly decision: Decision }
  | { readonly verdict: 'rejected'; readonly reason: RejectionReason; readonly kind: DecisionKind | null };

/** Kinds still open after the plan revisions are used up (AC-02.2). */
const AFTER_LAST_REPLAN: ReadonlySet<DecisionKind> = new Set(['requestVerification', 'proposeAnswer', 'concludeInconclusive']);
/** Kinds still open after `noveltyWindow` steps without novelty (AC-03.1). */
const WITHOUT_NOVELTY: ReadonlySet<DecisionKind> = new Set(['proposeAnswer', 'concludeInconclusive']);

/** Why a kind the configuration opens is closed at this step, or null when it is admissible. */
function limitOf(kind: DecisionKind, state: GateState): RejectionReason | null {
  if (state.replans >= state.limits.maxPlanRevisions && !AFTER_LAST_REPLAN.has(kind)) {
    return 'plan_revisions_exhausted';
  }
  if (state.stepsWithoutNovelty >= state.limits.noveltyWindow && !WITHOUT_NOVELTY.has(kind)) {
    return 'no_novelty';
  }
  if (kind === 'requestVerification' && state.verifyRounds >= state.limits.maxVerifyRounds) {
    return 'verify_rounds_exhausted';
  }
  if (TASK_CREATING_KINDS.has(kind) && state.msUntilNotAfter <= MIN_TASK_DEADLINE_MS) {
    return 'deadline_too_close';
  }
  if (kind === 'wait' && state.openTasks === 0) {
    return 'nothing_to_wait_for';
  }
  return null;
}

/** The decisions code admits at this step, in the order of the closed set (DecisionInput `admissible`). */
export function admissibleDecisions(state: GateState): DecisionKind[] {
  const opened = decisionsOpenedBy(state.capabilities);
  return DECISION_KINDS.filter((kind) => opened.has(kind) && limitOf(kind, state) === null);
}

/** One `args` field of a model output: absent stays absent, JSON text becomes its object; null when it is neither. */
function decodeArgs(args: unknown): { readonly args: Record<string, unknown> | undefined } | null {
  if (args === undefined) return { args: undefined };
  if (typeof args !== 'string') return null;
  const parsed = parseModelArgs(args);
  return parsed === null ? null : { args: parsed };
}

function withArgs<T extends object>(item: T, args: Record<string, unknown> | undefined): T {
  return args === undefined ? item : { ...item, args };
}

/**
 * The controller output with its `args` — top-level and of every sub-question — parsed from the JSON text the model
 * writes (`ControllerOutputSchema`); null when one of them is not a JSON object.
 */
function decodeOutputArgs(output: object): object | null {
  const top = decodeArgs('args' in output ? output.args : undefined);
  if (top === null) return null;
  const subquestions = 'subquestions' in output ? output.subquestions : undefined;
  if (!Array.isArray(subquestions)) return withArgs(output, top.args);
  const decoded: unknown[] = [];
  for (const item of subquestions as unknown[]) {
    if (typeof item !== 'object' || item === null) {
      decoded.push(item);
      continue;
    }
    const own = decodeArgs('args' in item ? item.args : undefined);
    if (own === null) return null;
    decoded.push(withArgs(item, own.args));
  }
  return { ...withArgs(output, top.args), subquestions: decoded };
}

/**
 * Invariant 6: a controller output becomes a decision only when its kind is in the closed set, the configuration enables
 * its capability (DC-1), its `args` are JSON objects (`invalid_args` otherwise), its structure passes the schema, it
 * stays within `maxFanOut` (DC-6) and the limits of this step admit it. The checks run in that order, and the first
 * failure is the reason.
 */
export function judgeDecision(output: unknown, state: GateState): GateVerdict {
  if (typeof output !== 'object' || output === null) {
    return { verdict: 'rejected', reason: 'kind_unknown', kind: null };
  }
  const rawKind = 'kind' in output ? output.kind : undefined;
  if (typeof rawKind !== 'string' || !isDecisionKind(rawKind)) {
    return { verdict: 'rejected', reason: 'kind_unknown', kind: null };
  }
  const kind = rawKind;
  const rejected = (reason: RejectionReason): GateVerdict => ({ verdict: 'rejected', reason, kind });
  if (!decisionsOpenedBy(state.capabilities).has(kind)) {
    return rejected('capability_disabled');
  }
  const decoded = decodeOutputArgs(output);
  if (decoded === null) {
    return rejected('invalid_args');
  }
  const parsed = DecisionSchema.safeParse(decoded);
  if (!parsed.success) {
    return rejected('invalid_structure');
  }
  // An accepted answer always waits for its synthesis, whatever the model sent: the controller ends with the answer
  // the synthesis writes, so it must not take steps while that task runs.
  const decision: Decision = parsed.data.kind === 'proposeAnswer' ? { ...parsed.data, await: true } : parsed.data;
  if (decision.kind === 'requestAnalysis' && decision.subquestions.length > state.limits.maxFanOut) {
    return rejected('fan_out_exceeded');
  }
  const limit = limitOf(kind, state);
  return limit === null ? { verdict: 'accepted', decision } : rejected(limit);
}

/** A source tool a decision may fetch from, with the argument schema of its descriptor; null when it may not. */
export type FetchToolLookup = (request: { readonly sourceId: string; readonly toolName: string }) => {
  readonly argsSchema: SourceSchema;
} | null;

/** The source requests of a decision: its own for `requestEvidence`, one per sub-question for `requestAnalysis`. */
function fetchRequestsOf(decision: Decision) {
  switch (decision.kind) {
    case 'requestEvidence':
      return [decision];
    case 'requestAnalysis':
      return decision.subquestions;
    default:
      return [];
  }
}

/**
 * The gate of a controller output (invariant 6): {@link judgeDecision}, then every source request of the decision
 * against the tools it may fetch from — a pair outside the configuration's `sources` or the `source.fetch` allowlist
 * is refused as `source_not_allowed`, arguments the tool's descriptor schema refuses as `invalid_args` (Security
 * Considerations: tool arguments are checked by the descriptor's schema from `SourceRegistry.resolveTool`).
 */
export function judgeControllerOutput(output: unknown, state: GateState, fetchTool: FetchToolLookup): GateVerdict {
  const verdict = judgeDecision(output, state);
  if (verdict.verdict === 'rejected') {
    return verdict;
  }
  for (const request of fetchRequestsOf(verdict.decision)) {
    const tool = fetchTool(request);
    if (tool === null) {
      return { verdict: 'rejected', reason: 'source_not_allowed', kind: verdict.decision.kind };
    }
    if (!tool.argsSchema.safeParse(request.args).success) {
      return { verdict: 'rejected', reason: 'invalid_args', kind: verdict.decision.kind };
    }
  }
  return verdict;
}
