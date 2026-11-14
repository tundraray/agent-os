import type { ToolOutcome } from '@agent-os/contracts';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/client';
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

/**
 * A tool is read-only only when its server listed it with `readOnlyHint: true`; anything else, the hint
 * missing included, changes something (KD-4).
 */
export function isReadOnly(annotations: ToolAnnotations | undefined): boolean {
  return annotations?.readOnlyHint === true;
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

/** Cuts a text to `maxBytes` of UTF-8 on a character boundary, noting how many bytes were cut. */
function truncate(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) {
    return text;
  }
  let cut = maxBytes;
  // A UTF-8 continuation byte (10xxxxxx) is the middle of a character: step back to its first byte.
  while (cut > 0 && ((bytes[cut] ?? 0) & 0xc0) === 0x80) {
    cut -= 1;
  }
  return `${bytes.subarray(0, cut).toString('utf8')}\n[truncated ${bytes.length - cut} bytes]`;
}

/** Turns an MCP response into exactly one outcome of the call (design-agents.md, Flow 1, Failure handling). */
export function toOutcome(response: McpCallResponse, maxBytes: number): McpOutcomeResult {
  if (response.kind === 'failure') {
    return { outcome: 'transport_failure', text: '', reason: response.reason };
  }
  const { result } = response;
  if (result.isError === true) {
    return { outcome: 'tool_error', text: truncate(resultText(result), maxBytes) };
  }
  if (isEmpty(result)) {
    return { outcome: 'empty', text: '' };
  }
  return { outcome: 'success', text: truncate(resultText(result), maxBytes) };
}
