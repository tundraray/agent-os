import {
  copyOrigin,
  formatThreadId,
  parseThreadId,
  type SelfCheckThreadId,
} from './thread-ids.js';

const INVESTIGATION = '5f0c2b9e-8a41-4d7e-9b1a-0c6f2d3e4a51';
const SHOW = 'b7e1d0a4-3c2f-4e8b-a9d6-1f5e7c8b9a02';

// Data Model «Где копия помнит оригинал»: the stored reference of a copy is written and read by this one scheme.
describe('thread ids', () => {
  it.each<[string, SelfCheckThreadId]>([
    [
      'self-check:run:run-20261107-01',
      { kind: 'run', runId: 'run-20261107-01' },
    ],
    [
      `self-check:copy:main:${INVESTIGATION}`,
      { kind: 'copy', base: 'main', investigationId: INVESTIGATION },
    ],
    [
      `self-check:copy:self_check:${INVESTIGATION}`,
      { kind: 'copy', base: 'self_check', investigationId: INVESTIGATION },
    ],
    [
      `self-check:show:main:${INVESTIGATION}:${SHOW}`,
      {
        kind: 'show',
        base: 'main',
        investigationId: INVESTIGATION,
        showId: SHOW,
      },
    ],
  ])('writes %s and parses it back', (text, id) => {
    expect(formatThreadId(id)).toBe(text);
    expect(parseThreadId(text)).toEqual(id);
  });

  it.each([
    ['an employee conversation id', '0b8f4c1e-2d3a-4b5c-8d7e-6f9a0b1c2d3e'],
    ['another prefix', 'selfcheck:run:r1'],
    ['an unknown kind', 'self-check:replay:main:x'],
    ['an unknown base', `self-check:copy:staging:${INVESTIGATION}`],
    ['an extra part in a run id', 'self-check:run:r1:extra'],
    [
      'an extra part in a copy id',
      `self-check:copy:main:${INVESTIGATION}:extra`,
    ],
    [
      'an extra part in a show id',
      `self-check:show:main:${INVESTIGATION}:${SHOW}:extra`,
    ],
    ['a missing part in a show id', `self-check:show:main:${INVESTIGATION}`],
    ['an empty part', 'self-check:copy:main:'],
  ])('rejects %s', (_, text) => {
    expect(parseThreadId(text)).toBeNull();
  });

  it.each<[string, SelfCheckThreadId]>([
    ['an empty id', { kind: 'run', runId: '' }],
    [
      'an id with the separator',
      { kind: 'copy', base: 'main', investigationId: 'a:b' },
    ],
  ])('refuses to write %s, which would not parse back', (_, id) => {
    expect(() => formatThreadId(id)).toThrow();
  });
});

// DC-4: a copy must not outlive the employee's original, so a copy of a copy from the main database points at
// that original; everything else points at the investigation it repeats.
describe('copyOrigin', () => {
  it.each<
    [string, Parameters<typeof copyOrigin>[0], ReturnType<typeof copyOrigin>]
  >([
    [
      'a copy from the main database inherits its original',
      {
        base: 'self_check',
        investigationId: 'copy-1',
        threadId: 'self-check:copy:main:X',
      },
      { base: 'main', investigationId: 'X' },
    ],
    [
      'a scenario run is referenced itself',
      {
        base: 'self_check',
        investigationId: 'scenario-1',
        threadId: 'self-check:run:R',
      },
      { base: 'self_check', investigationId: 'scenario-1' },
    ],
    [
      'a repeat of a scenario run is referenced itself',
      {
        base: 'self_check',
        investigationId: 'copy-2',
        threadId: 'self-check:copy:self_check:scenario-1',
      },
      { base: 'self_check', investigationId: 'copy-2' },
    ],
    [
      'an employee investigation in the main database is referenced itself',
      {
        base: 'main',
        investigationId: 'X',
        threadId: '0b8f4c1e-2d3a-4b5c-8d7e-6f9a0b1c2d3e',
      },
      { base: 'main', investigationId: 'X' },
    ],
  ])('%s', (_, source, origin) => {
    expect(copyOrigin(source)).toEqual(origin);
  });
});
