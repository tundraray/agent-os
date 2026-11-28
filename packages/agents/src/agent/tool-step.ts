import {
  CHILD_FINISHED_KIND,
  ChildFinishedPayloadSchema,
  type QuestionAnswer,
  QuestionAnswerSchema,
  ToolCallStateSchema,
  ToolOutcomeSchema,
  type ToolPair,
  type ToolRefusalReason,
  ToolRefusalReasonSchema,
} from '@agent-os/contracts';
import {
  type Question,
  RuntimeError,
  type StepContext,
  type StepEffects,
  type StepResult,
} from '@agent-os/runtime';
import { z } from 'zod';

import { OwnerDisabledError } from '../access-gate';
import {
  type CallState,
  isDelegated,
  requestedName,
} from '../history/call-state';
import type { HistoryEntry } from '../history/history';
import { ANSWER_LOST_TEXT, type CallEnding } from '../store/call-records';
import type { Session } from '../store/sessions';
import {
  isAccessRefusal,
  isInCommit,
  reportCheck,
  type ResolvedCall,
  toolDeniedEntry,
  toolRefusedEntry,
} from '../tools/call-check';
import type { NotSent, ToolExecution } from '../tools/tool-execution';
import type { ConfirmedSend } from '../tools/tool-runner';
import {
  callTarget,
  callTargetOf,
  isMcp,
  loggedArgsOf,
} from '../tools/tool-registry';
import { isQuestion } from '../task-tree';
import type { AgentDeps } from './agent-deps';
import { agentOwner } from './agent-owner';
import { callRule, type CallRuling } from './call-rule';
import type { BaseAgent } from './base-agent';
import type { CallClosing, DelegatedCall } from './delegation';
import { entriesOf } from './deliver';
import { logStep, refusedResult, signalAttention } from './step-common';
import {
  type PastCall,
  repeatMarkText,
  repeatOf,
  repeatRefusalText,
} from './repeat-rule';

/** The step kind in the step log. */
const STEP_KIND = 'tools';

const { sending, awaiting_confirmation: awaitingConfirmation } =
  ToolCallStateSchema.enum;
const { refused, rejected, unknown } = ToolOutcomeSchema.enum;
const { repeated_call: repeatedCall } = ToolRefusalReasonSchema.enum;

/** A call as the repeat rule counts it. */
function pastCallOf(call: CallState): PastCall {
  return {
    callId: call.callId,
    tool: call.tool,
    server: call.server,
    args: call.args,
  };
}

/**
 * The input of a confirmation question as the step needs it back (data-model/design-runtime.md, KD-3, Flow 2):
 * which call it is about and what was shown.
 */
const ConfirmationQuestionSchema = z.object({
  kind: z.string(),
  payload: z.object({ callId: z.string(), content: z.unknown() }).loose(),
});

/**
 * The answer `resolveConfirmation` gives the question; `args` — the employee's edit, if the tool allows one;
 * `allowInConversation` — the third answer «allow in this conversation» (improvements design-server.md Flow 2).
 */
export const ConfirmationResolutionSchema = z.object({
  approve: z.boolean(),
  args: z.unknown().optional(),
  allowInConversation: z.boolean().optional(),
  /** The employee's answers to an `agents.question` card; absent — he skipped it (agent-guidance KD-1). */
  answers: z.array(QuestionAnswerSchema).optional(),
});

/** The employee's decision on one call, read from the answered question. */
interface CallDecision {
  readonly callId: string;
  readonly approve: boolean;
  readonly args?: unknown;
  /** The approval also allows the call's pair in the conversation. */
  readonly allowInConversation: boolean;
  /** `content` of the question's input, handed to the tool (code-execution KD-10; deep-agents KD-3). */
  readonly confirmed?: unknown;
  /** The employee's answers to a question card, handed to the tool (agent-guidance KD-1). */
  readonly answers?: readonly QuestionAnswer[];
}

/**
 * The employee's decision the step delivers (Flow 2): the `child_finished` of an answered question among the
 * step's messages — the answer from its `result`, what was shown from the question's input. Ends of the
 * children in `closedChildren` are a `task` call's, never a question's. A stopped question carries no answer.
 */
async function answerOf(
  deps: Pick<AgentDeps, 'tasks'>,
  ctx: StepContext,
  closedChildren: ReadonlySet<string>,
): Promise<{ decision: CallDecision; questionId: string } | undefined> {
  for (const message of ctx.messages) {
    if (message.kind !== CHILD_FINISHED_KIND) continue;
    const notice = ChildFinishedPayloadSchema.parse(message.payload);
    if (notice.status !== 'completed' || closedChildren.has(notice.taskId))
      continue;
    const task = await deps.tasks.get(notice.taskId, agentOwner(ctx));
    if (!isQuestion(task)) continue;
    const { callId, content } = ConfirmationQuestionSchema.parse(
      task.input,
    ).payload;
    const resolution = ConfirmationResolutionSchema.parse(notice.result);
    return {
      questionId: notice.taskId,
      decision: {
        callId,
        approve: resolution.approve,
        allowInConversation: resolution.allowInConversation === true,
        ...(resolution.args === undefined ? {} : { args: resolution.args }),
        ...(content === undefined ? {} : { confirmed: content }),
        ...(resolution.answers === undefined
          ? {}
          : { answers: resolution.answers }),
      },
    };
  }
  return undefined;
}

/** The ruling on a call and the facts the step logs with it. */
interface RuledCall {
  readonly ruling: CallRuling;
  readonly scheduleId: string | null;
  readonly pair: ToolPair | null;
}

/** The server–tool pair of an MCP tool; `null` for every other tool, which no permission can name (KD-2). */
function pairOf(resolved: ResolvedCall): ToolPair | null {
  const { server, tool } = callTarget(resolved.tool);
  return server === null ? null : { server, tool };
}

/**
 * Reads the facts of the call rule now and asks it (improvements design-server.md KD-1, KD-2): the last message of
 * the root's history, straight from the table; with a schedule mark — that schedule's pairs, read by its id and the
 * caller's owner (none for a deleted or another's one); without one — the pairs allowed to the conversation.
 */
async function ruleOn(
  deps: Pick<AgentDeps, 'history' | 'scheduleRows' | 'sessionRows'>,
  resolved: ResolvedCall,
  cardKind: string,
): Promise<RuledCall> {
  const { caller } = resolved;
  const pair = pairOf(resolved);
  const scheduleId =
    (await deps.history.lastMessage(caller.rootId))?.content.schedule
      ?.scheduleId ?? null;
  const schedulePairs =
    scheduleId === null
      ? []
      : ((await deps.scheduleRows.findOwned(scheduleId, caller.ownerId))
          ?.schedule.allowedTools ?? []);
  const conversationPairs =
    scheduleId === null
      ? await deps.sessionRows.grantedTools(caller.rootId)
      : [];
  return {
    ruling: callRule({
      rootId: caller.rootId,
      pair,
      cardKind,
      scheduleId,
      schedulePairs,
      conversationPairs,
    }),
    scheduleId,
    pair,
  };
}

/** The call a step asks about and its question (`effects.ask`). */
interface AskedCall {
  readonly call: CallState;
  readonly question: Question;
}

/** How a call the runner ran ends in its `tool_result`. */
function endingOf(
  execution: ToolExecution,
  startedAt: Date,
  finishedAt: Date,
): CallEnding {
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
    ...(typeof execution.output === 'string'
      ? { output: execution.output }
      : {}),
    ...(execution.recorded === undefined
      ? {}
      : { recorded: execution.recorded }),
    ...(execution.childAgentId === undefined
      ? {}
      : { childTaskId: execution.childAgentId }),
    startedAt,
    finishedAt,
  };
}

/** Runs the closings in call order, each appending its `tool_result`, and returns the appended entries. */
async function closeAll(
  closings: readonly CallClosing[],
  effects: StepEffects,
): Promise<HistoryEntry[]> {
  const results: HistoryEntry[] = [];
  for (const closing of closings) {
    const closed = await closing(effects);
    if (closed !== undefined) results.push(closed);
  }
  return results;
}

/**
 * The commit of the step: the closings in call order, each with its `tool_result`, then the question of the
 * call the step asks about (`asked`: `effects.ask` and the call's `tool_confirmation` with the question's id) or
 * the start of the accepted delegated calls (`opening`), then the entries of the messages the step delivers
 * (KD-1: a message stands after the results of its answer), without the ends of the children whose `task` calls
 * this step closes and of the question it answers.
 */
function commitOf(
  deps: Pick<
    AgentDeps,
    'history' | 'sessions' | 'messageRows' | 'tasks' | 'signals'
  >,
  ctx: StepContext,
  closings: readonly CallClosing[],
  closedChildren: ReadonlySet<string>,
  asked?: AskedCall,
  opening?: (effects: StepEffects) => Promise<void>,
): NonNullable<StepResult['commit']> {
  return async (effects) => {
    await closeAll(closings, effects);
    await opening?.(effects);
    const questionId =
      asked === undefined ? undefined : await effects.ask(asked.question);
    await deps.history.append(ctx.taskId, [
      ...(asked === undefined || questionId === undefined
        ? []
        : [
            {
              kind: 'tool_confirmation' as const,
              content: { callId: asked.call.callId, questionId },
            },
          ]),
      ...(await entriesOf(deps, ctx, closedChildren)),
    ]);
    // A question in any agent of the tree opens a decision of the root conversation (live-feed KD-4).
    if (questionId !== undefined) await signalAttention(deps, ctx, 'decision');
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
 * - A sent delegated call is closed by the agent's next step, first, and never as `unknown`: from the
 *   `child_finished` of its subagents this step delivers, a subagent without one as still running
 *   (data-model/design-runtime.md, «Инструмент `task`»). Their `child_finished` become no `child_report`.
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
 *   then goes through the call rule (improvements design-server.md KD-1, KD-4): sent without a card under a
 *   schedule's or the conversation's grant, refused `unattended` in a schedule's run, or else it
 *   asks the employee (`effects.ask`, data-model KD-3) and ends the step with `wait`, the ready
 *   results committed and the call's `tool_confirmation` written, the rest waiting; the answer comes as the
 *   question's `child_finished` to the next step (Flow 2); a rejected one is
 *   `rejected`; a confirmed one is sent once through `sendConfirmed` (intent through `guard`), and the step ends
 *   after it so its result is committed before anything else runs; an `outside` call runs under the
 *   step's signal; an `in_commit` call runs in the commit, in a savepoint with its closing.
 * - A tool that throws unexpectedly ends its call `tool_error` with the error's text, the error logged whole,
 *   and the step goes on (data-model/design-runtime.md KD-6); a disabled owner and a broken rule of the
 *   runtime still end the step.
 * - The delegated calls the check lets through wait until every other call of the answer is closed, then are
 *   checked together (KD-4): a refusal is closed with its text; the accepted ones start their subagents as
 *   awaited children in the commit and the step ends with `wait`, which the runtime turns into waiting for them.
 * - The signal aborted around a call, or the intent fenced: `continue` without writes — the runtime
 *   rejects the result of a step that is no longer current.
 * - The gate refused the owner at a call's admission (KD-4): that call and the rest do not start; the
 *   calls that ran are closed and the agent fails with `owner_disabled`.
 */
export async function runToolStep(
  deps: AgentDeps,
  agent: Pick<
    BaseAgent,
    'caller' | 'declaration' | 'closeDelegated' | 'delegates' | 'delegate'
  >,
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
  // whose account went away gets `auth_required` (C3, DC-2). The set comes from the version (ADR-0017).
  const sessionTools = await registry.checkTools(agent.declaration);
  const argsOf = (call: CallState): unknown =>
    loggedArgsOf(sessionTools, (name) => registry.toolOf(name), {
      name: requestedName(call),
      args: call.args,
    });
  const closings: CallClosing[] = [];
  // Every sent delegated call closes in this step: its subagents' ends reach the model through its result.
  const closedChildren = new Set(
    openCalls.flatMap((call) => call.delegation?.taskIds ?? []),
  );
  const answered = await answerOf(deps, ctx, closedChildren);
  const decision = answered?.decision;
  // The answered question's end is read here, not reported to the model.
  if (answered !== undefined) closedChildren.add(answered.questionId);
  // The repeat rule's past (KD-5): the closed calls of the visible history, then each call of this step it lets through.
  const past: PastCall[] = calls.flatMap((earlier) =>
    earlier.result === null
      ? []
      : [{ ...pastCallOf(earlier), outcome: earlier.result.outcome }],
  );
  // The repeat mark of a call, by its id: appended to its result's text however it ends, never to `stored` (KD-1).
  const marks = new Map<string, string>();
  const marked = (call: CallState, ending: CallEnding): CallEnding => {
    const mark = marks.get(call.callId);
    if (mark === undefined) return ending;
    const text = ending.resultText ?? '';
    return { ...ending, resultText: text === '' ? mark : `${text}\n\n${mark}` };
  };
  const close =
    (call: CallState, ending: CallEnding): CallClosing =>
    () =>
      deps.callRecords.close(ctx.taskId, call, marked(call, ending));
  /**
   * Closes a call the runner ran and stores its full result in the same transaction: every successful and
   * empty direct MCP result, as before (code-execution KD-5); only a long one reached the model as the
   * wrapper (tool-result-reading R-1, R-4). A refusal, an error, a transport failure and a built-in tool
   * carry no `stored` and get no row (DC-8).
   */
  const closeExecuted = async (
    call: CallState,
    run: {
      readonly execution: ToolExecution;
      readonly startedAt: Date;
      readonly finishedAt: Date;
    },
    // The employee's decision on a confirmed call, written with the result unless the intent wrote it.
    decided?: CallDecision,
  ): Promise<HistoryEntry | undefined> => {
    const { execution } = run;
    const closed = await deps.callRecords.close(
      ctx.taskId,
      call,
      marked(call, endingOf(execution, run.startedAt, run.finishedAt)),
      decided === undefined
        ? undefined
        : {
            approved: decided.approve,
            ...(decided.args === undefined ? {} : { args: decided.args }),
          },
    );
    if (
      closed !== undefined &&
      execution.kind === 'done' &&
      execution.stored !== undefined
    ) {
      await deps.toolResultRows.insert({
        taskId: ctx.taskId,
        callId: call.callId,
        ...execution.stored,
      });
    }
    return closed;
  };
  /**
   * Runs an in-commit tool and closes its call in a savepoint of the commit (data-model KD-6): a tool that
   * throws rolls back only its own writes and what it did through the effects (`effects.savepoint`), and its
   * call is closed `tool_error` with the error's text. An error after which the transaction cannot go on is
   * thrown by the savepoint, so the commit repeats whole; a
   * `RuntimeError` and a disabled owner are thrown and still end the step; a broken rule of the effects is
   * kept by the runtime, which fails the commit with `invalid_step_result` after it.
   */
  const closeInCommit =
    (
      call: CallState,
      resolved: ResolvedCall,
      run: (effects: StepEffects) => Promise<ToolExecution | NotSent>,
      decided?: CallDecision,
    ): CallClosing =>
    async (effects) => {
      const startedAt = new Date();
      const attempt = await effects.savepoint(async () => {
        const execution = await run(effects);
        if (execution.kind === 'not_sent') return undefined;
        return closeExecuted(
          call,
          { execution, startedAt, finishedAt: new Date() },
          decided,
        );
      });
      if (attempt.ok) return attempt.value;
      const { error } = attempt;
      if (error instanceof RuntimeError || error instanceof OwnerDisabledError)
        throw error;
      return closeExecuted(
        call,
        {
          execution: runner.toolError(resolved, error, ctx.logger),
          startedAt,
          finishedAt: new Date(),
        },
        decided,
      );
    };
  const done = (): StepResult => {
    logStep(ctx, STEP_KIND, stepStartedAt, 'continue', {
      calls: closings.length,
    });
    return {
      outcome: 'continue',
      commit: commitOf(deps, ctx, closings, closedChildren),
    };
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
      writeEntries: async (effects) => {
        await closeAll(closings, effects);
        return entriesOf(deps, ctx, closedChildren);
      },
      patch: {},
    });

  // Sent delegated calls close in this step from the ends of their subagents it delivers, before the gate, like
  // the calls in `sending` below.
  const delegatedOpen = openCalls.filter(isDelegated);
  closings.push(...(await agent.closeDelegated(ctx, delegatedOpen)));

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
      reason: ctx.resumedAfterLoss
        ? 'resumed_after_loss'
        : 'sending_without_loss',
    });
    closings.push(
      close(call, { outcome: unknown, resultText: ANSWER_LOST_TEXT }),
    );
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
    const delegation = await agent.delegate({
      ctx,
      caller,
      calls: delegatedCalls,
      loggedArgs: argsOf,
    });
    for (const { call, ending } of delegation.refused)
      closings.push(close(call, ending));
    if (delegation.open === null) return done();
    logStep(ctx, STEP_KIND, stepStartedAt, 'wait', {
      calls: closings.length,
      delegations: delegation.accepted,
    });
    return {
      outcome: 'wait',
      commit: commitOf(
        deps,
        ctx,
        closings,
        closedChildren,
        undefined,
        delegation.open,
      ),
    };
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
      const refuse = (
        reason: ToolRefusalReason,
        text: string | undefined,
      ): void => {
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
        // Before any confirmation: a pair the owner may not use, or a switched-off tool, is never offered to the employee (Flow 2).
        if (isAccessRefusal(check.reason) && target.server !== null) {
          await audit(
            toolDeniedEntry(
              session.ownerId,
              { server: target.server, tool: target.tool },
              check.reason,
            ),
          );
        }
        refuse(check.reason, check.text);
        continue;
      }
      const resolved = check.call;

      // After the check and before any confirmation: a third same call is never offered to the employee (KD-5).
      const repeat = repeatOf({ call, past });
      if (repeat.kind === 'refuse') {
        if (target.server !== null) {
          await audit(
            toolRefusedEntry(
              session.ownerId,
              target.server,
              target.tool,
              repeatedCall,
            ),
          );
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

      // A training tree asks nobody (KD-3, place 1): its MCP call goes the usual way, a changing one ends `recorded`.
      if (
        runner.needsConfirmation(resolved) &&
        !(caller.training && isMcp(resolved.tool))
      ) {
        const callDecision =
          decision?.callId === call.callId ? decision : undefined;
        const startedAt = new Date();
        let send: ConfirmedSend;
        if (callDecision === undefined) {
          if (call.state === awaitingConfirmation) {
            throw new Error(
              `Call ${call.callId} of agent ${ctx.taskId} awaits confirmation, but the step got no decision for it`,
            );
          }
          const card = await runner.confirmationRequest(
            resolved,
            session,
            sessionTools,
          );
          if (card.kind === 'refused') {
            // The tool's check before the card refused it (deep-agents KD-3): no request, the model reads why.
            refuse(card.reason, card.text);
            continue;
          }
          const { request } = card;
          if (caller.training) {
            // The card's content is the decision, written by no one; the intent goes alone (KD-3, place 1).
            ctx.logger.info('confirmation skipped in training tree', {
              callId: call.callId,
              tool: call.tool,
              server: call.server,
              rootId: caller.rootId,
            });
            send = await runner.sendUnasked(
              resolved,
              ctx,
              request.payload.content,
            );
          } else {
            // After the rights, the arguments and the repeat rule, and after the card's own check (KD-4).
            const { ruling, scheduleId, pair } = await ruleOn(
              deps,
              resolved,
              request.kind,
            );
            const ruled = {
              callId: call.callId,
              agentId: ctx.taskId,
              rootId: caller.rootId,
              scheduleId,
              server: pair?.server ?? null,
              tool: call.tool,
            };
            if (ruling.kind === 'refuse') {
              ctx.logger.info('tool call refused: nobody to confirm it', {
                ...ruled,
                reason: ruling.reason,
              });
              refuse(ruling.reason, ruling.text);
              continue;
            }
            if (ruling.kind === 'send') {
              // The card's content is the decision, as in a training tree; the decision carries the grant (KD-3).
              ctx.logger.info('tool call sent by a permission without a card', {
                ...ruled,
                grant: ruling.grant.kind,
              });
              send = await runner.sendUnasked(
                resolved,
                ctx,
                request.payload.content,
                ruling.grant,
              );
            } else {
              ctx.logger.info('tool call awaits confirmation', {
                callId: call.callId,
                tool: call.tool,
                server: call.server,
                args: argsOf(call),
                outcome: null,
                reason: 'awaiting_confirmation',
              });
              logStep(ctx, STEP_KIND, stepStartedAt, 'wait', {
                calls: closings.length,
                asked: call.callId,
              });
              return {
                outcome: 'wait',
                commit: commitOf(deps, ctx, closings, closedChildren, {
                  call,
                  question: { kind: request.kind, payload: request.payload },
                }),
              };
            }
          }
        } else if (!callDecision.approve) {
          ctx.logger.info('tool call rejected by the employee', {
            callId: call.callId,
            tool: call.tool,
            server: call.server,
            args: argsOf(call),
            outcome: rejected,
            reason: 'rejected',
            durationMs: 0,
          });
          closings.push(() =>
            deps.callRecords.close(
              ctx.taskId,
              call,
              marked(call, { outcome: rejected }),
              {
                approved: false,
              },
            ),
          );
          continue;
        } else {
          // «Allow in this conversation» joins the pair to the conversation's permission with the intent (Flow 2);
          // a call without a pair has nothing to allow.
          const pair = pairOf(resolved);
          send = await runner.sendConfirmed(resolved, ctx, {
            editedArgs: callDecision.args,
            confirmed: callDecision.confirmed,
            ...(callDecision.answers === undefined
              ? {}
              : { answers: callDecision.answers }),
            ...(callDecision.allowInConversation && pair !== null
              ? {
                  grant: {
                    kind: 'conversation',
                    rootId: caller.rootId,
                    pair,
                  },
                }
              : {}),
          });
        }
        if (send.kind === 'not_sent') {
          if (send.reason === 'fenced') return abandon('intent fenced');
          // The call is no longer awaiting: nothing is sent; what is ready is committed.
          return done();
        }
        if (send.kind === 'in_commit') {
          closings.push(
            closeInCommit(call, resolved, send.commit, callDecision),
          );
          return done();
        }
        const { execution } = send;
        if (execution.kind === 'aborted')
          return abandon('signal aborted during the confirmed call');
        const finishedAt = new Date();
        closings.push(() =>
          closeExecuted(
            call,
            { execution, startedAt, finishedAt },
            callDecision,
          ),
        );
        // The confirmed result is committed before anything else of the answer runs (KD-1).
        return done();
      }

      if (isInCommit(resolved)) {
        const run = await runner.planInCommit(resolved, ctx.logger);
        closings.push(closeInCommit(call, resolved, run));
        continue;
      }

      const startedAt = new Date();
      const execution = await runner.runOutside(resolved, ctx);
      if (execution.kind === 'aborted')
        return abandon('signal aborted during the call');
      const finishedAt = new Date();
      closings.push(() =>
        closeExecuted(call, { execution, startedAt, finishedAt }),
      );
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
