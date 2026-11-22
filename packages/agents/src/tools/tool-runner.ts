import type { Logger } from '@agent-os/common';
import { AGENTS_TOOL_CONFIRMATION } from '@agent-os/contracts';
import { AgentToolResultsRepository } from '@agent-os/db';
import type { StepContext, StepEffects } from '@agent-os/runtime';
import { Inject, Injectable } from '@nestjs/common';

import type { AccessAudit, AccessGate } from '../access-gate';
import { ACCESS_AUDIT, ACCESS_GATE, AGENTS_CONFIG, MASK_SECRETS } from '../agents.tokens';
import type { AgentsConfig } from '../config';
import { McpAccounts } from '../mcp/mcp-accounts';
import { McpClient } from '../mcp/mcp-client';
import { CallRecords } from '../store/call-records';
import type { Session } from '../store/sessions';
import {
  admit,
  type CallCheck,
  checkCall,
  type InCommitCall,
  isInCommit,
  type PairAllowed,
  type RequestedCall,
  type ResolvedCall,
} from './call-check';
import { type CodeCallExecution, type CodeCallRequest, type CodeCallScope, createCodeCall } from './code-call';
import type { StartChild, ToolCaller, ToolReview } from './tool';
import {
  type AbortedExecution,
  createMcpCalls,
  logCall,
  loggedCall,
  type McpCalls,
  type NotSent,
  type ToolExecution,
} from './tool-execution';
import { callTarget, isMcp, type SessionTool } from './tool-registry';

/** What `planInCommit` gives the step: run inside `commit(effects)`. */
export type InCommitPlan = (effects: StepEffects) => Promise<ToolExecution>;

export type ConfirmedSend =
  | { readonly kind: 'sent'; readonly execution: ToolExecution | AbortedExecution }
  | NotSent
  /** An in-commit tool: the intent and the call happen in the step's commit transaction. */
  | {
      readonly kind: 'in_commit';
      readonly commit: (effects: StepEffects) => Promise<ToolExecution | NotSent>;
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

/** The card of a call that needs a decision, or the refusal its tool's `review` gave before any card (deep-agents KD-3). */
export type ConfirmationCard =
  | { readonly kind: 'request'; readonly request: ConfirmationRequest }
  | Extract<ToolReview, { readonly kind: 'refused' }>;

/** What the spawn helper of one in-commit call is bound to. */
export interface StartChildScope {
  readonly effects: StepEffects;
  readonly caller: ToolCaller;
}

/** The step context the runner needs for an outside call; the tool gets it in its input. */
export type OutsideContext = Pick<StepContext, 'signal' | 'logger' | 'guard'>;

/** The step context of a confirmed call: the intent goes through `guard`. */
export type ConfirmContext = Pick<StepContext, 'taskId' | 'signal' | 'logger' | 'guard'>;

/** The tool runner of the step (C3 `ToolRunner`; KD-4, KD-5, Flow 5). */
@Injectable()
export class ToolRunner {
  private readonly mcpCalls: McpCalls;
  private readonly codeCall: (request: CodeCallRequest, scope: CodeCallScope) => Promise<CodeCallExecution>;
  /** Binds the spawn helper to the commit transaction and the caller; `useStartChild` sets it. */
  private startChildFor: ((scope: StartChildScope) => StartChild) | undefined;

  constructor(
    /** Writes the `tool_sent` intent of a confirmed call before it goes out. */
    @Inject(CallRecords) private readonly callRecords: CallRecords,
    /** Sends a call to its server with the credentials of the call (KD-3). */
    @Inject(McpClient) client: Pick<McpClient, 'callTool'>,
    /** The credentials of the caller's owner, read just before the call (KD-5). */
    @Inject(McpAccounts) accounts: Pick<McpAccounts, 'credentialsFor'>,
    /**
     * Asked before every call the runner starts — direct, in-commit, confirmed and from code (design-access.md
     * KD-1, KD-4): a disabled owner rejects the runner's method with `OwnerDisabledError` and the call does not
     * start; an MCP pair it does not allow is refused `no_access` before any credentials are read.
     */
    @Inject(ACCESS_GATE) private readonly access: Pick<AccessGate, 'tools'>,
    /**
     * Gets the `access_denied` record of each `no_access` the runner decides, and the `tool_call_refused` record of
     * each call from code refused for its arguments (KD-6).
     */
    @Inject(ACCESS_AUDIT) private readonly audit: AccessAudit,
    /** `mcpCallTimeoutMs` bounds one MCP call, the handshake included. */
    @Inject(AGENTS_CONFIG) config: Pick<AgentsConfig, 'mcpCallTimeoutMs'>,
    /** The settings row of large results (tool-result-reading R-5), read on every direct MCP call. */
    @Inject(AgentToolResultsRepository) toolResultRows: Pick<AgentToolResultsRepository, 'readSettings'>,
    /** The logger's redaction by value: every MCP text the model gets and every stored result passes it. */
    @Inject(MASK_SECRETS) maskSecrets: (text: string) => string,
  ) {
    this.mcpCalls = createMcpCalls({
      client,
      accounts,
      callTimeoutMs: config.mcpCallTimeoutMs,
      resultSettings: () => toolResultRows.readSettings(),
      maskSecrets,
    });
    this.codeCall = createCodeCall({ access, audit, callMcp: this.mcpCalls.fromCode });
  }

  /**
   * Sets what binds the spawn helper of an in-commit call to the commit transaction and the caller. The factory
   * of agent objects supplies it once it exists: it needs the runner itself.
   */
  useStartChild(startChildFor: (scope: StartChildScope) => StartChild): void {
    this.startChildFor = startChildFor;
  }

  /**
   * Checks a call (C3; Flow 1, Failure handling; DC-6): the tool is in the session's check set
   * (`ToolRegistry.checkTools`: a disabled, removed or unnamed server's tool is not), the owner may
   * use its server–tool pair — `allows`, the gate's answer for this step — and the arguments fit the tool's
   * schema: a built-in or registered tool's zod schema, an MCP tool's stored JSON Schema (agent-harness KD-2).
   * An `invalid_arguments` refusal carries the error text; an MCP schema that cannot be built lets the call
   * through `unchecked`. A refused call never reaches the server; allowed arguments are the parsed ones. A
   * `no_access` decided here is audited by the caller of `check`; the rest is `reportCheck`'s.
   */
  check(
    requested: RequestedCall,
    scope: {
      readonly sessionTools: readonly SessionTool[];
      readonly caller: ToolCaller;
      readonly allows: PairAllowed;
    },
  ): CallCheck {
    return checkCall(requested, scope);
  }

  /**
   * A changing MCP tool (not `readOnlyHint`), or a tool with `confirmation` whose `required(args)` is
   * true or not set (KD-4; code-execution KD-4).
   */
  needsConfirmation(call: ResolvedCall): boolean {
    if (isMcp(call.tool)) return !call.tool.mcp.readOnly;
    const { confirmation } = call.tool.tool;
    if (confirmation === undefined) return false;
    return confirmation.required === undefined || confirmation.required(call.args);
  }

  /**
   * The `await_decision` request of the call; `agents.tool_confirmation` for an MCP tool. A tool with
   * `review` is asked first, outside any transaction: its refusal is the answer and no request is made, its
   * card is the request's content (deep-agents KD-3). Without `review` the content is the tool's
   * `content(args, tools)` — `tools` the session's tool set (code-execution KD-10).
   */
  async confirmationRequest(
    call: ResolvedCall,
    session: Pick<Session, 'description'>,
    tools: readonly SessionTool[],
  ): Promise<ConfirmationCard> {
    const { tool, server } = callTarget(call.tool);
    const confirmation = isMcp(call.tool) ? undefined : call.tool.tool.confirmation;
    const review: ToolReview =
      confirmation?.review === undefined
        ? {
            kind: 'card',
            content:
              confirmation === undefined
                ? { toolDescription: call.tool.description }
                : confirmation.content(call.args, tools),
          }
        : await confirmation.review(call.args, call.caller);
    if (review.kind === 'refused') return review;
    return {
      kind: 'request',
      request: {
        kind: confirmation?.kind ?? AGENTS_TOOL_CONFIRMATION,
        payload: {
          agentId: call.caller.agentId,
          description: session.description,
          callId: call.callId,
          tool,
          server,
          args: call.args,
          content: review.content,
        },
      },
    };
  }

  /** Runs an MCP tool or an `outside` tool, outside any transaction, under the step's signal. */
  async runOutside(call: ResolvedCall, ctx: OutsideContext): Promise<ToolExecution | AbortedExecution> {
    const startedAt = Date.now();
    const execution =
      (await admit(this.access, this.audit, call, ctx.logger)) ?? (await this.execute(call, ctx));
    logCall(ctx.logger, loggedCall(call), execution, startedAt);
    return execution;
  }

  /**
   * Checks and runs a script's call (code-execution «Проверка вызова из кода»; KD-2, KD-8, DC-5, DC-6):
   * a built-in or registered tool or `run_code` — `not_callable_from_code`; a `write` run and a name
   * outside the confirmed list — `not_in_confirmed_script`; then `check` against the snapshot; a `read`
   * run and a tool without `McpTool.readOnly` — `changing_in_read_run`. `check` gets the gate's answer asked
   * for this call: a disabled owner rejects, a pair it does not allow is `no_access` with one audit record.
   * An allowed call goes to its server on behalf of the caller's owner; a value is not cut, a server's error
   * text is not returned.
   */
  callFromCode(request: CodeCallRequest, scope: CodeCallScope): Promise<CodeCallExecution> {
    return this.codeCall(request, scope);
  }

  /**
   * The closure an `in_commit` tool runs in `commit(effects)`, with the spawn helper. The gate is asked and
   * the tool's `prepare` runs first, outside the transaction.
   */
  async planInCommit(call: InCommitCall, logger: Logger): Promise<InCommitPlan> {
    const refusal = await admit(this.access, this.audit, call, logger);
    const prepared = refusal === undefined ? await prepareInCommit(call) : undefined;
    return async (effects) => {
      const startedAt = Date.now();
      const execution = refusal ?? (await this.runInCommit(call, prepared, effects));
      logCall(logger, loggedCall(call), execution, startedAt);
      return execution;
    };
  }

  /**
   * Sends a confirmed call once (Flow 5): first the `tool_sent` intent through `ctx.guard`; `fenced`, or a
   * call no longer awaiting confirmation, is not sent (Invariant 2). `editedArgs` are the arguments the
   * employee edited; they replace the call's. `confirmed` — `content` of the resolved request, given to
   * the tool in its input, `outside` or `in_commit` (code-execution KD-10; deep-agents KD-3).
   */
  async sendConfirmed(
    call: ResolvedCall,
    ctx: ConfirmContext,
    editedArgs?: unknown,
    confirmed?: unknown,
  ): Promise<ConfirmedSend> {
    const sent: ResolvedCall = editedArgs === undefined ? call : { ...call, args: editedArgs };
    const refusal = await admit(this.access, this.audit, call, ctx.logger);
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
      const inCommit = { ...call, args: sent.args };
      const prepared = await prepareInCommit(inCommit);
      return {
        kind: 'in_commit',
        commit: async (effects) => {
          const startedAt = Date.now();
          const execution: ToolExecution | NotSent = (await this.callRecords.markSent(key))
            ? await this.runInCommit(inCommit, prepared, effects, confirmed)
            : { kind: 'not_sent', reason: 'not_awaiting' };
          logCall(ctx.logger, loggedCall(sent), execution, startedAt);
          return execution;
        },
      };
    }
    const startedAt = Date.now();
    // Committed before the request leaves: a step lost from here on finds the intent and never resends.
    const intent = await ctx.guard(() => this.callRecords.markSent(key));
    if (intent.outcome === 'fenced' || !intent.value) {
      const notSent: NotSent = {
        kind: 'not_sent',
        reason: intent.outcome === 'fenced' ? 'fenced' : 'not_awaiting',
      };
      logCall(ctx.logger, loggedCall(sent), notSent, startedAt);
      return notSent;
    }
    const execution = await this.execute(sent, ctx, confirmed);
    logCall(ctx.logger, loggedCall(sent), execution, startedAt);
    return { kind: 'sent', execution };
  }

  private async execute(
    call: ResolvedCall,
    ctx: OutsideContext,
    confirmed?: unknown,
  ): Promise<ToolExecution | AbortedExecution> {
    const { tool } = call;
    if (isMcp(tool)) return this.mcpCalls.direct({ ...call, tool }, ctx.signal, ctx.logger);
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

  private runInCommit(
    call: InCommitCall,
    prepared: unknown,
    effects: StepEffects,
    confirmed?: unknown,
  ): Promise<ToolExecution> {
    if (this.startChildFor === undefined) {
      throw new Error('The tool runner runs an in-commit tool before useStartChild() was called');
    }
    return call.tool.tool.execute({
      callId: call.callId,
      args: call.args,
      caller: call.caller,
      effects,
      startChild: this.startChildFor({ effects, caller: call.caller }),
      prepared,
      ...(confirmed === undefined ? {} : { confirmed }),
    });
  }
}

/** The tool's `prepare`, run before the commit transaction opens. */
function prepareInCommit(call: InCommitCall): Promise<unknown> {
  return call.tool.tool.prepare?.({ args: call.args, caller: call.caller }) ?? Promise.resolve(undefined);
}
