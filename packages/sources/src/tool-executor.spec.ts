import { systemClock } from '@agent-os/runtime';
import { z } from 'zod';
import { InMemoryTaskContext } from '../test/support/inMemoryTaskContext.js';
import { FetchHandler } from './fetch.handler.js';
import type { CallOutcome, SourceAdapter, SourceCall } from './source-adapter.js';
import { createSourceRegistry } from './source-registry.js';
import { parseSourcesSettings } from './sources.settings.js';
import { ToolExecutor } from './tool-executor.js';

const STUB_SOURCE_ID = 'stub-catalog';
const STUB_TOOL = 'list_items';
const STUB_SNAPSHOT = 'stub-v1';

/** A second source that is not MCP: no process, no client, two pages served from memory. */
function stubAdapter(): SourceAdapter & { readonly calls: SourceCall[] } {
  const calls: SourceCall[] = [];
  const pages: Record<string, CallOutcome> = {
    first: {
      kind: 'page',
      page: { snapshot: STUB_SNAPSHOT, items: ['a', 'b'], returned: 2, totalMatched: 3, totalRelation: 'eq', nextCursor: 'p2', exhausted: false },
    },
    p2: {
      kind: 'page',
      page: { snapshot: STUB_SNAPSHOT, items: ['c'], returned: 1, totalMatched: 3, totalRelation: 'eq', nextCursor: null, exhausted: true },
    },
  };
  return {
    calls,
    descriptor: {
      sourceId: STUB_SOURCE_ID,
      tools: [
        {
          name: STUB_TOOL,
          paginated: true,
          readOnly: true,
          argsSchema: z.object({ category: z.string() }),
          resultSchema: z.unknown(),
        },
      ],
    },
    call(call) {
      calls.push(call);
      return Promise.resolve(pages[call.cursor ?? 'first']);
    },
    currentSnapshot: () => Promise.resolve(STUB_SNAPSHOT),
    close: () => Promise.resolve(),
  };
}

// AC-16.1 / UC-7: a non-MCP adapter plugs in through its descriptor, snapshot and allowlist row alone.
// Defect caught: ToolExecutor bound to the MCP client or FixtureSourceAdapter instead of the SourceAdapter port.
describe('ToolExecutor with a second, non-MCP source adapter', () => {
  it('should complete a source.fetch with the same provenance format when the stub adapter is allowlisted', async () => {
    const adapter = stubAdapter();
    const registry = createSourceRegistry({
      adapters: [adapter],
      allowlist: { 'source.fetch': [{ sourceId: STUB_SOURCE_ID, toolName: STUB_TOOL }] },
    });
    const pinned = await registry.currentSnapshot(STUB_SOURCE_ID, new AbortController().signal);
    const ctx = new InMemoryTaskContext({
      maxToolCalls: 5,
      maxRetries: 1,
      completeness: 'all',
      input: { sourceId: STUB_SOURCE_ID, toolName: STUB_TOOL, args: { category: 'books' } },
      inputRefs: [{ kind: 'source', ref: STUB_SOURCE_ID, snapshot: pinned }],
    });
    const handler = new FetchHandler(
      new ToolExecutor({
        registry,
        settings: parseSourcesSettings({}),
        clock: systemClock,
        logger: { debug: () => undefined, warn: () => undefined, error: () => undefined },
      }),
    );

    const result = await handler.run(ctx);

    expect(result).toMatchObject({
      kind: 'completed',
      evidenceRefs: ctx.evidence.map((record) => record.ref.evidenceId),
      coverage: { completeness: 'complete', returned: 3, truncated: false },
    });
    expect(adapter.calls.map((call) => call.cursor)).toEqual([null, 'p2']);
    expect(ctx.evidence.map((record) => [record.input.evidenceKey, record.input.provenance])).toEqual([
      [
        'page-0001',
        { sourceId: STUB_SOURCE_ID, toolName: STUB_TOOL, normalizedArgs: { category: 'books', cursor: null }, snapshot: 'stub-v1' },
      ],
      [
        'page-0002',
        { sourceId: STUB_SOURCE_ID, toolName: STUB_TOOL, normalizedArgs: { category: 'books', cursor: 'p2' }, snapshot: 'stub-v1' },
      ],
    ]);
  });
});
