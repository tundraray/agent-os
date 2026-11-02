import type { Task } from '@agent-os/contracts';
import { stepsWithoutNovelty } from './decision-input.js';
import type { DecisionRow, LatestClaimRow } from './decisions.repository.js';

// AC-03.1 (Terms: novelty is new evidence or a new claim revision after the previous step): the count of trailing steps
// without novelty that closes the gather decisions at `noveltyWindow` (the gate's side is decision-gate.spec.ts).
// Defects caught: intervals counted from the oldest instead of back from the latest; a claim written at the next
// decision's instant left out of the interval before it, or one written at the decision's own instant taken as new;
// evidence returned by a proposed task not taken as novelty.

const INVESTIGATION_ID = '5c1f0a3e-7d2b-4e6a-9b8c-0f1e2d3c4b5a';
const at = (minute: number) => new Date(Date.UTC(2026, 10, 1, 10) + minute * 60_000);

function decision(minute: number, proposedTaskIds: string[] = []): DecisionRow {
  return {
    decisionId: `decision-${minute}`,
    investigationId: INVESTIGATION_ID,
    step: minute,
    callIndex: 0,
    status: 'accepted',
    rejectionReason: null,
    decidedBy: 'model',
    kind: 'requestEvidence',
    decision: null,
    planRevision: 1,
    proposedTaskIds,
    notAfter: null,
    createdAt: at(minute),
  };
}

function claim(minute: number): LatestClaimRow {
  return { claimId: `claim-${minute}`, text: 'a claim', evidenceIds: [], status: 'unverified', createdAt: at(minute) };
}

function task(taskId: string, evidence: number): Task {
  return {
    taskId,
    workflowType: 'source.fetch',
    workflowVersion: 1,
    status: 'succeeded',
    dedupKey: `v1:${taskId}`,
    outputRefs: Array.from({ length: evidence }, (_, index) => `${taskId}-evidence-${index}`),
    outcome: null,
    coverage: null,
    failureReason: null,
    attempt: 1,
    toolCallsUsed: 0,
    retriesUsed: 0,
    subscribers: [],
  };
}

describe('stepsWithoutNovelty: trailing steps after which neither evidence nor a claim revision appeared', () => {
  it.each<[string, DecisionRow[], LatestClaimRow[], Task[], number]>([
    ['no accepted decision yet', [], [], [], 0],
    ['one step whose task returned nothing', [decision(1, ['t-1'])], [], [task('t-1', 0)], 1],
    ['one step whose task returned evidence', [decision(1, ['t-1'])], [], [task('t-1', 2)], 0],
    ['a claim written at the instant of the decision is not after it', [decision(1)], [claim(1)], [], 1],
    ['a claim after the latest step', [decision(1), decision(2)], [claim(3)], [], 0],
    ['counted back from the latest: a claim after the first of three steps', [decision(1), decision(2), decision(3)], [claim(1.5)], [], 2],
    ['a claim written at the next decision belongs to the step before it', [decision(1), decision(2)], [claim(2)], [], 1],
    [
      'evidence of a task an earlier step proposed stops the count there',
      [decision(1, ['t-1']), decision(2, ['t-2']), decision(3)],
      [],
      [task('t-1', 1), task('t-2', 0)],
      2,
    ],
  ])('%s', (_, accepted, claims, tasks, expected) => {
    expect(stepsWithoutNovelty(accepted, claims, tasks)).toBe(expected);
  });
});
