import type {
  ChatStatus,
  ScheduleRunOutcome,
  ScheduleRunStatus,
} from '@agent-os/contracts';

/** A run's conversation as it is now; a deleted one is not read further. */
export type RunConversation = {
  /** The place in the root's queue of the last `user_message` to it, delivered or not. */
  readonly lastUserMessageSeq: number | null;
} & (
  | { readonly deleted: true }
  | {
      readonly deleted: false;
      /** `chatStatus` of its root. */
      readonly chat: ChatStatus;
      /** An open decision anywhere in its tree. */
      readonly openDecision: boolean;
    }
);

export interface RunStatusInput {
  readonly run: {
    readonly outcome: ScheduleRunOutcome;
    readonly finalStatus: ScheduleRunStatus | null;
    /** The run's message in the queue; `null` when it is the task of a new conversation. */
    readonly messageSeq: number | null;
  };
  /** Read only for a started run without a final status; `null` otherwise. */
  readonly conversation: RunConversation | null;
}

const BY_CHAT: Record<ChatStatus, ScheduleRunStatus> = {
  working: 'working',
  awaiting_confirmation: 'awaiting_confirmation',
  failed: 'failed',
  idle: 'completed',
  interrupted: 'stopped',
};

/**
 * The status of a history row (design-schedules.md, KD-4, Data Model «Статус запуска»): `null` for a skip, `working`
 * while the row is starting, the written final status once the next run started. Otherwise the run is
 * `completed` once a later message — the employee's or a schedule's — went to the root (any one, when the run's
 * message is the task of a new conversation); else it follows the conversation: deleted → `stopped`, an open
 * decision anywhere in the tree → `awaiting_confirmation`, then by `chatStatus`.
 */
export function runStatus({
  run,
  conversation,
}: RunStatusInput): ScheduleRunStatus | null {
  if (run.outcome === 'skipped') return null;
  if (run.outcome === 'starting') return 'working';
  if (run.finalStatus !== null) return run.finalStatus;
  if (conversation === null)
    throw new Error('A started run needs its conversation for its status');
  const { lastUserMessageSeq } = conversation;
  if (
    lastUserMessageSeq !== null &&
    (run.messageSeq === null || lastUserMessageSeq > run.messageSeq)
  )
    return 'completed';
  if (conversation.deleted) return 'stopped';
  if (conversation.openDecision) return 'awaiting_confirmation';
  return BY_CHAT[conversation.chat];
}
