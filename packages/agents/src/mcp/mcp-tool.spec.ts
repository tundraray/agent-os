import type { McpToolSettings } from '@agent-os/contracts';
import { describe, expect, it } from 'vitest';
import { type McpTool, newToolsAfterRefresh, storedMcpTools } from './mcp-tool';

// access-levels UC-3: AC-36.4, AC-36.5, AC-36.6. Catches: the server's mark winning over the admin's
// correction, a tool without a mark not read as changing, a disabled tool read as enabled, `new_tools` not
// marking a tool new, a new tool trusted as reading by the server's mark before the admin reviewed it, a refresh
// clearing the marks of an earlier one.

/** A stored list item with the server's mark: `true`, `false`, or `null` — the server gave none. */
function listed(tool: string, readOnly: boolean | null): unknown {
  return {
    name: `mcp__tracker__${tool}`,
    server: 'tracker',
    tool,
    description: '',
    inputSchema: { type: 'object' },
    readOnly,
    display: {},
  };
}

interface Row {
  readonly case: string;
  readonly mark: boolean | null;
  readonly settings: McpToolSettings;
  readonly newTools: string[];
  readonly expected: Partial<McpTool>;
}

describe('storedMcpTools', () => {
  it.each<Row>([
    {
      case: 'mark «reads», corrected to «changes»',
      mark: true,
      settings: { search: { readOnly: false } },
      newTools: [],
      expected: {
        readOnly: false,
        serverReadOnly: true,
        overridden: true,
        enabled: true,
        isNew: false,
      },
    },
    {
      case: 'no mark, corrected to «reads»',
      mark: null,
      settings: { search: { readOnly: true } },
      newTools: [],
      expected: {
        readOnly: true,
        serverReadOnly: null,
        overridden: true,
        enabled: true,
        isNew: false,
      },
    },
    {
      case: 'no mark, no correction — changes',
      mark: null,
      settings: {},
      newTools: [],
      expected: {
        readOnly: false,
        serverReadOnly: null,
        overridden: false,
        enabled: true,
        isNew: false,
      },
    },
    {
      case: 'mark «reads», no correction',
      mark: true,
      settings: { other: { readOnly: false } },
      newTools: [],
      expected: {
        readOnly: true,
        serverReadOnly: true,
        overridden: false,
        enabled: true,
        isNew: false,
      },
    },
    {
      case: 'disabled by the admin',
      mark: false,
      settings: { search: { enabled: false } },
      newTools: [],
      expected: {
        readOnly: false,
        serverReadOnly: false,
        overridden: false,
        enabled: false,
        isNew: false,
      },
    },
    {
      case: 'new, mark «reads» — changes until reviewed',
      mark: true,
      settings: {},
      newTools: ['search'],
      expected: {
        readOnly: false,
        serverReadOnly: true,
        overridden: false,
        enabled: true,
        isNew: true,
      },
    },
    {
      case: 'new, corrected to «reads»',
      mark: false,
      settings: { search: { readOnly: true } },
      newTools: ['search'],
      expected: {
        readOnly: true,
        serverReadOnly: false,
        overridden: true,
        enabled: true,
        isNew: true,
      },
    },
  ])('reads $case', ({ mark, settings, newTools, expected }) => {
    const [tool] =
      storedMcpTools({
        tools: [listed('search', mark)],
        toolSettings: settings,
        newTools,
      }) ?? [];
    expect(tool).toMatchObject(expected);
  });

  it('keeps the new marks of earlier refreshes and drops those of tools no longer listed', () => {
    expect(
      newToolsAfterRefresh(
        ['earlier', 'gone'],
        ['added'],
        ['added', 'earlier', 'old'],
      ),
    ).toEqual(['added', 'earlier']);
  });
});
