import type { Task } from '@agent-os/contracts';
import { controllerMessages } from '../context/role-packets.js';
import { controllerMaterial, type DecisionInputParts, rejectedAttemptsOf, stepsWithoutNovelty } from './decision-input.js';
import type { DecisionRow, LatestClaimRow, PlanRevisionRow } from './decisions.repository.js';

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

// KD-6, Invariant 7, DC-15: the stable block of the controller input — the tools, then the plan revision — is the same
// bytes on every step until the plan is revised, whatever changes after it. Defect caught: a changing value (budget,
// signals, observations, rejected attempts) placed in the stable block, so the cached start differs on every step.
describe('controllerMaterial: the stable block of the controller input', () => {
  const TOOLS = [{ sourceId: 'fixture', toolName: 'search_logs', argsSchema: { type: 'object', properties: { service: { type: 'string' } } } }];
  const planRevision = (revision: number): PlanRevisionRow => ({
    investigationId: INVESTIGATION_ID,
    revision,
    plan: { readinessCriteria: ['the cause is found'], branches: [] },
    reason: null,
    createdAt: at(0),
  });
  const parts = (overrides: Partial<DecisionInputParts>): DecisionInputParts => ({
    plan: planRevision(1),
    budget: { tokensLeft: 9_000, stepsLeft: 5 },
    admissible: ['requestEvidence', 'wait'],
    tools: TOOLS,
    signals: [],
    stepsWithoutNovelty: 0,
    tasks: [],
    claims: [],
    previous: undefined,
    rejectedAttempts: [],
    ...overrides,
  });
  const stableBlockOf = (input: DecisionInputParts): string => {
    const [stable] = controllerMessages(controllerMaterial(input), []);
    expect(stable!.cacheMark).toBe(true);
    return stable!.content;
  };
  const first = stableBlockOf(parts({}));

  it.each<[string, Partial<DecisionInputParts>, boolean]>([
    [
      'a later step: budget, admissible, signals, observations and rejected attempts changed',
      {
        budget: { tokensLeft: 4_000, stepsLeft: 2 },
        admissible: ['proposeAnswer'],
        signals: [{ signalId: 's-1', kind: 'test.note', recordedAt: at(3), payload: { note: 'rolled back' } }],
        tasks: [task('t-1', 1)],
        claims: [{ ...claim(2), confidence: null }],
        previous: decision(1, ['t-1']),
        stepsWithoutNovelty: 1,
        rejectedAttempts: [{ kind: 'wait', reason: 'nothing_to_wait_for' }],
      },
      true,
    ],
    ['the plan revised', { plan: { ...planRevision(2), plan: { readinessCriteria: ['the cause is found'], branches: [] } } }, false],
  ])('%s', (_, overrides, same) => {
    expect(stableBlockOf(parts(overrides)) === first).toBe(same);
  });

  it('carries the tools, then the plan revision, and nothing of the changing block', () => {
    expect(first).toBe(
      `<tools>\n${JSON.stringify(TOOLS)}\n</tools>\n` +
        '<plan_revision>\n{"revision":1,"readinessCriteria":["the cause is found"],"branches":[]}\n</plan_revision>',
    );
  });
});

// AC-08.1, DC-3: a retry of a step is told each rejected attempt of that step — the kind the model named or null and the
// code's reason — read from the stored rows, so one recorded before a restart is there too; the first attempt is told
// none. Defects caught: attempts of another step or accepted rows in the list, a lost null kind, the order of the calls
// lost, the rejected output itself in the input.
describe('rejectedAttemptsOf: the rejected attempts a retry of the step is told', () => {
  const row = (step: number, callIndex: number, verdict: Pick<DecisionRow, 'status' | 'rejectionReason' | 'kind' | 'decision'>): DecisionRow => ({
    ...decision(step),
    decisionId: `decision-${step}-${callIndex}`,
    callIndex,
    ...verdict,
  });
  const ROWS = [
    row(2, 1, { status: 'rejected', rejectionReason: 'kind_unknown', kind: null, decision: { kind: 'guess', rationale: 'REJECTED-OUTPUT-2' } }),
    row(1, 0, { status: 'rejected', rejectionReason: 'no_novelty', kind: 'requestEvidence', decision: null }),
    row(1, 1, { status: 'accepted', rejectionReason: null, kind: 'wait', decision: { kind: 'wait', rationale: 'r' } }),
    row(2, 0, {
      status: 'rejected',
      rejectionReason: 'nothing_to_wait_for',
      kind: 'wait',
      decision: { kind: 'wait', rationale: 'REJECTED-OUTPUT-1' },
    }),
  ];

  it.each<[string, number, { kind: string | null; reason: string }[]]>([
    ['the first attempt of a step', 3, []],
    ['a step whose first attempt was rejected and the second accepted', 1, [{ kind: 'requestEvidence', reason: 'no_novelty' }]],
    [
      'a step with two rejected attempts, in call order, the second without a kind',
      2,
      [
        { kind: 'wait', reason: 'nothing_to_wait_for' },
        { kind: null, reason: 'kind_unknown' },
      ],
    ],
  ])('%s', (_, step, expected) => {
    expect(rejectedAttemptsOf(ROWS, step)).toEqual(expected);
  });

  it('reach the changing block of the input as kind and code only', () => {
    const material = controllerMaterial({
      plan: { investigationId: INVESTIGATION_ID, revision: 1, plan: {}, reason: null, createdAt: at(0) },
      budget: {},
      admissible: [],
      tools: [],
      signals: [],
      stepsWithoutNovelty: 0,
      tasks: [],
      claims: [],
      previous: undefined,
      rejectedAttempts: rejectedAttemptsOf(ROWS, 2),
    });
    const [stable, changing] = controllerMessages(material, []);

    expect(changing!.cacheMark).toBeUndefined();
    expect(changing!.content).toContain(
      '"rejectedAttempts":[{"kind":"wait","reason":"nothing_to_wait_for"},{"kind":null,"reason":"kind_unknown"}]',
    );
    expect(`${stable!.content}${changing!.content}`).not.toMatch(/REJECTED-OUTPUT/);
  });
});
