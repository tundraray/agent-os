import { INVESTIGATION_QUERY_MAX_CHARS } from '@agent-os/contracts';
import { z } from 'zod';
import type { AgentDefinition, AgentProcessConfig } from '../config/agent-config.schema.js';
import { renderPromptTemplate } from '../config/prompt-template.js';
import type { ProcessConfigRejection } from '../config/process-config.schema.js';
import type { ResultForm, ResultFormRegistry } from './result-forms.js';
import { ASSIGNMENT_MAX_CHARS, BYTES_PER_CHAR, leastViewTokens } from './session-window.js';
import { agentToolsOf, type ToolRegistry } from './tool-registry.js';

/** The registries a definition is checked against (DC-1, DC-28). */
export interface AgentRegistries {
  readonly tools: ToolRegistry;
  readonly forms: ResultFormRegistry;
}

/** The longest `sourceMode` a prompt may get. */
const SOURCE_MODE_MAX = 'model_knowledge';

const utf8Bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

function reject(agentName: string, field: readonly (string | number)[], message: string): ProcessConfigRejection {
  return {
    code: 'process_config_rejected',
    path: ['agents', agentName, ...field],
    message: `agent ${agentName}: ${message}`,
  };
}

/** The rendered prompt at the longest values its fields can take, in bytes. */
function promptMaxBytes(definition: AgentDefinition, config: AgentProcessConfig): number {
  return utf8Bytes(
    renderPromptTemplate(definition.prompt, {
      goal: config.goal,
      query: 'x'.repeat(INVESTIGATION_QUERY_MAX_CHARS * BYTES_PER_CHAR),
      sourceMode: SOURCE_MODE_MAX,
      answerSections: config.answer.sections.join(', '),
    }),
  );
}

/**
 * The longest opening of the definition's session in bytes: the prologue's `firstMessageMaxBytes`, or the assignment —
 * at most `ASSIGNMENT_MAX_CHARS` from a parent, and for a root definition (`rootAgent`, `modelKnowledgeRoot`) the
 * investigation's question, at most `INVESTIGATION_QUERY_MAX_CHARS`, each at `BYTES_PER_CHAR` (DC-1).
 */
function openingMaxBytes(agentName: string, config: AgentProcessConfig, form: ResultForm): number {
  if (form.prologue !== undefined) return form.prologue.firstMessageMaxBytes;
  const root = config.rootAgent === agentName || config.modelKnowledgeRoot === agentName;
  return (root ? Math.max(ASSIGNMENT_MAX_CHARS, INVESTIGATION_QUERY_MAX_CHARS) : ASSIGNMENT_MAX_CHARS) * BYTES_PER_CHAR;
}

/** The least view must fit `windowTokens − marginTokens` (DC-1, design-agent-core.md «Что модель видит из сессии»). */
function checkWindow(
  agentName: string,
  definition: AgentDefinition,
  context: { readonly config: AgentProcessConfig; readonly form: ResultForm; readonly tools: ToolRegistry },
): ProcessConfigRejection | null {
  const tools = agentToolsOf(definition.tools, { registry: context.tools, resultSchema: context.form.resultSchema });
  const toolSchemaBytes = utf8Bytes(
    JSON.stringify(tools.map((tool) => [tool.name, tool.description, z.toJSONSchema(tool.inputSchema)])),
  );
  const least = leastViewTokens({
    promptBytes: promptMaxBytes(definition, context.config),
    toolSchemaBytes,
    openingMaxBytes: openingMaxBytes(agentName, context.config, context.form),
    maxTurns: definition.limits.maxTurns,
    maxCallsPerTurn: definition.limits.maxCallsPerTurn,
    maxOutputTokens: definition.limits.maxOutputTokens,
  });
  const room = definition.limits.windowTokens - definition.limits.marginTokens;
  return least <= room
    ? null
    : reject(
        agentName,
        ['limits', 'windowTokens'],
        `the least view of the session takes up to ${least} tokens, over windowTokens − marginTokens = ${room}`,
      );
}

/** The DC-28 constraints of `form` for the definition `agentName`; the message names the agent, form and constraint. */
function checkPlacement(
  agentName: string,
  definition: AgentDefinition,
  context: { readonly config: AgentProcessConfig; readonly form: ResultForm },
): ProcessConfigRejection | null {
  const { config, form } = context;
  if (form.onlyOn !== undefined && config[form.onlyOn] !== agentName) {
    return reject(agentName, ['result'], `form ${form.name} may stand only on ${form.onlyOn} (onlyOn)`);
  }
  if (form.maxDefinitions !== undefined) {
    const naming = Object.values(config.agents).filter((other) => other.result === form.name).length;
    if (naming > form.maxDefinitions) {
      return reject(
        agentName,
        ['result'],
        `form ${form.name} is named by ${naming} definitions, at most ${form.maxDefinitions} (maxDefinitions)`,
      );
    }
  }
  const allowed = form.toolsAllowed;
  const outside = allowed === undefined ? undefined : definition.tools.find((tool) => !allowed.includes(tool));
  if (outside !== undefined) {
    return reject(agentName, ['tools'], `form ${form.name} does not allow tool ${outside} (toolsAllowed)`);
  }
  return null;
}

/**
 * The checks of an agents-form configuration against the engine's registries (DC-1, DC-28, ADR-0009, ADR-0010): every
 * tool is in the tool registry, `result` is in the form registry and the form stands where its constraints allow, and
 * the least view of the session fits the definition's window. The first fault names the agent and the field.
 */
export function checkAgentDefinitions(
  config: AgentProcessConfig,
  registries: AgentRegistries,
): ProcessConfigRejection | null {
  for (const [agentName, definition] of Object.entries(config.agents)) {
    for (const [index, tool] of definition.tools.entries()) {
      if (!registries.tools.has(tool)) {
        return reject(agentName, ['tools', index], `tool ${tool} is not in the tool registry`);
      }
    }
    const form = registries.forms.get(definition.result);
    if (form === undefined) {
      return reject(agentName, ['result'], `result form ${definition.result} is not in the result-form registry`);
    }
    const fault =
      checkPlacement(agentName, definition, { config, form }) ??
      checkWindow(agentName, definition, { config, form, tools: registries.tools });
    if (fault !== null) {
      return fault;
    }
  }
  return null;
}
