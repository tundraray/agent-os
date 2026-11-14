import type { Logger } from '@agent-os/common';
import {
  AGENTS_TOOL_CONFIRMATION,
  type ToolOutcome,
  type ToolRefusalReason,
} from '@agent-os/contracts';
import type { RuntimeTx, StepContext, StepEffects } from '@agent-os/runtime';
import { z } from 'zod';

import type { McpAccessTable } from '../config.js';
import type { McpClients } from '../mcp/mcp-clients.js';
import type { McpFailureReason } from '../mcp/mcp-failure.js';
import { toOutcome } from '../mcp/mcp-outcome.js';
import type { Session } from '../store/sessions.repository.js';
import { toolCalls } from '../store/tool-calls.repository.js';
import type { StartChild, ToolCaller, ToolRunResult } from './tool.js';
import { serverAllowed } from './tool-access.js';
import { gateCall } from './tool-gate.js';
import { callTarget, type SessionTool } from './tool-registry.js';

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

export type CallCheck =
  | { readonly kind: 'allowed'; readonly call: ResolvedCall }
  | { readonly kind: 'refused'; readonly reason: ToolRefusalReason };

/** How a tool call the runner ran ended; a refusal reached no external system. */
export type ToolExecution =
  | {
      readonly kind: 'done';
      readonly outcome: Extract<ToolOutcome, 'success' | 'empty' | 'tool_error' | 'transport_failure'>;
      readonly text: string;
      /** Why an MCP call got no answer; only with `transport_failure`. */
      readonly failureReason?: McpFailureReason;
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
  readonly mcpClients: McpClients;
  /** `MCP_ACCESS_TABLE`: the same check `sessionTools` filters with (KD-5). */
  readonly access: McpAccessTable;
  /** `AGENT_TOOL_RESULT_MAX_BYTES`. */
  readonly toolResultMaxBytes: number;
  /** Binds `createStartChild` (T3.4) to the commit transaction and the caller; `createAgents` supplies it. */
  readonly startChildFor: (scope: StartChildScope) => StartChild;
}

/** The step context the runner needs for an outside call. */
export type OutsideContext = Pick<StepContext, 'signal' | 'logger'>;

/** The step context of a confirmed call: the intent goes through `guard`. */
export type ConfirmContext = Pick<StepContext, 'taskId' | 'signal' | 'logger' | 'guard'>;

export interface ToolRunner {
  /**
   * Checks a call (C3): the tool is in the session's set, the owner may use its server — `serverAllowed`,
   * as when the set was built — and the arguments of a built-in or registered tool fit its schema.
   */
  check(
    requested: RequestedCall,
    scope: { readonly sessionTools: readonly SessionTool[]; readonly caller: ToolCaller },
  ): CallCheck;
  /** A changing MCP tool (not `readOnlyHint`) or a tool that declares `confirmation` (KD-4). */
  needsConfirmation(call: ResolvedCall): boolean;
  /** The `await_decision` request of the call; `agents.tool_confirmation` for an MCP tool. */
  confirmationRequest(call: ResolvedCall, session: Pick<Session, 'description'>): ConfirmationRequest;
  /** Runs an MCP tool or an `outside` tool, outside any transaction, under the step's signal. */
  runOutside(call: ResolvedCall, ctx: OutsideContext): Promise<ToolExecution | AbortedExecution>;
  /** The closure an `in_commit` tool runs in `commit(tx, effects)`, with the spawn helper. */
  planInCommit(call: ResolvedCall, logger: Logger): InCommitPlan;
  /**
   * Sends a confirmed call once (Flow 5): first the intent `sending` through `ctx.guard`; `fenced`, or a
   * call no longer awaiting confirmation, is not sent (Invariant 2). `editedArgs` are the arguments the
   * employee edited; they replace the call's.
   */
  sendConfirmed(call: ResolvedCall, ctx: ConfirmContext, editedArgs?: unknown): Promise<ConfirmedSend>;
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

function fromRunResult(result: ToolRunResult): ToolExecution {
  return result.kind === 'refused'
    ? result
    : {
        kind: 'done',
        outcome: result.outcome,
        text: result.text,
        ...(result.childAgentId === undefined ? {} : { childAgentId: result.childAgentId }),
      };
}

/** Logs one tool call the runner ran (rule 9 of the plan): ids, tool, server, arguments, outcome, reason, duration. */
function logCall(
  logger: Logger,
  call: ResolvedCall,
  execution: ToolExecution | AbortedExecution | NotSent,
  startedAt: number,
): void {
  const { tool, server } = callTarget(call.tool);
  const fields = {
    callId: call.callId,
    tool,
    server,
    args: call.args,
    durationMs: Date.now() - startedAt,
  };
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

/** The tool runner of the step (C3 `ToolRunner`; KD-4, KD-5, Flow 5). */
export function createToolRunner(options: ToolRunnerOptions): ToolRunner {
  const { mcpClients, access, toolResultMaxBytes } = options;

  async function callMcp(
    call: ResolvedCall & { readonly tool: Extract<SessionTool, { kind: 'mcp' }> },
    signal: AbortSignal,
  ): Promise<ToolExecution | AbortedExecution> {
    if (signal.aborted) return { kind: 'aborted' };
    const args = MCP_ARGS_SCHEMA.parse(call.args);
    try {
      const response = await mcpClients.call(call.tool.mcp.server, call.tool.mcp.tool, args, signal);
      if (signal.aborted) return { kind: 'aborted' };
      const result = toOutcome(response, toolResultMaxBytes);
      return {
        kind: 'done',
        outcome: result.outcome,
        text: result.text,
        ...(result.reason === undefined ? {} : { failureReason: result.reason }),
      };
    } catch (error) {
      if (signal.aborted) return { kind: 'aborted' };
      throw error;
    }
  }

  async function execute(call: ResolvedCall, ctx: OutsideContext): Promise<ToolExecution | AbortedExecution> {
    const { tool } = call;
    if (tool.kind === 'mcp') return callMcp({ ...call, tool }, ctx.signal);
    if (tool.tool.mode !== 'outside') {
      throw new Error(`Tool ${tool.name} runs in the commit transaction, not outside it`);
    }
    if (ctx.signal.aborted) return { kind: 'aborted' };
    const result = await tool.tool.execute({
      callId: call.callId,
      args: call.args,
      caller: call.caller,
      signal: ctx.signal,
      logger: ctx.logger,
    });
    return ctx.signal.aborted ? { kind: 'aborted' } : fromRunResult(result);
  }

  async function runInCommit(
    call: ResolvedCall,
    tx: RuntimeTx,
    effects: StepEffects,
  ): Promise<ToolExecution> {
    const { tool } = call;
    if (tool.kind !== 'agent' || tool.tool.mode !== 'in_commit') {
      throw new Error(`Tool ${tool.name} runs outside the commit transaction`);
    }
    const result = await tool.tool.execute({
      callId: call.callId,
      args: call.args,
      caller: call.caller,
      tx,
      effects,
      startChild: options.startChildFor({ tx, effects, caller: call.caller }),
    });
    return fromRunResult(result);
  }

  function isInCommit(call: ResolvedCall): boolean {
    return call.tool.kind === 'agent' && call.tool.tool.mode === 'in_commit';
  }

  return {
    check(requested, { sessionTools, caller }) {
      const tool = sessionTools.find((candidate) => candidate.name === requested.toolName);
      const serverId = tool?.kind === 'mcp' ? tool.mcp.server : null;
      const gate = gateCall({
        toolName: requested.toolName,
        sessionTools: sessionTools.map((candidate) => candidate.name),
        serverId,
        ownerAllowed: serverId !== null && serverAllowed(access, caller.ownerId, serverId),
        args: requested.args,
        argsSchema: tool?.kind === 'agent' ? tool.inputSchema : MCP_ARGS_SCHEMA,
      });
      if (gate.kind === 'refused') return gate;
      if (tool === undefined) {
        throw new Error(`Tool ${requested.toolName} passed the gate without being in the session`);
      }
      return { kind: 'allowed', call: { callId: requested.callId, tool, args: gate.args, caller } };
    },

    needsConfirmation(call) {
      return call.tool.kind === 'mcp'
        ? !call.tool.mcp.readOnly
        : call.tool.tool.confirmation !== undefined;
    },

    confirmationRequest(call, session) {
      const { tool, server } = callTarget(call.tool);
      const confirmation = call.tool.kind === 'agent' ? call.tool.tool.confirmation : undefined;
      if (call.tool.kind === 'agent' && confirmation === undefined) {
        throw new Error(`Tool ${call.tool.name} declares no confirmation`);
      }
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
              : confirmation.content(call.args),
        },
      };
    },

    async runOutside(call, ctx) {
      const startedAt = Date.now();
      const execution = await execute(call, ctx);
      logCall(ctx.logger, call, execution, startedAt);
      return execution;
    },

    planInCommit(call, logger) {
      return async (tx, effects) => {
        const startedAt = Date.now();
        const execution = await runInCommit(call, tx, effects);
        logCall(logger, call, execution, startedAt);
        return execution;
      };
    },

    async sendConfirmed(call, ctx, editedArgs) {
      const sent: ResolvedCall = editedArgs === undefined ? call : { ...call, args: editedArgs };
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
                : await runInCommit(sent, tx, effects);
            logCall(ctx.logger, sent, execution, startedAt);
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
        logCall(ctx.logger, sent, notSent, startedAt);
        return notSent;
      }
      const execution = await execute(sent, ctx);
      logCall(ctx.logger, sent, execution, startedAt);
      return { kind: 'sent', execution };
    },
  };
}
