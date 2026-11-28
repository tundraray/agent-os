import {
  AGENTS_BRIEF_CONFIRMATION,
  AGENTS_QUESTION_CONFIRMATION,
  AGENTS_TOOL_CONFIRMATION,
  LIBRARY_RECORD_CONFIRMATION,
  type ScheduleAccess,
  ScheduleAccessSchema,
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
  /**
   * The access level of that schedule, read by its id and the caller's owner; `read` for a deleted or another's one
   * (chat-scheduling KD-3).
   */
  readonly scheduleAccess: ScheduleAccess;
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

/** What the model reads for a changing call refused in a `read` schedule's run (chat-scheduling, «How the call rule works»). */
const READ_ONLY_TEXT =
  'This run was started by a schedule that may only read, so this call was not made. ' +
  'Finish without it and describe in your answer the change it would have made.';

/** What the model reads for any other card refused in a schedule's run. */
const PERSON_ONLY_TEXT =
  'This run was started by a schedule, and only the employee can decide this in the conversation, so the call was not made. ' +
  'Finish without it and say in your answer that this needs the employee.';

function hasPair(pairs: readonly ToolPair[], pair: ToolPair): boolean {
  return pairs.some(
    (allowed) => allowed.server === pair.server && allowed.tool === pair.tool,
  );
}

/** Cards a schedule's run sends without asking at any level: a deep agent's brief, and a question nobody is there to answer. */
const UNASKED_IN_SCHEDULE: readonly string[] = [
  AGENTS_BRIEF_CONFIRMATION,
  AGENTS_QUESTION_CONFIRMATION,
];

/** The changing kinds of cards (chat-scheduling Terms): a `full` schedule's run sends them without a card. */
const CHANGING_CARDS: readonly string[] = [
  AGENTS_TOOL_CONFIRMATION,
  LIBRARY_RECORD_CONFIRMATION,
];

function unattended(text: string): CallRuling {
  return {
    kind: 'refuse',
    reason: ToolRefusalReasonSchema.enum.unattended,
    text,
  };
}

/**
 * The rule of a call that needs a card (improvements design-server.md KD-1, KD-4; chat-scheduling KD-3, «How the
 * call rule works»). In a schedule's run: a brief and an `ask_user` question (agent-guidance KD-2) are sent
 * without a card under the schedule's grant at any level; a changing kind of card is sent so at `full` and refused
 * `unattended` at `read`; any other kind is refused `unattended`. In an ordinary run: a pair of the conversation's
 * permission is sent under the conversation's grant, any other call gets its card.
 */
export function callRule(facts: CallRuleFacts): CallRuling {
  if (facts.scheduleId !== null) {
    const send: CallRuling = {
      kind: 'send',
      grant: { kind: 'schedule', scheduleId: facts.scheduleId },
    };
    if (UNASKED_IN_SCHEDULE.includes(facts.cardKind)) return send;
    if (!CHANGING_CARDS.includes(facts.cardKind))
      return unattended(PERSON_ONLY_TEXT);
    return facts.scheduleAccess === ScheduleAccessSchema.enum.full
      ? send
      : unattended(READ_ONLY_TEXT);
  }
  if (facts.pair !== null && hasPair(facts.conversationPairs, facts.pair)) {
    return {
      kind: 'send',
      grant: { kind: 'conversation', rootId: facts.rootId, pair: facts.pair },
    };
  }
  return { kind: 'card' };
}
