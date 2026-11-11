import type { ResolvedSourceTool, SourceSchema } from '@agent-os/sources';
import { z } from 'zod';
import { buildSourcesField } from './sources-field.js';

// KD-3, «Поля шаблона» (design-catalog-planning.md); DC-32, DC-12, UC-16 (design-agent-core.md): the value is one JSON
// line per source of the run, with its description and its tools. Defects caught: `localeCompare` or the order of the
// configuration instead of code-point order (missing-sort-key ordering); a line per tool, repeating the source; a pair
// outside the run's sources or refused by the source registry shown to the model; a source without a resolved pair shown
// with no tools; a default argument shown as required; a value for a run without sources that is empty instead of the
// text; a schema that cannot be described passing silently.

const ARGS = z.strictObject({ query: z.string(), limit: z.number().default(10) });
const ARGS_JSON =
  '{"type":"object","properties":{"query":{"type":"string"},"limit":{"default":10,"type":"number"}},"required":["query"],"additionalProperties":false}';
const toolOf = (toolName: string): string => `{"toolName":"${toolName}","description":"Tool ${toolName}.","argsSchema":${ARGS_JSON}}`;
const lineOf = (sourceId: string, ...toolNames: string[]): string =>
  `{"sourceId":"${sourceId}","description":"Source ${sourceId}.","tools":[${toolNames.map(toolOf).join(',')}]}`;

const resolved = (argsSchema: SourceSchema, toolName: string) =>
  ({ adapter: {}, tool: { argsSchema }, description: `Tool ${toolName}.` }) as ResolvedSourceTool;
const resolveAll = ({ toolName }: { toolName: string }) => resolved(ARGS, toolName);
const describeSource = (sourceId: string): string => `Source ${sourceId}.`;

const pair = (sourceId: string, toolName: string) => ({ sourceId, toolName });

describe('the value of the sources field', () => {
  it.each([
    ['a line per source with its description and its tools', [pair('alpha', 'search')], ['alpha'], lineOf('alpha', 'search')],
    [
      'one line for the tools of one source, the tools by code point',
      [pair('alpha', 'b'), pair('alpha', 'B')],
      ['alpha'],
      lineOf('alpha', 'B', 'b'),
    ],
    [
      'sources by code point, whatever the order of the configuration',
      [pair('beta', 'x'), pair('alpha', 'x'), pair('Zeta', 'x')],
      ['alpha', 'beta', 'Zeta'],
      [lineOf('Zeta', 'x'), lineOf('alpha', 'x'), lineOf('beta', 'x')].join('\n'),
    ],
    [
      'a supplementary character after every character of the basic plane',
      [pair('\u{1F600}', 'x'), pair('\u{FF5E}', 'x')],
      ['\u{1F600}', '\u{FF5E}'],
      [lineOf('\u{FF5E}', 'x'), lineOf('\u{1F600}', 'x')].join('\n'),
    ],
    [
      'without a source outside the sources of the run',
      [pair('alpha', 'search'), pair('beta', 'search')],
      ['beta'],
      lineOf('beta', 'search'),
    ],
    ['the text of a run without sources', [pair('alpha', 'search')], [], 'No data source is available to this run.'],
  ])('%s', (_case, configSources, runSources, value) => {
    expect(buildSourcesField({ configSources, runSources, resolveTool: resolveAll, describeSource })).toBe(value);
  });

  it('leaves out a pair the registry does not resolve for source.fetch, and a source left without pairs', () => {
    const requests: unknown[] = [];

    const value = buildSourcesField({
      configSources: [pair('alpha', 'search'), pair('alpha', 'hidden'), pair('beta', 'hidden')],
      runSources: ['alpha', 'beta'],
      resolveTool: (request) => {
        requests.push(request.workflowType);
        return request.toolName === 'hidden' ? null : resolved(ARGS, request.toolName);
      },
      describeSource: (sourceId) => {
        if (sourceId === 'beta') throw new Error('a source without a resolved pair is not described');
        return describeSource(sourceId);
      },
    });

    expect(value).toBe(lineOf('alpha', 'search'));
    expect(requests).toEqual(['source.fetch', 'source.fetch', 'source.fetch']);
  });

  it('throws naming the pair when the argument schema is not a zod schema', () => {
    const notZod: SourceSchema = { safeParse: (data) => ({ success: true, data }) };

    expect(() =>
      buildSourcesField({
        configSources: [pair('alpha', 'search')],
        runSources: ['alpha'],
        resolveTool: () => resolved(notZod, 'search'),
        describeSource,
      }),
    ).toThrow('the argument schema of alpha/search is not a zod schema');
  });
});
