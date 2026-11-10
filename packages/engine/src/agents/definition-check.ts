import { INVESTIGATION_QUERY_MAX_CHARS } from '@agent-os/contracts';
import { z } from 'zod';
import type { AgentDefinition, AgentProcessConfig, ProcessConfigRejection } from '../config/agent-config.schema.js';
import type { SourceRegistry } from '@agent-os/sources';
import {
  namesSourcesField,
  NO_SOURCES_TEXT,
  renderPromptTemplate,
  SOURCES_FIELD_MAX_BYTES,
  type SourcesFieldInput,
} from '../config/prompt-template.js';
import type { ResultForm, ResultFormRegistry } from './result-forms.js';
import { ASSIGNMENT_MAX_CHARS, BYTES_PER_CHAR, leastViewTokens } from './session-window.js';
import { agentToolsOf, type ToolRegistry } from './tool-registry.js';

/** The registries a definition is checked against (DC-1, DC-28, DC-31). */
export interface AgentRegistries {
  readonly tools: ToolRegistry;
  readonly forms: ResultFormRegistry;
  /** The source registry's lookup, as `gather` calls it. */
  readonly resolveTool: SourceRegistry['resolveTool'];
  /** Builds the value of `{{sources}}`; the assembly point passes it, this module does not import `capabilities`. */
  readonly buildSourcesField: (input: SourcesFieldInput) => string;
}

/**
 * The value of `{{sources}}` for a definition and the sources of a run. A template that does not name the field gets no
 * value built: a source double or a deployment without the field never meets its schema.
 */
export function sourcesValueOf(
  definition: Pick<AgentDefinition, 'prompt'>,
  input: { readonly config: Pick<AgentProcessConfig, 'sources'>; readonly runSources: readonly string[] },
  registries: Pick<AgentRegistries, 'resolveTool' | 'buildSourcesField'>,
): string {
  if (!namesSourcesField(definition.prompt)) return NO_SOURCES_TEXT;
  return registries.buildSourcesField({
    configSources: input.config.sources,
    runSources: input.runSources,
    resolveTool: registries.resolveTool,
  });
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
function promptMaxBytes(definition: AgentDefinition, config: AgentProcessConfig, sourcesValue: string): number {
  return utf8Bytes(
    renderPromptTemplate(
      definition.prompt,
      {
        goal: config.goal,
        query: 'x'.repeat(INVESTIGATION_QUERY_MAX_CHARS * BYTES_PER_CHAR),
        sourceMode: SOURCE_MODE_MAX,
        answerSections: config.answer.sections.join(', '),
        sources: sourcesValue,
      },
    ),
  );
}

/** `{{sources}}` stands only on a definition with a tool marked as reading the run's sources (DC-31). */
function checkSourcesReader(agentName: string, definition: AgentDefinition, tools: ToolRegistry): ProcessConfigRejection | null {
  if (!namesSourcesField(definition.prompt)) return null;
  const reads = definition.tools.some((tool) => tools.get(tool)?.readsRunSources === true);
  return reads ? null : reject(agentName, ['prompt'], '{{sources}} needs a tool that reads the sources of the run');
}

/** The longest value of the field must fit its limit (DC-31): a run never cuts it. */
function checkSourcesLimit(agentName: string, sourcesValue: string): ProcessConfigRejection | null {
  const bytes = utf8Bytes(sourcesValue);
  return bytes <= SOURCES_FIELD_MAX_BYTES
    ? null
    : reject(agentName, ['prompt'], `the longest {{sources}} value takes ${bytes} bytes, over ${SOURCES_FIELD_MAX_BYTES}`);
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
  context: {
    readonly config: AgentProcessConfig;
    readonly form: ResultForm;
    readonly tools: ToolRegistry;
    readonly sourcesValue: string;
  },
): ProcessConfigRejection | null {
  const tools = agentToolsOf(definition.tools, { registry: context.tools, resultSchema: context.form.resultSchema });
  const toolSchemaBytes = utf8Bytes(
    JSON.stringify(tools.map((tool) => [tool.name, tool.description, z.toJSONSchema(tool.inputSchema)])),
  );
  const least = leastViewTokens({
    promptBytes: promptMaxBytes(definition, context.config, context.sourcesValue),
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
 * The checks of an agents-form configuration against the engine's registries (DC-1, DC-28, DC-31, ADR-0009, ADR-0010):
 * every tool is in the tool registry, `result` is in the form registry and the form stands where its constraints allow,
 * `{{sources}}` stands where a tool reads the run's sources and its longest value (all the process's pairs, narrowed by
 * the definition's `sources` when it names them) fits its limit, and the least view of the session, that value included,
 * fits the definition's window. The first fault names the agent and the field.
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
    const misplaced =
      checkPlacement(agentName, definition, { config, form }) ?? checkSourcesReader(agentName, definition, registries.tools);
    if (misplaced !== null) {
      return misplaced;
    }
    const runSources = definition.sources ?? config.sources.map((source) => source.sourceId);
    const sourcesValue = sourcesValueOf(definition, { config, runSources }, registries);
    const fault =
      checkSourcesLimit(agentName, sourcesValue) ??
      checkWindow(agentName, definition, { config, form, tools: registries.tools, sourcesValue });
    if (fault !== null) {
      return fault;
    }
  }
  return null;
}
