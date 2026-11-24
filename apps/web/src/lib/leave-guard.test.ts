import { describe, expect, it } from 'vitest';
import { createLeaveGuard, type LeaveGuard } from './leave-guard';

type Outcome = {
  leave: boolean;
  held: string | null;
  question: { name: string } | null;
};

/** Each row drives a fresh guard and returns the answer of its `confirmLeave()`. */
const cases: Array<
  [
    title: string,
    run: (guard: LeaveGuard) => Promise<boolean>,
    expected: Outcome,
  ]
> = [
  [
    'nothing held: leaves without a question',
    (guard) => guard.confirmLeave(),
    { leave: true, held: null, question: null },
  ],
  [
    'released before navigating: leaves without a question',
    (guard) => {
      guard.hold('Разбор логов');
      guard.release();
      return guard.confirmLeave();
    },
    { leave: true, held: null, question: null },
  ],
  [
    'held, «Остаться»: stays and keeps the hold',
    (guard) => {
      guard.hold('Разбор логов');
      const answer = guard.confirmLeave();
      expect(guard.getState().question).toEqual({ name: 'Разбор логов' });
      guard.answer(false);
      return answer;
    },
    { leave: false, held: 'Разбор логов', question: null },
  ],
  [
    'held, «Уйти без сохранения»: leaves and the hold is gone',
    (guard) => {
      guard.hold('Разбор логов');
      const answer = guard.confirmLeave();
      guard.answer(true);
      return answer;
    },
    { leave: true, held: null, question: null },
  ],
  [
    'held, released while asking: the question closes with «leave»',
    (guard) => {
      guard.hold('Разбор логов');
      const answer = guard.confirmLeave();
      guard.release();
      return answer;
    },
    { leave: true, held: null, question: null },
  ],
];

// KD-4, MC-11: no question while nothing is held; the hold ends only by the employee's decision or `release()`.
describe('leaveGuard', () => {
  it.each(cases)('%s', async (_title, run, expected) => {
    const guard = createLeaveGuard();

    const leave = await run(guard);

    const { held, question } = guard.getState();
    expect({ leave, held, question }).toEqual(expected);
  });
});
