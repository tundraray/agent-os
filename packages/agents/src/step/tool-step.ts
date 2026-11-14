import { AGENTS_HISTORY_APPENDED, ToolCallStateSchema, ToolOutcomeSchema } from '@agent-os/contracts';
import type { RuntimeTx, StepContext, StepEffects, StepResult } from '@agent-os/runtime';
import { z } from 'zod';

import type { DefinitionCatalog } from '../definitions/catalog.js';
import { mcpToolName } from '../mcp/mcp-clients.js';
import { history, type NewHistoryEntry } from '../store/history.repository.js';
import type { Session } from '../store/sessions.repository.js';
import { type ToolCallEnding, type ToolCallRow, toolCalls } from '../store/tool-calls.repository.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import {
  callerOf,
  type ResolvedCall,
  type ToolExecution,
  type ToolRunner,
} from '../tools/tool-runner.js';
import { entriesOf, toolResultEntry } from './deliver.js';

/** The step kind in the step log. */
const STEP_KIND = 'tools';

const { sending, awaiting_confirmation: awaitingConfirmation } = ToolCallStateSchema.enum;
const { refused, rejected, unknown } = ToolOutcomeSchema.enum;

/** The part of a confirmation request the step needs back: which call it is about. */
const ConfirmationPayloadSchema = z.object({ callId: z.string() });

/** The resolution `resolveConfirmation` (T4.3) writes; `args` — the employee's edit, if the tool allows one. */
const ConfirmationResolutionSchema = z.object({
  approve: z.boolean(),
  args: z.unknown().optional(),
});

/** The employee's decision on one call, read from `ctx.decision`. */
interface CallDecision {
  readonly callId: string;
  readonly approve: boolean;
  readonly args?: unknown;
}

/**
 * Closes one call inside the commit transaction and returns its closed row; `undefined` when the call
 * was closed already or was not sent. Closings run one after another, in call order, so an in-commit
 * call sees the calls before it closed (two `start_agent` calls of one answer count each other).
 */
type Closing = (tx: RuntimeTx, effects: StepEffects) => Promise<ToolCallRow | undefined>;

export interface ToolStepDeps {
  readonly catalog: DefinitionCatalog;
  readonly registry: ToolRegistry;
  readonly runner: ToolRunner;
}

/**
 * The tool step (KD-1): runs the open calls of the model's last answer, in answer order.
 * `openCalls` are `toolCalls.open` of the agent; a step that took an `interrupt` never comes here (T4.4).
 */
export type ToolStep = (
  ctx: StepContext,
  session: Session,
  openCalls: readonly ToolCallRow[],
) => Promise<StepResult>;

function decisionOf(ctx: StepContext): CallDecision | undefined {
  if (ctx.decision === null) return undefined;
  const { callId } = ConfirmationPayloadSchema.parse(ctx.decision.payload);
  const resolution = ConfirmationResolutionSchema.parse(ctx.decision.resolution);
  return {
    callId,
    approve: resolution.approve,
    ...(resolution.args === undefined ? {} : { args: resolution.args }),
  };
}

/** The name the model called: `agent_tool_calls` keeps an MCP tool as its server and raw name. */
function requestedName(call: ToolCallRow): string {
  return call.server === null ? call.tool : mcpToolName(call.server, call.tool);
}

function close(call: ToolCallRow, ending: ToolCallEnding): Closing {
  return (tx) => toolCalls.close(tx, { taskId: call.taskId, callId: call.callId }, ending);
}

/** How a call the runner ran ends in its row. */
function endingOf(execution: ToolExecution, startedAt: Date, finishedAt: Date): ToolCallEnding {
  if (execution.kind === 'refused') {
    return { outcome: refused, refusalReason: execution.reason, startedAt, finishedAt };
  }
  return {
    outcome: execution.outcome,
    resultText: execution.text,
    ...(execution.childAgentId === undefined ? {} : { childTaskId: execution.childAgentId }),
    startedAt,
    finishedAt,
  };
}

function isInCommit(call: ResolvedCall): boolean {
  return call.tool.kind === 'agent' && call.tool.tool.mode === 'in_commit';
}

/**
 * The commit of the step: the closings in call order, their `tool_result` entries, then the entries of
 * the messages the step delivers (KD-1: a message stands after the results of its answer), and
 * `agents.history_appended` with the last `seq`. `afterClosings` (`markAwaiting` of `await_decision`)
 * runs between the closings and the entries.
 */
function commitOf(
  ctx: StepContext,
  closings: readonly Closing[],
  afterClosings?: (tx: RuntimeTx) => Promise<void>,
): NonNullable<StepResult['commit']> {
  return async (tx, effects) => {
    const results: NewHistoryEntry[] = [];
    for (const closing of closings) {
      const closed = await closing(tx, effects);
      if (closed !== undefined) results.push(toolResultEntry(closed));
    }
    if (afterClosings !== undefined) await afterClosings(tx);
    const appended = await history.append(tx, ctx.taskId, [
      ...results,
      ...(await entriesOf(tx, ctx.messages)),
    ]);
    const last = appended.at(-1);
    if (last !== undefined) {
      await effects.emit(AGENTS_HISTORY_APPENDED, { agentId: ctx.taskId, seq: last.seq });
    }
  };
}

/**
 * Builds the tool step (design-agents.md: KD-1, KD-4, Flow 1, Flow 5, DC-5, DC-6, Invariants 1–3).
 *
 * - A call in `sending` has no result and is never sent again: `unknown` (DC-5, AC-01.2). It is
 *   `sending` only when a step was lost after the intent; an interrupt or a stop closes it elsewhere.
 * - Every other open call, in order: a refused call never reaches its tool (`refused` with the reason);
 *   a call needing confirmation without a decision ends the step with `await_decision`, the ready
 *   results committed and the call marked awaiting, the rest waiting; a rejected one is `rejected`; a
 *   confirmed one is sent once through `sendConfirmed` (intent through `guard`), and the step ends
 *   after it so its result is committed before anything else runs; an `outside` call runs under the
 *   step's signal; an `in_commit` call runs in the commit.
 * - The signal aborted around a call, or the intent fenced: `continue` without writes — the runtime
 *   rejects the result of a step that is no longer current.
 */
export function createToolStep(deps: ToolStepDeps): ToolStep {
  const { catalog, registry, runner } = deps;

  return async function toolStep(ctx, session, openCalls) {
    const stepStartedAt = Date.now();
    const logStep = (outcome: StepResult['outcome'], closedCalls: number): void => {
      ctx.logger.info('agent step finished', {
        stepKind: STEP_KIND,
        agentId: ctx.taskId,
        rootId: ctx.rootId,
        ownerId: ctx.ownerId,
        stepNo: ctx.stepNo,
        outcome,
        calls: closedCalls,
        durationMs: Date.now() - stepStartedAt,
      });
    };
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

    const definition = catalog.get(session.definition);
    if (definition === undefined) {
      throw new Error(`Agent ${ctx.taskId} has definition ${session.definition}, which is not in the catalog`);
    }
    const sessionTools = registry.sessionTools({
      definition,
      limits: session.limits,
      ownerId: session.ownerId,
    });
    const caller = callerOf(ctx);
    const decision = decisionOf(ctx);
    const closings: Closing[] = [];
    const done = (): StepResult => {
      logStep('continue', closings.length);
      return { outcome: 'continue', commit: commitOf(ctx, closings) };
    };

    for (const call of openCalls) {
      if (call.state === sending) {
        // The intent is written and no result came back: the call may have reached its server.
        ctx.logger.warn('tool call in sending without a result closed as unknown', {
          callId: call.callId,
          tool: call.tool,
          server: call.server,
          args: call.args,
          outcome: unknown,
          reason: ctx.resumedAfterLoss ? 'resumed_after_loss' : 'sending_without_loss',
        });
        closings.push(close(call, { outcome: unknown }));
        continue;
      }
      if (ctx.signal.aborted) return abandon('signal aborted before the call');

      const check = runner.check(
        { callId: call.callId, toolName: requestedName(call), args: call.args },
        { sessionTools, caller },
      );
      if (check.kind === 'refused') {
        ctx.logger.info('tool call refused', {
          callId: call.callId,
          tool: call.tool,
          server: call.server,
          args: call.args,
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
          const request = runner.confirmationRequest(resolved, session);
          ctx.logger.info('tool call awaits confirmation', {
            callId: call.callId,
            tool: call.tool,
            server: call.server,
            args: call.args,
            outcome: null,
            reason: 'awaiting_confirmation',
          });
          logStep('await_decision', closings.length);
          return {
            outcome: 'await_decision',
            kind: request.kind,
            payload: request.payload,
            commit: commitOf(ctx, closings, async (tx) => {
              const moved = await toolCalls.markAwaiting(tx, {
                taskId: ctx.taskId,
                callId: call.callId,
              });
              if (moved === undefined) {
                throw new Error(`Call ${call.callId} of agent ${ctx.taskId} was no longer requested`);
              }
            }),
          };
        }

        if (!callDecision.approve) {
          ctx.logger.info('tool call rejected by the employee', {
            callId: call.callId,
            tool: call.tool,
            server: call.server,
            args: call.args,
            outcome: rejected,
            reason: 'rejected',
            durationMs: 0,
          });
          closings.push(close(call, { outcome: rejected }));
          continue;
        }

        const startedAt = new Date();
        const send = await runner.sendConfirmed(resolved, ctx, callDecision.args);
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
            return close(call, endingOf(execution, callStartedAt, new Date()))(tx, effects);
          });
          return done();
        }
        if (send.execution.kind === 'aborted') return abandon('signal aborted during the confirmed call');
        closings.push(close(call, endingOf(send.execution, startedAt, new Date())));
        // The confirmed result is committed before anything else of the answer runs (KD-1).
        return done();
      }

      if (isInCommit(resolved)) {
        const run = runner.planInCommit(resolved, ctx.logger);
        closings.push(async (tx, effects) => {
          const startedAt = new Date();
          const execution = await run(tx, effects);
          return close(call, endingOf(execution, startedAt, new Date()))(tx, effects);
        });
        continue;
      }

      const startedAt = new Date();
      const execution = await runner.runOutside(resolved, ctx);
      if (execution.kind === 'aborted') return abandon('signal aborted during the call');
      closings.push(close(call, endingOf(execution, startedAt, new Date())));
    }

    return done();
  };
}
