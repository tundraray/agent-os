import { SELF_CHECK_OWNER } from '../auth/system-owners.js';
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
      `self-check:copy:${INVESTIGATION}`,
      { kind: 'copy', investigationId: INVESTIGATION },
    ],
    [
      `self-check:show:${INVESTIGATION}:${SHOW}`,
      { kind: 'show', investigationId: INVESTIGATION, showId: SHOW },
    ],
  ])('writes %s and parses it back', (text, id) => {
    expect(formatThreadId(id)).toBe(text);
    expect(parseThreadId(text)).toEqual(id);
  });

  it.each([
    ['an employee conversation id', '0b8f4c1e-2d3a-4b5c-8d7e-6f9a0b1c2d3e'],
    ['another prefix', 'selfcheck:run:r1'],
    ['an unknown kind', 'self-check:replay:x'],
    ['an extra part in a run id', 'self-check:run:r1:extra'],
    [
      'a copy id with a database segment, as before design 1.6',
      `self-check:copy:main:${INVESTIGATION}`,
    ],
    [
      'an extra part in a show id',
      `self-check:show:${INVESTIGATION}:${SHOW}:extra`,
    ],
    ['a missing part in a show id', `self-check:show:${INVESTIGATION}`],
    ['an empty part', 'self-check:copy:'],
  ])('rejects %s', (_, text) => {
    expect(parseThreadId(text)).toBeNull();
  });

  it.each<[string, SelfCheckThreadId]>([
    ['an empty id', { kind: 'run', runId: '' }],
    ['an id with the separator', { kind: 'copy', investigationId: 'a:b' }],
  ])('refuses to write %s, which would not parse back', (_, id) => {
    expect(() => formatThreadId(id)).toThrow();
  });
});

// DC-4: a copy must not outlive the employee's original, so a repeat of a repeat points at that original; everything
// else points at the investigation it repeats. Only the program's own investigation is a repeat: an employee's
// conversation id shaped like a copy id must not point the copy at another investigation.
describe('copyOrigin', () => {
  it.each<[string, Parameters<typeof copyOrigin>[0], string]>([
    [
      'a repeat inherits its original',
      {
        investigationId: 'copy-1',
        ownerId: SELF_CHECK_OWNER,
        threadId: 'self-check:copy:X',
      },
      'X',
    ],
    [
      'a scenario run is referenced itself',
      {
        investigationId: 'scenario-1',
        ownerId: SELF_CHECK_OWNER,
        threadId: 'self-check:run:R',
      },
      'scenario-1',
    ],
    [
      'an employee investigation is referenced itself',
      {
        investigationId: 'X',
        ownerId: 'employee-1',
        threadId: '0b8f4c1e-2d3a-4b5c-8d7e-6f9a0b1c2d3e',
      },
      'X',
    ],
    [
      "an employee investigation with a copy-shaped id is referenced itself, not the id's investigation",
      {
        investigationId: 'own-1',
        ownerId: 'employee-1',
        threadId: 'self-check:copy:someone-elses',
      },
      'own-1',
    ],
  ])('%s', (_, source, origin) => {
    expect(copyOrigin(source)).toBe(origin);
  });
});
