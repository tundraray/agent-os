import type { ToolOutcome } from '@agent-os/contracts';
import type { CallToolResult } from '@modelcontextprotocol/client';
import type { McpCallResponse } from './mcp-client';
import type { McpFailureReason } from './mcp-failure';

/** The outcomes an MCP response can have; refusals, rejections and interruptions are decided elsewhere. */
export type McpOutcome = Extract<
  ToolOutcome,
  'success' | 'empty' | 'tool_error' | 'transport_failure' | 'auth_required'
>;

export interface McpOutcomeResult {
  readonly outcome: McpOutcome;
  /** The whole result text of the server, or the platform's own text of `auth_required`. */
  readonly text: string;
  /** Why the call got no answer; only with `transport_failure`. */
  readonly reason?: McpFailureReason;
}

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
 * Turns an MCP response into exactly one outcome of the call (design-agents.md, Flow 1, Failure handling;
 * design-mcp-connect.md KD-5 for `auth_required`).
 */
export function toOutcome(response: McpCallResponse, server: string): McpOutcomeResult {
  if (response.kind === 'auth_required') {
    return { outcome: 'auth_required', text: authRequiredText(server) };
  }
  if (response.kind === 'failure') {
    return { outcome: 'transport_failure', text: '', reason: response.reason };
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
