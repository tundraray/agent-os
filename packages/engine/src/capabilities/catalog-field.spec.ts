import type { ResolvedSourceTool, SourceSchema } from '@agent-os/sources';
import { z } from 'zod';
import { buildCatalogField } from './catalog-field.js';

// KD-3, «Поля шаблона», FR-05 (design-catalog-planning.md): the value of `{{catalog}}` is one JSON line per source of the
// run, its id and description only. Defects caught: tools or argument schemas reaching the plan agent; a line per pair
// instead of per source; a source outside the run or without a pair the registry resolves listed; a run without sources
// given an empty value instead of the text.

const ARGS: SourceSchema = z.strictObject({});
const resolveUnlessHidden = ({ toolName }: { toolName: string }) =>
  toolName === 'hidden' ? null : ({ adapter: {}, tool: { argsSchema: ARGS }, description: 'A tool.' } as ResolvedSourceTool);
const describeSource = (sourceId: string): string => `Source ${sourceId}, "quoted".`;
const lineOf = (sourceId: string): string => `{"sourceId":"${sourceId}","description":"Source ${sourceId}, \\"quoted\\"."}`;

const pair = (sourceId: string, toolName: string) => ({ sourceId, toolName });

describe('the value of the catalog field', () => {
  it.each([
    [
      'a line per source, id and description only, by code point',
      [pair('beta', 'search'), pair('alpha', 'search'), pair('alpha', 'aggregate')],
      ['alpha', 'beta'],
      [lineOf('alpha'), lineOf('beta')].join('\n'),
    ],
    [
      'without a source outside the run or without a resolved pair',
      [pair('alpha', 'search'), pair('beta', 'search'), pair('gamma', 'hidden')],
      ['beta', 'gamma'],
      lineOf('beta'),
    ],
    ['the text of a run without sources', [pair('alpha', 'search')], [], 'No data source is available to this run.'],
  ])('%s', (_case, configSources, runSources, value) => {
    expect(buildCatalogField({ configSources, runSources, resolveTool: resolveUnlessHidden, describeSource })).toBe(value);
  });
});
