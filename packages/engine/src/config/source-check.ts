import type { SourceRegistry } from '@agent-os/sources';
import type { ProcessConfig, ProcessConfigRejection } from './process-config.schema.js';

/** `sources` when the deployment has a connected source, `model_knowledge` when it has none (KD-8). */
export type SourceMode = 'sources' | 'model_knowledge';

const SOURCE_FETCH = 'source.fetch';

export type SourceCheckResult =
  | { readonly ok: true; readonly sourceMode: SourceMode; readonly warnNoSources: boolean }
  | { readonly ok: false; readonly rejection: ProcessConfigRejection };

/**
 * With a connected source, every configured pair of a configuration of either form must resolve through the
 * `source.fetch` allowlist (DC-14); the path is `[configIndex, 'sources', sourceIndex]`. Without one there is nothing to check against: the engine runs on model
 * knowledge and its creation writes one warning (DC-18).
 */
export function checkProcessSources(input: {
  readonly configs: readonly Pick<ProcessConfig, 'processId' | 'version' | 'sources'>[];
  readonly registry: Pick<SourceRegistry, 'resolveTool'>;
  readonly connectedSources: readonly string[];
}): SourceCheckResult {
  if (input.connectedSources.length === 0) {
    return { ok: true, sourceMode: 'model_knowledge', warnNoSources: true };
  }
  for (const [configIndex, config] of input.configs.entries()) {
    for (const [sourceIndex, { sourceId, toolName }] of config.sources.entries()) {
      if (input.registry.resolveTool({ workflowType: SOURCE_FETCH, sourceId, toolName }) === null) {
        return {
          ok: false,
          rejection: {
            code: 'process_config_rejected',
            path: [configIndex, 'sources', sourceIndex],
            message: `${sourceId}/${toolName} of ${config.processId} version ${config.version} is not allowed for ${SOURCE_FETCH}`,
          },
        };
      }
    }
  }
  return { ok: true, sourceMode: 'sources', warnNoSources: false };
}
