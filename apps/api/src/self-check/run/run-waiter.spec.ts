import type {
  InvestigationView,
  InvestigationViewStatus,
  RunRecord,
} from '@agent-os/engine';
import type { StoredEvidence } from '@agent-os/runtime';
import { describe, expect, it } from 'vitest';
import {
  type RunWaiterPorts,
  waitForScenarioRuns,
  type WaitedRun,
} from './run-waiter.js';

// DC-9, UC-E5, UC-E5a, design-self-check.md C3 self-check: the waiter polls InvestigationView.status every 5 seconds,
// reads a finished run and then cancels it, cancels a run still running past the controller deadline plus 10 minutes,
// and returns only when the scenario has no task left in the queue.

const START = new Date('2026-11-07T10:00:00.000Z');
const CONTROLLER_DEADLINE_MS = 60_000;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;

const ANSWER = {
  answerId: 'answer-1',
  outcome: 'answered',
  stopReason: null,
} as unknown as RunRecord['answer'];

const usage = (totalTokens: number): InvestigationView['usage'] => ({
  byRoleAndModel: [],
  totalTokens,
  totalCostUsd: 0,
  tokenBudget: 100_000,
});

const record = (
  investigationId: string,
  answer: RunRecord['answer'],
  evidenceIds: readonly string[],
): RunRecord =>
  ({
    investigationId,
    answer,
    evidence: evidenceIds.map((evidenceId) => ({ evidenceId })),
  }) as unknown as RunRecord;

interface Script {
  /** Statuses by poll; the last one repeats. */
  readonly statuses: readonly InvestigationViewStatus[];
  readonly answer: RunRecord['answer'];
  readonly evidenceIds?: readonly string[];
}

/**
 * A program clock whose timers fire at once and move its time by their delay, and doubles of the engine view, the run
 * record, the evidence pages, the cancel and the task queue that log what the waiter does in order.
 */
function harness(
  scripts: Readonly<Record<string, Script>>,
  queue: readonly number[] = [0],
) {
  let now = START.getTime();
  const delays: number[] = [];
  const events: string[] = [];
  const polls = new Map<string, number>();
  let queueReads = 0;
  let viewReads = 0;
  const ports: RunWaiterPorts = {
    clock: {
      now: () => new Date(now),
      setTimer: (ms, callback) => {
        delays.push(ms);
        now += ms;
        queueMicrotask(callback);
        return () => undefined;
      },
    },
    async readView(investigationId) {
      viewReads += 1;
      const script = scripts[investigationId]!;
      const poll = polls.get(investigationId) ?? 0;
      polls.set(investigationId, poll + 1);
      const status =
        script.statuses[Math.min(poll, script.statuses.length - 1)]!;
      events.push(
        `status:${investigationId}:${status}@${(now - START.getTime()) / SECOND}s`,
      );
      return {
        investigationId,
        status,
        usage: usage(viewReads * 10),
      } as unknown as InvestigationView;
    },
    async readRecord(investigationId) {
      events.push(`record:${investigationId}`);
      const script = scripts[investigationId]!;
      return record(investigationId, script.answer, script.evidenceIds ?? []);
    },
    async readPage(evidenceId) {
      events.push(`page:${evidenceId}`);
      return {
        record: { evidenceId },
        bytes: new Uint8Array(),
      } as unknown as StoredEvidence;
    },
    async cancel(investigationId) {
      events.push(`cancel:${investigationId}`);
    },
    async unfinishedTasks(investigationIds) {
      const left = queue[Math.min(queueReads, queue.length - 1)]!;
      queueReads += 1;
      events.push(`queue:${investigationIds.join(',')}=${left}`);
      return left;
    },
  };
  return { ports, delays, events };
}

const outcomeOf = (run: WaitedRun) =>
  run.outcome === 'finished'
    ? `finished:${run.reason ?? 'answered'}`
    : run.outcome;

describe('waitForScenarioRuns', () => {
  it.each([
    {
      name: 'UC-E5: failed without an answer -> read, then cancelled, no_answer',
      script: { statuses: ['running', 'failed'], answer: null },
      outcome: 'finished:no_answer',
      events: [
        'status:a:running@0s',
        'status:a:failed@5s',
        'record:a',
        'cancel:a',
        'queue:a=0',
        'status:a:failed@5s',
      ],
    },
    {
      name: 'completed with an answer -> its pages read, then cancelled',
      script: {
        statuses: ['completed'],
        answer: ANSWER,
        evidenceIds: ['e1', 'e2'],
      },
      outcome: 'finished:answered',
      events: [
        'status:a:completed@0s',
        'record:a',
        'page:e1',
        'page:e2',
        'cancel:a',
        'queue:a=0',
        'status:a:completed@0s',
      ],
    },
    {
      name: 'cancelled without an answer -> no_answer',
      script: { statuses: ['cancelled'], answer: null },
      outcome: 'finished:no_answer',
      events: [
        'status:a:cancelled@0s',
        'record:a',
        'cancel:a',
        'queue:a=0',
        'status:a:cancelled@0s',
      ],
    },
  ] satisfies readonly {
    name: string;
    script: Script;
    outcome: string;
    events: readonly string[];
  }[])('$name', async ({ script, outcome, events: expected }) => {
    const { ports, events } = harness({ a: script });

    const [run] = await waitForScenarioRuns(ports, {
      runs: [{ investigationId: 'a', startedAt: START }],
      controllerDeadlineMs: CONTROLLER_DEADLINE_MS,
    });

    expect(outcomeOf(run!)).toBe(outcome);
    expect(events).toEqual(expected);
  });

  it('UC-E5a: a run still running past the controller deadline plus 10 minutes is cancelled with timeout', async () => {
    const { ports, events } = harness({
      a: { statuses: ['running'], answer: null },
    });

    const [run] = await waitForScenarioRuns(ports, {
      runs: [{ investigationId: 'a', startedAt: START }],
      controllerDeadlineMs: CONTROLLER_DEADLINE_MS,
    });

    expect(run!.outcome).toBe('timeout');
    // Deadline 1 minute + 10 minutes = 660 s: at 660 s the run is exactly at the limit and keeps waiting; the next
    // poll cancels it.
    expect(events).toContain('status:a:running@660s');
    expect(events.slice(events.indexOf('status:a:running@665s'))).toEqual([
      'status:a:running@665s',
      'cancel:a',
      'record:a',
      'queue:a=0',
      'status:a:running@665s',
    ]);
    expect(events.filter((event) => event.startsWith('cancel:'))).toEqual([
      'cancel:a',
    ]);
  });

  it('counts the deadline from each run start, not from the first poll', async () => {
    const { ports, events } = harness({
      a: { statuses: ['running'], answer: null },
    });

    await waitForScenarioRuns(ports, {
      runs: [
        {
          investigationId: 'a',
          startedAt: new Date(START.getTime() - 11 * MINUTE - SECOND),
        },
      ],
      controllerDeadlineMs: CONTROLLER_DEADLINE_MS,
    });

    expect(events.slice(0, 2)).toEqual(['status:a:running@0s', 'cancel:a']);
  });

  it('polls every 5 seconds, stops polling a run on its final status, and returns the runs in their order', async () => {
    const { ports, delays, events } = harness({
      a: {
        statuses: ['running', 'running', 'running', 'completed'],
        answer: ANSWER,
      },
      b: { statuses: ['running', 'failed'], answer: null },
    });

    const runs = await waitForScenarioRuns(ports, {
      runs: [
        { investigationId: 'a', startedAt: START },
        { investigationId: 'b', startedAt: START },
      ],
      controllerDeadlineMs: CONTROLLER_DEADLINE_MS,
    });

    expect(
      runs.map((run) => `${run.investigationId}:${outcomeOf(run)}`),
    ).toEqual(['a:finished:answered', 'b:finished:no_answer']);
    expect(delays).toEqual([5_000, 5_000, 5_000]);
    expect(events.filter((event) => event.startsWith('status:'))).toEqual([
      'status:a:running@0s',
      'status:b:running@0s',
      'status:a:running@5s',
      'status:b:failed@5s',
      'status:a:running@10s',
      'status:a:completed@15s',
      // After the queue emptied: one read of each run for its final spend.
      'status:a:completed@15s',
      'status:b:failed@15s',
    ]);
  });

  it('returns only when the scenario has no task left in the queue, with the spend read after that', async () => {
    const { ports, delays, events } = harness(
      {
        a: { statuses: ['completed'], answer: ANSWER },
        b: { statuses: ['completed'], answer: ANSWER },
      },
      [2, 1, 0],
    );

    const runs = await waitForScenarioRuns(ports, {
      runs: [
        { investigationId: 'a', startedAt: START },
        { investigationId: 'b', startedAt: START },
      ],
      controllerDeadlineMs: CONTROLLER_DEADLINE_MS,
    });

    expect(events.filter((event) => event.startsWith('queue:'))).toEqual([
      'queue:a,b=2',
      'queue:a,b=1',
      'queue:a,b=0',
    ]);
    expect(delays).toEqual([5_000, 5_000]);
    expect(events.slice(-2)).toEqual([
      'status:a:completed@10s',
      'status:b:completed@10s',
    ]);
    // The view double reports 10 tokens per view read so far: reads 3 and 4 are the ones after the queue emptied.
    expect(runs.map((run) => run.usage.totalTokens)).toEqual([30, 40]);
  });
});
