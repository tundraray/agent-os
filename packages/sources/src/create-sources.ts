import type { Clock, HandlerRegistry } from '@agent-os/runtime';
import { FetchHandler } from './fetch.handler.js';
import type { SourceAdapter } from './source-adapter.js';
import type { SourceDeclaration } from './source-declaration.js';
import { createSourceRegistry, type SourceRegistry } from './source-registry.js';
import type { SourcesLogger } from './sources-logger.js';
import type { SourcesSettings } from './sources.settings.js';
import { ToolExecutor } from './tool-executor.js';

export interface CreateSourcesOptions {
  /** `runtime.handlers`: `source.fetch` is registered here, before the runtime's workers start. */
  readonly handlers: HandlerRegistry;
  /** Adapters of the connected sources; `createSources` owns them from here on and closes them in `close()`. */
  readonly adapters: readonly SourceAdapter[];
  /** The declared sources with their descriptions; its tools are the `source.fetch` allowlist. */
  readonly declaration: SourceDeclaration;
  readonly settings: SourcesSettings;
  readonly clock: Clock;
  readonly logger: SourcesLogger;
}

export interface Sources {
  readonly registry: SourceRegistry;
  /** Closes every adapter (their processes); call after the runtime's workers have stopped. */
  close(): Promise<void>;
}

/**
 * Assembly function of the sources package (design-catalog-planning.md, KD-2): checks the declaration against the
 * adapters' descriptors — every declared source has an adapter, every source and tool a description within its
 * length, every declared tool is read-only — then registers the `source.fetch` handler. A refused configuration
 * throws with `sourceId` and `toolName` (AC-11.3, AC-01.1) before anything is registered or any process is started.
 */
export function createSources(options: CreateSourcesOptions): Sources {
  const { handlers, adapters, declaration, settings, clock, logger } = options;
  const registry = createSourceRegistry({ adapters, declaration });
  handlers.register(new FetchHandler(new ToolExecutor({ registry, settings, clock, logger })));
  return { registry, close: () => closeAdapters(adapters) };
}

/** Closes all adapters even when one fails; the failures are rethrown together. */
async function closeAdapters(adapters: readonly SourceAdapter[]): Promise<void> {
  const results = await Promise.allSettled(adapters.map((adapter) => adapter.close()));
  const failures = results.flatMap((result) => (result.status === 'rejected' ? [result.reason as unknown] : []));
  if (failures.length > 0) {
    throw new AggregateError(failures, `${failures.length} source adapter(s) failed to close`);
  }
}
