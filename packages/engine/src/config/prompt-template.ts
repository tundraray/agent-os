import type { SourceRegistry } from '@agent-os/sources';

/**
 * The closed list of fields an agent definition's prompt may substitute (ADR-0009, KD-9); `sources` names the sources of
 * the run with their tools, `catalog` the sources of the run without tools (design-catalog-planning.md, KD-3). The prompt
 * is the agent's instructions; the investigation material reaches the agent through its assignment and tools, not
 * through the template. A new field is a release of the engine, not a configuration edit.
 */
export const PROMPT_FIELDS = ['goal', 'query', 'sourceMode', 'answerSections', 'sources', 'catalog'] as const;
export type PromptField = (typeof PROMPT_FIELDS)[number];

/** The upper bound of the value of `{{sources}}` (DC-31): the load checks it, a run never cuts the value. */
export const SOURCES_FIELD_MAX_BYTES = 8_192;
/** The upper bound of the value of `{{catalog}}` (design-catalog-planning.md, DC-4): the load checks it, a run never cuts it. */
export const CATALOG_FIELD_MAX_BYTES = 8_192;
/** The value of `{{sources}}` and `{{catalog}}` for a run without sources (DC-32). */
export const NO_SOURCES_TEXT = 'No data source is available to this run.';

/**
 * What the values of `{{sources}}` and `{{catalog}}` are built from: the frozen configuration's pairs, the run's sources
 * and the source registry, which resolves the pairs and describes the sources.
 */
export interface SourcesFieldInput {
  readonly configSources: readonly { readonly sourceId: string; readonly toolName: string }[];
  readonly runSources: readonly string[];
  readonly resolveTool: SourceRegistry['resolveTool'];
  readonly describeSource: SourceRegistry['describeSource'];
}

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const FIELD_NAME = /^\s*([A-Za-z][A-Za-z0-9]*)\s*$/;

/**
 * The first fault of a template, or null. A placeholder is `{{field}}` with a field from the closed list; anything else
 * between braces (an unknown field, an expression, a condition, a call) and an unpaired `{{` or `}}` is a fault.
 */
export function findPromptTemplateFault(template: string): string | null {
  const allowed: readonly string[] = PROMPT_FIELDS;
  for (const [, inner = ''] of template.matchAll(PLACEHOLDER)) {
    const name = FIELD_NAME.exec(inner)?.[1];
    if (name === undefined || !allowed.includes(name)) {
      return `unknown prompt field {{${inner}}}; allowed: ${allowed.join(', ')}`;
    }
  }
  const outsidePlaceholders = template.replace(PLACEHOLDER, '');
  if (outsidePlaceholders.includes('{{') || outsidePlaceholders.includes('}}')) {
    return 'unpaired placeholder braces';
  }
  return null;
}

/** Whether a template substitutes `field`; a template that does not needs no value (DC-31). */
export function namesPromptField(template: string, field: PromptField): boolean {
  return [...template.matchAll(PLACEHOLDER)].some(([, inner = '']) => FIELD_NAME.exec(inner)?.[1] === field);
}

/** Substitutes the fields of a template that passed `findPromptTemplateFault`. A value goes in as it is. */
export function renderPromptTemplate(template: string, values: Readonly<Record<PromptField, string>>): string {
  const fields: readonly string[] = PROMPT_FIELDS;
  return template.replace(PLACEHOLDER, (placeholder, inner: string) => {
    const name = FIELD_NAME.exec(inner)?.[1];
    const value = name === undefined || !fields.includes(name) ? undefined : values[name as PromptField];
    if (value === undefined) {
      throw new Error(`prompt template was not validated: ${placeholder}`);
    }
    return value;
  });
}
