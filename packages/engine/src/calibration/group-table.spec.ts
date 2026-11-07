import { promptVersion } from '../model/prompt-version.js';
import { type GroupTable, GroupTableSchema, findGroupTable } from './group-table.js';

// KD-3, DC-2 (the lookup half; the start refusal is createEngine, T5.2), DC-11: the group table of an investigation is
// the one calibrated for the model and the prompt version of its `verifier` role. Defect caught: a table calibrated for
// another prompt or another model is used after the prompt or the model changed; a three-group table names the fourth
// group.

const PROMPT = 'Judge the claim against the data section.';
const PROFILE = { claimType: 'quantitative', valueCheck: 'matched', independentRecords: 'two_or_more', contradictions: false } as const;

const table = (overrides: Partial<GroupTable> = {}): GroupTable => ({
  model: 'anthropic/claude-haiku-4-5',
  promptVersion: promptVersion(PROMPT),
  scenarioSet: 'first',
  pairsFingerprint: '0123456789ab',
  calibratedAt: '2026-11-07T10:00:00.000Z',
  groupCount: 3,
  profiles: [{ profile: PROFILE, group: 'high' }],
  groups: [{ group: 'high', establishedPairs: 12, correctShare: 0.92 }],
  pairKinds: [{ pairKind: 'supported', supportMatch: 0.9, typeMatch: 0.8, decisionMatch: 0.85 }],
  ...overrides,
});

describe('findGroupTable: the table of the verifier model and prompt version', () => {
  const calibrated = table();
  const otherModel = table({ model: 'anthropic/claude-sonnet-4-5' });

  it.each<[string, { model: string; prompt: string }, GroupTable | undefined]>([
    ['the same model and prompt', { model: 'anthropic/claude-haiku-4-5', prompt: PROMPT }, calibrated],
    ['the prompt edited by one word', { model: 'anthropic/claude-haiku-4-5', prompt: `${PROMPT} Now.` }, undefined],
    ['another model with the same prompt', { model: 'anthropic/claude-opus-4-5', prompt: PROMPT }, undefined],
  ])('%s', (_, verifier, expected) => {
    expect(findGroupTable([otherModel, calibrated], verifier)).toBe(expected);
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
