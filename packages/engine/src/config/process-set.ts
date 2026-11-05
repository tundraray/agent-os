import type { ProcessConfig, ProcessConfigRejection } from './process-config.schema.js';

export type ProcessResolution =
  | { readonly ok: true; readonly config: ProcessConfig }
  | { readonly ok: false; readonly code: 'process_unknown' };

export interface ProcessSet {
  /** Without a version, the highest loaded version of the process (DC-15). */
  resolve(processId: string, version?: number): ProcessResolution;
}

export type CreateProcessSetResult =
  | { readonly ok: true; readonly set: ProcessSet }
  | { readonly ok: false; readonly rejection: ProcessConfigRejection };

const UNKNOWN: ProcessResolution = { ok: false, code: 'process_unknown' };

/**
 * The loaded processes keyed by the pair `processId` + `version`: versions of one process load side by side, and only a
 * repeated pair is refused, at the index of the repeated configuration.
 */
export function createProcessSet(configs: readonly ProcessConfig[]): CreateProcessSetResult {
  const versionsById = new Map<string, Map<number, ProcessConfig>>();
  for (const [index, config] of configs.entries()) {
    const versions = versionsById.get(config.processId) ?? new Map<number, ProcessConfig>();
    if (versions.has(config.version)) {
      return {
        ok: false,
        rejection: {
          code: 'process_config_rejected',
          path: [index],
          message: `${config.processId} version ${config.version} is loaded twice`,
        },
      };
    }
    versions.set(config.version, config);
    versionsById.set(config.processId, versions);
  }

  return {
    ok: true,
    set: {
      resolve(processId, version) {
        const versions = versionsById.get(processId);
        if (versions === undefined) {
          return UNKNOWN;
        }
        const config = versions.get(version ?? Math.max(...versions.keys()));
        return config === undefined ? UNKNOWN : { ok: true, config };
      },
    },
  };
}
