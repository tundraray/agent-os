import type { ToolOutcome } from '@agent-os/contracts';
import type { CallToolResult } from '@modelcontextprotocol/client';
import type { McpCallResponse } from './mcp-client';
import type { McpFailureReason } from './mcp-failure';

/** The outcomes an MCP response can have; refusals, rejections and interruptions are decided elsewhere. */
export type McpOutcome = Extract<
  ToolOutcome,
  'success' | 'empty' | 'tool_error' | 'transport_failure' | 'unknown' | 'auth_required'
>;

export interface McpOutcomeResult {
  readonly outcome: McpOutcome;
  /**
   * The whole result text of the server, or the platform's own text of `auth_required`, `transport_failure`
   * and `unknown`.
   */
  readonly text: string;
  /** Why the call got no answer; only with `transport_failure` and `unknown`. */
  readonly reason?: McpFailureReason;
}

/** The called tool as `toOutcome` needs it: its server and whether it only reads (`readOnlyHint`). */
export interface OutcomeTarget {
  readonly server: string;
  readonly readOnly: boolean;
}

/** Failures after which the request may have reached the server and run (KD-4). */
const MAYBE_EXECUTED: ReadonlySet<McpFailureReason> = new Set(['timeout', 'connection_lost', 'protocol_error']);

/** Each failure reason as the model reads it. */
const FAILURE_TEXTS: Readonly<Record<McpFailureReason, string>> = {
  timeout: 'the server did not answer in time (timeout)',
  connection_lost: 'the connection to the server was lost',
  protocol_error: 'the server answered outside the MCP protocol',
  unauthorized: "the server rejected the platform's credentials",
  client_error: 'the MCP client failed to make the call',
};

function resultText(result: CallToolResult): string {
  if (result.content.length === 0) {
    return result.structuredContent === undefined ? '' : JSON.stringify(result.structuredContent);
  }
  return result.content.map((block) => (block.type === 'text' ? block.text : JSON.stringify(block))).join('\n');
}

function isEmpty(result: CallToolResult): boolean {
  return result.content.length === 0 && result.structuredContent === undefined;
}

/** What the model reads when the owner has no usable account on the server (KD-5). */
function authRequiredText(server: string): string {
  return `An account of ${server} must be connected on the page «Мой доступ»`;
}

/**
 * A call with no answer (agent-harness design-core.md KD-4): a changing call whose request may have run is
 * `unknown`, with a text that forbids repeating it unchecked; any other is `transport_failure`. Both name the reason.
 */
function failureOutcome(reason: McpFailureReason, target: OutcomeTarget): McpOutcomeResult {
  const why = FAILURE_TEXTS[reason];
  if (!target.readOnly && MAYBE_EXECUTED.has(reason)) {
    return {
      outcome: 'unknown',
      text:
        `The call to ${target.server} got no answer: ${why}. The action may have been carried out. ` +
        'Do not repeat it before checking whether it was.',
      reason,
    };
  }
  return {
    outcome: 'transport_failure',
    text: `The call to ${target.server} failed: ${why}.`,
    reason,
  };
}

/**
 * Turns an MCP response into exactly one outcome of the call (design-agents.md, Flow 1, Failure handling;
 * design-mcp-connect.md KD-5 for `auth_required`; agent-harness design-core.md KD-4 for `unknown`).
 */
export function toOutcome(response: McpCallResponse, target: OutcomeTarget): McpOutcomeResult {
  if (response.kind === 'auth_required') {
    return { outcome: 'auth_required', text: authRequiredText(target.server) };
  }
  if (response.kind === 'failure') {
    return failureOutcome(response.reason, target);
  }
  const { result } = response;
  if (result.isError === true) {
    return { outcome: 'tool_error', text: resultText(result) };
  }
  if (isEmpty(result)) {
    return { outcome: 'empty', text: '' };
  }
  return { outcome: 'success', text: resultText(result) };
}

/**
 * The value a script gets for an MCP result (design-code-execution.md, «API скрипта»):
 * `structuredContent` when present, else the text parsed as JSON, else the text itself.
 */
export function scriptValueOf(result: CallToolResult): unknown {
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }
  const text = resultText(result);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}
