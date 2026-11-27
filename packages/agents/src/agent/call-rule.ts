import {
  AGENTS_BRIEF_CONFIRMATION,
  type ToolPair,
  ToolRefusalReasonSchema,
} from '@agent-os/contracts';

import type { SendGrant } from '../store/call-records';

/** What the rule decides on, read by the step before it (improvements design-server.md KD-1, KD-2). */
export interface CallRuleFacts {
  /** The caller's root: a conversation's grant names it. */
  readonly rootId: string;
  /** The pair of an MCP tool; `null` for `run_code`, a script, a library write and every other built-in tool. */
  readonly pair: ToolPair | null;
  /** The kind of the card the tool built. */
  readonly cardKind: string;
  /** The schedule mark of the conversation's last message; `null` — the employee wrote it. */
  readonly scheduleId: string | null;
  /** The pairs of that schedule, read by its id and the caller's owner; empty for a deleted or another's one. */
  readonly schedulePairs: readonly ToolPair[];
  /** The pairs allowed to the conversation (`granted_tools` of the root). */
  readonly conversationPairs: readonly ToolPair[];
}

/** What becomes of a call that needs a card and has no decision of the employee. */
export type CallRuling =
  | { readonly kind: 'send'; readonly grant: SendGrant }
  | {
      readonly kind: 'refuse';
      readonly reason: typeof ToolRefusalReasonSchema.enum.unattended;
      readonly text: string;
    }
  | { readonly kind: 'card' };

/** What the model reads for a call refused in a schedule's run (design-server.md, «How the call rule works»). */
const UNATTENDED_TEXT =
  'This run was started by a schedule, so nobody can confirm this call, and it was not made. ' +
  "Finish without it and say in your answer that this action needs the owner's permission.";

function hasPair(pairs: readonly ToolPair[], pair: ToolPair | null): boolean {
  return (
    pair !== null &&
    pairs.some(
      (allowed) => allowed.server === pair.server && allowed.tool === pair.tool,
    )
  );
}

/**
 * The rule of a call that needs a card (improvements design-server.md KD-1, KD-4, «How the call rule works»).
 * In a schedule's run: a pair of the schedule's permission and a deep agent's brief are sent without a card
 * under the schedule's grant, any other call is refused `unattended`. In an ordinary run: a pair of the
 * conversation's permission is sent under the conversation's grant, any other call gets its card.
 */
export function callRule(facts: CallRuleFacts): CallRuling {
  if (facts.scheduleId !== null) {
    if (
      hasPair(facts.schedulePairs, facts.pair) ||
      facts.cardKind === AGENTS_BRIEF_CONFIRMATION
    ) {
      return {
        kind: 'send',
        grant: { kind: 'schedule', scheduleId: facts.scheduleId },
      };
    }
    return {
      kind: 'refuse',
      reason: ToolRefusalReasonSchema.enum.unattended,
      text: UNATTENDED_TEXT,
    };
  }
  if (facts.pair !== null && hasPair(facts.conversationPairs, facts.pair)) {
    return {
      kind: 'send',
      grant: { kind: 'conversation', rootId: facts.rootId, pair: facts.pair },
    };
  }
  return { kind: 'card' };
}
