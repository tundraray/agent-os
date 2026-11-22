import type { HistoryContent } from '../history/history';
import type { SessionTask } from '../store/session-tasks.repository';
import { blockLine } from './task-block';

/** The last report of the final subagent the deep agent has received. */
export interface FinalSubagentReport {
  readonly status: 'completed' | 'failed' | 'stopped';
  /** The report text; a failed or stopped subagent may have none. */
  readonly text: string | null;
}

export interface EndOfTurnInput {
  readonly isRoot: boolean;
  /** Children of the agent that have not finished. */
  readonly unfinishedChildren: number;
  /** `child_finished` messages pending in the inbox and not among the messages of this step (Notes 6). */
  readonly pendingChildNotices: number;
  /** `finalSubagent` of the deep agent's snapshot; `null` for every other run. */
  readonly finalSubagent: string | null;
  /** The last report of `finalSubagent`, if any. */
  readonly finalSubagentReport: FinalSubagentReport | null;
  /** The session's tasks still `pending` or `in_progress`, by number; empty for a session without a list. */
  readonly openTasks: readonly SessionTask[];
  /** The text of the model's answer without tool calls. */
  readonly text: string;
  /** The provider ended the answer at the output length limit (`ModelAnswer.cutOff`, KD-3). */
  readonly cutOff: boolean;
}

export type EndOfTurn =
  /** Nothing to do until the next message. */
  | { readonly kind: 'wait' }
  /**
   * The agent may not finish yet: the notice goes to history, the outcome is `continue`, and it is a turn.
   * `openTasks` — the numbers of the open tasks the notice names, when they are its reason;
   * `missingReport` — the final subagent whose completed report is lacking, when that is its reason.
   */
  | {
      readonly kind: 'notice';
      readonly text: string;
      readonly openTasks?: readonly number[];
      readonly missingReport?: string;
    }
  /** The agent is done; `report` is its outcome for the parent. */
  | { readonly kind: 'complete'; readonly report: string };

/**
 * The outcome of an answer without tool calls (KD-2, «Конец хода», DC-3, DC-4, Invariant 4;
 * design-runtime.md KD-5): a root session waits; an agent with unfinished children or an undelivered
 * child notice waits; an agent with open tasks gets a notice naming them (design-task-list.md KD-4),
 * and the final subagent rule is not checked; with a final subagent, only its `completed` report
 * ends the deep agent and becomes its report; otherwise the answer text is the report — unless the answer
 * was cut off at the length limit (agent-harness KD-3, DC-1): then a notice asks for it again, since a cut
 * text is no report.
 */
export function endOfTurn(input: EndOfTurnInput): EndOfTurn {
  if (input.isRoot) return { kind: 'wait' };
  if (input.unfinishedChildren > 0 || input.pendingChildNotices > 0) return { kind: 'wait' };
  if (input.openTasks.length > 0) {
    return {
      kind: 'notice',
      text: openTasksNotice(input.openTasks),
      openTasks: input.openTasks.map((task) => task.number),
    };
  }
  if (input.finalSubagent === null) {
    return input.cutOff ? { kind: 'notice', text: CUT_OFF_NOTICE } : { kind: 'complete', report: input.text };
  }
  const report = input.finalSubagentReport;
  if (report?.status === 'completed') return { kind: 'complete', report: report.text ?? '' };
  return {
    kind: 'notice',
    text: finishRefusal(input.finalSubagent, report),
    missingReport: input.finalSubagent,
  };
}

type NoticeEnding = Extract<EndOfTurn, { kind: 'notice' }>;

/**
 * The content of the `notice` history entry of a notice outcome: its text for the model and, for the feed line
 * (uxrd.md MC-15), the numbers of the open tasks or the name of the final subagent whose report is lacking,
 * when that is its reason; the keys are absent for every other notice.
 */
export function noticeContent(ending: NoticeEnding): HistoryContent<'notice'> {
  const content: HistoryContent<'notice'> = { text: ending.text };
  if (ending.openTasks !== undefined) content.openTasks = [...ending.openTasks];
  if (ending.missingReport !== undefined) content.missingReport = ending.missingReport;
  return content;
}

/** The notice after an answer cut off at the length limit (KD-1, KD-3). */
const CUT_OFF_NOTICE =
  'Your answer was cut off at the output length limit and is not accepted as your report. ' +
  'Write the report again, shorter, so that it fits in one answer.';

/** The notice of an answer while tasks are open (KD-4): their lines as the task block shows them. */
function openTasksNotice(tasks: readonly SessionTask[]): string {
  return [
    'You cannot finish yet: these tasks of your list are still open:',
    ...tasks.map(blockLine),
    'Do the work they name and mark each completed with task_update, or delete the ones no longer needed; then answer.',
  ].join('\n');
}

function finishRefusal(finalSubagent: string, report: FinalSubagentReport | null): string {
  const why =
    report === null
      ? `there is no report of subagent "${finalSubagent}" yet`
      : `the last run of subagent "${finalSubagent}" ended as ${report.status}`;
  return `You cannot finish: ${why}. The deep agent ends only with a completed report of subagent "${finalSubagent}"; start it with start_agent.`;
}
