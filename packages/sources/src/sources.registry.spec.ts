import { FIXTURE_SOURCE_ID, FixtureSourceAdapter } from './fixture/fixture-source.adapter.js';
import type { SourceAdapter } from './source-adapter.js';
import { createSourceRegistry, type SourceAllowlist } from './source-registry.js';
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

function fixtureAdapter(): FixtureSourceAdapter {
  return new FixtureSourceAdapter({
    serverPath: 'never-started/server.js',
    settings: parseSourcesSettings({}),
    logger: { debug: () => undefined },
  });
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

const searchLogsOnly: SourceAllowlist = { 'source.fetch': [{ sourceId: FIXTURE_SOURCE_ID, toolName: 'search_logs' }] };

// AC-11.3 / UC-E2, Flow 5: a wrong configuration is rejected before the fixture process starts.
describe('SourceRegistry factory and settings reject a wrong configuration before the process starts', () => {
  beforeEach(() => {
    spawnSpy.mockClear();
  });

  it.each([
    [
      'allowlisted tool declared readOnly: false although the server marks it readOnlyHint',
      () => createSourceRegistry({ adapters: [writableSearchAdapter()], allowlist: searchLogsOnly }),
      { sourceId: FIXTURE_SOURCE_ID, toolName: 'search_logs', message: expect.stringContaining('not read-only') },
    ],
    [
      'allowlisted tool missing from the source descriptor',
      () =>
        createSourceRegistry({
          adapters: [fixtureAdapter()],
          allowlist: { 'source.fetch': [{ sourceId: FIXTURE_SOURCE_ID, toolName: 'delete_logs' }] },
        }),
      { sourceId: FIXTURE_SOURCE_ID, toolName: 'delete_logs', message: expect.stringContaining('delete_logs') },
    ],
    [
      'allowlisted source without an adapter',
      () =>
        createSourceRegistry({
          adapters: [fixtureAdapter()],
          allowlist: { 'source.fetch': [{ sourceId: 'elastic', toolName: 'search_logs' }] },
        }),
      { sourceId: 'elastic', toolName: 'search_logs', message: expect.stringContaining('elastic') },
    ],
    [
      'two adapters with the same sourceId',
      () => createSourceRegistry({ adapters: [fixtureAdapter(), fixtureAdapter()], allowlist: searchLogsOnly }),
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

  it('accepts a read-only allowlist without starting the process', () => {
    const registry = createSourceRegistry({ adapters: [fixtureAdapter()], allowlist: searchLogsOnly });

    expect(registry.resolveTool({ workflowType: 'source.fetch', sourceId: FIXTURE_SOURCE_ID, toolName: 'search_logs' }))
      .toMatchObject({ tool: { name: 'search_logs', readOnly: true } });
    expect(registry.resolveTool({ workflowType: 'source.fetch', sourceId: FIXTURE_SOURCE_ID, toolName: 'get_trace' }))
      .toBeNull();
    expect(spawnSpy).not.toHaveBeenCalled();
  });
});

// design-mcp-source.md, Contract Definitions: the empty registry (fixture not installed) answers "no adapter".
describe('SourceRegistry.currentSnapshot', () => {
  it('throws "no adapter" for a source without an adapter', async () => {
    const registry = createSourceRegistry({ adapters: [], allowlist: {} });

    await expect(registry.currentSnapshot(FIXTURE_SOURCE_ID, new AbortController().signal)).rejects.toThrow(
      `no adapter for source ${FIXTURE_SOURCE_ID}`,
    );
  });
});
