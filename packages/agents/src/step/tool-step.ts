import { ToolCallStateSchema, ToolOutcomeSchema } from '@agent-os/contracts';
import type { RuntimeTx, StepContext, StepEffects, StepResult } from '@agent-os/runtime';
import { z } from 'zod';

import { type AccessAudit, type AccessGate, OwnerDisabledError } from '../access-gate';
import { type CallState, requestedName } from '../history/call-state';
import type { HistoryEntry } from '../history/history';
import { type CallEnding, callRecords } from '../store/call-records.repository';
import type { Session } from '../store/sessions.repository';
import { toolResults } from '../store/tool-results.repository';
import { callTargetOf, loggedArgsOf, type ToolRegistry } from '../tools/tool-registry';
import {
  callerOf,
  isInCommit,
  type ToolExecution,
  type ToolRunner,
  toolDeniedEntry,
} from '../tools/tool-runner';
import { entriesOf } from './deliver';
import { appendWithEvent, logStep, refusedResult } from './model-step';

/** The step kind in the step log. */
const STEP_KIND = 'tools';

const { sending, awaiting_confirmation: awaitingConfirmation } = ToolCallStateSchema.enum;
const { refused, rejected, unknown } = ToolOutcomeSchema.enum;

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
  /** `content` of the resolved request, handed to the tool (code-execution KD-10). */
  readonly confirmed?: unknown;
}

/**
 * Closes one call inside the commit transaction and returns its appended `tool_result`; `undefined`
 * when the call was closed already or was not sent. Closings run one after another, in call order, so
 * an in-commit call sees the results of the calls before it (two `start_agent` calls of one answer
 * count each other).
 */
type Closing = (tx: RuntimeTx, effects: StepEffects) => Promise<HistoryEntry | undefined>;

export interface ToolStepDeps {
  readonly registry: Pick<ToolRegistry, 'checkTools'>;
  readonly runner: ToolRunner;
  /** Asked once per step before the calls: the pairs `check` refuses with (design-access.md KD-1). */
  readonly access: Pick<AccessGate, 'tools'>;
  /** Gets the `access_denied` record of each `no_access` the step's check decides (KD-6). */
  readonly audit: AccessAudit;
}

/**
 * The tool step (KD-1): runs the open calls of the model's last answer, in answer order.
 * `openCalls` are the agent's calls without a result (`openCalls` of its history); a step that took an
 * `interrupt` never comes here (T4.4).
 */
export type ToolStep = (
  ctx: StepContext,
  session: Session,
  openCalls: readonly CallState[],
) => Promise<StepResult>;

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
  closings: readonly Closing[],
  tx: RuntimeTx,
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
 * `tool_confirmation` of the call an `await_decision` waits on (`awaited`), then the entries of the
 * messages the step delivers (KD-1: a message stands after the results of its answer), and
 * `agents.history_appended` with the last `seq`.
 */
function commitOf(
  ctx: StepContext,
  closings: readonly Closing[],
  awaited?: CallState,
): NonNullable<StepResult['commit']> {
  return async (tx, effects) => {
    const results = await closeAll(closings, tx, effects);
    await appendWithEvent(
      tx,
      effects,
      ctx.taskId,
      [
        ...(awaited === undefined
          ? []
          : [{ kind: 'tool_confirmation' as const, content: { callId: awaited.callId } }]),
        ...(await entriesOf(tx, ctx.messages)),
      ],
      results,
    );
  };
}

/**
 * Builds the tool step (design-agents.md: KD-1, KD-4, Flow 1, Flow 5, DC-5, DC-6, Invariants 1–3).
 *
 * - A call in `sending` — its `tool_sent` intent is written and it has no result — is never sent again:
 *   `unknown` (DC-5, AC-01.2), also when the owner is disabled. A step finds it so only when a step was
 *   lost after the intent; an interrupt or a stop closes it elsewhere.
 * - The gate is asked once before the calls: a disabled owner fails the agent with `owner_disabled` and no
 *   call starts; a pair it does not allow is `no_access` before any confirmation, with one audit record.
 * - Every other open call, in order: a refused call never reaches its tool (`refused` with the reason);
 *   a call needing confirmation without a decision ends the step with `await_decision`, the ready
 *   results committed and the call's `tool_confirmation` written, the rest waiting; a rejected one is
 *   `rejected`; a confirmed one is sent once through `sendConfirmed` (intent through `guard`), and the step ends
 *   after it so its result is committed before anything else runs; an `outside` call runs under the
 *   step's signal; an `in_commit` call runs in the commit.
 * - The signal aborted around a call, or the intent fenced: `continue` without writes — the runtime
 *   rejects the result of a step that is no longer current.
 * - The gate refused the owner at a call's admission (KD-4): that call and the rest do not start; the
 *   calls that ran are closed and the agent fails with `owner_disabled`.
 */
export function createToolStep(deps: ToolStepDeps): ToolStep {
  const { registry, runner, access, audit } = deps;

  return async function toolStep(ctx, session, openCalls) {
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

    const caller = callerOf(ctx);
    // Without the access and account filters: a call to a server the owner may not use gets `no_access`, one
    // whose account went away gets `auth_required` (C3, DC-2). The set comes from the snapshot (ADR-0017).
    const sessionTools = await registry.checkTools({
      snapshot: caller.snapshot,
      ownerId: session.ownerId,
      agentId: ctx.taskId,
      root: ctx.parentId === null,
    });
    const decision = decisionOf(ctx);
    const closings: Closing[] = [];
    const close = (call: CallState, ending: CallEnding): Closing =>
      (tx) => callRecords.close(tx, ctx.taskId, call, ending);
    /**
     * Closes a call the runner ran and stores its full result in the same transaction: every successful and
     * empty direct MCP result, as before (code-execution KD-5); only a long one reached the model as the
     * wrapper (tool-result-reading R-1, R-4). A refusal, an error, a transport failure and a built-in tool
     * carry no `stored` and get no row (DC-8).
     */
    const closeExecuted = async (
      tx: RuntimeTx,
      call: CallState,
      run: { readonly execution: ToolExecution; readonly startedAt: Date; readonly finishedAt: Date },
      // The employee's decision on a confirmed call, written with the result unless the intent wrote it.
      decided?: CallDecision,
    ): Promise<HistoryEntry | undefined> => {
      const { execution } = run;
      const closed = await callRecords.close(
        tx,
        ctx.taskId,
        call,
        endingOf(execution, run.startedAt, run.finishedAt),
        decided === undefined
          ? undefined
          : { approved: decided.approve, ...(decided.args === undefined ? {} : { args: decided.args }) },
      );
      if (closed !== undefined && execution.kind === 'done' && execution.stored !== undefined) {
        await toolResults.insert(tx, { taskId: ctx.taskId, callId: call.callId, ...execution.stored });
      }
      return closed;
    };
    const done = (): StepResult => {
      logStep(ctx, STEP_KIND, stepStartedAt, 'continue', { calls: closings.length });
      return { outcome: 'continue', commit: commitOf(ctx, closings) };
    };
    /** The agent fails with `owner_disabled`: the calls that ran are closed, the rest never start (KD-5). */
    const ownerDisabled = (): Promise<StepResult> =>
      refusedResult({
        ctx,
        stepKind: STEP_KIND,
        startedAt: stepStartedAt,
        model: session.model,
        refusal: { kind: 'refused', reason: 'owner_disabled' },
        audit,
        writeEntries: async (tx, effects) => {
          await closeAll(closings, tx, effects);
          return entriesOf(tx, ctx.messages);
        },
        patch: {},
      });

    // Before the gate, so a disabled owner's exit closes them too: a call left in `sending` precedes every
    // other open call of its answer.
    for (const call of openCalls) {
      if (call.state !== sending) continue;
      // The intent is written and no result came back: the call may have reached its server.
      ctx.logger.warn('tool call in sending without a result closed as unknown', {
        callId: call.callId,
        tool: call.tool,
        server: call.server,
        args: loggedArgsOf(sessionTools, requestedName(call), call.args),
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

    const runCalls = async (): Promise<StepResult> => {
      for (const call of openCalls) {
        if (call.state === sending) continue;
        if (ctx.signal.aborted) return abandon('signal aborted before the call');

        const check = runner.check(
          { callId: call.callId, toolName: requestedName(call), args: call.args },
          { sessionTools, caller, allows },
        );
        if (check.kind === 'refused') {
          // Before any confirmation: a pair the owner may not use is never offered to the employee (Flow 2).
          // The row keeps the name as asked when the offered set lacked the tool, so the pair comes from the check's set.
          const target = callTargetOf(sessionTools, requestedName(call));
          if (check.reason === 'no_access' && target.server !== null) {
            await audit(toolDeniedEntry(session.ownerId, target.server, target.tool));
          }
          ctx.logger.info('tool call refused', {
            callId: call.callId,
            tool: call.tool,
            server: call.server,
            args: loggedArgsOf(sessionTools, requestedName(call), call.args),
            outcome: refused,
            reason: check.reason,
            durationMs: 0,
          });
          closings.push(close(call, { outcome: refused, refusalReason: check.reason }));
          continue;
        }
        const resolved = check.call;

        if (runner.needsConfirmation(resolved)) {
          const callDecision = decision?.callId === call.callId ? decision : undefined;
          if (callDecision === undefined) {
            if (call.state === awaitingConfirmation) {
              throw new Error(
                `Call ${call.callId} of agent ${ctx.taskId} awaits confirmation, but the step got no decision for it`,
              );
            }
            const request = runner.confirmationRequest(resolved, session, sessionTools);
            ctx.logger.info('tool call awaits confirmation', {
              callId: call.callId,
              tool: call.tool,
              server: call.server,
              args: loggedArgsOf(sessionTools, requestedName(call), call.args),
              outcome: null,
              reason: 'awaiting_confirmation',
            });
            logStep(ctx, STEP_KIND, stepStartedAt, 'await_decision', { calls: closings.length });
            return {
              outcome: 'await_decision',
              kind: request.kind,
              payload: request.payload,
              commit: commitOf(ctx, closings, call),
            };
          }

          if (!callDecision.approve) {
            ctx.logger.info('tool call rejected by the employee', {
              callId: call.callId,
              tool: call.tool,
              server: call.server,
              args: loggedArgsOf(sessionTools, requestedName(call), call.args),
              outcome: rejected,
              reason: 'rejected',
              durationMs: 0,
            });
            closings.push((tx) =>
              callRecords.close(tx, ctx.taskId, call, { outcome: rejected }, { approved: false }),
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

      return done();
    };

    try {
      return await runCalls();
    } catch (error) {
      if (!(error instanceof OwnerDisabledError)) throw error;
      return ownerDisabled();
    }
  };
}
