/** The last report of the final executor the coordinator has received. */
export interface FinalExecutorReport {
  readonly status: 'completed' | 'failed' | 'stopped';
  /** The report text; a failed or stopped executor may have none. */
  readonly text: string | null;
}

export interface EndOfTurnInput {
  readonly isRoot: boolean;
  /** Children of the agent that have not finished. */
  readonly unfinishedChildren: number;
  /** `child_finished` messages pending in the inbox and not among the messages of this step (Notes 6). */
  readonly pendingChildNotices: number;
  /** `finalExecutor` of the coordinator's snapshot; `null` for every other run. */
  readonly finalExecutor: string | null;
  /** The last report of `finalExecutor`, if any. */
  readonly finalExecutorReport: FinalExecutorReport | null;
  /** The text of the model's answer without tool calls. */
  readonly text: string;
}

export type EndOfTurn =
  /** Nothing to do until the next message. */
  | { readonly kind: 'wait' }
  /** The agent may not finish yet: the notice goes to history, the outcome is `continue`, and it is a turn. */
  | { readonly kind: 'notice'; readonly text: string }
  /** The agent is done; `report` is its outcome for the parent. */
  | { readonly kind: 'complete'; readonly report: string };

/**
 * The outcome of an answer without tool calls (KD-2, «Конец хода», DC-3, DC-4, Invariant 4;
 * design-runtime.md KD-5): a root session waits; an agent with unfinished children or an undelivered
 * child notice waits; with a final executor, only its `completed` report ends the coordinator and
 * becomes its report; otherwise the answer text is the report.
 */
export function endOfTurn(input: EndOfTurnInput): EndOfTurn {
  if (input.isRoot) return { kind: 'wait' };
  if (input.unfinishedChildren > 0 || input.pendingChildNotices > 0) return { kind: 'wait' };
  if (input.finalExecutor === null) return { kind: 'complete', report: input.text };
  const report = input.finalExecutorReport;
  if (report?.status === 'completed') return { kind: 'complete', report: report.text ?? '' };
  return { kind: 'notice', text: finishRefusal(input.finalExecutor, report) };
}

function finishRefusal(finalExecutor: string, report: FinalExecutorReport | null): string {
  const why =
    report === null
      ? `there is no report of executor "${finalExecutor}" yet`
      : `the last run of executor "${finalExecutor}" ended as ${report.status}`;
  return `You cannot finish: ${why}. The workflow ends only with a completed report of executor "${finalExecutor}"; start it with start_agent.`;
}
