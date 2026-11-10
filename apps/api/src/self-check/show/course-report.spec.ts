import { deepResearchProcessV3, type RunRecord } from '@agent-os/engine';
import { describe, expect, it } from 'vitest';
import { SIGNAL_LABELS } from '../result/report.js';
import type { FailureSignals } from '../signals.js';
import { renderCourseReport } from './course-report.js';

// AC-07.1, DC-15 (the report half): the course report marks each of the four failure signals as fired or not; the
// signal rules themselves are signals.spec.ts. Defect caught: a report that prints the signals without their state, or
// marks a signal that did not fire.

/** The shipped v3 as a run record names its frozen configuration. */
const SHIPPED = deepResearchProcessV3 as RunRecord['config']['processConfig'];

const RECORD: RunRecord = {
  investigationId: '00000000-0000-4000-8000-000000000001',
  ownerId: 'e2e-owner',
  query: 'Почему 15 сентября выросли ошибки оплаты?',
  status: 'completed',
  config: { processConfig: SHIPPED, fingerprint: '0123456789ab' },
  sourceSnapshots: { fixture: 'fx-v1-2157485c' },
  answer: {
    answerId: '00000000-0000-4000-8000-000000000002',
    outcome: 'inconclusive',
    stopReason: 'step_limit',
    established: [],
    assumed: [],
    unknown: [],
    removed: [],
  },
  claims: [],
  evidence: [],
  usage: {
    byRoleAndModel: [],
    byAgentAndModel: [],
    totalTokens: 0,
    totalCostUsd: 0,
    tokenBudget: 300_000,
  },
  calls: [],
  agentTree: {
    investigationId: '00000000-0000-4000-8000-000000000001',
    runs: [],
    definitionMemorySnapshot: {},
    budgetExhausted: false,
  },
};

const FIRED = 'сработал';
const NOT_FIRED = 'не сработал';

type SignalName = keyof typeof SIGNAL_LABELS;
const SIGNAL_NAMES = Object.keys(SIGNAL_LABELS) as SignalName[];

/** The mark of each signal line of the report's «Сигналы сбоя» section, by signal name. */
function marksOf(report: string): Record<SignalName, string> {
  const lines = report.split('\n');
  return Object.fromEntries(
    SIGNAL_NAMES.map((name) => {
      const prefix = `- ${SIGNAL_LABELS[name]}: `;
      const line = lines.find((candidate) => candidate.startsWith(prefix));
      if (line === undefined) throw new Error(`no line of the signal ${name}`);
      const state = line.slice(prefix.length);
      return [
        name,
        state.startsWith(NOT_FIRED)
          ? NOT_FIRED
          : state.startsWith(FIRED)
            ? FIRED
            : state,
      ];
    }),
  ) as Record<SignalName, string>;
}

describe('renderCourseReport', () => {
  it.each<{
    name: string;
    signals: FailureSignals;
    marks: Record<SignalName, string>;
  }>([
    {
      name: 'two signals fired, two not: each fired one is marked, an unfired one is not',
      signals: {
        lowJudgeScore: {
          fired: false,
          answersQuestion: 'yes',
          judgeInvalid: false,
        },
        discardedClaims: { fired: false, discarded: 0, total: 3, share: 0 },
        rejectedCalls: { fired: true, rejected: 3 },
        stopReason: { fired: true, stopReason: 'step_limit' },
      },
      marks: {
        lowJudgeScore: NOT_FIRED,
        discardedClaims: NOT_FIRED,
        rejectedCalls: FIRED,
        stopReason: FIRED,
      },
    },
    {
      name: 'the judge signal fired on an invalid form, the claims signal fired, the others not',
      signals: {
        lowJudgeScore: {
          fired: true,
          answersQuestion: null,
          judgeInvalid: true,
        },
        discardedClaims: { fired: true, discarded: 2, total: 3, share: 2 / 3 },
        rejectedCalls: { fired: false, rejected: 0 },
        stopReason: { fired: false, stopReason: null },
      },
      marks: {
        lowJudgeScore: FIRED,
        discardedClaims: FIRED,
        rejectedCalls: NOT_FIRED,
        stopReason: NOT_FIRED,
      },
    },
    {
      name: 'no answer: the judge signal is not set, the other three are marked',
      signals: {
        lowJudgeScore: null,
        discardedClaims: { fired: false, discarded: 0, total: 0, share: null },
        rejectedCalls: { fired: true, rejected: 4 },
        stopReason: { fired: false, stopReason: null },
      },
      marks: {
        lowJudgeScore: 'не ставится: ответа нет, судья не вызывался',
        discardedClaims: NOT_FIRED,
        rejectedCalls: FIRED,
        stopReason: NOT_FIRED,
      },
    },
  ])('$name', ({ signals, marks }) => {
    const report = renderCourseReport({
      record: RECORD,
      transcripts: [],
      retention: { days: 30 },
      signals,
      showRunId: `self-check:show:${RECORD.investigationId}:00000000-0000-4000-8000-000000000003`,
    });

    expect(marksOf(report)).toEqual(marks);
  });
});

// AC-18.3, FR-18: the report of an agents-form investigation shows the tree and the two lists.
describe('renderCourseReport of an agents-form investigation', () => {
  const CALL_DEFAULTS = {
    turn: 0,
    outcome: null,
    childTaskId: null,
  };
  const report = renderCourseReport({
    record: {
      ...RECORD,
      claims: [
        {
          claimId: 'claim-1',
          text: 'claim text',
          status: 'unverified',
          atoms: [],
          evidenceIds: [],
        },
      ],
      config: {
        processConfig: {
          agents: { verifier: { result: 'claim_assessment' } },
        } as unknown as RunRecord['config']['processConfig'],
        fingerprint: '0123456789ab',
      },
      agentTree: {
        investigationId: RECORD.investigationId,
        definitionMemorySnapshot: {},
        budgetExhausted: false,
        runs: [
          {
            runTaskId: 'task-root',
            agentName: 'controller',
            parent: null,
            depth: 0,
            assignment: null,
            prologueFirstMessage: null,
            status: 'succeeded',
            result: { inconclusive: true },
            failure: null,
            shareTokens: 100,
            spentTokens: 40,
            subtreeSpentTokens: 70,
            turns: [
              { turn: 0, llmCallId: 'call-1', transcriptCallId: 'call-1' },
            ],
            toolCalls: [
              {
                ...CALL_DEFAULTS,
                callIndex: 0,
                toolName: 'call_agent',
                arguments: { agent: 'verifier', assignment: 'claim-1' },
                state: 'rejected',
                reason: 'children_limit',
              },
            ],
          },
          {
            runTaskId: 'task-worker',
            agentName: 'worker',
            parent: { taskId: 'task-root', callIndex: 1 },
            depth: 1,
            assignment: 'look at the logs',
            prologueFirstMessage: null,
            status: 'failed',
            result: null,
            failure: { code: 'turn_limit' },
            shareTokens: 50,
            spentTokens: 30,
            subtreeSpentTokens: 30,
            turns: [],
            toolCalls: [
              {
                ...CALL_DEFAULTS,
                callIndex: 0,
                toolName: 'claims_write',
                arguments: {},
                state: 'rejected',
                reason: 'pointer_invalid',
              },
            ],
          },
        ],
      },
    },
    transcripts: [],
    retention: 'no_term',
    signals: {
      lowJudgeScore: null,
      discardedClaims: { fired: false, discarded: 0, total: 1, share: 0 },
      rejectedCalls: { fired: false, rejected: 2 },
      stopReason: { fired: false, stopReason: null },
    },
    showRunId: 'self-check:show:x:y',
  });
  const section = (title: string) =>
    report.split(`## ${title}\n`)[1]?.split('\n## ')[0] ?? '';

  it('lists each run with its parent, assignment, outcome and spending', () => {
    const tree = section('Дерево агентов');

    expect(tree).toContain('task-root');
    expect(tree).toContain('родитель task-root, вызов 1');
    expect(tree).toContain('look at the logs');
    expect(tree).toContain('{"code":"turn_limit"}');
    expect(tree).toContain('потрачено 30, с поддеревом 30');
    expect(tree).toContain('call-1');
  });

  it('lists the refused calls with agent, tool and reason, and the claims left unverified by a refusal', () => {
    expect(section('Отклонённые вызовы').trim().split('\n')).toEqual([
      '- controller · call_agent: children_limit',
      '- worker · claims_write: pointer_invalid',
    ]);
    expect(section('Утверждения без проверки из-за отказа').trim()).toBe(
      '- claim-1: claim text',
    );
    expect(report).not.toContain('## Отклонённые решения controller');
    expect(report).toContain('- отклонённые вызовы: не сработал; отклонено 2');
  });
});
