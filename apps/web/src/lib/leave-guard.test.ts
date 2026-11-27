import { describe, expect, it } from 'vitest';
import {
  createLeaveGuard,
  type LeaveGuard,
  type LeaveSubject,
} from './leave-guard';

type Outcome = {
  leave: boolean;
  held: LeaveSubject | null;
  question: LeaveSubject | null;
};

const RECORD: LeaveSubject = { kind: 'record', name: 'Разбор логов' };

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
      guard.hold(RECORD);
      guard.release();
      return guard.confirmLeave();
    },
    { leave: true, held: null, question: null },
  ],
  [
    'held, «Остаться»: stays and keeps the hold',
    (guard) => {
      guard.hold(RECORD);
      const answer = guard.confirmLeave();
      expect(guard.getState().question).toEqual(RECORD);
      guard.answer(false);
      return answer;
    },
    { leave: false, held: RECORD, question: null },
  ],
  [
    'held, «Уйти без сохранения»: leaves and the hold is gone',
    (guard) => {
      guard.hold(RECORD);
      const answer = guard.confirmLeave();
      guard.answer(true);
      return answer;
    },
    { leave: true, held: null, question: null },
  ],
  [
    'held, released while asking: the question closes with «leave»',
    (guard) => {
      guard.hold(RECORD);
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
