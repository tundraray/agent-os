import type { ToolOutcome } from '@agent-os/contracts';
import type { CallToolResult } from '@modelcontextprotocol/client';
import type { McpCallResponse } from './mcp-client.js';
import type { McpFailureReason } from './mcp-failure.js';

/** The outcomes an MCP response can have; refusals, rejections and interruptions are decided elsewhere. */
export type McpOutcome = Extract<
  ToolOutcome,
  'success' | 'empty' | 'tool_error' | 'transport_failure' | 'auth_required'
>;

/** The call a response belongs to: its id names the full result, its server the account to connect. */
export interface McpOutcomeCall {
  readonly callId: string;
  readonly server: string;
}

export interface McpOutcomeResult {
  readonly outcome: McpOutcome;
  /** The result text for the model, cut to the byte limit. */
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

/**
 * The note that ends a cut text (DC-7). With `callId` it names how a script reads the full result;
 * without it — a tool error, which keeps no full result (DC-8) — it only says how much was cut.
 */
function cutNote(cutBytes: number, callId: string | undefined): string {
  const note = `результат обрезан на ${cutBytes} байт`;
  return callId === undefined ? note : `${note}; полный — \`readResult("${callId}")\` в \`run_code\``;
}

/** Cuts a text to `maxBytes` of UTF-8 on a character boundary and ends it with the cut note. */
function truncate(text: string, maxBytes: number, callId: string | undefined): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) {
    return text;
  }
  let cut = maxBytes;
  // A UTF-8 continuation byte (10xxxxxx) is the middle of a character: step back to its first byte.
  while (cut > 0 && ((bytes[cut] ?? 0) & 0xc0) === 0x80) {
    cut -= 1;
  }
  return `${bytes.subarray(0, cut).toString('utf8')}\n${cutNote(bytes.length - cut, callId)}`;
}

/** What the model reads when the owner has no usable account on the server (KD-5). */
function authRequiredText(server: string): string {
  return `Нужно подключить аккаунт ${server} на странице «Мой доступ»`;
}

/**
 * Turns an MCP response into exactly one outcome of the call (design-agents.md, Flow 1, Failure handling;
 * design-mcp-connect.md KD-5 for `auth_required`).
 */
export function toOutcome(response: McpCallResponse, maxBytes: number, call: McpOutcomeCall): McpOutcomeResult {
  if (response.kind === 'auth_required') {
    return { outcome: 'auth_required', text: authRequiredText(call.server) };
  }
  if (response.kind === 'failure') {
    return { outcome: 'transport_failure', text: '', reason: response.reason };
  }
  const { result } = response;
  if (result.isError === true) {
    return { outcome: 'tool_error', text: truncate(resultText(result), maxBytes, undefined) };
  }
  if (isEmpty(result)) {
    return { outcome: 'empty', text: '' };
  }
  return { outcome: 'success', text: truncate(resultText(result), maxBytes, call.callId) };
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
