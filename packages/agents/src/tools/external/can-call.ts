import type { RunCodeConfirmationContent } from '@agent-os/contracts';
import { isMcp, type SessionTool } from '../tool-registry';

/** One entry of the "Может вызвать" list. */
export type CanCallEntry = RunCodeConfirmationContent['canCall'][number];

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The "Может вызвать" list of a `write` run (KD-10, DC-17): the session's MCP tools whose full name
 * stands in the script as a separate word — in code, a string or a comment — with neither a letter,
 * a digit nor `_` beside it. Changing tools (no `readOnlyHint: true`) come first, then reading ones,
 * each group in order of first mention (UXRD KD-6). Built-in tools and the script API are left out:
 * code cannot call them.
 */
export function canCallOf(
  script: string,
  tools: readonly SessionTool[],
): CanCallEntry[] {
  const changesByName = new Map<string, boolean>();
  for (const tool of tools) {
    if (isMcp(tool)) changesByName.set(tool.name, !tool.mcp.readOnly);
  }
  if (changesByName.size === 0) return [];

  // Longest first, so a name that extends another is matched as itself.
  const names = [...changesByName.keys()]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp);
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])(?:${names.join('|')})(?![\\p{L}\\p{N}_])`,
    'gu',
  );

  const mentioned = new Set<string>();
  for (const match of script.matchAll(pattern)) mentioned.add(match[0]);

  const entries = [...mentioned].map((name) => ({
    name,
    changes: changesByName.get(name) === true,
  }));
  return [
    ...entries.filter((entry) => entry.changes),
    ...entries.filter((entry) => !entry.changes),
  ];
}
