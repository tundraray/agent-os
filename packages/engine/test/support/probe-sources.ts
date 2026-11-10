import { parseSourcesSettings, type SourceAdapter, type SourceSchema } from '@agent-os/sources';
import { z } from 'zod';
import type { ToolRegistryEntry } from '../../src/agents/tool-registry.js';
import type { HarnessSource } from './engineHarness.js';

/**
 * The two sources of the probe process's `{{sources}}` cases (design-agent-core.md, UC-16, UC-2) and a tool marked as
 * reading the run's sources. No test calls them: the value of the field is what is proved, so `call` only answers.
 */

const PROBE_SOURCE_TOOL = 'search';
export const PROBE_SOURCE_PAIRS = [
  { sourceId: 'alpha', toolName: PROBE_SOURCE_TOOL },
  { sourceId: 'beta', toolName: PROBE_SOURCE_TOOL },
] as const;
export const PROBE_SOURCE_IDS = PROBE_SOURCE_PAIRS.map((pair) => pair.sourceId);

const PROBE_ARGS: SourceSchema = z.strictObject({ query: z.string(), limit: z.number().default(10) });
const anyValue: SourceSchema = { safeParse: (value) => ({ success: true, data: value }) };

/** The tool that allows `{{sources}}` on a probe definition; the scripted model never calls it. */
export const PROBE_READS_SOURCES_TOOL: ToolRegistryEntry = {
  name: 'probe_reads_sources',
  description: 'Reads the sources of this run.',
  argsSchema: z.strictObject({}),
  effect: 'read',
  resultMaxBytes: 1_024,
  readsRunSources: true,
};

function probeAdapter(sourceId: string, argsSchema: SourceSchema): SourceAdapter {
  return {
    descriptor: {
      sourceId,
      tools: [{ name: PROBE_SOURCE_TOOL, paginated: false, readOnly: true, argsSchema, resultSchema: anyValue }],
    },
    call: () =>
      Promise.resolve({
        kind: 'page',
        page: { snapshot: 'probe-v1', items: [], returned: 0, totalMatched: 0, totalRelation: 'eq', nextCursor: null, exhausted: true },
      }),
    currentSnapshot: () => Promise.resolve('probe-v1'),
    close: () => Promise.resolve(),
  };
}

/** The sources `alpha` and `beta` of one assembly; `betaArgs` replaces the argument schema of `beta`. */
export function probeSources(options: { readonly betaArgs?: SourceSchema } = {}): HarnessSource {
  return {
    settings: parseSourcesSettings({ SOURCE_RETRY_BASE_MS: '10', SOURCE_RETRY_CAP_MS: '50' }),
    declaration: PROBE_SOURCE_IDS.map((sourceId) => ({
      sourceId,
      description: `Probe source ${sourceId} of the {{sources}} cases.`,
      tools: [{ name: PROBE_SOURCE_TOOL, description: 'Searches the probe source; never called.' }],
    })),
    adapter: () => probeAdapter('alpha', PROBE_ARGS),
    extraAdapters: () => [probeAdapter('beta', options.betaArgs ?? PROBE_ARGS)],
  };
}
