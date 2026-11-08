import {
  deepResearchProcessV2,
  loadProcessConfig,
  type RunRecord,
} from '@agent-os/engine';
import { describe, expect, it } from 'vitest';
import { SIGNAL_LABELS } from '../result/report.js';
import type { FailureSignals } from '../signals.js';
import { renderCourseReport } from './course-report.js';

// AC-07.1, DC-15 (the report half): the course report marks each of the four failure signals as fired or not; the
// signal rules themselves are signals.spec.ts. Defect caught: a report that prints the signals without their state, or
// marks a signal that did not fire.

const loaded = loadProcessConfig(deepResearchProcessV2);
if (!loaded.ok) throw new Error('the shipped configuration is refused');

const RECORD: RunRecord = {
  investigationId: '00000000-0000-4000-8000-000000000001',
  ownerId: 'e2e-owner',
  query: 'Почему 15 сентября выросли ошибки оплаты?',
  status: 'completed',
  config: { processConfig: loaded.config, fingerprint: '0123456789ab' },
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
  decisions: [],
  evidence: [],
  usage: {
    byRoleAndModel: [],
    totalTokens: 0,
    totalCostUsd: 0,
    tokenBudget: 300_000,
  },
  calls: [],
};

const FIRED = 'сработал';
const NOT_FIRED = 'не сработал';

type SignalName = keyof FailureSignals;
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
        controllerRejections: { fired: true, rejected: 3 },
        stopReason: { fired: true, stopReason: 'step_limit' },
      },
      marks: {
        lowJudgeScore: NOT_FIRED,
        discardedClaims: NOT_FIRED,
        controllerRejections: FIRED,
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
        controllerRejections: { fired: false, rejected: 0 },
        stopReason: { fired: false, stopReason: null },
      },
      marks: {
        lowJudgeScore: FIRED,
        discardedClaims: FIRED,
        controllerRejections: NOT_FIRED,
        stopReason: NOT_FIRED,
      },
    },
    {
      name: 'no answer: the judge signal is not set, the other three are marked',
      signals: {
        lowJudgeScore: null,
        discardedClaims: { fired: false, discarded: 0, total: 0, share: null },
        controllerRejections: { fired: true, rejected: 4 },
        stopReason: { fired: false, stopReason: null },
      },
      marks: {
        lowJudgeScore: 'не ставится: ответа нет, судья не вызывался',
        discardedClaims: NOT_FIRED,
        controllerRejections: FIRED,
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
