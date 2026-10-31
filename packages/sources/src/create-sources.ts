import type { Clock, HandlerRegistry } from '@agent-os/runtime';
import { FetchHandler } from './fetch.handler.js';
import type { SourceAdapter } from './source-adapter.js';
import { createSourceRegistry, type SourceAllowlist, type SourceRegistry } from './source-registry.js';
import type { SourcesLogger } from './sources-logger.js';
import type { SourcesSettings } from './sources.settings.js';
import { ToolExecutor } from './tool-executor.js';

export interface CreateSourcesOptions {
  /** `runtime.handlers`: `source.fetch` is registered here, before the runtime's workers start. */
  readonly handlers: HandlerRegistry;
  /** Adapters of the connected sources; `createSources` owns them from here on and closes them in `close()`. */
  readonly adapters: readonly SourceAdapter[];
  readonly allowlist: SourceAllowlist;
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
 * Assembly function of the sources package (design-mcp-source.md, Contract Definitions): checks the allowlist
 * against the adapters' descriptors, then registers the `source.fetch` handler. A refused configuration throws
 * with `sourceId` and `toolName` (AC-11.3) before anything is registered or any source process is started.
 */
export function createSources(options: CreateSourcesOptions): Sources {
  const { handlers, adapters, allowlist, settings, clock, logger } = options;
  const registry = createSourceRegistry({ adapters, allowlist });
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
