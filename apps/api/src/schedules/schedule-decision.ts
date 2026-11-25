import type { ModelVerdict } from '@agent-os/agents';
import type {
  ScheduleRunStatus,
  ScheduleSkipReason,
} from '@agent-os/contracts';

export interface ScheduleDecisionInput {
  /** The status of the schedule's last started run (`run-status.ts`); `null` without one. */
  readonly previousRun: ScheduleRunStatus | null;
  /** A `this_conversation` schedule's conversation works or waits for a decision; `false` for a new conversation. */
  readonly conversationBusy: boolean;
  /** The schedule's agent passes the chip rule now; `true` for the chat agent. */
  readonly agentAvailable: boolean;
  /**
   * The gate's verdicts on the owner's models of the run's first call: the conversation's model and the chip
   * agent's own one; `null` — no model is set for a new conversation.
   */
  readonly models: readonly (ModelVerdict | null)[];
}

export type ScheduleDecision =
  | { readonly kind: 'run' }
  | { readonly kind: 'skip'; readonly reason: ScheduleSkipReason };

const UNFINISHED: ReadonlySet<ScheduleRunStatus> = new Set([
  'working',
  'awaiting_confirmation',
]);

/** The reason a model verdict gives, or `null` for an allowed model (plan Notes 4.1). */
function modelSkip(verdict: ModelVerdict | null): ScheduleSkipReason | null {
  if (verdict === null) return 'agent_unavailable';
  if (verdict.kind === 'allowed') return null;
  if (verdict.reason === 'owner_disabled') return 'owner_disabled';
  if (verdict.reason === 'quota_exhausted') return 'quota_exhausted';
  return 'agent_unavailable';
}

/** The skip reasons of rights and quota in the order of the PRD. */
const RIGHTS_ORDER: readonly ScheduleSkipReason[] = [
  'owner_disabled',
  'agent_unavailable',
  'quota_exhausted',
];

/**
 * Run or skip at a term (design-schedules.md, KD-4): the first reason in the PRD's order — the previous run is
 * unfinished, the schedule's conversation is busy, the account is disabled, the agent is unavailable, the quota
 * is exhausted — or a run.
 */
export function decideRun(input: ScheduleDecisionInput): ScheduleDecision {
  if (input.previousRun !== null && UNFINISHED.has(input.previousRun))
    return { kind: 'skip', reason: 'previous_run_unfinished' };
  if (input.conversationBusy)
    return { kind: 'skip', reason: 'conversation_busy' };
  const reasons = new Set(input.models.map(modelSkip));
  if (!input.agentAvailable) reasons.add('agent_unavailable');
  const reason = RIGHTS_ORDER.find((candidate) => reasons.has(candidate));
  return reason === undefined ? { kind: 'run' } : { kind: 'skip', reason };
}
