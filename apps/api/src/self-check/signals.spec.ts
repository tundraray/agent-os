import type { RunRecord } from '@agent-os/engine';
import { describe, expect, it } from 'vitest';
import { checkUnkeyedForm } from './judge/form-check.js';
import { failureSignals, type SignalRun } from './signals.js';

// DC-15, AC-07.1 (rule half), UC-15: the four failure signals of an investigation without a key.

const THRESHOLDS = { discardedShare: 0.5, controllerRejections: 3 } as const;

type Claim = RunRecord['claims'][number];
type Decision = RunRecord['decisions'][number];
type Answer = NonNullable<RunRecord['answer']>;

const claim = (claimId: string, status: string): Claim => ({
  claimId,
  text: claimId,
  status,
  atoms: [],
  evidenceIds: [],
});

const answerClaim = (claimId: string) => ({
  claimId,
  text: claimId,
  evidenceIds: [],
  verified: true,
});

const removed = (claimId: string) => ({
  claimId,
  text: claimId,
  reason: 'gateway',
});

const decision = (index: number, status: 'accepted' | 'rejected'): Decision => {
  const base = {
    decisionId: `d${index}`,
    step: index,
    callIndex: 0,
    decidedBy: 'model',
    decidedAt: new Date(0),
  };
  return status === 'accepted'
    ? { ...base, status, kind: 'collect' }
    : { ...base, status, kind: null, rejectionReason: 'invalid_kind' };
};

const decisions = (rejected: number, accepted = 1): Decision[] => [
  ...Array.from({ length: accepted }, (_, index) =>
    decision(index, 'accepted'),
  ),
  ...Array.from({ length: rejected }, (_, index) =>
    decision(accepted + index, 'rejected'),
  ),
];

const answer = (overrides: Partial<Answer> = {}): Answer => ({
  answerId: 'a1',
  outcome: 'partial',
  stopReason: null,
  established: [],
  assumed: [],
  unknown: [],
  removed: [],
  ...overrides,
});

const run = (overrides: Partial<SignalRun> = {}): SignalRun => ({
  answer: answer(),
  claims: [],
  decisions: [],
  ...overrides,
});

const judged = (answersQuestion: unknown) =>
  checkUnkeyedForm({ answersQuestion });

describe('failureSignals', () => {
  it('UC-15: refuted and insufficient in «Не выяснено» are discarded, causal and supported are not; share 0.5 fires', () => {
    const signals = failureSignals({
      run: run({
        answer: answer({
          stopReason: 'step_limit',
          established: [answerClaim('supported-1')],
          unknown: [answerClaim('insufficient-1')],
        }),
        claims: [
          claim('refuted-1', 'refuted'),
          claim('insufficient-1', 'insufficient'),
          claim('causal-1', 'causal'),
          claim('supported-1', 'supported'),
        ],
        decisions: decisions(3),
      }),
      judge: judged('yes'),
      thresholds: THRESHOLDS,
    });

    expect(signals).toEqual({
      lowJudgeScore: {
        fired: false,
        answersQuestion: 'yes',
        judgeInvalid: false,
      },
      discardedClaims: { fired: true, discarded: 2, total: 4, share: 0.5 },
      controllerRejections: { fired: true, rejected: 3 },
      stopReason: { fired: true, stopReason: 'step_limit' },
    });
  });

  it.each([
    // [case, claims, removed ids, discarded, total, share, fired]
    ['no claims at all: no share and no signal', [], [], 0, 0, null, false],
    [
      'causal and unverified are not discarded',
      [claim('c', 'causal'), claim('u', 'unverified')],
      [],
      0,
      2,
      0,
      false,
    ],
    [
      'a removed new draft claim counts in numerator and denominator',
      [claim('s', 'supported')],
      ['draft-new'],
      1,
      2,
      0.5,
      true,
    ],
    [
      'a removed claim with a revision counts once in each',
      [
        claim('s', 'supported'),
        claim('r', 'supported'),
        claim('t', 'supported'),
      ],
      ['r'],
      1,
      3,
      1 / 3,
      false,
    ],
    [
      'just below the threshold: 1 of 3',
      [
        claim('x', 'refuted'),
        claim('s1', 'supported'),
        claim('s2', 'supported'),
      ],
      [],
      1,
      3,
      1 / 3,
      false,
    ],
    [
      'above the threshold: 2 of 3',
      [
        claim('x', 'refuted'),
        claim('y', 'insufficient'),
        claim('s', 'supported'),
      ],
      [],
      2,
      3,
      2 / 3,
      true,
    ],
  ] as const)(
    'discarded claims: %s',
    (_, claims, removedIds, discarded, total, share, fired) => {
      const signals = failureSignals({
        run: run({
          claims: [...claims],
          answer: answer({ removed: removedIds.map(removed) }),
        }),
        judge: judged('yes'),
        thresholds: THRESHOLDS,
      });

      expect(signals.discardedClaims).toEqual({
        fired,
        discarded,
        total,
        share,
      });
    },
  );

  it.each([
    // [rejected decisions, fired]
    [2, false],
    [3, true],
    [4, true],
  ])(
    'controller rejections: %i rejected against threshold 3 -> fired %s',
    (rejected, fired) => {
      const signals = failureSignals({
        run: run({ decisions: decisions(rejected, 5) }),
        judge: judged('yes'),
        thresholds: THRESHOLDS,
      });

      expect(signals.controllerRejections).toEqual({ fired, rejected });
    },
  );

  it.each([
    ['budget_exhausted', true],
    [null, false],
  ] as const)('stop reason %s -> fired %s', (stopReason, fired) => {
    const signals = failureSignals({
      run: run({ answer: answer({ stopReason }) }),
      judge: judged('yes'),
      thresholds: THRESHOLDS,
    });

    expect(signals.stopReason).toEqual({ fired, stopReason });
  });

  it.each([
    ['yes', { fired: false, answersQuestion: 'yes', judgeInvalid: false }],
    [
      'partly',
      { fired: false, answersQuestion: 'partly', judgeInvalid: false },
    ],
    ['no', { fired: true, answersQuestion: 'no', judgeInvalid: false }],
    ['maybe', { fired: true, answersQuestion: null, judgeInvalid: true }],
  ] as const)('low judge score: judge form %s', (value, expected) => {
    const signals = failureSignals({
      run: run(),
      judge: judged(value),
      thresholds: THRESHOLDS,
    });

    expect(signals.lowJudgeScore).toEqual(expected);
  });

  it('no answer: the judge score is not set, the other signals are still counted', () => {
    const signals = failureSignals({
      run: run({
        answer: null,
        claims: [claim('r', 'refuted')],
        decisions: decisions(3),
      }),
      judge: null,
      thresholds: THRESHOLDS,
    });

    expect(signals).toEqual({
      lowJudgeScore: null,
      discardedClaims: { fired: true, discarded: 1, total: 1, share: 1 },
      controllerRejections: { fired: true, rejected: 3 },
      stopReason: { fired: false, stopReason: null },
    });
  });

  it('an answer without a judge result is a caller defect', () => {
    expect(() =>
      failureSignals({ run: run(), judge: null, thresholds: THRESHOLDS }),
    ).toThrow(
      'the low judge score needs the judge result of an answered investigation',
    );
  });
});
