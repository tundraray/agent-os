import { agentFingerprint } from '../agents/fingerprint.js';
import { createResultFormRegistry, SHIPPED_RESULT_FORMS } from '../agents/result-forms.js';
import { agentToolsOf, BASE_TOOLS, createToolRegistry } from '../agents/tool-registry.js';
import { AgentProcessConfigSchema } from '../config/agent-config.schema.js';
import { configFingerprint } from '../runs/run-record.js';
import { RESEARCH_FORMS } from './research-forms.js';
import { RESEARCH_TOOLS } from './research-tools.js';

/** The tools and forms `composeEngine` registers: the same definition gives the fingerprint a run gives it. */
const TOOLS = createToolRegistry([...BASE_TOOLS, ...RESEARCH_TOOLS]);
const FORMS = createResultFormRegistry([...SHIPPED_RESULT_FORMS, ...RESEARCH_FORMS]);

/** How the result file of a self-check run names an agents-form configuration (design-research-flow.md, Contract `RunResult`). */
export interface AgentsConfigIdentity {
  readonly processId: string;
  readonly version: number;
  /** As `RunRecord.config.fingerprint` names the same configuration. */
  readonly fingerprint: string;
  /** By definition name: its model and `agentFingerprint`. */
  readonly definitions: Readonly<Record<string, { readonly model: string; readonly fingerprint: string }>>;
}

/**
 * The identity of an agents-form configuration given as data. Null when the data is not one, or a definition names a form
 * the engine does not have: `createEngine` is what refuses a bad configuration, with the path of its fault.
 */
export function agentsConfigIdentity(config: unknown): AgentsConfigIdentity | null {
  const parsed = AgentProcessConfigSchema.safeParse(config);
  if (!parsed.success) return null;
  const definitions: Record<string, { model: string; fingerprint: string }> = {};
  for (const [name, definition] of Object.entries(parsed.data.agents)) {
    const form = FORMS.get(definition.result);
    if (form === undefined) return null;
    const tools = agentToolsOf(definition.tools, { registry: TOOLS, resultSchema: form.resultSchema });
    definitions[name] = { model: definition.model, fingerprint: agentFingerprint({ definition, tools, form }) };
  }
  return { processId: parsed.data.processId, version: parsed.data.version, fingerprint: configFingerprint(parsed.data), definitions };
}
