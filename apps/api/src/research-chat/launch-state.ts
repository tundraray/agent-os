import type {
  ResearchLaunchView,
  ResearchSourceMode,
} from '@agent-os/contracts';
import type { researchChatLaunches } from '@agent-os/db';

/** States of a launch row (design-chat-entry.md, State Transitions and Invariants). */
export const LAUNCH_STATES = [
  'proposed',
  'launching',
  'running',
  'answer_pending',
  'answered',
  'answer_reappend',
  'declined',
  'superseded',
  'failed',
  'stopped',
  'discarded',
] as const;
export type LaunchState = (typeof LAUNCH_STATES)[number];

export const LAUNCH_MODES = ['explicit', 'proposal'] as const;
export type LaunchMode = (typeof LAUNCH_MODES)[number];

/**
 * What happens to a launch: a card decision, the next user message (`supersede`), a regeneration whose tail holds the
 * card (`discard`) or only the answer (`answer_removed`), the start's outcome, an event of the controller task, and
 * the delivery loop's write or its give-up window.
 */
export type LaunchAction =
  | 'confirm'
  | 'decline'
  | 'stop'
  | 'supersede'
  | 'discard'
  | 'started'
  | 'start_failed'
  | 'task_succeeded'
  | 'task_failed'
  | 'task_cancelled'
  | 'answer_removed'
  | 'append_window_expired'
  | 'answer_written';

/** A row of `research_chat_launches` with its enumerated columns narrowed. */
export type LaunchRecord = Omit<
  typeof researchChatLaunches.$inferSelect,
  'state' | 'mode' | 'sourceMode'
> & {
  readonly state: LaunchState;
  readonly mode: LaunchMode;
  readonly sourceMode: ResearchSourceMode | null;
};

type Edges = Partial<Record<LaunchAction, LaunchState>>;

/** Edges that hold for both modes; the omitted edges into `discarded` of the diagram are listed too. */
const EDGES: Record<LaunchState, Edges> = {
  proposed: {
    confirm: 'launching',
    decline: 'declined',
    supersede: 'superseded',
    discard: 'discarded',
  },
  launching: { started: 'running', discard: 'discarded' },
  running: {
    task_succeeded: 'answer_pending',
    task_failed: 'failed',
    task_cancelled: 'stopped',
    stop: 'stopped',
    discard: 'discarded',
  },
  answer_pending: {
    answer_written: 'answered',
    stop: 'stopped',
    append_window_expired: 'failed',
    discard: 'discarded',
  },
  answered: { answer_removed: 'answer_reappend', discard: 'discarded' },
  // A stop leaves it as is: the user already got its answer.
  answer_reappend: {
    answer_written: 'answered',
    append_window_expired: 'failed',
    discard: 'discarded',
  },
  declined: {},
  superseded: {},
  failed: {},
  stopped: {},
  discarded: {},
};

/** A failed start returns a confirmed proposal to its card; an explicit launch fails. */
const START_FAILED_TARGET: Record<LaunchMode, LaunchState> = {
  proposal: 'proposed',
  explicit: 'failed',
};

/**
 * The state `action` moves the launch to, or `null` when it changes nothing: a repeated or late decision, a redelivered
 * event, and every pair the diagram has no edge for (DC-1).
 */
export function nextLaunchState(
  launch: { readonly state: LaunchState; readonly mode: LaunchMode },
  action: LaunchAction,
): LaunchState | null {
  if (action === 'start_failed') {
    return launch.state === 'launching'
      ? START_FAILED_TARGET[launch.mode]
      : null;
  }
  return EDGES[launch.state][action] ?? null;
}

const VIEW_STATE: Record<
  Exclude<LaunchState, 'discarded'>,
  ResearchLaunchView['state']
> = {
  proposed: 'proposed',
  launching: 'running',
  running: 'running',
  answer_pending: 'running',
  answered: 'completed',
  answer_reappend: 'completed',
  declined: 'not_launched',
  superseded: 'not_launched',
  failed: 'failed',
  stopped: 'stopped',
};

/** Id of the answer message of an investigation: one per investigation (invariant 4). */
const answerMessageIdOf = (investigationId: string): string =>
  `research-answer-${investigationId}`;

/**
 * The card's view of a launch. The source mode is the one copied from the investigation; a launch without it shows the
 * engine's current mode, `engineSourceMode` (KD-8, DC-8). A discarded launch has no view: it is not listed.
 */
export function toLaunchView(
  launch: LaunchRecord,
  engineSourceMode: ResearchSourceMode,
): ResearchLaunchView {
  const { state } = launch;
  if (state === 'discarded') {
    throw new Error(`launch ${launch.launchKey} is discarded and has no view`);
  }
  const { investigationId } = launch;
  return {
    launchKey: launch.launchKey,
    mode: launch.mode,
    state: VIEW_STATE[state],
    notLaunchedReason:
      state === 'declined' || state === 'superseded' ? state : null,
    goal: launch.goal,
    tokenBudget: launch.tokenBudget,
    createdAt: launch.createdAt.toISOString(),
    answerMessageId:
      state === 'answered' && investigationId !== null
        ? answerMessageIdOf(investigationId)
        : null,
    answerPending: state === 'answer_reappend',
    sourceMode: launch.sourceMode ?? engineSourceMode,
  };
}
