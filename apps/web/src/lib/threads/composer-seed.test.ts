import type { ChipRecord } from '@agent-os/contracts';
import { describe, expect, it } from 'vitest';
import {
  createComposerSeed,
  NEW_THREAD_TARGET,
  type ComposerSeed,
} from './composer-seed';

const LOGS: ChipRecord = {
  id: '7f3c1a52-4b8e-4c1d-9a0e-2d6b5f8e1c40',
  kind: 'agent',
  name: 'Разбор логов',
};
const REVIEW: ChipRecord = {
  id: '2a9d6e14-8c3b-4f70-b5d1-6e0c9a4f7b23',
  kind: 'agent',
  name: 'Ревью',
};
const RESEARCH: ChipRecord = {
  id: '0b9a4b8e-6c1e-4f43-9a52-3f0d1c2e5a71',
  kind: 'deep_agent',
  name: 'Исследование',
};

type Chips = Record<string, string>;

/** Each row drives a fresh store; `expected` is the chip name of every target that has one afterwards. */
const cases: Array<
  [title: string, run: (seed: ComposerSeed) => void, expected: Chips]
> = [
  [
    'a new chip replaces the previous one of the same conversation and leaves another alone',
    (seed) => {
      seed.put('t2', { record: RESEARCH });
      seed.put('t1', { record: LOGS });
      seed.put('t1', { record: REVIEW });
    },
    { t1: 'Ревью', t2: 'Исследование' },
  ],
  [
    'the text is taken once and the chip stays',
    (seed) => {
      seed.put('t1', { record: LOGS, text: 'Найди ошибки' });
      expect(seed.takeText('t1')).toBe('Найди ошибки');
      expect(seed.takeText('t1')).toBeNull();
    },
    { t1: 'Разбор логов' },
  ],
  [
    '«✕» or an accepted send drops the chip of that conversation only',
    (seed) => {
      seed.put('t1', { record: LOGS });
      seed.put('t2', { record: REVIEW });
      seed.clear('t1');
    },
    { t2: 'Ревью' },
  ],
  [
    'the conversation is gone: its chip and text move to a new conversation',
    (seed) => {
      seed.put('t1', { record: LOGS, text: 'Найди ошибки' });
      seed.move('t1', NEW_THREAD_TARGET);
      expect(seed.takeText('t1')).toBeNull();
      expect(seed.takeText(NEW_THREAD_TARGET)).toBe('Найди ошибки');
    },
    { [NEW_THREAD_TARGET]: 'Разбор логов' },
  ],
];

// Invariant 4 (one chip per composer), KD-5: the text is taken once, the chip waits for send or «✕».
describe('composerSeed', () => {
  it.each(cases)('%s', (_title, run, expected) => {
    const seed = createComposerSeed();

    run(seed);

    const chips = Object.fromEntries(
      [...seed.getState().chips].map(([target, record]) => [
        target,
        record.name,
      ]),
    );
    expect(chips).toEqual(expected);
  });
});
