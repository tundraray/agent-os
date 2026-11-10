import { type GroupTable, GroupTableSchema, findGroupTableByPair } from './group-table.js';

// KD-4 of research-flow, DC-10, DC-11: a group table is keyed by the fingerprint pair of the checker agent. Defects
// caught: another pair finds the table; a table with no key, half a key, or a `promptVersion` key instead of the pair
// loads; a three-group table names the fourth group.

const PROFILE = { claimType: 'quantitative', valueCheck: 'matched', independentRecords: 'two_or_more', contradictions: false } as const;
const PAIR = { agentFingerprint: 'aaaaaaaaaaaa', definitionMemoryFingerprint: 'bbbbbbbbbbbb' };

const table = (overrides: Partial<GroupTable> = {}): GroupTable => ({
  model: 'anthropic/claude-haiku-4-5',
  ...PAIR,
  scenarioSet: 'first',
  pairsFingerprint: '0123456789ab',
  calibratedAt: '2026-11-07T10:00:00.000Z',
  groupCount: 3,
  profiles: [{ profile: PROFILE, group: 'high' }],
  groups: [{ group: 'high', establishedPairs: 12, correctShare: 0.92 }],
  pairKinds: [{ pairKind: 'supported', supportMatch: 0.9, typeMatch: 0.8, decisionMatch: 0.85 }],
  ...overrides,
});

describe('findGroupTableByPair: only the table of its own fingerprint pair', () => {
  const own = table();
  const otherMemory = table({ definitionMemoryFingerprint: 'cccccccccccc' });
  const otherAgent = table({ agentFingerprint: 'dddddddddddd' });

  it.each<[string, typeof PAIR, GroupTable | undefined]>([
    ['its own pair', PAIR, own],
    ['the same agent, other memory', { ...PAIR, definitionMemoryFingerprint: 'eeeeeeeeeeee' }, undefined],
    ['other agent, the same memory', { ...PAIR, agentFingerprint: 'eeeeeeeeeeee' }, undefined],
  ])('%s', (_, pair, expected) => {
    expect(findGroupTableByPair([otherMemory, otherAgent, own], pair)).toBe(expected);
  });
});

describe('GroupTableSchema: the key of a table', () => {
  const { agentFingerprint: _agent, definitionMemoryFingerprint: _memory, ...unkeyed } = table();

  it.each<[string, () => unknown, boolean]>([
    ['the pair of fingerprints and the model', () => table(), true],
    ['no key', () => unkeyed, false],
    ['half of the pair', () => ({ ...unkeyed, agentFingerprint: PAIR.agentFingerprint }), false],
    ['a promptVersion key instead of the pair', () => ({ ...unkeyed, promptVersion: '0123456789ab' }), false],
    ['the pair with a prompt version beside it', () => ({ ...table(), promptVersion: '0123456789ab' }), false],
    ['a fingerprint that is not 12 hex digits', () => table({ agentFingerprint: 'not-hex' }), false],
  ])('%s', (_, candidate, accepted) => {
    expect(GroupTableSchema.safeParse(candidate()).success).toBe(accepted);
  });
});

describe('GroupTableSchema: the groups a table may name', () => {
  it.each<[string, GroupTable, boolean]>([
    ['three groups from high to low', table(), true],
    [
      'three groups naming very_high',
      table({ groups: [{ group: 'very_high', establishedPairs: 3, correctShare: 1 }] }),
      false,
    ],
    [
      'a profile of a three-group table in very_high',
      table({ profiles: [{ profile: PROFILE, group: 'very_high' }] }),
      false,
    ],
    [
      'four groups naming very_high',
      table({ groupCount: 4, groups: [{ group: 'very_high', establishedPairs: 3, correctShare: 1 }] }),
      true,
    ],
  ])('%s', (_, candidate, accepted) => {
    expect(GroupTableSchema.safeParse(candidate).success).toBe(accepted);
  });
});
