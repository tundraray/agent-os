import type { FailureReason } from '@agent-os/contracts';
import { runNotAfter } from './agent-task-spec.js';
import { CHILD_RESULT_CUT_MARK, type ChildFailedReason, childFailedReason, childResultForSession } from './child-failure.js';

// What a parent learns of a failed child (design-agent-core.md, FR-05, DC-6, Error Handling; UC-E2, UC-E15) and the
// deadline of a run (DC-7, DC-27): pure rules, no doubles.
// Defects caught: a reason outside the closed list reaches the parent's session; a child's `context_overflow` reaches
// the parent as anything but `failed`; a child's deadline later than its parent's minus one lease.

describe('класс и код сбоя дочернего → причина child_failed', () => {
  it.each<[string, Pick<FailureReason, 'class' | 'code'> | null, ChildFailedReason]>([
    ['budget_exhausted / run_tokens_exhausted', { class: 'budget_exhausted', code: 'run_tokens_exhausted' }, 'budget_exhausted'],
    ['budget_exhausted / investigation_tokens_exhausted', { class: 'budget_exhausted', code: 'investigation_tokens_exhausted' }, 'budget_exhausted'],
    ['deadline / not_after', { class: 'deadline', code: 'not_after' }, 'deadline'],
    ['deadline / deadline_exceeded of the runtime', { class: 'deadline', code: 'deadline_exceeded' }, 'deadline'],
    ['validation_rejected / turn_limit', { class: 'validation_rejected', code: 'turn_limit' }, 'turn_limit'],
    ['transport_protocol / model_unavailable', { class: 'transport_protocol', code: 'model_unavailable' }, 'model_unavailable'],
    ['validation_rejected / context_overflow', { class: 'validation_rejected', code: 'context_overflow' }, 'failed'],
    ['validation_rejected / prologue_oversize', { class: 'validation_rejected', code: 'prologue_oversize' }, 'failed'],
    ['recovery_exhausted of the runtime', { class: 'recovery_exhausted', code: 'recovery_exhausted' }, 'failed'],
    ['internal of the runtime', { class: 'internal', code: 'handler_exception' }, 'failed'],
    ['no recorded reason', null, 'failed'],
  ])('%s → its reason', (_case, failure, expected) => {
    expect(childFailedReason(failure)).toBe(expected);
  });
});

describe('срок дочернего — меньшее из трёх', () => {
  const DEADLINE = new Date('2026-11-08T11:00:00.000Z');
  const MARGIN = 90_000;
  const LEASE = 30_000;
  const LATER = new Date('2026-11-09T00:00:00.000Z');

  // Defects caught: the bound of the task input ignored, so a run outlives what its start recorded (fix cycle 1, D3);
  // the root's bound taken without the margin — the start records it without one, to keep the margin out of the
  // root's `dedup_key` (fix cycle 2, M2) — or a child's bound, already less its margins, cut by the margin again.
  it.each<[string, Date | null, Date, string]>([
    ['the root: its task deadline minus the margin', null, LATER, '2026-11-08T10:58:30.000Z'],
    ['a child whose parent ends later: its own task deadline minus the margin', new Date('2026-11-08T11:30:00.000Z'), LATER, '2026-11-08T10:58:30.000Z'],
    ['a child whose parent ends sooner: the parent notAfter minus one lease', new Date('2026-11-08T10:40:00.000Z'), LATER, '2026-11-08T10:39:30.000Z'],
    ['the root whose task input bound is the soonest: that bound minus the margin', null, new Date('2026-11-08T10:20:00.000Z'), '2026-11-08T10:18:30.000Z'],
    ['a child whose task input bound is the soonest: that bound', new Date('2026-11-08T11:30:00.000Z'), new Date('2026-11-08T10:20:00.000Z'), '2026-11-08T10:20:00.000Z'],
  ])('%s', (_case, parentNotAfter, inputNotAfter, expected) => {
    const notAfter = runNotAfter({
      taskDeadlineAt: DEADLINE,
      deadlineMarginMs: MARGIN,
      inputNotAfter,
      parent: parentNotAfter === null ? null : { notAfter: parentNotAfter, leaseMs: LEASE },
    });

    expect(notAfter.toISOString()).toBe(expected);
  });
});

// Fix cycles 1 (D6) and 2 (M1), design-agent-core.md «Реестр инструментов» (a result is at most 16 KiB), FR-04: a
// child's result in its parent's session is cut to the `call_agent` result limit with the child's run and a mark naming
// `investigation_read` by that run, which reads the whole result in pieces. Defect caught: a child's long result
// written whole into the parent's session.
describe('результат дочернего в сессии родителя', () => {
  const LIMIT = 16 * 1_024;
  const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
  const CHILD_RUN = '00000000-0000-4000-8000-0000000000c1';

  it.each<[string, unknown]>([
    ['a result within the limit comes whole', { summary: 'the disk was full', refs: [] }],
    ['a result over the limit comes cut to it, with its size and the mark', { summary: 'ж'.repeat(12_000), refs: [] }],
  ])('%s', (_case, result) => {
    const written = childResultForSession(result, CHILD_RUN, LIMIT);

    expect(bytesOf(written)).toBeLessThanOrEqual(LIMIT);
    if (bytesOf(result) <= LIMIT) {
      expect(written).toEqual(result);
    } else {
      expect(written).toMatchObject({ cut: true, bytes: bytesOf(result), run: CHILD_RUN, mark: CHILD_RESULT_CUT_MARK });
      expect(JSON.stringify(result).startsWith((written as { resultText: string }).resultText)).toBe(true);
    }
  });
});
