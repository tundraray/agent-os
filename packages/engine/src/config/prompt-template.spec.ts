import { findPromptTemplateFault, namesPromptField, renderPromptTemplate } from './prompt-template.js';

// KD-9, DC-31, UC-2 (design-agent-core.md, «Поле шаблона sources»); KD-3 (design-catalog-planning.md, `{{catalog}}`): one
// closed list of fields. Defects caught: `{{sources}}`, `{{catalog}}` or a field of a definition prompt refused; a fault
// that does not name the allowed fields; an expression between braces accepted; a value changed on its way into the
// prompt (replacement patterns, escaping).
const ALLOWED = 'allowed: goal, query, sourceMode, answerSections, sources, catalog';

describe('the closed field list of a prompt', () => {
  it.each([
    ['the list takes {{sources}}', 'List: {{sources}}', null],
    ['the list takes {{catalog}}', 'Catalog: {{catalog}}', null],
    ['the list takes the other fields', '{{goal}} {{query}} {{sourceMode}} {{answerSections}}', null],
    ['an unknown field is refused and the fault names the list', 'Answer {{question}}', `unknown prompt field {{question}}; ${ALLOWED}`],
    [
      'an expression around the field is refused',
      '{{ sources.length }}',
      `unknown prompt field {{ sources.length }}; ${ALLOWED}`,
    ],
    ['unpaired braces are refused', '{{sources', 'unpaired placeholder braces'],
  ])('%s', (_case, template, fault) => {
    expect(findPromptTemplateFault(template)).toBe(fault);
  });

  it('substitutes a value with quotes, angle brackets and a replacement pattern as it is', () => {
    const value = '{"pattern":"^<a>$&$1$`"}';

    expect(
      renderPromptTemplate('[{{sources}}]({{catalog}})', {
        goal: '',
        query: '',
        sourceMode: '',
        answerSections: '',
        sources: value,
        catalog: value,
      }),
    ).toBe(`[${value}](${value})`);
  });

  it.each([
    ['a template that names the field', 'List:\n{{ sources }}', 'sources', true],
    ['a template of other fields', 'Goal: {{goal}}', 'sources', false],
    ['the word outside a placeholder', 'Read the sources first.', 'sources', false],
    ['the catalog field, apart from sources', 'Catalog: {{catalog}}', 'sources', false],
    ['a template that names the catalog field', 'Catalog: {{catalog}}', 'catalog', true],
  ] as const)('tells %s', (_case, template, field, named) => {
    expect(namesPromptField(template, field)).toBe(named);
  });
});
