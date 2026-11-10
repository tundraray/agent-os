import type {
  AgentTree,
  AgentTreeCall,
  AgentTreeRun,
  RunRecord,
} from '@agent-os/engine';
import { describe, expect, it } from 'vitest';
import { checkUnkeyedForm } from './judge/form-check.js';
import {
  failureSignals,
  type SignalRun,
  unverifiedByRefusal,
} from './signals.js';

// DC-15, AC-07.1 (rule half), UC-15: the four failure signals of an investigation without a key.

const THRESHOLDS = {
  discardedShare: 0.5,
  rejectedCalls: 3,
} as const;

type Claim = RunRecord['claims'][number];
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
  agentTree: treeOf(),
  ...overrides,
});

/** A tree whose worker had `count` calls refused by the code. */
const refusedCalls = (count: number): AgentTree =>
  treeOf(
    treeRun(
      'worker',
      Array.from({ length: count }, (_, callIndex) => treeCall({ callIndex })),
    ),
  );

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
        agentTree: refusedCalls(3),
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
      rejectedCalls: { fired: true, rejected: 3 },
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
        agentTree: refusedCalls(3),
      }),
      judge: null,
      thresholds: THRESHOLDS,
    });

    expect(signals).toEqual({
      lowJudgeScore: null,
      discardedClaims: { fired: true, discarded: 1, total: 1, share: 1 },
      rejectedCalls: { fired: true, rejected: 3 },
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

const treeCall = (overrides: Partial<AgentTreeCall>): AgentTreeCall => ({
  callIndex: 0,
  turn: 0,
  toolName: 'claims_write',
  arguments: {},
  state: 'rejected',
  outcome: { outcome: 'rejected', reason: 'pointer_invalid' },
  reason: 'pointer_invalid',
  childTaskId: null,
  ...overrides,
});

const treeRun = (
  agentName: string,
  toolCalls: AgentTreeCall[],
): AgentTreeRun => ({
  runTaskId: `run-${agentName}`,
  agentName,
  parent: null,
  depth: 0,
  assignment: null,
  prologueFirstMessage: null,
  status: 'succeeded',
  result: null,
  failure: null,
  shareTokens: 0,
  spentTokens: 0,
  subtreeSpentTokens: 0,
  turns: [],
  toolCalls,
});

const treeOf = (...runs: AgentTreeRun[]): AgentTree => ({
  investigationId: '00000000-0000-4000-8000-000000000001',
  runs,
  definitionMemorySnapshot: {},
  catalog: [],
  budgetExhausted: false,
});

/** A `finish` refused by the closure, as T2.4 stores it: the form's reason is in the outcome, not in the column. */
const refusedFinish = (reason: string): AgentTreeCall =>
  treeCall({
    toolName: 'finish',
    reason: 'invalid_result',
    outcome: {
      outcome: 'rejected',
      reason: 'invalid_result',
      detail: { reason },
    },
  });

const POINTER_INVALID = treeCall({});
const CHILD_FAILED = treeCall({
  toolName: 'call_agent',
  state: 'done',
  reason: 'child_failed',
  outcome: {
    outcome: 'tool_error',
    reason: 'child_failed',
    result: { child_failed: 'deadline' },
  },
});

// DC-12, KD-6: the signal of an agents-form run reads the tree's refused calls; the protocol's own refusal and a child's
// failure are not faults of the agent.
describe('сигналы v3', () => {
  it.each<[string, AgentTreeCall[], number, boolean]>([
    [
      'two pointer_invalid: below the threshold',
      [POINTER_INVALID, POINTER_INVALID],
      2,
      false,
    ],
    [
      'three pointer_invalid: at the threshold',
      [POINTER_INVALID, POINTER_INVALID, POINTER_INVALID],
      3,
      true,
    ],
    [
      'needs_verification is not counted',
      [POINTER_INVALID, POINTER_INVALID, refusedFinish('needs_verification')],
      2,
      false,
    ],
    [
      'child_failed is not counted',
      [POINTER_INVALID, POINTER_INVALID, CHILD_FAILED],
      2,
      false,
    ],
    [
      'finish refused draft_invalid is counted',
      [POINTER_INVALID, POINTER_INVALID, refusedFinish('draft_invalid')],
      3,
      true,
    ],
  ])('rejected calls: %s', (_case, calls, rejected, fired) => {
    const [first, ...rest] = calls;
    if (first === undefined) throw new Error('a row has calls');
    const signals = failureSignals({
      // Over two runs of the tree: the count is the whole tree's.
      run: run({
        agentTree: treeOf(
          treeRun('worker', [first]),
          treeRun('controller', rest),
        ),
      }),
      judge: judged('yes'),
      thresholds: THRESHOLDS,
    });

    expect(signals.rejectedCalls).toEqual({ fired, rejected });
  });

  const PROCESS_CONFIG = {
    agents: {
      verifier: { result: 'claim_assessment' },
      worker: { result: 'text' },
    },
  };
  const checkOf = (claimId: string, overrides: Partial<AgentTreeCall>) =>
    treeCall({
      toolName: 'call_agent',
      arguments: { agent: 'verifier', assignment: claimId },
      ...overrides,
    });
  const refused = (reason: string) => ({
    reason,
    outcome: { outcome: 'rejected', reason },
  });

  it.each<[string, string, AgentTreeCall, string[]]>([
    [
      'budget_exhausted',
      'unverified',
      checkOf('c1', refused('budget_exhausted')),
      ['c1'],
    ],
    [
      'children_limit',
      'unverified',
      checkOf('c1', refused('children_limit')),
      ['c1'],
    ],
    ['task_limit', 'unverified', checkOf('c1', refused('task_limit')), ['c1']],
    [
      'a failed checker run',
      'unverified',
      { ...CHILD_FAILED, arguments: { agent: 'verifier', assignment: 'c1' } },
      ['c1'],
    ],
    [
      'a supported claim is not counted',
      'supported',
      checkOf('c1', refused('budget_exhausted')),
      [],
    ],
    // Owner decision, shared with gate 2: any other refusal is not an attempted check.
    ...['calls_per_turn_limit', 'access_denied', 'invalid_arguments'].map(
      (reason): [string, string, AgentTreeCall, string[]] => [
        `the refusal ${reason} is not counted`,
        'unverified',
        checkOf('c1', refused(reason)),
        [],
      ],
    ),
    [
      'a call for another claim is not counted',
      'unverified',
      checkOf('c2', refused('task_limit')),
      [],
    ],
    [
      'a call of another agent is not counted',
      'unverified',
      checkOf('c1', {
        ...refused('task_limit'),
        arguments: { agent: 'worker', assignment: 'c1' },
      }),
      [],
    ],
  ])('unverifiedByRefusal: %s', (_case, status, call, claimIds) => {
    const unverified = unverifiedByRefusal({
      claims: [claim('c1', status)],
      agentTree: treeOf(treeRun('controller', [call])),
      processConfig: PROCESS_CONFIG,
    });

    expect(unverified.map(({ claimId }) => claimId)).toEqual(claimIds);
  });
});
