import type { ToolOutcome } from '@agent-os/contracts';
import type { CallToolResult } from '@modelcontextprotocol/client';
import type { McpCallResponse } from './mcp-client.js';
import type { McpFailureReason } from './mcp-failure.js';

/** The outcomes an MCP response can have; refusals, rejections and interruptions are decided elsewhere. */
export type McpOutcome = Extract<ToolOutcome, 'success' | 'empty' | 'tool_error' | 'transport_failure'>;

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

/** Turns an MCP response into exactly one outcome of the call (design-agents.md, Flow 1, Failure handling). */
export function toOutcome(response: McpCallResponse, maxBytes: number, callId: string): McpOutcomeResult {
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
  return { outcome: 'success', text: truncate(resultText(result), maxBytes, callId) };
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
