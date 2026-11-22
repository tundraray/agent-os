import { z } from 'zod';
import type { SessionTool } from '../tool-registry';
import { canCallOf } from './can-call';

// UC-6 (AC-05.7, DC-17): the "Может вызвать" list holds the session's MCP tools named in the script
// as a whole word, changing first, then reading, each group by first mention.

function mcpTool(server: string, tool: string, readOnly: boolean): SessionTool {
  const name = `mcp__${server}__${tool}`;
  return {
    kind: 'external',
    name,
    description: tool,
    inputSchema: { type: 'object' },
    mcp: { name, server, tool, description: tool, inputSchema: { type: 'object' }, readOnly, display: {} },
  };
}

const START_AGENT_ARGS = z.object({ description: z.string(), agent: z.string(), prompt: z.string() });

const SESSION_TOOLS: readonly SessionTool[] = [
  // readOnlyHint: true
  mcpTool('logs', 'search_logs', true),
  // readOnlyHint: false
  mcpTool('backoffice', 'create_incident_note', false),
  // no annotations
  mcpTool('backoffice', 'close_ticket', false),
  // readOnlyHint: true
  mcpTool('logs', 'search', true),
  {
    kind: 'system',
    name: 'start_agent',
    description: 'Start an agent',
    inputSchema: START_AGENT_ARGS,
    tool: {
      name: 'start_agent',
      description: 'Start an agent',
      argsSchema: START_AGENT_ARGS,
      mode: 'outside',
      execute: async () => ({ kind: 'done', outcome: 'success', text: '' }),
    },
  },
];

describe('the "Может вызвать" list holds the session\'s MCP tools named in the script, changing first', () => {
  it.each([
    [
      'three names: changing first, each group by first mention',
      [
        "const logs = await callTool('mcp__logs__search_logs', { query: 'timeout' });",
        "await callTool('mcp__backoffice__close_ticket', { id: 'T-1' });",
        "await callTool('mcp__backoffice__create_incident_note', { text: 'done' });",
      ].join('\n'),
      [
        { name: 'mcp__backoffice__close_ticket', changes: true },
        { name: 'mcp__backoffice__create_incident_note', changes: true },
        { name: 'mcp__logs__search_logs', changes: false },
      ],
    ],
    [
      'a name only in a comment',
      "// later: mcp__backoffice__close_ticket\nconsole.log('nothing called');",
      [{ name: 'mcp__backoffice__close_ticket', changes: true }],
    ],
    [
      'a longer name does not give its prefix',
      "await callTool('mcp__logs__search_logs', { query: 'x' });",
      [{ name: 'mcp__logs__search_logs', changes: false }],
    ],
    [
      'a name assembled from parts',
      "const name = 'mcp__backoffice__' + 'create_incident_note';\nawait callTool(name, {});",
      [],
    ],
    [
      'script API functions and built-in tools',
      "const full = await readResult('call-1');\nconsole.log('start_agent');",
      [],
    ],
    ['no names at all', "console.log('hello');", []],
  ])('%s', (_case, script, expected) => {
    expect(canCallOf(script, SESSION_TOOLS)).toEqual(expected);
  });
});
