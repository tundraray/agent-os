import type { ResolvedSourceTool, SourceSchema } from '@agent-os/sources';
import { z } from 'zod';
import { buildSourcesField } from './sources-field.js';

// DC-32, DC-12, UC-16 (design-agent-core.md, «Поле шаблона sources»): the value is one JSON line per tool of this run.
// Defects caught: `localeCompare` instead of code-point order; a pair outside the run's sources or refused by the
// source registry shown to the model; a default argument shown as required; a value for a run without sources that is
// empty instead of the text; a schema that cannot be described passing silently.

const ARGS = z.strictObject({ query: z.string(), limit: z.number().default(10) });
const ARGS_JSON =
  '{"type":"object","properties":{"query":{"type":"string"},"limit":{"default":10,"type":"number"}},"required":["query"],"additionalProperties":false}';
const lineOf = (sourceId: string, toolName: string): string =>
  `{"sourceId":"${sourceId}","toolName":"${toolName}","argsSchema":${ARGS_JSON}}`;

const resolved = (argsSchema: SourceSchema) => ({ adapter: {}, tool: { argsSchema } }) as ResolvedSourceTool;
const resolveAll = () => resolved(ARGS);

const pair = (sourceId: string, toolName: string) => ({ sourceId, toolName });

describe('the value of the sources field', () => {
  it.each([
    [
      'one JSON line per pair with its input schema',
      [pair('alpha', 'search')],
      ['alpha'],
      lineOf('alpha', 'search'),
    ],
    [
      'by sourceId, then toolName, in code-point order',
      [pair('alpha', 'b'), pair('alpha', 'B'), pair('Zeta', 'x')],
      ['alpha', 'Zeta'],
      [lineOf('Zeta', 'x'), lineOf('alpha', 'B'), lineOf('alpha', 'b')].join('\n'),
    ],
    [
      'a supplementary character after every character of the basic plane',
      [pair('\u{1F600}', 'x'), pair('\u{FF5E}', 'x')],
      ['\u{1F600}', '\u{FF5E}'],
      [lineOf('\u{FF5E}', 'x'), lineOf('\u{1F600}', 'x')].join('\n'),
    ],
    [
      'without a pair outside the sources of the run',
      [pair('alpha', 'search'), pair('beta', 'search')],
      ['beta'],
      lineOf('beta', 'search'),
    ],
    ['the text of a run without sources', [pair('alpha', 'search')], [], 'No data source is available to this run.'],
  ])('%s', (_case, configSources, runSources, value) => {
    expect(buildSourcesField({ configSources, runSources, resolveTool: resolveAll })).toBe(value);
  });

  it('leaves out a pair the registry does not resolve for source.fetch, and asks for it under that workflow', () => {
    const requests: unknown[] = [];

    const value = buildSourcesField({
      configSources: [pair('alpha', 'search'), pair('alpha', 'hidden')],
      runSources: ['alpha'],
      resolveTool: (request) => {
        requests.push(request.workflowType);
        return request.toolName === 'hidden' ? null : resolved(ARGS);
      },
    });

    expect(value).toBe(lineOf('alpha', 'search'));
    expect(requests).toEqual(['source.fetch', 'source.fetch']);
  });

  it('throws naming the pair when the argument schema is not a zod schema', () => {
    const notZod: SourceSchema = { safeParse: (data) => ({ success: true, data }) };

    expect(() =>
      buildSourcesField({ configSources: [pair('alpha', 'search')], runSources: ['alpha'], resolveTool: () => resolved(notZod) }),
    ).toThrow('the argument schema of alpha/search is not a zod schema');
  });
});
