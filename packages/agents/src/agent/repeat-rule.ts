import { type ToolOutcome, ToolOutcomeSchema } from '@agent-os/contracts';

/** From this many past same calls on, a new one runs with the repeat mark (FR-06). */
const REPEAT_MARK_FROM = 1;
/** From this many past same calls on, a new one is refused `repeated_call` (FR-06). */
const REPEAT_REFUSAL_FROM = 2;

/** The tool the rule never applies to: its answer changes while the agents it lists work (DC-7). */
const EXEMPT_TOOL = 'list_agents';

/** A call as the rule compares it: the raw tool name, its MCP server (`null` for a built-in) and arguments. */
export interface RepeatCall {
  readonly tool: string;
  readonly server: string | null;
  readonly args: unknown;
}

/** A call before the new one: from the visible history with its outcome, or passed earlier in this step without one. */
export interface PastCall extends RepeatCall {
  readonly callId: string;
  readonly outcome?: ToolOutcome;
}

export interface RepeatInput {
  readonly call: RepeatCall;
  readonly past: readonly PastCall[];
}

/** What happens to the new call; `callIds` — the past same calls, oldest first. */
export type RepeatDecision =
  | { readonly kind: 'run' }
  | { readonly kind: 'mark'; readonly callIds: readonly string[] }
  | { readonly kind: 'refuse'; readonly callIds: readonly string[] };

/** The arguments as one string with object keys sorted: `jsonb` keeps no key order. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    inner !== null && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => a.localeCompare(b)))
      : inner,
  );
}

/**
 * The repeat rule (KD-5): counts the past calls with the same tool, server and arguments — a call refused by
 * the check never reached its tool and is not counted (DC-9) — and decides: none → run; one → run with the
 * mark; two or more → refuse. `list_agents` always runs (DC-7).
 */
export function repeatOf({ call, past }: RepeatInput): RepeatDecision {
  if (call.server === null && call.tool === EXEMPT_TOOL) return { kind: 'run' };
  const args = canonical(call.args);
  const callIds = past
    .filter(
      (earlier) =>
        earlier.outcome !== ToolOutcomeSchema.enum.refused &&
        earlier.tool === call.tool &&
        earlier.server === call.server &&
        canonical(earlier.args) === args,
    )
    .map((earlier) => earlier.callId);
  if (callIds.length >= REPEAT_REFUSAL_FROM) return { kind: 'refuse', callIds };
  if (callIds.length >= REPEAT_MARK_FROM) return { kind: 'mark', callIds };
  return { kind: 'run' };
}

/** The mark the platform appends to the text of a repeated call's result (KD-1). */
export function repeatMarkText(callIds: readonly string[]): string {
  return `[repeat] You already made this call with the same arguments: ${callIds.join(', ')}.`;
}

/** The text of a `repeated_call` refusal: the past same calls and what to do instead (KD-1). */
export function repeatRefusalText(callIds: readonly string[]): string {
  return (
    `This call was already made with the same arguments: ${callIds.join(', ')}. ` +
    'Change the arguments or finish your work.'
  );
}
