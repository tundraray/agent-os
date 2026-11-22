import type { Transaction } from '@agent-os/db';
import {
  ToolCallStateSchema,
  ToolOutcomeSchema,
  type ToolRefusalReason,
  ToolRefusalReasonSchema,
} from '@agent-os/contracts';
import type { StepContext, StepEffects, StepResult } from '@agent-os/runtime';
import { z } from 'zod';

import { OwnerDisabledError } from '../access-gate';
import { type CallState, isDelegated, requestedName } from '../history/call-state';
import type { HistoryEntry } from '../history/history';
import type { CallEnding } from '../store/call-records';
import type { Session } from '../store/sessions';
import { isInCommit, reportCheck, toolDeniedEntry, toolRefusedEntry } from '../tools/call-check';
import type { ToolExecution } from '../tools/tool-execution';
import { callTargetOf, loggedArgsOf } from '../tools/tool-registry';
import type { AgentDeps } from './agent-deps';
import type { BaseAgent } from './base-agent';
import type { CallClosing, DelegatedCall } from './delegation';
import { entriesOf } from './deliver';
import { appendWithEvent, logStep, refusedResult } from './step-common';
import { type PastCall, repeatMarkText, repeatOf, repeatRefusalText } from './repeat-rule';

/** The step kind in the step log. */
const STEP_KIND = 'tools';

const { sending, awaiting_confirmation: awaitingConfirmation } = ToolCallStateSchema.enum;
const { refused, rejected, unknown } = ToolOutcomeSchema.enum;
const { repeated_call: repeatedCall } = ToolRefusalReasonSchema.enum;

/** A call as the repeat rule counts it. */
function pastCallOf(call: CallState): PastCall {
  return { callId: call.callId, tool: call.tool, server: call.server, args: call.args };
}

/** The part of a confirmation request the step needs back: which call it is about and what was shown. */
const ConfirmationPayloadSchema = z.object({ callId: z.string(), content: z.unknown() });

/** The resolution `resolveConfirmation` (T4.3) writes; `args` — the employee's edit, if the tool allows one. */
export const ConfirmationResolutionSchema = z.object({
  approve: z.boolean(),
  args: z.unknown().optional(),
});

/** The employee's decision on one call, read from `ctx.decision`. */
interface CallDecision {
  readonly callId: string;
  readonly approve: boolean;
  readonly args?: unknown;
  /** `content` of the resolved request, handed to the tool (code-execution KD-10; deep-agents KD-3). */
  readonly confirmed?: unknown;
}

function decisionOf(ctx: StepContext): CallDecision | undefined {
  if (ctx.decision === null) return undefined;
  const { callId, content } = ConfirmationPayloadSchema.parse(ctx.decision.payload);
  const resolution = ConfirmationResolutionSchema.parse(ctx.decision.resolution);
  return {
    callId,
    approve: resolution.approve,
    ...(resolution.args === undefined ? {} : { args: resolution.args }),
    ...(content === undefined ? {} : { confirmed: content }),
  };
}

/** How a call the runner ran ends in its `tool_result`. */
function endingOf(execution: ToolExecution, startedAt: Date, finishedAt: Date): CallEnding {
  if (execution.kind === 'refused') {
    return {
      outcome: refused,
      refusalReason: execution.reason,
      refusalDetail: execution.refusalDetail ?? null,
      ...(execution.text === undefined ? {} : { resultText: execution.text }),
      startedAt,
      finishedAt,
    };
  }
  return {
    outcome: execution.outcome,
    resultText: execution.text,
    ...(typeof execution.output === 'string' ? { output: execution.output } : {}),
    ...(execution.childAgentId === undefined ? {} : { childTaskId: execution.childAgentId }),
    startedAt,
    finishedAt,
  };
}

/** Runs the closings in call order, each appending its `tool_result`, and returns the appended entries. */
async function closeAll(
  closings: readonly CallClosing[],
  tx: Transaction,
  effects: StepEffects,
): Promise<HistoryEntry[]> {
  const results: HistoryEntry[] = [];
  for (const closing of closings) {
    const closed = await closing(tx, effects);
    if (closed !== undefined) results.push(closed);
  }
  return results;
}

/**
 * The commit of the step: the closings in call order, each with its `tool_result`, then the
 * `tool_confirmation` of the call an `await_decision` waits on (`awaited`) or the start of the accepted
 * delegated calls (`opening`), then the entries of the messages the step delivers (KD-1: a message stands after
 * the results of its answer), and `agents.history_appended` with the last `seq`.
 */
function commitOf(
  deps: Pick<AgentDeps, 'history' | 'sessions' | 'messageRows'>,
  ctx: StepContext,
  closings: readonly CallClosing[],
  awaited?: CallState,
  opening?: (tx: Transaction, effects: StepEffects) => Promise<void>,
): NonNullable<StepResult['commit']> {
  return async (tx, effects) => {
    const results = await closeAll(closings, tx, effects);
    await opening?.(tx, effects);
    await appendWithEvent(
      deps,
      tx,
      effects,
      ctx.taskId,
      [
        ...(awaited === undefined
          ? []
          : [{ kind: 'tool_confirmation' as const, content: { callId: awaited.callId } }]),
        ...(await entriesOf(deps, tx, ctx.messages)),
      ],
      results,
    );
  };
}

/**
 * The tool step of an agent, called by `BaseAgent.toolStep` (design-agents.md: KD-1, KD-4, Flow 1, Flow 5, DC-5,
 * DC-6, Invariants 1–3): runs the open calls of the model's last answer, in answer order. `openCalls` are the
 * agent's calls without a result; a step that took an `interrupt` comes here only with its sent delegated calls.
 * `calls` are all the calls of the visible history (`foldCalls`): the repeat rule counts the closed ones
 * (agent-harness KD-5).
 *
 * - What differs between the kinds of agents are the agent's methods: the closings of the sent delegated calls
 *   (`closeDelegated`), which calls are delegated (`delegates`), and their check (`delegate`). Only a deep agent
 *   delegates — its `task` calls (deep-agents/design-task.md KD-4).
 * - A sent delegated call waits for its tracker: the step that delivers `tasks_finished` closes it with its
 *   tasks' outcomes, first, and never as `unknown`.
 * - A call in `sending` — its `tool_sent` intent is written and it has no result — is never sent again:
 *   `unknown` (DC-5, AC-01.2), also when the owner is disabled. A step finds it so only when a step was
 *   lost after the intent; an interrupt or a stop closes it elsewhere.
 * - The gate is asked once before the calls: a disabled owner fails the agent with `owner_disabled` and no
 *   call starts; a pair it does not allow is `no_access` before any confirmation, with one audit record.
 * - Every other open call, in order: a refused call never reaches its tool (`refused` with the reason);
 *   a call the check allows goes through the repeat rule (agent-harness KD-5) — a third same call is
 *   `repeated_call`, audited for an MCP tool; a second one runs and its result's text gets the mark;
 *   a call needing confirmation without a decision is checked by its tool's `review`, if it has one, outside
 *   any transaction (deep-agents KD-3) — a refusal closes it `refused` with its text and asks nothing —
 *   and then ends the step with `await_decision`, the ready
 *   results committed and the call's `tool_confirmation` written, the rest waiting; a rejected one is
 *   `rejected`; a confirmed one is sent once through `sendConfirmed` (intent through `guard`), and the step ends
 *   after it so its result is committed before anything else runs; an `outside` call runs under the
 *   step's signal; an `in_commit` call runs in the commit.
 * - The delegated calls the check lets through wait until every other call of the answer is closed, then are
 *   checked together (KD-4): a refusal is closed with its text; the accepted ones open one tracker in the
 *   commit and the step ends with `wait`, which the runtime turns into waiting for the tracker's tasks.
 * - The signal aborted around a call, or the intent fenced: `continue` without writes — the runtime
 *   rejects the result of a step that is no longer current.
 * - The gate refused the owner at a call's admission (KD-4): that call and the rest do not start; the
 *   calls that ran are closed and the agent fails with `owner_disabled`.
 */
export async function runToolStep(
  deps: AgentDeps,
  agent: Pick<BaseAgent, 'caller' | 'declaration' | 'closeDelegated' | 'delegates' | 'delegate'>,
  ctx: StepContext,
  session: Session,
  openCalls: readonly CallState[],
  calls: readonly CallState[],
): Promise<StepResult> {
  const { registry, runner, access, audit } = deps;
  const stepStartedAt = Date.now();
  const abandon = (why: string): StepResult => {
    ctx.logger.info('tool step abandoned without writes', {
      stepKind: STEP_KIND,
      agentId: ctx.taskId,
      stepNo: ctx.stepNo,
      reason: why,
      signalReason: ctx.signal.aborted ? String(ctx.signal.reason) : null,
      durationMs: Date.now() - stepStartedAt,
    });
    return { outcome: 'continue' };
  };

  const { caller } = agent;
  // Without the access and account filters: a call to a server the owner may not use gets `no_access`, one
  // whose account went away gets `auth_required` (C3, DC-2). The set comes from the snapshot (ADR-0017).
  const sessionTools = await registry.checkTools(agent.declaration);
  const argsOf = (call: CallState): unknown =>
    loggedArgsOf(sessionTools, (name) => registry.toolOf(name), { name: requestedName(call), args: call.args });
  const decision = decisionOf(ctx);
  const closings: CallClosing[] = [];
  // The repeat rule's past (KD-5): the closed calls of the visible history, then each call of this step it lets through.
  const past: PastCall[] = calls.flatMap((earlier) =>
    earlier.result === null ? [] : [{ ...pastCallOf(earlier), outcome: earlier.result.outcome }],
  );
  // The repeat mark of a call, by its id: appended to its result's text however it ends, never to `stored` (KD-1).
  const marks = new Map<string, string>();
  const marked = (call: CallState, ending: CallEnding): CallEnding => {
    const mark = marks.get(call.callId);
    if (mark === undefined) return ending;
    const text = ending.resultText ?? '';
    return { ...ending, resultText: text === '' ? mark : `${text}\n\n${mark}` };
  };
  const close = (call: CallState, ending: CallEnding): CallClosing =>
    (tx) => deps.callRecords.close(tx, ctx.taskId, call, marked(call, ending));
  /**
   * Closes a call the runner ran and stores its full result in the same transaction: every successful and
   * empty direct MCP result, as before (code-execution KD-5); only a long one reached the model as the
   * wrapper (tool-result-reading R-1, R-4). A refusal, an error, a transport failure and a built-in tool
   * carry no `stored` and get no row (DC-8).
   */
  const closeExecuted = async (
    tx: Transaction,
    call: CallState,
    run: { readonly execution: ToolExecution; readonly startedAt: Date; readonly finishedAt: Date },
    // The employee's decision on a confirmed call, written with the result unless the intent wrote it.
    decided?: CallDecision,
  ): Promise<HistoryEntry | undefined> => {
    const { execution } = run;
    const closed = await deps.callRecords.close(
      tx,
      ctx.taskId,
      call,
      marked(call, endingOf(execution, run.startedAt, run.finishedAt)),
      decided === undefined
        ? undefined
        : { approved: decided.approve, ...(decided.args === undefined ? {} : { args: decided.args }) },
    );
    if (closed !== undefined && execution.kind === 'done' && execution.stored !== undefined) {
      await deps.toolResultRows.insert(tx, { taskId: ctx.taskId, callId: call.callId, ...execution.stored });
    }
    return closed;
  };
  const done = (): StepResult => {
    logStep(ctx, STEP_KIND, stepStartedAt, 'continue', { calls: closings.length });
    return { outcome: 'continue', commit: commitOf(deps, ctx, closings) };
  };
  /** The agent fails with `owner_disabled`: the calls that ran are closed, the rest never start (KD-5). */
  const ownerDisabled = (): Promise<StepResult> =>
    refusedResult({
      deps,
      ctx,
      stepKind: STEP_KIND,
      startedAt: stepStartedAt,
      model: session.model,
      refusal: { kind: 'refused', reason: 'owner_disabled' },
      audit,
      writeEntries: async (tx, effects) => {
        await closeAll(closings, tx, effects);
        return entriesOf(deps, tx, ctx.messages);
      },
      patch: {},
    });

  // Sent delegated calls wait for their tracker, and this step delivers its `tasks_finished` (KD-4): they close
  // with the outcomes of their tasks, before the gate, like the calls in `sending` below.
  closings.push(...(await agent.closeDelegated(ctx, openCalls.filter(isDelegated))));

  // Before the gate, so a disabled owner's exit closes them too: a call left in `sending` precedes every
  // other open call of its answer.
  for (const call of openCalls) {
    if (call.state !== sending || isDelegated(call)) continue;
    // The intent is written and no result came back: the call may have reached its server.
    ctx.logger.warn('tool call in sending without a result closed as unknown', {
      callId: call.callId,
      tool: call.tool,
      server: call.server,
      args: argsOf(call),
      outcome: unknown,
      reason: ctx.resumedAfterLoss ? 'resumed_after_loss' : 'sending_without_loss',
    });
    closings.push(close(call, { outcome: unknown }));
  }

  const toolAccess = await access.tools(session.ownerId);
  if (toolAccess.kind === 'owner_disabled') {
    ctx.logger.warn('access gate refused the tool step', {
      ownerId: session.ownerId,
      agentId: ctx.taskId,
      calls: openCalls.length,
      reason: 'owner_disabled',
    });
    return ownerDisabled();
  }
  const { allows } = toolAccess;
  /** The delegated calls the check let through, run together after every other call of the answer (KD-4). */
  const delegatedCalls: DelegatedCall[] = [];

  /**
   * The delegated calls of the answer, checked together by the agent once every other call is closed (KD-4):
   * a refusal is closed with its text; the accepted ones start in the commit, and the step waits for them.
   */
  const delegate = async (): Promise<StepResult> => {
    const delegation = await agent.delegate({ ctx, caller, calls: delegatedCalls, loggedArgs: argsOf });
    for (const { call, ending } of delegation.refused) closings.push(close(call, ending));
    if (delegation.open === null) return done();
    logStep(ctx, STEP_KIND, stepStartedAt, 'wait', {
      calls: closings.length,
      delegations: delegation.accepted,
    });
    return { outcome: 'wait', commit: commitOf(deps, ctx, closings, undefined, delegation.open) };
  };

  const runCalls = async (): Promise<StepResult> => {
    for (const call of openCalls) {
      if (call.state === sending) continue;
      if (ctx.signal.aborted) return abandon('signal aborted before the call');

      const check = runner.check(
        { callId: call.callId, toolName: requestedName(call), args: call.args },
        { sessionTools, caller, allows },
      );
      // The row keeps the name as asked when the offered set lacked the tool, so the pair comes from the check's set.
      const target = callTargetOf(sessionTools, requestedName(call));
      await reportCheck(
        check,
        { callId: call.callId, ...target },
        { ownerId: session.ownerId, logger: ctx.logger, audit },
      );
      /** Closes the call `refused`; KD-1: the model reads why from the result's text. */
      const refuse = (reason: ToolRefusalReason, text: string | undefined): void => {
        ctx.logger.info('tool call refused', {
          callId: call.callId,
          tool: call.tool,
          server: call.server,
          args: argsOf(call),
          outcome: refused,
          reason,
          durationMs: 0,
        });
        closings.push(
          close(call, {
            outcome: refused,
            refusalReason: reason,
            ...(text === undefined ? {} : { resultText: text }),
          }),
        );
      };
      if (check.kind === 'refused') {
        // Before any confirmation: a pair the owner may not use is never offered to the employee (Flow 2).
        if (check.reason === 'no_access' && target.server !== null) {
          await audit(toolDeniedEntry(session.ownerId, target.server, target.tool));
        }
        refuse(check.reason, check.text);
        continue;
      }
      const resolved = check.call;

      // After the check and before any confirmation: a third same call is never offered to the employee (KD-5).
      const repeat = repeatOf({ call, past });
      if (repeat.kind === 'refuse') {
        if (target.server !== null) {
          await audit(toolRefusedEntry(session.ownerId, target.server, target.tool, repeatedCall));
        }
        refuse(repeatedCall, repeatRefusalText(repeat.callIds));
        continue;
      }
      past.push(pastCallOf(call));
      if (repeat.kind === 'mark') {
        ctx.logger.info('tool call repeated', {
          callId: call.callId,
          tool: call.tool,
          server: call.server,
          sameCallIds: repeat.callIds,
        });
        marks.set(call.callId, repeatMarkText(repeat.callIds));
      }

      if (agent.delegates(resolved.tool)) {
        delegatedCalls.push({ call, args: resolved.args });
        continue;
      }

      if (runner.needsConfirmation(resolved)) {
        const callDecision = decision?.callId === call.callId ? decision : undefined;
        if (callDecision === undefined) {
          if (call.state === awaitingConfirmation) {
            throw new Error(
              `Call ${call.callId} of agent ${ctx.taskId} awaits confirmation, but the step got no decision for it`,
            );
          }
          const card = await runner.confirmationRequest(resolved, session, sessionTools);
          if (card.kind === 'refused') {
            // The tool's check before the card refused it (deep-agents KD-3): no request, the model reads why.
            refuse(card.reason, card.text);
            continue;
          }
          const { request } = card;
          ctx.logger.info('tool call awaits confirmation', {
            callId: call.callId,
            tool: call.tool,
            server: call.server,
            args: argsOf(call),
            outcome: null,
            reason: 'awaiting_confirmation',
          });
          logStep(ctx, STEP_KIND, stepStartedAt, 'await_decision', { calls: closings.length });
          return {
            outcome: 'await_decision',
            kind: request.kind,
            payload: request.payload,
            commit: commitOf(deps, ctx, closings, call),
          };
        }

        if (!callDecision.approve) {
          ctx.logger.info('tool call rejected by the employee', {
            callId: call.callId,
            tool: call.tool,
            server: call.server,
            args: argsOf(call),
            outcome: rejected,
            reason: 'rejected',
            durationMs: 0,
          });
          closings.push((tx) =>
            deps.callRecords.close(tx, ctx.taskId, call, marked(call, { outcome: rejected }), {
              approved: false,
            }),
          );
          continue;
        }

        const startedAt = new Date();
        const send = await runner.sendConfirmed(
          resolved,
          ctx,
          callDecision.args,
          callDecision.confirmed,
        );
        if (send.kind === 'not_sent') {
          if (send.reason === 'fenced') return abandon('intent fenced');
          // The call is no longer awaiting: nothing is sent; what is ready is committed.
          return done();
        }
        if (send.kind === 'in_commit') {
          const { commit } = send;
          closings.push(async (tx, effects) => {
            const callStartedAt = new Date();
            const execution = await commit(tx, effects);
            if (execution.kind === 'not_sent') return undefined;
            return closeExecuted(
              tx,
              call,
              { execution, startedAt: callStartedAt, finishedAt: new Date() },
              callDecision,
            );
          });
          return done();
        }
        const { execution } = send;
        if (execution.kind === 'aborted') return abandon('signal aborted during the confirmed call');
        const finishedAt = new Date();
        closings.push((tx) =>
          closeExecuted(tx, call, { execution, startedAt, finishedAt }, callDecision),
        );
        // The confirmed result is committed before anything else of the answer runs (KD-1).
        return done();
      }

      if (isInCommit(resolved)) {
        const run = await runner.planInCommit(resolved, ctx.logger);
        closings.push(async (tx, effects) => {
          const startedAt = new Date();
          const execution = await run(tx, effects);
          return closeExecuted(tx, call, { execution, startedAt, finishedAt: new Date() });
        });
        continue;
      }

      const startedAt = new Date();
      const execution = await runner.runOutside(resolved, ctx);
      if (execution.kind === 'aborted') return abandon('signal aborted during the call');
      const finishedAt = new Date();
      closings.push((tx) => closeExecuted(tx, call, { execution, startedAt, finishedAt }));
    }

    return delegatedCalls.length > 0 ? delegate() : done();
  };

  try {
    return await runCalls();
  } catch (error) {
    if (!(error instanceof OwnerDisabledError)) throw error;
    return ownerDisabled();
  }
}
