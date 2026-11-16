import type { Logger } from '@agent-os/common';
import {
  AGENTS_TOOL_CONFIRMATION,
  RUN_CODE_TOOL,
  type RunCodeArgs,
  type ToolOutcome,
  type ToolRefusalReason,
} from '@agent-os/contracts';
import type { RuntimeTx, StepContext, StepEffects } from '@agent-os/runtime';
import { z } from 'zod';

import {
  type AccessAudit,
  type AccessDeniedEntry,
  type AccessGate,
  OwnerDisabledError,
  type ToolAccess,
} from '../access-gate.js';
import type { McpAccounts } from '../mcp/mcp-accounts.js';
import type { McpCallResponse, McpClient } from '../mcp/mcp-client.js';
import type { McpFailureReason } from '../mcp/mcp-failure.js';
import { type McpOutcome, scriptValueOf, toOutcome } from '../mcp/mcp-outcome.js';
import type { Session } from '../store/sessions.repository.js';
import { toolCalls } from '../store/tool-calls.repository.js';
import type { InCommitAgentTool, StartChild, ToolCaller } from './tool.js';
import { callTarget, callTargetOf, type SessionTool } from './tool-registry.js';

/** One tool call of a model answer, as the model wrote it. */
export interface RequestedCall {
  readonly callId: string;
  /** The name the model called. */
  readonly toolName: string;
  readonly args: unknown;
}

/** A call that passed `check`: its session tool, its parsed arguments and the calling agent. */
export interface ResolvedCall {
  readonly callId: string;
  readonly tool: SessionTool;
  readonly args: unknown;
  readonly caller: ToolCaller;
}

/** A call of a tool that runs in the commit transaction of the step. */
export type InCommitCall = ResolvedCall & {
  readonly tool: { readonly kind: 'agent'; readonly tool: InCommitAgentTool<unknown> };
};

export function isInCommit(call: ResolvedCall): call is InCommitCall {
  return call.tool.kind === 'agent' && call.tool.tool.mode === 'in_commit';
}

export type CallCheck =
  | { readonly kind: 'allowed'; readonly call: ResolvedCall }
  | { readonly kind: 'refused'; readonly reason: ToolRefusalReason };

/** Whether the owner may call this tool of this server: the answer of `AccessGate.tools` for him. */
export type PairAllowed = Extract<ToolAccess, { readonly kind: 'allowed' }>['allows'];

/** A call refused because the gate does not allow its server–tool pair. */
export interface NoAccess {
  readonly kind: 'refused';
  readonly reason: 'no_access';
}

/** The `access_denied` record of a tool call refused `no_access` (KD-6): one per refusal. */
export function toolDeniedEntry(ownerId: string, server: string, tool: string): AccessDeniedEntry {
  return {
    kind: 'access_denied',
    actor: ownerId,
    objectType: 'tool',
    objectId: `${server}/${tool}`,
    outcome: 'rejected',
    reason: 'no_access',
  };
}

/** How a tool call the runner ran ended; a refusal reached no external system. */
export type ToolExecution =
  | {
      readonly kind: 'done';
      readonly outcome: McpOutcome;
      readonly text: string;
      /** Why an MCP call got no answer; only with `transport_failure`. */
      readonly failureReason?: McpFailureReason;
      /** Script output of a `run_code` run: text of a successful run, `null` of a failed one. */
      readonly output?: string | null;
      /**
       * The full result of a direct MCP call with `success` or `empty`, as a script reads it; the step's
       * commit stores it with the closing (code-execution KD-5, DC-8).
       */
      readonly fullResult?: { readonly value: unknown };
      /** The child a `start_agent`-like call started. */
      readonly childAgentId?: string;
    }
  | { readonly kind: 'refused'; readonly reason: ToolRefusalReason };

/**
 * The step's signal was aborted around an outside call: the step's result is rejected by the runtime,
 * so the step writes nothing (T4.1).
 */
export interface AbortedExecution {
  readonly kind: 'aborted';
}

/** A confirmed call that was not sent: the intent was fenced, or the call was no longer awaiting. */
export interface NotSent {
  readonly kind: 'not_sent';
  readonly reason: 'fenced' | 'not_awaiting';
}

/** What `planInCommit` gives the step: run inside `commit(tx, effects)`. */
export type InCommitPlan = (tx: RuntimeTx, effects: StepEffects) => Promise<ToolExecution>;

export type ConfirmedSend =
  | { readonly kind: 'sent'; readonly execution: ToolExecution | AbortedExecution }
  | NotSent
  /** An in-commit tool: the intent and the call happen in the step's commit transaction. */
  | {
      readonly kind: 'in_commit';
      readonly commit: (tx: RuntimeTx, effects: StepEffects) => Promise<ToolExecution | NotSent>;
    };

/** The decision request of a tool with confirmation (design-agents.md, «Сообщения и события»). */
export interface ConfirmationRequest {
  readonly kind: string;
  readonly payload: {
    readonly agentId: string;
    readonly description: string;
    readonly callId: string;
    readonly tool: string;
    readonly server: string | null;
    readonly args: unknown;
    readonly content: unknown;
  };
}

/** What the spawn helper of one in-commit call is bound to. */
export interface StartChildScope {
  readonly tx: RuntimeTx;
  readonly effects: StepEffects;
  readonly caller: ToolCaller;
}

export interface ToolRunnerOptions {
  /** Sends a call to its server with the credentials of the call (KD-3). */
  readonly client: Pick<McpClient, 'callTool'>;
  /** The credentials of the caller's owner, read just before the call (KD-5). */
  readonly accounts: Pick<McpAccounts, 'credentialsFor'>;
  /**
   * Asked before every call the runner starts — direct, in-commit, confirmed and from code (design-access.md
   * KD-1, KD-4): a disabled owner rejects the runner's method with `OwnerDisabledError` and the call does not
   * start; an MCP pair it does not allow is refused `no_access` before any credentials are read.
   */
  readonly access: Pick<AccessGate, 'tools'>;
  /** Gets the `access_denied` record of each `no_access` the runner decides (KD-6). */
  readonly audit: AccessAudit;
  /** `MCP_CALL_TIMEOUT_MS`: bounds one call, the handshake included. */
  readonly callTimeoutMs: number;
  /** `AGENT_TOOL_RESULT_MAX_BYTES`. */
  readonly toolResultMaxBytes: number;
  /** Binds `createStartChild` (T3.4) to the commit transaction and the caller; `createAgents` supplies it. */
  readonly startChildFor: (scope: StartChildScope) => StartChild;
}

/** A script's request to call a tool: the name from the model's tool list and the arguments. */
export interface CodeCallRequest {
  readonly name: string;
  readonly args: unknown;
}

/** What a call from code is checked against (code-execution KD-2, KD-8, KD-10). */
export interface CodeCallScope {
  /** The calling agent of the run; the call goes out on behalf of its owner. */
  readonly caller: ToolCaller;
  /** `definitionMcpTools` of the agent's definition, taken when the run started. */
  readonly snapshot: readonly SessionTool[];
  readonly runClass: RunCodeArgs['class'];
  /** The names of the confirmed «Может вызвать» list; a `write` run always has it. */
  readonly confirmedNames?: readonly string[];
  /** Names of the built-in and registered tools (`ToolRegistry.toolNames`): a script never calls them (DC-5). */
  readonly agentToolNames: readonly string[];
  /** `callId` of the `run_code` call: the run the request belongs to. */
  readonly callId: string;
  readonly signal: AbortSignal;
  readonly logger: Logger;
}

/** A refused call from code: the text names the tool, the reason and the run class. */
export interface CodeCallRefusal {
  readonly kind: 'refused';
  readonly reason: ToolRefusalReason;
  readonly text: string;
}

/**
 * How a call from code ended: a refusal, the step's signal, or the MCP outcome; `fullResult` holds the
 * whole value of `success`/`empty`; a `tool_error` or `transport_failure` has an empty text (the
 * server's text is only in the run log).
 */
export type CodeCallExecution =
  | Extract<ToolExecution, { kind: 'done' }>
  | CodeCallRefusal
  | AbortedExecution;

/** The step context the runner needs for an outside call; the tool gets it in its input. */
export type OutsideContext = Pick<StepContext, 'signal' | 'logger' | 'guard'>;

/** The step context of a confirmed call: the intent goes through `guard`. */
export type ConfirmContext = Pick<StepContext, 'taskId' | 'signal' | 'logger' | 'guard'>;

export interface ToolRunner {
  /**
   * Checks a call (C3; Flow 1, Failure handling; DC-6): the tool is in the session's check set
   * (`ToolRegistry.checkTools`: a disabled, removed or unnamed server's tool is not), the owner may
   * use its server–tool pair — `allows`, the gate's answer for this step — and the arguments of a built-in
   * or registered tool fit its schema. A refused call never reaches the server; allowed arguments are the
   * parsed ones. A `no_access` decided here is audited by the caller of `check`.
   */
  check(
    requested: RequestedCall,
    scope: {
      readonly sessionTools: readonly SessionTool[];
      readonly caller: ToolCaller;
      readonly allows: PairAllowed;
    },
  ): CallCheck;
  /**
   * A changing MCP tool (not `readOnlyHint`), or a tool with `confirmation` whose `required(args)` is
   * true or not set (KD-4; code-execution KD-4).
   */
  needsConfirmation(call: ResolvedCall): boolean;
  /**
   * The `await_decision` request of the call; `agents.tool_confirmation` for an MCP tool. `tools` — the
   * session's tool set, passed to the tool's `content` (code-execution KD-10).
   */
  confirmationRequest(
    call: ResolvedCall,
    session: Pick<Session, 'description'>,
    tools: readonly SessionTool[],
  ): ConfirmationRequest;
  /** Runs an MCP tool or an `outside` tool, outside any transaction, under the step's signal. */
  runOutside(call: ResolvedCall, ctx: OutsideContext): Promise<ToolExecution | AbortedExecution>;
  /**
   * Checks and runs a script's call (code-execution «Проверка вызова из кода»; KD-2, KD-8, DC-5, DC-6):
   * a built-in or registered tool or `run_code` — `not_callable_from_code`; a `write` run and a name
   * outside the confirmed list — `not_in_confirmed_script`; then `check` against the snapshot; a `read`
   * run and a tool without `McpTool.readOnly` — `changing_in_read_run`. `check` gets the gate's answer asked
   * for this call: a disabled owner rejects, a pair it does not allow is `no_access` with one audit record.
   * An allowed call goes to its server on behalf of the caller's owner; a value is not cut, a server's error
   * text is not returned.
   */
  callFromCode(request: CodeCallRequest, scope: CodeCallScope): Promise<CodeCallExecution>;
  /** The closure an `in_commit` tool runs in `commit(tx, effects)`, with the spawn helper; the gate is asked first. */
  planInCommit(call: InCommitCall, logger: Logger): Promise<InCommitPlan>;
  /**
   * Sends a confirmed call once (Flow 5): first the intent `sending` through `ctx.guard`; `fenced`, or a
   * call no longer awaiting confirmation, is not sent (Invariant 2). `editedArgs` are the arguments the
   * employee edited; they replace the call's. `confirmed` — `content` of the resolved request, given to
   * an `outside` tool in its input (code-execution KD-10).
   */
  sendConfirmed(
    call: ResolvedCall,
    ctx: ConfirmContext,
    editedArgs?: unknown,
    confirmed?: unknown,
  ): Promise<ConfirmedSend>;
}

/** An MCP server checks its own arguments; the runner only needs an object to send. */
const MCP_ARGS_SCHEMA = z.record(z.string(), z.unknown());

/** The calling agent of a step. */
export function callerOf(ctx: StepContext): ToolCaller {
  return {
    agentId: ctx.taskId,
    ownerId: ctx.ownerId,
    rootId: ctx.rootId,
    parentId: ctx.parentId,
    depth: ctx.depth,
  };
}

/**
 * The text of a refused call from code: it names the tool, the reason and the run class
 * (code-execution «Error handling», AC-05.5, AC-03.7).
 */
function codeRefusalText(
  tool: string,
  reason: ToolRefusalReason,
  runClass: RunCodeArgs['class'],
): string {
  const run = `запуск ${runClass}`;
  switch (reason) {
    case 'not_in_confirmed_script':
      return `${tool}: инструмента нет в подтверждённом коде (${reason}, ${run})`;
    case 'changing_in_read_run':
      return `${tool}: инструмент не помечен читающим, а ${run} только читает (${reason})`;
    default:
      return `${tool}: отказ ${reason} (${run})`;
  }
}

/** What a log record of a call names: its id, tool, server and arguments. */
interface LoggedCall {
  readonly callId: string;
  readonly tool: string;
  readonly server: string | null;
  readonly args: unknown;
}

function loggedCall(call: ResolvedCall): LoggedCall {
  return { callId: call.callId, ...callTarget(call.tool), args: call.args };
}

/** Logs one tool call the runner ran (rule 9 of the plan): ids, tool, server, arguments, outcome, reason, duration. */
function logCall(
  logger: Logger,
  call: LoggedCall,
  execution: ToolExecution | AbortedExecution | NotSent | CodeCallRefusal,
  startedAt: number,
): void {
  const fields = { ...call, durationMs: Date.now() - startedAt };
  switch (execution.kind) {
    case 'done':
      logger.info('tool call finished', {
        ...fields,
        outcome: execution.outcome,
        reason: execution.failureReason ?? null,
      });
      return;
    case 'refused':
      logger.info('tool call finished', { ...fields, outcome: 'refused', reason: execution.reason });
      return;
    case 'aborted':
      logger.info('tool call aborted by the step signal', { ...fields, outcome: null, reason: 'aborted' });
      return;
    case 'not_sent':
      logger.warn('confirmed tool call not sent', { ...fields, outcome: null, reason: execution.reason });
      return;
  }
}

/** Outcomes whose text comes from the server; `auth_required` carries the platform's own text. */
const HIDDEN_TEXT_OUTCOMES: ReadonlySet<ToolOutcome> = new Set(['tool_error', 'transport_failure']);

/**
 * A call from code the server did not answer with a value: the script gets the outcome and reason
 * only, never the server's text, which may carry a secret; the full response goes to the run log as
 * one warning, where the logger masks the known secrets.
 */
function withoutServerText(
  execution: CodeCallExecution,
  call: LoggedCall,
  logger: Logger,
): CodeCallExecution {
  if (execution.kind !== 'done' || !HIDDEN_TEXT_OUTCOMES.has(execution.outcome)) {
    return execution;
  }
  logger.warn('tool call from code failed; its response is hidden from the script', {
    callId: call.callId,
    tool: call.tool,
    server: call.server,
    outcome: execution.outcome,
    reason: execution.failureReason ?? null,
    response: execution.text,
  });
  return { ...execution, text: '' };
}

/** The tool runner of the step (C3 `ToolRunner`; KD-4, KD-5, Flow 5). */
export function createToolRunner(options: ToolRunnerOptions): ToolRunner {
  const { client, accounts, access, audit, callTimeoutMs, toolResultMaxBytes } = options;

  /**
   * The gate's answer for the caller's owner, asked right before a call starts: a disabled owner is logged
   * and thrown as `OwnerDisabledError`, so the call does not start.
   */
  async function pairsOf(callId: string, caller: ToolCaller, logger: Logger): Promise<PairAllowed> {
    const answer = await access.tools(caller.ownerId);
    if (answer.kind === 'allowed') return answer.allows;
    logger.warn('access gate refused a tool call', {
      ownerId: caller.ownerId,
      agentId: caller.agentId,
      callId,
      reason: 'owner_disabled',
    });
    throw new OwnerDisabledError(caller.ownerId);
  }

  /** The one audit record of a `no_access` the runner decided, and its log line. */
  async function refuseNoAccess(
    call: { readonly callId: string; readonly caller: ToolCaller },
    target: { readonly server: string; readonly tool: string },
    logger: Logger,
  ): Promise<NoAccess> {
    logger.warn('access gate refused a tool pair', {
      ownerId: call.caller.ownerId,
      agentId: call.caller.agentId,
      callId: call.callId,
      server: target.server,
      tool: target.tool,
      reason: 'no_access',
    });
    await audit(toolDeniedEntry(call.caller.ownerId, target.server, target.tool));
    return { kind: 'refused', reason: 'no_access' };
  }

  /**
   * The admission point every execution path goes through right before it starts (design-access.md KD-1):
   * the owner is on, and an MCP pair is still allowed — a right taken away after the set was built or while
   * a confirmation waited is `no_access`, with no token read and no request sent. A built-in tool asks only
   * whether the owner is on.
   */
  async function admit(call: ResolvedCall, logger: Logger): Promise<NoAccess | undefined> {
    const allows = await pairsOf(call.callId, call.caller, logger);
    if (call.tool.kind !== 'mcp' || allows(call.tool.mcp.server, call.tool.mcp.tool)) return undefined;
    return refuseNoAccess(call, call.tool.mcp, logger);
  }

  /**
   * Sends one MCP call with the owner's credentials (KD-5): without an account the call is `auth_required`
   * and reaches no server (DC-3); an `oauth` call that ends `auth_required` loses the account it used. A
   * server removed or switched off after the call check is `server_gone`, and nothing is sent (DC-2).
   */
  async function sendMcp(request: {
    readonly server: string;
    readonly tool: string;
    readonly args: Readonly<Record<string, unknown>>;
    readonly ownerId: string;
    readonly signal: AbortSignal;
  }): Promise<McpCallResponse | { readonly kind: 'server_gone' }> {
    const credentials = await accounts.credentialsFor(request.server, request.ownerId, 'call');
    if (credentials.kind !== 'ready') return credentials;
    const response = await client.callTool({
      url: credentials.url,
      auth: credentials.auth,
      timeoutMs: callTimeoutMs,
      signal: request.signal,
      request: { name: request.tool, arguments: request.args },
    });
    if (response.kind === 'auth_required') await credentials.rejected();
    return response;
  }

  async function callMcp(
    call: ResolvedCall & { readonly tool: Extract<SessionTool, { kind: 'mcp' }> },
    signal: AbortSignal,
    maxBytes: number,
  ): Promise<ToolExecution | AbortedExecution> {
    if (signal.aborted) return { kind: 'aborted' };
    const args = MCP_ARGS_SCHEMA.parse(call.args);
    const { server, tool } = call.tool.mcp;
    try {
      const response = await sendMcp({ server, tool, args, ownerId: call.caller.ownerId, signal });
      if (signal.aborted) return { kind: 'aborted' };
      if (response.kind === 'server_gone') return { kind: 'refused', reason: 'tool_not_in_definition' };
      const result = toOutcome(response, maxBytes, { callId: call.callId, server });
      const hasValue =
        response.kind === 'result' && (result.outcome === 'success' || result.outcome === 'empty');
      return {
        kind: 'done',
        outcome: result.outcome,
        text: result.text,
        ...(result.reason === undefined ? {} : { failureReason: result.reason }),
        ...(hasValue ? { fullResult: { value: scriptValueOf(response.result) } } : {}),
      };
    } catch (error) {
      if (signal.aborted) return { kind: 'aborted' };
      throw error;
    }
  }

  async function execute(
    call: ResolvedCall,
    ctx: OutsideContext,
    confirmed?: unknown,
  ): Promise<ToolExecution | AbortedExecution> {
    const { tool } = call;
    if (tool.kind === 'mcp') return callMcp({ ...call, tool }, ctx.signal, toolResultMaxBytes);
    if (tool.tool.mode !== 'outside') {
      throw new Error(`Tool ${tool.name} runs in the commit transaction, not outside it`);
    }
    if (ctx.signal.aborted) return { kind: 'aborted' };
    const result = await tool.tool.execute({
      args: call.args,
      caller: call.caller,
      callId: call.callId,
      signal: ctx.signal,
      logger: ctx.logger,
      guard: (work) => ctx.guard(work),
      ...(confirmed === undefined ? {} : { confirmed }),
    });
    return ctx.signal.aborted ? { kind: 'aborted' } : result;
  }

  function runInCommit(call: InCommitCall, tx: RuntimeTx, effects: StepEffects): Promise<ToolExecution> {
    return call.tool.tool.execute({
      callId: call.callId,
      args: call.args,
      caller: call.caller,
      tx,
      effects,
      startChild: options.startChildFor({ tx, effects, caller: call.caller }),
    });
  }

  const check: ToolRunner['check'] = (requested, { sessionTools, caller, allows }) => {
    const tool = sessionTools.find((candidate) => candidate.name === requested.toolName);
    if (tool === undefined) return { kind: 'refused', reason: 'tool_not_in_definition' };
    if (tool.kind === 'mcp' && !allows(tool.mcp.server, tool.mcp.tool)) {
      return { kind: 'refused', reason: 'no_access' };
    }
    const schema = tool.kind === 'agent' ? tool.inputSchema : MCP_ARGS_SCHEMA;
    const parsed = schema.safeParse(requested.args);
    return parsed.success
      ? { kind: 'allowed', call: { callId: requested.callId, tool, args: parsed.data, caller } }
      : { kind: 'refused', reason: 'invalid_arguments' };
  };

  /** The filters of «Проверка вызова из кода» in their order, then the MCP call itself. */
  async function checkAndCallFromCode(
    request: CodeCallRequest,
    scope: CodeCallScope,
  ): Promise<CodeCallExecution> {
    const { name } = request;
    const refuse = (reason: ToolRefusalReason): CodeCallRefusal => ({
      kind: 'refused',
      reason,
      text: codeRefusalText(name, reason, scope.runClass),
    });
    if (name === RUN_CODE_TOOL || scope.agentToolNames.includes(name)) {
      return refuse('not_callable_from_code');
    }
    if (scope.runClass === 'write' && !(scope.confirmedNames ?? []).includes(name)) {
      return refuse('not_in_confirmed_script');
    }
    // One answer of the gate for this call: `check` decides with it, and nothing is asked again before the send.
    const allows = await pairsOf(scope.callId, scope.caller, scope.logger);
    const checked = check(
      { callId: scope.callId, toolName: name, args: request.args },
      { sessionTools: scope.snapshot, caller: scope.caller, allows },
    );
    if (checked.kind === 'refused') {
      const { server, tool } = callTargetOf(scope.snapshot, name);
      if (checked.reason === 'no_access' && server !== null) {
        await refuseNoAccess(scope, { server, tool }, scope.logger);
      }
      return refuse(checked.reason);
    }
    const { call } = checked;
    if (call.tool.kind !== 'mcp') {
      // The snapshot holds MCP tools only; an agent tool here is a wrong snapshot, not a script's error.
      throw new Error(`Tool ${name} of a run's snapshot is not an MCP tool`);
    }
    if (scope.runClass === 'read' && !call.tool.mcp.readOnly) {
      return refuse('changing_in_read_run');
    }
    const execution = await callMcp({ ...call, tool: call.tool }, scope.signal, Number.POSITIVE_INFINITY);
    return execution.kind === 'refused' ? refuse(execution.reason) : execution;
  }

  return {
    check,

    needsConfirmation(call) {
      if (call.tool.kind === 'mcp') return !call.tool.mcp.readOnly;
      const { confirmation } = call.tool.tool;
      if (confirmation === undefined) return false;
      return confirmation.required === undefined || confirmation.required(call.args);
    },

    confirmationRequest(call, session, tools) {
      const { tool, server } = callTarget(call.tool);
      const confirmation = call.tool.kind === 'agent' ? call.tool.tool.confirmation : undefined;
      return {
        kind: confirmation?.kind ?? AGENTS_TOOL_CONFIRMATION,
        payload: {
          agentId: call.caller.agentId,
          description: session.description,
          callId: call.callId,
          tool,
          server,
          args: call.args,
          content:
            confirmation === undefined
              ? { toolDescription: call.tool.description }
              : confirmation.content(call.args, tools),
        },
      };
    },

    async runOutside(call, ctx) {
      const startedAt = Date.now();
      const execution = (await admit(call, ctx.logger)) ?? (await execute(call, ctx));
      logCall(ctx.logger, loggedCall(call), execution, startedAt);
      return execution;
    },

    async callFromCode(request, scope) {
      const startedAt = Date.now();
      const logged: LoggedCall = {
        callId: scope.callId,
        ...callTargetOf(scope.snapshot, request.name),
        args: request.args,
      };
      const execution = await checkAndCallFromCode(request, scope);
      logCall(scope.logger, logged, execution, startedAt);
      return withoutServerText(execution, logged, scope.logger);
    },

    async planInCommit(call, logger) {
      const refusal = await admit(call, logger);
      return async (tx, effects) => {
        const startedAt = Date.now();
        const execution = refusal ?? (await runInCommit(call, tx, effects));
        logCall(logger, loggedCall(call), execution, startedAt);
        return execution;
      };
    },

    async sendConfirmed(call, ctx, editedArgs, confirmed) {
      const sent: ResolvedCall = editedArgs === undefined ? call : { ...call, args: editedArgs };
      const refusal = await admit(call, ctx.logger);
      if (refusal !== undefined) {
        // The right went away while the confirmation waited: no intent and no request (INT-1 steps 5–6).
        logCall(ctx.logger, loggedCall(sent), refusal, Date.now());
        return { kind: 'sent', execution: refusal };
      }
      const key = {
        taskId: ctx.taskId,
        callId: call.callId,
        ...(editedArgs === undefined ? {} : { args: editedArgs }),
      };
      if (isInCommit(call)) {
        return {
          kind: 'in_commit',
          commit: async (tx, effects) => {
            const startedAt = Date.now();
            const intent = await toolCalls.markSending(tx, key);
            const execution: ToolExecution | NotSent =
              intent === undefined
                ? { kind: 'not_sent', reason: 'not_awaiting' }
                : await runInCommit({ ...call, args: sent.args }, tx, effects);
            logCall(ctx.logger, loggedCall(sent), execution, startedAt);
            return execution;
          },
        };
      }
      const startedAt = Date.now();
      const intent = await ctx.guard((tx) => toolCalls.markSending(tx, key));
      if (intent.outcome === 'fenced' || intent.value === undefined) {
        const notSent: NotSent = {
          kind: 'not_sent',
          reason: intent.outcome === 'fenced' ? 'fenced' : 'not_awaiting',
        };
        logCall(ctx.logger, loggedCall(sent), notSent, startedAt);
        return notSent;
      }
      const execution = await execute(sent, ctx, confirmed);
      logCall(ctx.logger, loggedCall(sent), execution, startedAt);
      return { kind: 'sent', execution };
    },
  };
}
