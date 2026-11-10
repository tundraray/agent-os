import type { ResolvedSourceTool } from '@agent-os/sources';
import type { ToolAccessPolicy, ToolAccessRequest } from '../agents/tool-access-policy.js';
import { buildSourceCatalog, type CatalogCandidate, catalogSourceMode } from './source-catalog.js';

// design-catalog-planning.md, KD-1, DC-3, DC-10, Invariants 1–2: the catalog of a start is the sources that are
// connected, in the process ceiling and allowed to the owner by the rights port asked about the source as a whole;
// sources and tools in code point order, tools only from the ceiling; an empty catalog is the mode without sources.
// Defect caught: a source outside that intersection gets into the catalog. The wiring over the database (the catalog in
// the row, a repeated start not rebuilding it) is INT-1 (T4.1).

/** The registry double: every declared source and tool has a description that names it. */
const sources = {
  describeSource: (sourceId: string): string => `about ${sourceId}`,
  resolveTool: ({ sourceId, toolName }: { sourceId: string; toolName: string }): ResolvedSourceTool =>
    ({ description: `${sourceId}/${toolName} does` }) as ResolvedSourceTool,
};

/** The rights port double: allows the listed sources, records every question. */
function accessPolicyAllowing(allowed: readonly string[]) {
  const asked: ToolAccessRequest[] = [];
  return {
    asked,
    accessPolicy: {
      decide: (request) => {
        asked.push(request);
        return Promise.resolve(allowed.includes(request.sourceId ?? '') ? 'allowed' : 'access_denied');
      },
    } satisfies ToolAccessPolicy,
  };
}

const tool = (sourceId: string, toolName: string) => ({ toolName, description: `${sourceId}/${toolName} does` });

describe('builds the catalog', () => {
  it.each<{
    name: string;
    ceiling: readonly [string, string][];
    connected: readonly string[];
    allowed: readonly string[];
    expected: readonly CatalogCandidate[];
    mode: 'sources' | 'model_knowledge';
    asked: readonly string[];
  }>([
    {
      name: 'leaves out a connected and allowed source outside the ceiling',
      ceiling: [['fixture', 'search_logs']],
      connected: ['fixture', 'backoffice'],
      allowed: ['fixture', 'backoffice'],
      expected: [{ sourceId: 'fixture', description: 'about fixture', tools: [tool('fixture', 'search_logs')] }],
      mode: 'sources',
      asked: ['fixture'],
    },
    {
      name: 'leaves out a ceiling source that is not connected, without asking the port about it',
      ceiling: [['fixture', 'search_logs'], ['backoffice', 'get_order']],
      connected: ['fixture'],
      allowed: ['fixture', 'backoffice'],
      expected: [{ sourceId: 'fixture', description: 'about fixture', tools: [tool('fixture', 'search_logs')] }],
      mode: 'sources',
      asked: ['fixture'],
    },
    {
      name: 'leaves out a source the port refused',
      ceiling: [['fixture', 'search_logs'], ['backoffice', 'get_order']],
      connected: ['fixture', 'backoffice'],
      allowed: ['backoffice'],
      expected: [{ sourceId: 'backoffice', description: 'about backoffice', tools: [tool('backoffice', 'get_order')] }],
      mode: 'sources',
      asked: ['backoffice', 'fixture'],
    },
    {
      name: 'orders sources and tools by code point, tools only those of the ceiling',
      ceiling: [
        ['fixture', 'search_logs'],
        ['fixture', 'Get_trace'],
        ['fixture', 'aggregate_logs'],
        ['backoffice', 'search_orders'],
        ['Zeta', 'read'],
      ],
      connected: ['fixture', 'backoffice', 'Zeta'],
      allowed: ['fixture', 'backoffice', 'Zeta'],
      expected: [
        { sourceId: 'Zeta', description: 'about Zeta', tools: [tool('Zeta', 'read')] },
        { sourceId: 'backoffice', description: 'about backoffice', tools: [tool('backoffice', 'search_orders')] },
        {
          sourceId: 'fixture',
          description: 'about fixture',
          tools: [tool('fixture', 'Get_trace'), tool('fixture', 'aggregate_logs'), tool('fixture', 'search_logs')],
        },
      ],
      mode: 'sources',
      asked: ['Zeta', 'backoffice', 'fixture'],
    },
    {
      name: 'is empty when the port refuses every source',
      ceiling: [['fixture', 'search_logs'], ['backoffice', 'get_order']],
      connected: ['fixture', 'backoffice'],
      allowed: [],
      expected: [],
      mode: 'model_knowledge',
      asked: ['backoffice', 'fixture'],
    },
  ])('$name', async ({ ceiling, connected, allowed, expected, mode, asked }) => {
    const port = accessPolicyAllowing(allowed);

    const catalog = await buildSourceCatalog(
      { sources, accessPolicy: port.accessPolicy },
      {
        resourceId: 'owner-1',
        config: { sources: ceiling.map(([sourceId, toolName]) => ({ sourceId, toolName })) },
        connectedSources: connected,
      },
    );

    expect(catalog).toEqual(expected);
    expect(catalogSourceMode(catalog)).toBe(mode);
    // The right to the source as a whole: no tool named, the owner asked about.
    expect([...port.asked].sort((left, right) => (left.sourceId ?? '').localeCompare(right.sourceId ?? ''))).toEqual(
      [...asked]
        .sort((left, right) => left.localeCompare(right))
        .map((sourceId) => ({ resourceId: 'owner-1', toolName: null, sourceId })),
    );
  });
});
