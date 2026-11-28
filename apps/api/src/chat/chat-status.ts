import type { AgentView } from '@agent-os/agents';
import type {
  ChatStatus,
  ConversationState,
  TaskStatus,
  WaitReason,
} from '@agent-os/contracts';
import type { ConversationStateFactsRow } from '@agent-os/db';

export interface ChatStatusInput {
  /** The root's view. */
  readonly root: Pick<AgentView, 'status' | 'failureReason'>;
  /** The root's runtime task. */
  readonly task: {
    readonly status: TaskStatus;
    readonly waitReason: WaitReason | null;
  };
  /** The conversation is a training: its trainer waits on messages while replays run. */
  readonly training: boolean;
}

export interface ChatState {
  readonly status: ChatStatus;
  /** Set when `failed`. */
  readonly failureReason: string | null;
}

/**
 * The chat status for the composer (design-chat.md, State Transitions). It follows the root's view,
 * except that the view shows both waiting for messages and working as `working`, which the composer
 * tells apart by the root's task. A root stopped other than by delete is `idle`: a message revives it.
 */
export function chatStatus({
  root,
  task,
  training,
}: ChatStatusInput): ChatState {
  switch (root.status) {
    case 'interrupted':
    case 'awaiting_confirmation':
      return { status: root.status, failureReason: null };
    case 'failed':
      return { status: 'failed', failureReason: root.failureReason };
    case 'stopped':
    case 'completed':
      return { status: 'idle', failureReason: null };
    case 'working':
      return {
        status:
          !training &&
          task.status === 'waiting' &&
          task.waitReason === 'messages'
            ? 'idle'
            : 'working',
        failureReason: null,
      };
  }
}

/**
 * The state of a conversation in the list (improvements design-server.md, «How the conversation state works»): a
 * question open in its tree first, then the root or an agent under it working, then the later of the last answer
 * and the last failure if it comes after the «seen through» mark; `null` — read and idle.
 */
export function conversationState(
  facts: Omit<ConversationStateFactsRow, 'rootId'>,
): ConversationState | null {
  if (facts.questionOpen) return 'waiting_for_you';
  if (facts.rootAnswering || facts.agentsWorking) return 'working';
  const answer = facts.lastAnswerSeq ?? 0;
  const failure = facts.lastFailureSeq ?? 0;
  if (Math.max(answer, failure) <= facts.seenThroughSeq) return null;
  return failure > answer ? 'failed' : 'new_answer';
}
