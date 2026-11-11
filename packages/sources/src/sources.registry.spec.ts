import { BACKOFFICE_SOURCE_ID, BackofficeSourceAdapter } from './backoffice/backoffice-source.adapter.js';
import { FIXTURE_SOURCE_ID, FixtureSourceAdapter } from './fixture/fixture-source.adapter.js';
import type { SourceAdapter } from './source-adapter.js';
import type { DeclaredSource, DeclaredTool, SourceDeclaration } from './source-declaration.js';
import { createSourceRegistry } from './source-registry.js';
import { parseSourcesSettings } from './sources.settings.js';

// The process boundary: every fixture process starts by constructing this transport.
const spawnSpy = vi.hoisted(() =>
  vi.fn(function blockedSpawn() {
    throw new Error('the fixture process must not start during configuration checks');
  }),
);
vi.mock('@modelcontextprotocol/client/stdio', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@modelcontextprotocol/client/stdio')>()),
  StdioClientTransport: spawnSpy,
}));

const NEVER_STARTED = {
  serverPath: 'never-started/server.js',
  settings: parseSourcesSettings({}),
  logger: { debug: () => undefined },
};

function fixtureAdapter(): FixtureSourceAdapter {
  return new FixtureSourceAdapter(NEVER_STARTED);
}

function backofficeAdapter(): BackofficeSourceAdapter {
  return new BackofficeSourceAdapter(NEVER_STARTED);
}

/** The real fixture source with `search_logs` declared writable; the server still marks it `readOnlyHint: true`. */
function writableSearchAdapter(): SourceAdapter {
  const fixture = fixtureAdapter();
  return {
    descriptor: {
      ...fixture.descriptor,
      tools: fixture.descriptor.tools.map((tool) =>
        tool.name === 'search_logs' ? { ...tool, readOnly: false } : tool,
      ),
    },
    call: (call) => fixture.call(call),
    currentSnapshot: (signal) => fixture.currentSnapshot(signal),
    close: () => fixture.close(),
  };
}

function caught(act: () => unknown): unknown {
  try {
    act();
  } catch (error) {
    return error;
  }
  throw new Error('expected the configuration to be rejected');
}

function declaredTool(name: string, description = `The ${name} tool of the test declaration.`): DeclaredTool {
  return { name, description };
}

function declaredSource(
  sourceId: string,
  tools: readonly DeclaredTool[],
  description = `The ${sourceId} test source.`,
): DeclaredSource {
  return { sourceId, description, tools };
}

const searchLogsOnly: SourceDeclaration = [declaredSource(FIXTURE_SOURCE_ID, [declaredTool('search_logs')])];

/** Both sources with the given back-office tools declared (by default both of its tools). */
function twoSources(
  backofficeTools: readonly DeclaredTool[] = [declaredTool('search_orders'), declaredTool('get_order')],
): SourceDeclaration {
  return [...searchLogsOnly, declaredSource(BACKOFFICE_SOURCE_ID, backofficeTools)];
}

/** A description that is not there at all (written as a literal: a default parameter would fill it in). */
const ABSENT = undefined as unknown as string;

// AC-11.3 / UC-E2, Flow 5: a wrong configuration is rejected before the fixture process starts.
describe('SourceRegistry factory and settings reject a wrong configuration before the process starts', () => {
  beforeEach(() => {
    spawnSpy.mockClear();
  });

  it.each([
    [
      'declared tool marked readOnly: false although the server marks it readOnlyHint',
      () => createSourceRegistry({ adapters: [writableSearchAdapter()], declaration: searchLogsOnly }),
      { sourceId: FIXTURE_SOURCE_ID, toolName: 'search_logs', message: expect.stringContaining('not read-only') },
    ],
    [
      'declared tool missing from the source descriptor',
      () =>
        createSourceRegistry({
          adapters: [fixtureAdapter()],
          declaration: [declaredSource(FIXTURE_SOURCE_ID, [declaredTool('delete_logs')])],
        }),
      { sourceId: FIXTURE_SOURCE_ID, toolName: 'delete_logs', message: expect.stringContaining('delete_logs') },
    ],
    [
      'two adapters with the same sourceId',
      () => createSourceRegistry({ adapters: [fixtureAdapter(), fixtureAdapter()], declaration: searchLogsOnly }),
      { sourceId: FIXTURE_SOURCE_ID, toolName: null, message: expect.stringContaining('duplicate') },
    ],
    [
      'FIXTURE_FAULTS without FIXTURE_CALL_LOG',
      () => parseSourcesSettings({ FIXTURE_FAULTS: 'faults.json' }),
      { message: expect.stringContaining('FIXTURE_FAULTS requires FIXTURE_CALL_LOG') },
    ],
  ])('%s', (_row, act, expected) => {
    expect(spawnSpy).not.toHaveBeenCalled();

    expect(caught(act)).toMatchObject(expected);

    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('accepts a read-only declaration without starting the process', () => {
    const registry = createSourceRegistry({ adapters: [fixtureAdapter()], declaration: searchLogsOnly });

    expect(registry.resolveTool({ workflowType: 'source.fetch', sourceId: FIXTURE_SOURCE_ID, toolName: 'search_logs' }))
      .toMatchObject({ tool: { name: 'search_logs', readOnly: true } });
    expect(registry.resolveTool({ workflowType: 'source.fetch', sourceId: FIXTURE_SOURCE_ID, toolName: 'get_trace' }))
      .toBeNull();
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

// AC-01.1, DC-1 (design-catalog-planning.md, KD-2): a declaration missing a description, with one over its limit, or
// naming a source no adapter connects does not start; the error names the source and the tool.
// Defect caught: the server starts with a source or tool the agents would see without a description.
describe('createSourceRegistry refuses a declaration', () => {
  beforeEach(() => {
    spawnSpy.mockClear();
  });

  const bothAdapters = (): readonly SourceAdapter[] => [fixtureAdapter(), backofficeAdapter()];

  it.each<[string, () => readonly SourceAdapter[], SourceDeclaration, Record<string, unknown>]>([
    [
      'no description of the source',
      bothAdapters,
      [...searchLogsOnly, { sourceId: BACKOFFICE_SOURCE_ID, description: ABSENT, tools: [declaredTool('get_order')] }],
      { sourceId: BACKOFFICE_SOURCE_ID, toolName: null, message: expect.stringContaining('no description') },
    ],
    [
      'a blank description of the source',
      bothAdapters,
      [...searchLogsOnly, declaredSource(BACKOFFICE_SOURCE_ID, [declaredTool('get_order')], '   ')],
      { sourceId: BACKOFFICE_SOURCE_ID, toolName: null, message: expect.stringContaining('no description') },
    ],
    [
      'no description of the tool get_order',
      bothAdapters,
      twoSources([declaredTool('search_orders'), { name: 'get_order', description: ABSENT }]),
      { sourceId: BACKOFFICE_SOURCE_ID, toolName: 'get_order', message: expect.stringContaining('no description') },
    ],
    [
      'a source description of 601 characters',
      bothAdapters,
      [...searchLogsOnly, declaredSource(BACKOFFICE_SOURCE_ID, [declaredTool('get_order')], 'd'.repeat(601))],
      { sourceId: BACKOFFICE_SOURCE_ID, toolName: null, message: expect.stringContaining('longer than 600') },
    ],
    [
      'a tool description of 301 characters',
      bothAdapters,
      twoSources([declaredTool('search_orders', 'd'.repeat(301))]),
      { sourceId: BACKOFFICE_SOURCE_ID, toolName: 'search_orders', message: expect.stringContaining('longer than 300') },
    ],
    [
      'a declared source without an adapter (DC-1)',
      () => [fixtureAdapter()],
      twoSources(),
      { sourceId: BACKOFFICE_SOURCE_ID, toolName: null, message: expect.stringContaining('no adapter') },
    ],
    [
      'a connected source without a declaration',
      bothAdapters,
      searchLogsOnly,
      { sourceId: BACKOFFICE_SOURCE_ID, toolName: null, message: expect.stringContaining('no declaration') },
    ],
  ])('%s', (_row, adapters, declaration, expected) => {
    expect(caught(() => createSourceRegistry({ adapters: adapters(), declaration }))).toMatchObject(expected);

    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it('accepts descriptions at their limits and gives them back by source and tool', () => {
    const sourceText = 's'.repeat(600);
    const toolText = 't'.repeat(300);
    const registry = createSourceRegistry({
      adapters: bothAdapters(),
      declaration: [...searchLogsOnly, declaredSource(BACKOFFICE_SOURCE_ID, [declaredTool('get_order', toolText)], sourceText)],
    });

    expect(registry.describeSource(BACKOFFICE_SOURCE_ID)).toBe(sourceText);
    expect(registry.resolveTool({ workflowType: 'source.fetch', sourceId: BACKOFFICE_SOURCE_ID, toolName: 'get_order' }))
      .toMatchObject({ tool: { name: 'get_order', readOnly: true }, description: toolText });
    // The declared tools are the `source.fetch` allowlist: an undeclared tool or another workflow type stays out.
    expect(registry.resolveTool({ workflowType: 'source.fetch', sourceId: BACKOFFICE_SOURCE_ID, toolName: 'search_orders' }))
      .toBeNull();
    expect(registry.resolveTool({ workflowType: 'other.workflow', sourceId: BACKOFFICE_SOURCE_ID, toolName: 'get_order' }))
      .toBeNull();
    expect(() => registry.describeSource('elastic')).toThrow('source elastic is not declared');
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

// design-mcp-source.md, Contract Definitions: the empty registry (fixture not installed) answers "no adapter".
describe('SourceRegistry.currentSnapshot', () => {
  it('throws "no adapter" for a source without an adapter', async () => {
    const registry = createSourceRegistry({ adapters: [], declaration: [] });

    await expect(registry.currentSnapshot(FIXTURE_SOURCE_ID, new AbortController().signal)).rejects.toThrow(
      `no adapter for source ${FIXTURE_SOURCE_ID}`,
    );
  });
});
