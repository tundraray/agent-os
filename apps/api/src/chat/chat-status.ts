import type { AgentView } from '@agent-os/agents';
import type { ChatStatus, TaskStatus, WaitReason } from '@agent-os/contracts';

export interface ChatStatusInput {
  /** The root's view. */
  readonly root: Pick<AgentView, 'status' | 'failureReason'>;
  /** The root's runtime task. */
  readonly task: { readonly status: TaskStatus; readonly waitReason: WaitReason | null };
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
export function chatStatus({ root, task }: ChatStatusInput): ChatState {
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
        status: task.status === 'waiting' && task.waitReason === 'messages' ? 'idle' : 'working',
        failureReason: null,
      };
  }
}
