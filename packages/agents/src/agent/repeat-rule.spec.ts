import {
  type PastCall,
  type RepeatCall,
  type RepeatDecision,
  repeatOf,
} from './repeat-rule';

// UC-7 (KD-5, AC-06.3, DC-7, DC-8, DC-9): the second same call runs with the mark, the third is refused.
const SEARCH: RepeatCall = {
  tool: 'search',
  server: 'logs',
  args: { query: 'timeout', limit: 5 },
};
const LIST_AGENTS: RepeatCall = { tool: 'list_agents', server: null, args: {} };
const START_SCOUT: RepeatCall = {
  tool: 'start_agent',
  server: null,
  args: { name: 'scout' },
};

function past(
  callId: string,
  call: RepeatCall,
  outcome?: PastCall['outcome'],
): PastCall {
  return { callId, ...call, ...(outcome === undefined ? {} : { outcome }) };
}

describe('the repeat rule counts the past same calls', () => {
  it.each<[string, RepeatCall, readonly PastCall[], RepeatDecision]>([
    [
      'no same call: run',
      SEARCH,
      [
        past(
          'c1',
          { ...SEARCH, args: { query: 'other', limit: 5 } },
          'success',
        ),
        past('c2', { ...SEARCH, server: 'tickets' }, 'success'),
        past('c3', { ...SEARCH, tool: 'get' }, 'success'),
      ],
      { kind: 'run' },
    ],
    [
      'one same call: the mark with its id',
      SEARCH,
      [past('c1', SEARCH, 'success')],
      { kind: 'mark', callIds: ['c1'] },
    ],
    [
      'two same calls of any outcome but refused: refuse',
      SEARCH,
      [past('c1', SEARCH, 'transport_failure'), past('c2', SEARCH, 'rejected')],
      { kind: 'refuse', callIds: ['c1', 'c2'] },
    ],
    [
      'the same arguments in another key order: the mark',
      SEARCH,
      [
        past(
          'c1',
          { ...SEARCH, args: { limit: 5, query: 'timeout' } },
          'success',
        ),
      ],
      { kind: 'mark', callIds: ['c1'] },
    ],
    [
      'two same calls refused by the check: run',
      SEARCH,
      [past('c1', SEARCH, 'refused'), past('c2', SEARCH, 'refused')],
      { kind: 'run' },
    ],
    [
      'one same call passed earlier in the same answer: the mark',
      SEARCH,
      [past('c1', SEARCH)],
      { kind: 'mark', callIds: ['c1'] },
    ],
    [
      'list_agents twice before: run',
      LIST_AGENTS,
      [past('c1', LIST_AGENTS, 'success'), past('c2', LIST_AGENTS, 'success')],
      { kind: 'run' },
    ],
    [
      'a built-in tool is counted as well',
      START_SCOUT,
      [past('c1', START_SCOUT, 'success'), past('c2', START_SCOUT, 'success')],
      { kind: 'refuse', callIds: ['c1', 'c2'] },
    ],
  ])('%s', (_case, call, earlier, expected) => {
    expect(repeatOf({ call, past: earlier })).toEqual(expected);
  });
});
