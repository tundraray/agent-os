/**
 * What changes the turn counter (DC-1): a model call counts, except the compaction call; a finished
 * turn resets it — a report, a failure, a stop, an interrupt without text — and in a root session so
 * does every delivered message of the employee.
 */
export type TurnEvent =
  | { readonly kind: 'model_call' }
  | { readonly kind: 'compaction_call' }
  | { readonly kind: 'report' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'stopped' }
  | { readonly kind: 'interrupted_without_text' }
  | { readonly kind: 'user_message_delivered'; readonly isRoot: boolean };

/** The turn counter after `event` (DC-1). */
export function nextTurns(turns: number, event: TurnEvent): number {
  switch (event.kind) {
    case 'model_call':
      return turns + 1;
    case 'compaction_call':
      return turns;
    case 'report':
    case 'failed':
    case 'stopped':
    case 'interrupted_without_text':
      return 0;
    case 'user_message_delivered':
      return event.isRoot ? 0 : turns;
  }
}

/** The definition's `maxTurns` is spent: the step fails with `turn_limit` instead of calling the model. */
export function turnLimitReached(turns: number, maxTurns: number): boolean {
  return turns >= maxTurns;
}

/** The last report of the final agent the session has received. */
export interface FinalAgentReport {
  readonly status: 'completed' | 'failed' | 'stopped';
  /** The report text; a failed or stopped agent may have none. */
  readonly text: string | null;
}

export interface EndOfTurnInput {
  readonly isRoot: boolean;
  /** Children of the agent that have not finished. */
  readonly unfinishedChildren: number;
  /** `child_finished` messages pending in the inbox and not among the messages of this step (Notes 6). */
  readonly pendingChildNotices: number;
  /** `limits.finalAgent` of the session. */
  readonly finalAgent: string | null;
  /** The last report of `finalAgent`, if any. */
  readonly finalAgentReport: FinalAgentReport | null;
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
 * The outcome of an answer without tool calls (KD-2, «Конец хода», DC-3, DC-4, Invariant 4): a root
 * session waits; an agent with unfinished children or an undelivered child notice waits; with a final
 * agent, only that agent's `completed` report ends the session and becomes its report; otherwise the
 * answer text is the report.
 */
export function endOfTurn(input: EndOfTurnInput): EndOfTurn {
  if (input.isRoot) return { kind: 'wait' };
  if (input.unfinishedChildren > 0 || input.pendingChildNotices > 0) return { kind: 'wait' };
  if (input.finalAgent === null) return { kind: 'complete', report: input.text };
  const report = input.finalAgentReport;
  if (report?.status === 'completed') return { kind: 'complete', report: report.text ?? '' };
  return { kind: 'notice', text: finishRefusal(input.finalAgent, report) };
}

function finishRefusal(finalAgent: string, report: FinalAgentReport | null): string {
  const why =
    report === null
      ? `there is no report of agent "${finalAgent}" yet`
      : `the last run of agent "${finalAgent}" ended as ${report.status}`;
  return `You cannot finish: ${why}. The session ends only with a completed report of agent "${finalAgent}"; start it with start_agent.`;
}
