import type { SourceRegistry } from '@agent-os/sources';
import type { ProcessConfig } from '../config/process-config.schema.js';
import type { FetchToolLookup } from '../controller/decision-gate.js';
import type { Decision } from '../controller/decision.schema.js';
import { proposeAnalysis } from './analyze.js';
import { type DecisionFrame, type GatherDeps, type ProposedTasks, proposeGather } from './gather.js';
import { SOURCE_FETCH_WORKFLOW } from './gather-key.js';

export interface CapabilityRegistryDeps extends GatherDeps {
  readonly sources: Pick<SourceRegistry, 'resolveTool' | 'currentSnapshot'>;
}

/**
 * The capabilities of the engine that turn an accepted decision into runtime tasks (design-engine.md, C3:
 * `CapabilityRegistry`). `plan` and `wait` run inside the controller task and are not here.
 */
export interface CapabilityRegistry {
  /**
   * The tools a configuration's decisions may fetch from, with their argument schemas: a pair the configuration lists
   * in `sources` that the source registry allows `source.fetch` to call.
   */
  fetchTools(config: ProcessConfig): FetchToolLookup;
  /** Proposes the tasks of an accepted decision; `undefined` when no capability of this release executes its kind. */
  proposeTasks(frame: DecisionFrame, decision: Decision): Promise<ProposedTasks> | undefined;
}

export function createCapabilityRegistry(deps: CapabilityRegistryDeps): CapabilityRegistry {
  return {
    fetchTools: (config) => (request) => {
      const listed = config.sources.some(
        (source) => source.sourceId === request.sourceId && source.toolName === request.toolName,
      );
      if (!listed) return null;
      return deps.sources.resolveTool({ workflowType: SOURCE_FETCH_WORKFLOW, ...request })?.tool ?? null;
    },
    proposeTasks: (frame, decision) => {
      switch (decision.kind) {
        case 'requestEvidence':
          return proposeGather(deps, frame, decision);
        case 'requestAnalysis':
          return proposeAnalysis(deps, frame, decision);
        default:
          return undefined;
      }
    },
  };
}
