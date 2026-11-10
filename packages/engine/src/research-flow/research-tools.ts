import type { ToolRegistryEntry } from '../agents/tool-registry.js';
import type { ImmediateTool, TaskTool } from '../agents/tools/tool-context.js';
import { CLAIMS_WRITE_ENTRY, claimsWriteTool } from './tools/claims-write.js';
import { createGatherTool, GATHER_ENTRY, type GatherToolDeps } from './tools/gather.js';
import { PLAN_WRITE_ENTRY, planWriteTool } from './tools/plan-write.js';

/** The registry entries of the research process's tools; the engine's assembly adds them to the base tools. */
export const RESEARCH_TOOLS: readonly ToolRegistryEntry[] = [CLAIMS_WRITE_ENTRY, PLAN_WRITE_ENTRY, GATHER_ENTRY];

/** The research process's tools the executor ends at once, by name. */
export const RESEARCH_IMMEDIATE_TOOLS: ReadonlyMap<string, ImmediateTool> = new Map(
  [claimsWriteTool, planWriteTool].map((tool) => [tool.name, tool]),
);

/** The research process's tools of class `task`, by name. */
export function researchTaskTools(deps: GatherToolDeps): ReadonlyMap<string, TaskTool> {
  return new Map([createGatherTool(deps)].map((tool) => [tool.name, tool]));
}
