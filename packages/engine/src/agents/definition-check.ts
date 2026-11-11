import { INVESTIGATION_QUERY_MAX_CHARS } from '@agent-os/contracts';
import { z } from 'zod';
import type { AgentDefinition, AgentProcessConfig, ProcessConfigRejection } from '../config/agent-config.schema.js';
import type { SourceRegistry } from '@agent-os/sources';
import {
  CATALOG_FIELD_MAX_BYTES,
  namesPromptField,
  NO_SOURCES_TEXT,
  type PromptField,
  renderPromptTemplate,
  SOURCES_FIELD_MAX_BYTES,
  type SourcesFieldInput,
} from '../config/prompt-template.js';
import type { ResultForm, ResultFormRegistry } from './result-forms.js';
import { ASSIGNMENT_MAX_CHARS, BYTES_PER_CHAR, leastViewTokens } from './session-window.js';
import { agentToolsOf, type ToolRegistry } from './tool-registry.js';

/** The registries a definition is checked against (DC-1, DC-28, DC-31; design-catalog-planning.md, DC-4). */
export interface AgentRegistries {
  readonly tools: ToolRegistry;
  readonly forms: ResultFormRegistry;
  /** The source registry's lookup, as `gather` calls it. */
  readonly resolveTool: SourceRegistry['resolveTool'];
  /** The source registry's description of a source it resolves a pair of. */
  readonly describeSource: SourceRegistry['describeSource'];
  /** Builds the value of `{{sources}}`; the assembly point passes it, this module does not import `capabilities`. */
  readonly buildSourcesField: (input: SourcesFieldInput) => string;
  /** Builds the value of `{{catalog}}`, passed by the assembly point as `buildSourcesField` is. */
  readonly buildCatalogField: (input: SourcesFieldInput) => string;
}

/** The values of the source fields of a prompt: `{{sources}}` and `{{catalog}}`. */
export interface SourceFieldValues {
  readonly sources: string;
  readonly catalog: string;
}

type SourceFieldRegistries = Pick<AgentRegistries, 'resolveTool' | 'describeSource' | 'buildSourcesField' | 'buildCatalogField'>;

/**
 * The values of `{{sources}}` and `{{catalog}}` for a definition and the sources of a run. A template that does not name a
 * field gets no value built for it: a source double or a deployment without the field never meets its schema.
 */
export function sourceFieldValuesOf(
  definition: Pick<AgentDefinition, 'prompt'>,
  input: { readonly config: Pick<AgentProcessConfig, 'sources'>; readonly runSources: readonly string[] },
  registries: SourceFieldRegistries,
): SourceFieldValues {
  const fieldInput: SourcesFieldInput = {
    configSources: input.config.sources,
    runSources: input.runSources,
    resolveTool: registries.resolveTool,
    describeSource: registries.describeSource,
  };
  const valueOf = (field: PromptField, build: (built: SourcesFieldInput) => string): string =>
    namesPromptField(definition.prompt, field) ? build(fieldInput) : NO_SOURCES_TEXT;
  return {
    sources: valueOf('sources', registries.buildSourcesField),
    catalog: valueOf('catalog', registries.buildCatalogField),
  };
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
function promptMaxBytes(definition: AgentDefinition, config: AgentProcessConfig, fieldValues: SourceFieldValues): number {
  return utf8Bytes(
    renderPromptTemplate(
      definition.prompt,
      {
        goal: config.goal,
        query: 'x'.repeat(INVESTIGATION_QUERY_MAX_CHARS * BYTES_PER_CHAR),
        sourceMode: SOURCE_MODE_MAX,
        answerSections: config.answer.sections.join(', '),
        sources: fieldValues.sources,
        catalog: fieldValues.catalog,
      },
    ),
  );
}

/**
 * `{{sources}}` stands only on a definition with a tool marked as reading the run's sources (DC-31), `{{catalog}}` only on
 * one with a tool marked as checking the plan against the run's catalog (design-catalog-planning.md, KD-3, DC-4).
 */
function checkSourceFieldReaders(agentName: string, definition: AgentDefinition, tools: ToolRegistry): ProcessConfigRejection | null {
  const hasMarkedTool = (mark: 'readsRunSources' | 'readsRunCatalog'): boolean =>
    definition.tools.some((tool) => tools.get(tool)?.[mark] === true);
  if (namesPromptField(definition.prompt, 'sources') && !hasMarkedTool('readsRunSources')) {
    return reject(agentName, ['prompt'], '{{sources}} needs a tool that reads the sources of the run');
  }
  if (namesPromptField(definition.prompt, 'catalog') && !hasMarkedTool('readsRunCatalog')) {
    return reject(agentName, ['prompt'], '{{catalog}} needs a tool that checks the plan against the catalog of the run');
  }
  return null;
}

/** The longest value of each source field must fit its limit (DC-31, DC-4): a run never cuts it. */
function checkSourceFieldLimits(agentName: string, fieldValues: SourceFieldValues): ProcessConfigRejection | null {
  const limits = [
    ['sources', fieldValues.sources, SOURCES_FIELD_MAX_BYTES],
    ['catalog', fieldValues.catalog, CATALOG_FIELD_MAX_BYTES],
  ] as const;
  for (const [field, value, maxBytes] of limits) {
    const bytes = utf8Bytes(value);
    if (bytes > maxBytes) {
      return reject(agentName, ['prompt'], `the longest {{${field}}} value takes ${bytes} bytes, over ${maxBytes}`);
    }
  }
  return null;
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
    readonly fieldValues: SourceFieldValues;
  },
): ProcessConfigRejection | null {
  const tools = agentToolsOf(definition.tools, { registry: context.tools, resultSchema: context.form.resultSchema });
  const toolSchemaBytes = utf8Bytes(
    JSON.stringify(tools.map((tool) => [tool.name, tool.description, z.toJSONSchema(tool.inputSchema)])),
  );
  const least = leastViewTokens({
    promptBytes: promptMaxBytes(definition, context.config, context.fieldValues),
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
 * `{{sources}}` stands where a tool reads the run's sources and `{{catalog}}` where a tool checks the plan against the
 * run's catalog, the longest value of each (all the process's sources the registry resolves a pair of, narrowed by the
 * definition's `sources` when it names them) fits its limit, and the least view of the session, those values included,
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
      checkPlacement(agentName, definition, { config, form }) ??
      checkSourceFieldReaders(agentName, definition, registries.tools);
    if (misplaced !== null) {
      return misplaced;
    }
    const runSources = definition.sources ?? config.sources.map((source) => source.sourceId);
    const fieldValues = sourceFieldValuesOf(definition, { config, runSources }, registries);
    const fault =
      checkSourceFieldLimits(agentName, fieldValues) ??
      checkWindow(agentName, definition, { config, form, tools: registries.tools, fieldValues });
    if (fault !== null) {
      return fault;
    }
  }
  return null;
}
