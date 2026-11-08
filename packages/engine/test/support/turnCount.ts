// The port's agent-turn request is internal to the package; the counting doubles take its type from the sources.
import type { AgentTurnCountRequest } from '../../src/model/token-counter.js';

/**
 * What the counting doubles count for an agent turn (DC-30): one token per character of everything the turn sends — its
 * system block, its messages with their tool calls and results, and its tool schemas — as a role call is counted by the
 * characters of its instructions and messages. The in-process harness and the engine child count the same way, so a
 * probe window that fits a scenario in one fits it in the other.
 */
export function turnInputCharacters(request: AgentTurnCountRequest): number {
  return request.system.length + JSON.stringify(request.messages).length + JSON.stringify(request.tools).length;
}
