import type { SourceRegistry, SourceSchema } from '@agent-os/sources';
import { z } from 'zod';
import type { ProcessConfig } from '../config/process-config.schema.js';
import type { FetchToolLookup } from '../controller/decision-gate.js';
import type { Decision } from '../controller/decision.schema.js';
import { proposeAnalysis } from './analyze.js';
import { type DecisionFrame, type GatherDeps, type ProposedTasks, proposeGather } from './gather.js';
import { SOURCE_FETCH_WORKFLOW } from './gather-key.js';
import { proposeSynthesis } from './synthesize.js';
import { proposeVerification } from './verify.js';

/**
 * A tool the role may fetch from, as its input shows it (DecisionInput `tools`, the verifier's assignment): the pair and
 * the JSON schema of its arguments from the descriptor `SourceRegistry.resolveTool` returns.
 */
export interface FetchToolLine {
  readonly sourceId: string;
  readonly toolName: string;
  readonly argsSchema: Readonly<Record<string, unknown>>;
}

/**
 * The argument schema as JSON schema, in its input form (defaults optional). A descriptor schema that is not a zod schema
 * cannot be described to the model: that is an assembly defect, so it throws naming the pair.
 */
function argsJsonSchema(schema: SourceSchema, pair: { sourceId: string; toolName: string }): Record<string, unknown> {
  if (!(schema instanceof z.ZodType)) {
    throw new Error(`the argument schema of ${pair.sourceId}/${pair.toolName} is not a zod schema: it cannot be described to the model`);
  }
  const { $schema: _dialect, ...json } = z.toJSONSchema(schema, { io: 'input' });
  return json;
}

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
  /** Every pair {@link fetchTools} admits, with its argument JSON schema, ordered by `sourceId`, then `toolName`. */
  fetchToolCatalog(config: ProcessConfig): FetchToolLine[];
  /** Proposes the tasks of an accepted decision; `undefined` when no capability of this release executes its kind. */
  proposeTasks(frame: DecisionFrame, decision: Decision): Promise<ProposedTasks> | undefined;
}

export function createCapabilityRegistry(deps: CapabilityRegistryDeps): CapabilityRegistry {
  const fetchTools = (config: ProcessConfig): FetchToolLookup => (request) => {
    const listed = config.sources.some(
      (source) => source.sourceId === request.sourceId && source.toolName === request.toolName,
    );
    if (!listed) return null;
    return deps.sources.resolveTool({ workflowType: SOURCE_FETCH_WORKFLOW, ...request })?.tool ?? null;
  };
  return {
    fetchTools,
    fetchToolCatalog: (config) => {
      const lookup = fetchTools(config);
      return config.sources
        .flatMap(({ sourceId, toolName }) => {
          const tool = lookup({ sourceId, toolName });
          return tool === null ? [] : [{ sourceId, toolName, argsSchema: argsJsonSchema(tool.argsSchema, { sourceId, toolName }) }];
        })
        .sort((a, b) => a.sourceId.localeCompare(b.sourceId) || a.toolName.localeCompare(b.toolName));
    },
    proposeTasks: (frame, decision) => {
      switch (decision.kind) {
        case 'requestEvidence':
          return proposeGather(deps, frame, decision);
        case 'requestAnalysis':
          return proposeAnalysis(deps, frame, decision);
        case 'requestVerification':
          return proposeVerification(deps, frame, decision);
        case 'proposeAnswer':
          return proposeSynthesis(deps, frame);
        default:
          return undefined;
      }
    },
  };
}
