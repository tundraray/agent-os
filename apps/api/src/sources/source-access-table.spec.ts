import type { ToolAccessRequest } from '@agent-os/engine';
import { SourceAccessTable } from './source-access-table.js';
import { SOURCES_DECLARATION } from './sources.config.js';

const OWNER = 'user-1';

function request(
  resourceId: string,
  sourceId: string | null,
): ToolAccessRequest {
  return { resourceId, toolName: 'gather', sourceId };
}

// AC-03.1, AC-03.2, DC-2, UC-E7. Risk: an owner is allowed a source outside their row, or the server starts with a
// table it cannot read or one that names an undeclared source.
describe('SourceAccessTable - answers by the table', () => {
  it.each<[string, string | undefined, ToolAccessRequest, string]>([
    [
      'the owner asks for a source in their row (AC-03.1)',
      '{"user-1":["fixture"]}',
      request(OWNER, 'fixture'),
      'allowed',
    ],
    [
      'the owner asks for a source outside their row (AC-03.1)',
      '{"user-1":["fixture"]}',
      request(OWNER, 'backoffice'),
      'access_denied',
    ],
    [
      'the owner is not in the table (AC-03.2)',
      '{"user-2":["fixture","backoffice"]}',
      request(OWNER, 'fixture'),
      'access_denied',
    ],
    [
      'the table is unset (AC-03.2)',
      undefined,
      request(OWNER, 'fixture'),
      'access_denied',
    ],
    ['the request has no source', undefined, request(OWNER, null), 'allowed'],
  ])('when %s', (_, value, accessRequest, expected) => {
    const table = new SourceAccessTable(value, SOURCES_DECLARATION);

    expect(table.decide(accessRequest)).toBe(expected);
  });

  it.each<[string, string, RegExp[]]>([
    ['the value is not JSON', '{user-1: fixture', [/SOURCE_ACCESS_TABLE/]],
    ['the value is a list', '["fixture"]', [/SOURCE_ACCESS_TABLE/]],
    [
      'a row is not a list of strings',
      '{"user-1":"fixture"}',
      [/SOURCE_ACCESS_TABLE/, /user-1/],
    ],
    [
      'a row names a source outside the declaration (DC-2)',
      '{"user-1":["fixture","crm"]}',
      [/user-1/, /\bcrm\b/],
    ],
  ])('refuses the start when %s', (_, value, named) => {
    let message = '';
    try {
      new SourceAccessTable(value, SOURCES_DECLARATION);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).not.toBe('');
    for (const pattern of named) expect(message).toMatch(pattern);
  });
});
