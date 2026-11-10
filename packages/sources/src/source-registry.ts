import type { SourceAdapter, SourceToolDescriptor } from './source-adapter.js';
import {
  SOURCE_DESCRIPTION_MAX_CHARS,
  SOURCE_FETCH_WORKFLOW,
  TOOL_DESCRIPTION_MAX_CHARS,
  type DeclaredSource,
  type SourceDeclaration,
} from './source-declaration.js';

export interface SourceToolRequest {
  readonly workflowType: string;
  readonly sourceId: string;
  readonly toolName: string;
}

export interface ResolvedSourceTool {
  readonly adapter: SourceAdapter;
  readonly tool: SourceToolDescriptor;
  /** The tool's description from the declaration. */
  readonly description: string;
}

export interface SourceRegistry {
  /** The declared tool, its adapter and description; null when the workflow type may not call it. */
  resolveTool(request: SourceToolRequest): ResolvedSourceTool | null;
  /** The declared description of a connected source; an unknown source is an exception. */
  describeSource(sourceId: string): string;
  /** The source's current snapshot; no adapter for `sourceId` and an adapter failure are exceptions. */
  currentSnapshot(sourceId: string, signal: AbortSignal): Promise<string>;
}

/** A configuration the registry refuses at startup (AC-11.3, AC-01.1). `toolName` is null for a source-level fault. */
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

/** The reason a description is refused, or null when it is present and within `maxChars` characters. */
function descriptionFault(description: string | undefined, maxChars: number): string | null {
  if (description === undefined || description.trim().length === 0) {
    return 'no description';
  }
  const length = Array.from(description).length;
  return length > maxChars ? `description is ${length} characters, longer than ${maxChars}` : null;
}

/** Only the project's descriptor decides: the server's own `readOnlyHint` is never read, so nothing is started. */
function checkDeclaredSource(source: DeclaredSource, adapters: ReadonlyMap<string, SourceAdapter>): void {
  const { sourceId } = source;
  const sourceFault = descriptionFault(source.description, SOURCE_DESCRIPTION_MAX_CHARS);
  if (sourceFault !== null) {
    throw new SourceConfigurationError(sourceId, null, sourceFault);
  }
  const adapter = adapters.get(sourceId);
  if (adapter === undefined) {
    throw new SourceConfigurationError(sourceId, null, `no adapter for source ${sourceId}`);
  }
  const seen = new Set<string>();
  for (const declared of source.tools) {
    const toolName = declared.name;
    if (seen.has(toolName)) {
      throw new SourceConfigurationError(sourceId, toolName, 'tool declared twice');
    }
    seen.add(toolName);
    const toolFault = descriptionFault(declared.description, TOOL_DESCRIPTION_MAX_CHARS);
    if (toolFault !== null) {
      throw new SourceConfigurationError(sourceId, toolName, toolFault);
    }
    const tool = adapter.descriptor.tools.find((candidate) => candidate.name === toolName);
    if (tool === undefined) {
      throw new SourceConfigurationError(sourceId, toolName, `${toolName} is not in the descriptor`);
    }
    if (!tool.readOnly) {
      throw new SourceConfigurationError(sourceId, toolName, 'the tool is not read-only');
    }
  }
}

function indexDeclaration(
  declaration: SourceDeclaration,
  adapters: ReadonlyMap<string, SourceAdapter>,
): ReadonlyMap<string, DeclaredSource> {
  const bySourceId = new Map<string, DeclaredSource>();
  for (const source of declaration) {
    if (bySourceId.has(source.sourceId)) {
      throw new SourceConfigurationError(source.sourceId, null, 'source declared twice');
    }
    checkDeclaredSource(source, adapters);
    bySourceId.set(source.sourceId, source);
  }
  for (const sourceId of adapters.keys()) {
    if (!bySourceId.has(sourceId)) {
      throw new SourceConfigurationError(sourceId, null, 'a connected source has no declaration');
    }
  }
  return bySourceId;
}

/**
 * Checks the declaration against the adapters' descriptors (design-catalog-planning.md, KD-2) and builds the
 * registry. Runs before any adapter is called; the first violation throws with `sourceId` and `toolName`. The
 * declared tools are the `source.fetch` allowlist. No adapters and an empty declaration give the empty registry,
 * whose `currentSnapshot` answers "no adapter".
 */
export function createSourceRegistry(config: {
  adapters: readonly SourceAdapter[];
  declaration: SourceDeclaration;
}): SourceRegistry {
  const adapters = indexAdapters(config.adapters);
  const declared = indexDeclaration(config.declaration, adapters);
  const adapterOf = (sourceId: string): SourceAdapter => {
    const adapter = adapters.get(sourceId);
    if (adapter === undefined) {
      throw new Error(`no adapter for source ${sourceId}`);
    }
    return adapter;
  };

  return {
    resolveTool({ workflowType, sourceId, toolName }) {
      if (workflowType !== SOURCE_FETCH_WORKFLOW) {
        return null;
      }
      const declaredTool = declared.get(sourceId)?.tools.find((candidate) => candidate.name === toolName);
      if (declaredTool === undefined) {
        return null;
      }
      const adapter = adapterOf(sourceId);
      const tool = adapter.descriptor.tools.find((candidate) => candidate.name === toolName);
      if (tool === undefined) {
        // Checked at construction: a declared tool always has its descriptor.
        throw new Error(`${toolName} of source ${sourceId} vanished from the descriptor`);
      }
      return { adapter, tool, description: declaredTool.description };
    },
    describeSource(sourceId) {
      const source = declared.get(sourceId);
      if (source === undefined) {
        throw new Error(`source ${sourceId} is not declared`);
      }
      return source.description;
    },
    async currentSnapshot(sourceId, signal) {
      return adapterOf(sourceId).currentSnapshot(signal);
    },
  };
}
