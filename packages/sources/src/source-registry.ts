import type { SourceAdapter, SourceToolDescriptor } from './source-adapter.js';

export interface AllowlistedTool {
  readonly sourceId: string;
  readonly toolName: string;
}

/** `workflowType` → the tools that workflow type may call (`sources.config.ts` of the assembly point). */
export type SourceAllowlist = Readonly<Record<string, readonly AllowlistedTool[]>>;

export interface SourceToolRequest extends AllowlistedTool {
  readonly workflowType: string;
}

export interface ResolvedSourceTool {
  readonly adapter: SourceAdapter;
  readonly tool: SourceToolDescriptor;
}

export interface SourceRegistry {
  /** The allowlisted tool and its adapter; null when the workflow type may not call it. */
  resolveTool(request: SourceToolRequest): ResolvedSourceTool | null;
  /** The source's current snapshot; no adapter for `sourceId` and an adapter failure are exceptions. */
  currentSnapshot(sourceId: string, signal: AbortSignal): Promise<string>;
}

/** A configuration the registry refuses at startup (AC-11.3). `toolName` is null for a source-level fault. */
class SourceConfigurationError extends Error {
  override readonly name = 'SourceConfigurationError';

  constructor(
    readonly sourceId: string,
    readonly toolName: string | null,
    reason: string,
  ) {
    super(`source configuration rejected (sourceId ${sourceId}, toolName ${toolName ?? '-'}): ${reason}`);
  }
}

function indexAdapters(adapters: readonly SourceAdapter[]): ReadonlyMap<string, SourceAdapter> {
  const bySourceId = new Map<string, SourceAdapter>();
  for (const adapter of adapters) {
    const { sourceId } = adapter.descriptor;
    if (bySourceId.has(sourceId)) {
      throw new SourceConfigurationError(sourceId, null, 'duplicate sourceId');
    }
    bySourceId.set(sourceId, adapter);
  }
  return bySourceId;
}

/** Only the project's descriptor decides: the server's own `readOnlyHint` is never read, so nothing is started. */
function checkAllowlisted(entry: AllowlistedTool, adapters: ReadonlyMap<string, SourceAdapter>): void {
  const adapter = adapters.get(entry.sourceId);
  if (adapter === undefined) {
    throw new SourceConfigurationError(entry.sourceId, entry.toolName, `no adapter for source ${entry.sourceId}`);
  }
  const tool = adapter.descriptor.tools.find((candidate) => candidate.name === entry.toolName);
  if (tool === undefined) {
    throw new SourceConfigurationError(entry.sourceId, entry.toolName, `${entry.toolName} is not in the descriptor`);
  }
  if (!tool.readOnly) {
    throw new SourceConfigurationError(entry.sourceId, entry.toolName, 'the tool is not read-only');
  }
}

/**
 * Checks the allowlist against the adapters' descriptors (design-mcp-source.md, SourceDescriptor и allowlist) and
 * builds the registry. Runs before any adapter is called; the first violation throws. No adapters and an empty
 * allowlist give the empty registry, whose `currentSnapshot` answers "no adapter".
 */
export function createSourceRegistry(config: {
  adapters: readonly SourceAdapter[];
  allowlist: SourceAllowlist;
}): SourceRegistry {
  const adapters = indexAdapters(config.adapters);
  for (const entries of Object.values(config.allowlist)) {
    for (const entry of entries) {
      checkAllowlisted(entry, adapters);
    }
  }
  const adapterOf = (sourceId: string): SourceAdapter => {
    const adapter = adapters.get(sourceId);
    if (adapter === undefined) {
      throw new Error(`no adapter for source ${sourceId}`);
    }
    return adapter;
  };

  return {
    resolveTool({ workflowType, sourceId, toolName }) {
      const allowed = (config.allowlist[workflowType] ?? []).some(
        (entry) => entry.sourceId === sourceId && entry.toolName === toolName,
      );
      if (!allowed) {
        return null;
      }
      const adapter = adapterOf(sourceId);
      const tool = adapter.descriptor.tools.find((candidate) => candidate.name === toolName);
      if (tool === undefined) {
        // Checked at construction: an allowlisted pair always has its descriptor.
        throw new Error(`${toolName} of source ${sourceId} vanished from the descriptor`);
      }
      return { adapter, tool };
    },
    async currentSnapshot(sourceId, signal) {
      return adapterOf(sourceId).currentSnapshot(signal);
    },
  };
}
