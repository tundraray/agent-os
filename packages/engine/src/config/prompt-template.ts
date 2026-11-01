/**
 * The closed list of fields a role prompt may substitute (ADR-0005). The prompt is the role's instructions; the
 * investigation material (plan, observations, evidence, claims) is packed by the ContextBuilder, not by the template.
 * A new field is a release of the engine, not a configuration edit.
 */
export const PROMPT_FIELDS = ['goal', 'query', 'sourceMode', 'answerSections'] as const;
export type PromptField = (typeof PROMPT_FIELDS)[number];

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const FIELD_NAME = /^\s*([A-Za-z][A-Za-z0-9]*)\s*$/;

function isPromptField(name: string): name is PromptField {
  return (PROMPT_FIELDS as readonly string[]).includes(name);
}

/**
 * The first fault of a template, or null. A placeholder is `{{field}}` with a field from the closed list; anything
 * else between braces (an unknown field, an expression, a condition, a call) and an unpaired `{{` or `}}` is a fault.
 */
export function findPromptTemplateFault(template: string): string | null {
  for (const [, inner = ''] of template.matchAll(PLACEHOLDER)) {
    const name = FIELD_NAME.exec(inner)?.[1];
    if (name === undefined || !isPromptField(name)) {
      return `unknown prompt field {{${inner}}}; allowed: ${PROMPT_FIELDS.join(', ')}`;
    }
  }
  const outsidePlaceholders = template.replace(PLACEHOLDER, '');
  if (outsidePlaceholders.includes('{{') || outsidePlaceholders.includes('}}')) {
    return 'unpaired placeholder braces';
  }
  return null;
}

/** Substitutes the fields of a template that passed `findPromptTemplateFault`. */
export function renderPromptTemplate(template: string, values: Readonly<Record<PromptField, string>>): string {
  return template.replace(PLACEHOLDER, (placeholder, inner: string) => {
    const name = FIELD_NAME.exec(inner)?.[1];
    if (name === undefined || !isPromptField(name)) {
      throw new Error(`prompt template was not validated: ${placeholder}`);
    }
    return values[name];
  });
}
