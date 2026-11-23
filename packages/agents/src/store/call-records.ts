import { CodeCallsRepository, type CallKey } from '@agent-os/db';
import {
  RunCodeArgsSchema,
  type ToolOutcome,
  ToolOutcomeSchema,
  type ToolRefusalReason,
} from '@agent-os/contracts';
import { Inject, Injectable } from '@nestjs/common';

import {
  type CallState,
  isDelegated,
  isRunCodeCall,
  openCalls,
} from '../history/call-state';
import type {
  AnswerCall,
  HistoryContent,
  HistoryEntry,
} from '../history/history';
import { History, type NewHistoryEntry } from './history';

/** The refused model of a refusal by model (design-runtime.md, «Данные для `web`»). */
export type RefusalDetail = HistoryContent<'tool_result'>['refusalDetail'];

/** How a call ends; the times default to the moment of the write. */
export interface CallEnding {
  readonly outcome: ToolOutcome;
  readonly refusalReason?: ToolRefusalReason;
  readonly refusalDetail?: RefusalDetail;
  readonly resultText?: string;
  /** Script output of a successful `run_code` run (DC-14). */
  readonly output?: string;
  /** Agent started by `start_agent`, or the subagent of a single `task` call. */
  readonly childTaskId?: string;
  /** When the call went to its tool; the time of its `tool_sent` record wins. */
  readonly startedAt?: Date;
  readonly finishedAt?: Date;
}

/** The employee's decision on a call, as its `tool_decision` record keeps it. */
export interface CallDecision {
  readonly approved: boolean;
  /** The arguments the employee edited. */
  readonly args?: unknown;
}

/** A `run_code` read run starts at most twice: once, and once more after a lost step (KD-7, Invariant 5). */
const MAX_RUN_ATTEMPTS = 2;

type ResultEntry = Extract<NewHistoryEntry, { kind: 'tool_result' }>;

const RunClassSchema = RunCodeArgsSchema.pick({ class: true });

/**
 * The outcome of a call from code the run did not close itself (Invariant 4): a `write` run's calls
 * may have reached their server — «unknown»; a `read` run's are «interrupted». Arguments that are not
 * a `run_code` class count as `read`: such a run never started.
 */
export function interruptedRunOutcome(runArgs: unknown): ToolOutcome {
  const parsed = RunClassSchema.safeParse(runArgs);
  return parsed.success && parsed.data.class === 'write'
    ? ToolOutcomeSchema.enum.unknown
    : ToolOutcomeSchema.enum.interrupted;
}

function decisionEntry(
  callId: string,
  decision: CallDecision,
): NewHistoryEntry {
  return {
    kind: 'tool_decision',
    content: {
      callId,
      approved: decision.approved,
      ...(decision.args === undefined ? {} : { args: decision.args }),
    },
  };
}

/**
 * The `tool_result` of a call that ends at `finishedAt`; a `run_code` call also carries its script
 * output (DC-14), other tools have no `output` field.
 */
function resultEntry(
  call: Pick<CallState, 'callId' | 'tool' | 'server' | 'args' | 'sentAt'>,
  ending: CallEnding,
  finishedAt: Date,
): ResultEntry {
  return {
    kind: 'tool_result',
    content: {
      callId: call.callId,
      tool: call.tool,
      server: call.server,
      args: call.args,
      outcome: ending.outcome,
      refusalReason: ending.refusalReason ?? null,
      refusalDetail: ending.refusalDetail ?? null,
      text: ending.resultText ?? null,
      ...(isRunCodeCall(call) ? { output: ending.output ?? null } : {}),
      startedAt: call.sentAt ?? (ending.startedAt ?? finishedAt).toISOString(),
      finishedAt: finishedAt.toISOString(),
      ...(ending.childTaskId === undefined
        ? {}
        : { childTaskId: ending.childTaskId }),
    },
  };
}

/**
 * Closing on an interrupt or a stop (KD-3, Flow 7): «interrupted», but a call with the `tool_sent`
 * intent may have reached its server — «unknown».
 */
function interruptedEnding(call: Pick<CallState, 'sentAt'>): CallEnding {
  const { unknown, interrupted } = ToolOutcomeSchema.enum;
  return { outcome: call.sentAt === null ? interrupted : unknown };
}

/**
 * The open calls as an interrupt or a stop closes them at `finishedAt`, before the write or without
 * one: the preview of a step and the derived view of a stopped agent's history. A sent `task` call is
 * not among them: the agent's next step closes it from its subagents' `child_finished`
 * (data-model/design-runtime.md, «Инструмент `task`»).
 */
export function interruptedResults(
  open: readonly CallState[],
  finishedAt: Date,
): ResultEntry[] {
  return open
    .filter((call) => !isDelegated(call))
    .map((call) => resultEntry(call, interruptedEnding(call), finishedAt));
}

/**
 * The records of tool calls in `messages`, over the session's `History` and the queries of
 * `CodeCallsRepository`: every change of a call is an appended record, written in a step's
 * commit or its `guard`. Each write first reads the call's records, so a closed call
 * gets no second result and a sent call no second intent (Invariants 1, 2); the unique index
 * `messages_call_once_idx` holds the same.
 */
@Injectable()
export class CallRecords {
  constructor(
    @Inject(History) private readonly history: History,
    @Inject(CodeCallsRepository)
    private readonly codeCallRows: CodeCallsRepository,
  ) {}

  /**
   * Closes the call with its result and returns the appended `tool_result`; `undefined` when the call
   * is closed already. `decision` is written first unless the call has one. Closing a `run_code` call
   * also closes its open calls from code, by the run's class (code-execution Invariant 4).
   */
  async close(
    taskId: string,
    call: AnswerCall,
    ending: CallEnding,
    decision?: CallDecision,
  ): Promise<Extract<HistoryEntry, { kind: 'tool_result' }> | undefined> {
    const records = await this.history.callRecords(taskId, [call.callId]);
    if (records.some((record) => record.kind === 'tool_result'))
      return undefined;
    const sent = records.find((record) => record.kind === 'tool_sent');
    const closing = {
      ...call,
      args: sent?.content.args === undefined ? call.args : sent.content.args,
      sentAt: sent?.content.startedAt ?? null,
    };
    const decided = records.some((record) => record.kind === 'tool_decision');
    const appended = await this.history.append(taskId, [
      ...(decision === undefined || decided
        ? []
        : [decisionEntry(call.callId, decision)]),
      resultEntry(closing, ending, ending.finishedAt ?? new Date()),
    ]);
    if (isRunCodeCall(call)) {
      await this.codeCallRows.closeOpenOfRun(
        { taskId, callId: call.callId },
        interruptedRunOutcome(closing.args),
      );
    }
    const result = appended.at(-1);
    if (result?.kind !== 'tool_result')
      throw new Error(`The result of call ${call.callId} was not appended`);
    return result;
  }

  /**
   * Closes the agent's open calls in answer and position order as an interrupt or a stop does and
   * returns their results; a sent `task` call stays open for its subagents' `child_finished`. The only closing of
   * open calls (overview, Common Processing Points).
   */
  async closeOpen(taskId: string): Promise<HistoryEntry[]> {
    const closed: HistoryEntry[] = [];
    for (const call of openCalls(await this.history.visible(taskId))) {
      if (isDelegated(call)) continue;
      const result = await this.close(taskId, call, interruptedEnding(call));
      if (result !== undefined) closed.push(result);
    }
    return closed;
  }

  /**
   * Writes the employee's approval and the `tool_sent` intent of a call that awaits confirmation, before
   * the call goes out (KD-4, Invariant 2). `args` — the arguments the employee edited; they replace the
   * call's. `false` when the call does not await confirmation — then it must not be sent.
   */
  async markSent(
    call: CallKey & { readonly args?: unknown },
  ): Promise<boolean> {
    const records = await this.history.callRecords(call.taskId, [call.callId]);
    const kinds = new Set(records.map((record) => record.kind));
    if (
      !kinds.has('tool_confirmation') ||
      kinds.has('tool_sent') ||
      kinds.has('tool_result')
    ) {
      return false;
    }
    const edited = call.args === undefined ? {} : { args: call.args };
    await this.history.append(call.taskId, [
      decisionEntry(call.callId, { approved: true, ...edited }),
      {
        kind: 'tool_sent',
        content: {
          callId: call.callId,
          startedAt: new Date().toISOString(),
          ...edited,
        },
      },
    ]);
    return true;
  }

  /**
   * Records the start of a read run's attempt (KD-7): its number, or `null` when the run already
   * started twice — then it must not start again. Open calls from code of the earlier attempt get
   * their outcome by the run's class (Invariant 4).
   */
  async startAttempt(run: CallKey, runArgs: unknown): Promise<number | null> {
    const records = await this.history.callRecords(run.taskId, [run.callId]);
    const attempt =
      records.filter((record) => record.kind === 'run_attempt').length + 1;
    if (attempt > MAX_RUN_ATTEMPTS) return null;
    await this.history.append(run.taskId, [
      { kind: 'run_attempt', content: { callId: run.callId, attempt } },
    ]);
    await this.codeCallRows.closeOpenOfRun(run, interruptedRunOutcome(runArgs));
    return attempt;
  }
}
