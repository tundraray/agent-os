import type { Script, ScriptedToolCall } from '@agent-os/agents/testing';
import { LOGS_SERVER } from './mcp-servers.js';

/**
 * What the suites that read the fixture's payment logs share: the direct `search_logs` call and its window,
 * a `run_code` call of a scripted answer, the ids of the scripted calls.
 */

/** `search_logs` as the model and a script name it. */
export const SEARCH_LOGS = `mcp__${LOGS_SERVER}__search_logs`;
/** A quarter of an hour of the fixture's week: 629 records, so the first page (500, the default `pageSize`) is not all of them. */
export const WINDOW = { from: '2026-09-15T10:00:00.000Z', to: '2026-09-15T10:15:00.000Z' } as const;
/** One record of {@link WINDOW}: a cheap read call, and a short direct answer. */
export const ONE_RECORD = { ...WINDOW, pageSize: 1 } as const;

/** A `run_code` call of a scripted answer; class `read` unless named. */
export function runCode(description: string, script: string, runClass: 'read' | 'write' = 'read'): ScriptedToolCall {
  return { tool: 'run_code', args: { description, class: runClass, script } };
}

/** The id the model's double gave to call `position` of the script's answer `answer`. */
export function toolCallIdOf(script: Script, answer: number, position = 0): string {
  const id = script.calls[answer]?.toolCallIds[position];
  if (id === undefined) throw new Error(`Answer ${answer} of the script has no tool call ${position}`);
  return id;
}
