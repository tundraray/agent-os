import type { SourceRegistry } from '@agent-os/sources';
import { z } from 'zod';
import type { ToolAccessPolicy } from '../agents/tool-access-policy.js';
import type { AgentProcessConfig } from '../config/agent-config.schema.js';
import type { SourceMode } from '../config/source-check.js';

const SOURCE_FETCH = 'source.fetch';

/** A tool of a catalog source: one of the process ceiling's, with its declared description. */
export interface CatalogTool {
  readonly toolName: string;
  readonly description: string;
}

/** A source of the catalog before its slice is read. */
export interface CatalogCandidate {
  readonly sourceId: string;
  readonly description: string;
  readonly tools: readonly CatalogTool[];
}

/** A source of an investigation's catalog: its description, ceiling tools and the slice read at start, or null. */
export interface CatalogSource extends CatalogCandidate {
  readonly snapshot: string | null;
}

/**
 * The investigation's source catalog (design-catalog-planning.md, KD-1, Data Model): written once at start in
 * `research_engine_runs.source_catalog` and never changed; by `sourceId` in code point order. Empty is the mode without
 * sources.
 */
export type SourceCatalog = readonly CatalogSource[];

/** The stored form of the catalog, as `source_catalog` holds it. */
export const SourceCatalogSchema: z.ZodType<SourceCatalog> = z.array(
  z.object({
    sourceId: z.string(),
    description: z.string(),
    tools: z.array(z.object({ toolName: z.string(), description: z.string() })),
    snapshot: z.string().nullable(),
  }),
);

export interface SourceCatalogDeps {
  readonly sources: Pick<SourceRegistry, 'describeSource' | 'resolveTool'>;
  readonly accessPolicy: ToolAccessPolicy;
}

export interface SourceCatalogInput {
  /** The investigation's owner, whom the rights port is asked about. */
  readonly resourceId: string;
  /** The process ceiling: the configured source and tool pairs. */
  readonly config: Pick<AgentProcessConfig, 'sources'>;
  /** `sourceId` of the sources the deployment connected (`connectedSources` of `createEngine`). */
  readonly connectedSources: readonly string[];
}

/** UTF-8 byte order is code point order, so equal catalogs give equal template fields byte for byte. */
const byCodePoints = (left: string, right: string): number => Buffer.compare(Buffer.from(left), Buffer.from(right));

/**
 * The catalog candidates of a start (KD-1, DC-3): the sources that are connected, named in the process ceiling and
 * allowed to the owner by the rights port asked about the source as a whole (`toolName: null`). Only connected ceiling
 * sources are asked about. Descriptions come from the source registry; sources and tools are in code point order.
 */
export async function buildSourceCatalog(
  deps: SourceCatalogDeps,
  input: SourceCatalogInput,
): Promise<readonly CatalogCandidate[]> {
  const connected = new Set(input.connectedSources);
  const ceiling = new Map<string, Set<string>>();
  for (const { sourceId, toolName } of input.config.sources) {
    if (!connected.has(sourceId)) continue;
    ceiling.set(sourceId, (ceiling.get(sourceId) ?? new Set()).add(toolName));
  }
  const sourceIds = [...ceiling.keys()].sort(byCodePoints);
  const decisions = await Promise.all(
    sourceIds.map((sourceId) =>
      Promise.resolve(deps.accessPolicy.decide({ resourceId: input.resourceId, toolName: null, sourceId })),
    ),
  );
  return sourceIds
    .filter((_, index) => decisions[index] === 'allowed')
    .map((sourceId) => ({
      sourceId,
      description: deps.sources.describeSource(sourceId),
      tools: [...(ceiling.get(sourceId) ?? [])].sort(byCodePoints).map((toolName) => ({
        toolName,
        description: describeTool(deps.sources, sourceId, toolName),
      })),
    }));
}

/** The mode of an investigation by its catalog (KD-1, DC-10): an empty catalog runs on model knowledge. */
export function catalogSourceMode(catalog: readonly CatalogCandidate[]): SourceMode {
  return catalog.length === 0 ? 'model_knowledge' : 'sources';
}

function describeTool(
  sources: Pick<SourceRegistry, 'resolveTool'>,
  sourceId: string,
  toolName: string,
): string {
  const resolved = sources.resolveTool({ workflowType: SOURCE_FETCH, sourceId, toolName });
  // The engine's creation checked every ceiling pair of a connected source against the registry (DC-14).
  if (resolved === null) throw new Error(`${sourceId}/${toolName} of the process ceiling does not resolve`);
  return resolved.description;
}
