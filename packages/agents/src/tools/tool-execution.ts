import type { Logger } from '@agent-os/common';
import type { SettingsValue, ToolRefusalReason } from '@agent-os/contracts';

import type { McpAccounts } from '../mcp/mcp-accounts';
import type { McpCallResponse, McpClient } from '../mcp/mcp-client';
import type { McpFailureReason } from '../mcp/mcp-failure';
import { type McpOutcome, scriptValueOf, toOutcome } from '../mcp/mcp-outcome';
import type { StoredToolResult } from '@agent-os/db';
import { MCP_ARGS_SCHEMA, type McpCall, type ResolvedCall } from './call-check';
import { cutText, maskValue, wrapperText } from './large-result';
import { callTarget, loggedArgs } from './tool-registry';

/** How a tool call the runner ran ended; a refusal reached no external system. */
export type ToolExecution =
  | {
      readonly kind: 'done';
      readonly outcome: McpOutcome;
      readonly text: string;
      /** Why an MCP call got no answer; only with `transport_failure` and `unknown`. */
      readonly failureReason?: McpFailureReason;
      /** Script output of a `run_code` run: text of a successful run, `null` of a failed one. */
      readonly output?: string | null;
      /** The value a script gets for its call from code with `success` or `empty` (code-execution KD-2). */
      readonly fullResult?: { readonly value: unknown };
      /**
       * The full result of a direct MCP call with `success` or `empty`, secrets masked: the step's commit
       * stores it with the closing, whatever its length (code-execution KD-5, DC-8; tool-result-reading R-4).
       */
      readonly stored?: StoredToolResult;
      /** The child a `start_agent`-like call started. */
      readonly childAgentId?: string;
    }
  | {
      readonly kind: 'refused';
      readonly reason: ToolRefusalReason;
      /** The refused model of a refusal by model; absent otherwise. */
      readonly refusalDetail?: { readonly model: string } | null;
      /** What the model reads after `[refused: <reason>]` (deep-agents KD-4); absent — the reason alone. */
      readonly text?: string;
    };

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

/** What a log record of a call names: its id, tool, server and arguments. */
export interface LoggedCall {
  readonly callId: string;
  readonly tool: string;
  readonly server: string | null;
  readonly args: unknown;
}

export function loggedCall(call: ResolvedCall): LoggedCall {
  return {
    callId: call.callId,
    ...callTarget(call.tool),
    args: loggedArgs(call.tool, call.args),
  };
}

/** Logs one tool call the runner ran (rule 9 of the plan): ids, tool, server, arguments, outcome, reason, duration. */
export function logCall(
  logger: Logger,
  call: LoggedCall,
  execution: ToolExecution | AbortedExecution | NotSent,
  startedAt: number,
): void {
  const fields = { ...call, durationMs: Date.now() - startedAt };
  switch (execution.kind) {
    case 'done':
      logger.info('tool call finished', {
        ...fields,
        outcome: execution.outcome,
        reason: execution.failureReason ?? null,
        resultChars: execution.text.length,
      });
      return;
    case 'refused':
      logger.info('tool call finished', {
        ...fields,
        outcome: 'refused',
        reason: execution.reason,
      });
      return;
    case 'aborted':
      logger.info('tool call aborted by the step signal', {
        ...fields,
        outcome: null,
        reason: 'aborted',
      });
      return;
    case 'not_sent':
      logger.warn('confirmed tool call not sent', {
        ...fields,
        outcome: null,
        reason: execution.reason,
      });
      return;
  }
}

/** What sending an MCP call and shaping its answer needs. */
export interface McpCallOptions {
  /** Sends a call to its server with the credentials of the call (KD-3). */
  readonly client: Pick<McpClient, 'callTool'>;
  /** The credentials of the caller's owner, read just before the call (KD-5). */
  readonly accounts: Pick<McpAccounts, 'credentialsFor'>;
  /** `MCP_CALL_TIMEOUT_MS`: bounds one call, the handshake included. */
  readonly callTimeoutMs: number;
  /**
   * The settings of large results (tool-result-reading R-5), read on every direct MCP call that ends
   * `success` or `tool_error`: its threshold decides whether the model gets the whole text or the wrapper.
   */
  readonly resultSettings: () => Promise<SettingsValue<'tool_result_settings'>>;
  /** The logger's redaction by value: every MCP text the model gets and every stored result passes it. */
  readonly maskSecrets: (text: string) => string;
}

/** The two ways an MCP call goes out: a direct call of the model, and a script's call. */
export interface McpCalls {
  /** A direct call: its answer masked, a large one wrapped, the full result kept for the step's commit. */
  readonly direct: (
    call: McpCall,
    signal: AbortSignal,
    logger: Logger,
  ) => Promise<ToolExecution | AbortedExecution>;
  /** A script's call: the whole text and, with `success` or `empty`, the value. */
  readonly fromCode: (
    call: McpCall,
    signal: AbortSignal,
  ) => Promise<ToolExecution | AbortedExecution>;
}

export function createMcpCalls(options: McpCallOptions): McpCalls {
  const { client, accounts, callTimeoutMs, resultSettings, maskSecrets } =
    options;

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
    const credentials = await accounts.credentialsFor(
      request.server,
      request.ownerId,
      'call',
    );
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

  /**
   * Sends an MCP call and turns its answer into an execution with `finish`; the step's signal and a server
   * gone since the check end it before.
   */
  async function callMcp(
    call: McpCall,
    signal: AbortSignal,
    finish: (
      response: McpCallResponse,
    ) => ToolExecution | Promise<ToolExecution>,
  ): Promise<ToolExecution | AbortedExecution> {
    if (signal.aborted) return { kind: 'aborted' };
    const args = MCP_ARGS_SCHEMA.parse(call.args);
    const { server, tool } = call.tool.mcp;
    try {
      const response = await sendMcp({
        server,
        tool,
        args,
        ownerId: call.caller.ownerId,
        signal,
      });
      if (signal.aborted) return { kind: 'aborted' };
      if (response.kind === 'server_gone')
        return { kind: 'refused', reason: 'tool_not_in_definition' };
      const execution = await finish(response);
      return signal.aborted ? { kind: 'aborted' } : execution;
    } catch (error) {
      if (signal.aborted) return { kind: 'aborted' };
      throw error;
    }
  }

  /**
   * A direct call's answer for the model (tool-result-reading R-1, R-3, R-4): the text masked; a `success`
   * longer than `storeFromChars` becomes the wrapper, a `tool_error` is cut there; `success` and `empty`
   * carry their full result for the step's commit.
   */
  async function directExecution(
    call: McpCall,
    response: McpCallResponse,
    logger: Logger,
  ): Promise<ToolExecution> {
    const { server, tool, readOnly } = call.tool.mcp;
    const result = toOutcome(response, { server, readOnly });
    const done = {
      kind: 'done',
      outcome: result.outcome,
      ...(result.reason === undefined ? {} : { failureReason: result.reason }),
    } as const;
    if (response.kind !== 'result') return { ...done, text: result.text };
    const text = maskSecrets(result.text);
    const stored = (): StoredToolResult => ({
      value: maskValue(scriptValueOf(response.result), maskSecrets),
      text,
    });
    if (result.outcome === 'empty') return { ...done, text, stored: stored() };
    const settings = await resultSettings();
    if (result.outcome === 'tool_error')
      return { ...done, text: cutText(text, settings.storeFromChars) };
    if (text.length <= settings.storeFromChars)
      return { ...done, text, stored: stored() };
    logger.info('tool result wrapped', {
      callId: call.callId,
      server,
      tool,
      chars: text.length,
      previewChars: settings.previewChars,
    });
    return {
      ...done,
      text: wrapperText({
        callId: call.callId,
        text,
        previewChars: settings.previewChars,
      }),
      stored: stored(),
    };
  }

  /** A script's call's answer, as today: the whole text and, with `success` or `empty`, the value. */
  function codeExecution(
    call: McpCall,
    response: McpCallResponse,
  ): ToolExecution {
    const { server, readOnly } = call.tool.mcp;
    const result = toOutcome(response, { server, readOnly });
    const hasValue =
      response.kind === 'result' &&
      (result.outcome === 'success' || result.outcome === 'empty');
    return {
      kind: 'done',
      outcome: result.outcome,
      text: result.text,
      ...(result.reason === undefined ? {} : { failureReason: result.reason }),
      ...(hasValue
        ? { fullResult: { value: scriptValueOf(response.result) } }
        : {}),
    };
  }

  return {
    direct: (call, signal, logger) =>
      callMcp(call, signal, (response) =>
        directExecution(call, response, logger),
      ),
    fromCode: (call, signal) =>
      callMcp(call, signal, (response) => codeExecution(call, response)),
  };
}
