import type { FailureClass } from '@agent-os/contracts';
import { buildCodeAnswer } from '../answer/code-answer.js';
import type { Capability } from '../config/capabilities.js';
import { noSourceEnd, type ObservedSynthesis, seedPlan } from './stop-rules.js';

// KD-8 and AC-25.5 (UC-11, UC-E11 rule half, mode `model_knowledge`): code ends an investigation without sources when its
// synthesis ends without an answer — a stop on the budget, `notAfter` or an unavailable model gives an answer with no
// claims, `inconclusive` and that stop reason; a configuration without `synthesize` concludes `inconclusive` with no stop
// reason; a configuration without `plan` seeds the first plan revision with the goal and calls no role.
// Defects caught: a stop answer of this path left without its stop reason, a configuration without `synthesize` waiting
// for a synthesis that is never proposed, a configuration without `plan` calling the plan role.
// The INT rows L6 (a), (b) wire the budget and deadline stops; `model_unavailable` is proven only here.

const ANSWER_ID = '3f0e2c55-8a1b-4d2e-9c7f-6b5a4d3c2b10';
const ALL: readonly Capability[] = ['plan', 'gather', 'analyze', 'verify', 'synthesize'];

const failedWith = (failureClass: FailureClass): ObservedSynthesis => ({
  status: 'failed',
  outcome: null,
  failureReason: { class: failureClass, code: 'scripted', message: 'scripted failure', cause: null, attempt: 1, toolCalls: 0, retries: 0 },
});
const succeededWith = (answerOrDelta: unknown): ObservedSynthesis => ({
  status: 'succeeded',
  failureReason: null,
  outcome: { answerOrDelta, evidenceRefs: [], coverage: null, missingEvidence: [], warnings: [] } as ObservedSynthesis['outcome'],
});

describe('noSourceEnd: the answer code writes on the no-source path follows KD-8 and AC-25.5', () => {
  it.each<[string, readonly Capability[], ObservedSynthesis | undefined, { outcome: string; stopReason: string | null } | null]>([
    ['the investigation budget refused the synthesis', ALL, failedWith('budget_exhausted'), { outcome: 'inconclusive', stopReason: 'budget_exhausted' }],
    ['the synthesis reached notAfter', ALL, failedWith('deadline'), { outcome: 'inconclusive', stopReason: 'deadline' }],
    ['the model stayed unavailable after the retries', ALL, failedWith('transport_protocol'), { outcome: 'inconclusive', stopReason: 'model_unavailable' }],
    ['the synthesis packet did not fit its window', ALL, succeededWith({ needsNarrowing: {}, answerId: null }), { outcome: 'inconclusive', stopReason: 'context_overflow' }],
    ['the synthesis output stayed invalid after its retry', ALL, succeededWith({ answerId: null }), { outcome: 'inconclusive', stopReason: null }],
    ['a configuration without synthesize', ['plan', 'gather'], undefined, { outcome: 'inconclusive', stopReason: null }],
    ['a synthesis still to be proposed', ALL, undefined, null],
    ['a synthesis still running', ALL, { status: 'running', failureReason: null, outcome: null }, null],
  ])('%s', (_, capabilities, synthesis, expected) => {
    const end = noSourceEnd({ capabilities, synthesis });
    if (expected === null) {
      expect(end).toBeNull();
      return;
    }
    expect(end).not.toBeNull();
    const answer = buildCodeAnswer(ANSWER_ID, [], end!);
    expect(answer).toEqual({ answerId: ANSWER_ID, summary: null, summaryItems: [], established: [], assumed: [], unknown: [], removed: [], ...expected });
  });

  it('a synthesis that failed for a reason with no stop reason is a defect, not an answer', () => {
    expect(() => noSourceEnd({ capabilities: ALL, synthesis: failedWith('internal') })).toThrow(/internal/);
  });
});

describe('seedPlan: the first plan revision without the plan capability is the goal (KD-8)', () => {
  it.each<[string, readonly Capability[], unknown]>([
    ['without plan the goal is the first revision', ['synthesize'], { goal: 'the goal', readinessCriteria: [], branches: [] }],
    ['with plan the plan role writes it', ['plan', 'synthesize'], null],
  ])('%s', (_, capabilities, expected) => {
    expect(seedPlan({ goal: 'the goal', capabilities: [...capabilities] })).toEqual(expected);
  });
});
