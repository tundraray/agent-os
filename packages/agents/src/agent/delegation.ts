import type { Transaction } from '@agent-os/db';
import type { StepContext, StepEffects } from '@agent-os/runtime';

import type { CallState } from '../history/call-state';
import type { HistoryEntry } from '../history/history';
import type { CallEnding } from '../store/call-records.repository';
import type { ToolCaller } from '../tools/tool';

/**
 * Closes one call inside the step's commit transaction and returns its appended `tool_result`; `undefined`
 * when the call was closed already or was not sent. Closings run one after another, in call order, so an
 * in-commit call sees the results of the calls before it (two `start_agent` calls of one answer count each
 * other).
 */
export type CallClosing = (tx: Transaction, effects: StepEffects) => Promise<HistoryEntry | undefined>;

/** A call of the model's answer the agent delegates instead of running: its record and its checked arguments. */
export interface DelegatedCall {
  readonly call: CallState;
  readonly args: unknown;
}

export interface DelegationInput {
  readonly ctx: StepContext;
  readonly caller: ToolCaller;
  /** The delegated calls of one answer, in answer order. */
  readonly calls: readonly DelegatedCall[];
  /** The arguments of a call as the log may hold them. */
  readonly loggedArgs: (call: CallState) => unknown;
}

/** What the tool step does with the delegated calls of an answer. */
export interface Delegation {
  /** The refused calls with how each closes; nothing starts for them. */
  readonly refused: readonly { readonly call: CallState; readonly ending: CallEnding }[];
  /** How many calls were accepted. */
  readonly accepted: number;
  /** Starts the accepted calls' work in the step's commit, after which the step waits; `null` — none accepted. */
  readonly open: ((tx: Transaction, effects: StepEffects) => Promise<void>) | null;
}

/**
 * The last finished single `task` given to the final subagent (deep-agents/design-task.md KD-6): how it ended
 * and its last message.
 */
export interface FinalSubagentReport {
  readonly status: 'completed' | 'failed' | 'stopped';
  /** The subagent's last message; a failed or stopped subagent has none. */
  readonly text: string | null;
}

/** The subagent whose answer ends the run, with the report of its last finished single `task`, if any. */
export interface FinalAnswer {
  readonly subagent: string;
  readonly report: FinalSubagentReport | null;
}
