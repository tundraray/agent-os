import type { Capability, DecisionKind } from '../config/capabilities.js';
import { admissibleDecisions, type GateState, judgeDecision, type RejectionReason } from './decision-gate.js';

// Invariant 6, AC-02.2, AC-03.1, DC-1, DC-3 (1 000 ms), DC-6, Decision (`rationale` up to 2 000, `wait` only with
// open tasks): which controller outputs become a decision. Defect caught: an output outside the admissible set of the
// step is accepted (kind outside the set, capability off, broken structure, fan-out above the limit, a limit of the
// step ignored), or `admissible` in the DecisionInput lists a kind the gate would refuse.

const ALL: readonly Capability[] = ['plan', 'gather', 'analyze', 'verify', 'synthesize'];
const EVIDENCE_ID = '0d8f6f53-5e3e-4bd4-9d3f-2b6f5d0f5a11';
const CLAIM_ID = '7b0c4a8e-9f62-4c1a-b2d4-8f1b6e2a9c33';

const open: GateState = {
  capabilities: ALL,
  limits: { maxPlanRevisions: 3, noveltyWindow: 3, maxFanOut: 2, maxVerifyRounds: 3 },
  replans: 0,
  verifyRounds: 0,
  stepsWithoutNovelty: 0,
  msUntilNotAfter: 60_000,
  openTasks: 1,
};

// The model writes `args` as JSON text (ControllerOutputSchema); the gate parses it.
const fetch = { sourceId: 'fixture', toolName: 'search_logs', args: '{"q":"x"}', completeness: 'all' };
const subquestion = (text: string) => ({ text, ...fetch });

const outputs = {
  requestEvidence: { kind: 'requestEvidence', rationale: 'r', ...fetch },
  requestAnalysis: { kind: 'requestAnalysis', rationale: 'r', subquestions: [subquestion('a'), subquestion('b')] },
  requestVerification: { kind: 'requestVerification', rationale: 'r', claimIds: [CLAIM_ID] },
  replan: { kind: 'replan', rationale: 'r', reason: 'contradiction' },
  wait: { kind: 'wait', rationale: 'r' },
  proposeAnswer: { kind: 'proposeAnswer', rationale: 'r', evidenceIds: [EVIDENCE_ID] },
  concludeInconclusive: { kind: 'concludeInconclusive', rationale: 'r' },
} satisfies Record<DecisionKind, unknown>;

describe('DecisionGate: only an admissible, well-formed decision of an enabled capability becomes a step', () => {
  it.each<[string, unknown, Partial<GateState>, RejectionReason | 'accepted', readonly DecisionKind[]]>([
    [
      'every kind of an open step is accepted (requestEvidence shown)',
      outputs.requestEvidence,
      {},
      'accepted',
      ['requestEvidence', 'requestAnalysis', 'requestVerification', 'replan', 'wait', 'proposeAnswer', 'concludeInconclusive'],
    ],
    ['a kind outside the closed set', { kind: 'deleteEverything', rationale: 'r' }, {}, 'kind_unknown', [
      'requestEvidence', 'requestAnalysis', 'requestVerification', 'replan', 'wait', 'proposeAnswer', 'concludeInconclusive',
    ]],
    ['an output without a kind', { rationale: 'r' }, {}, 'kind_unknown', [
      'requestEvidence', 'requestAnalysis', 'requestVerification', 'replan', 'wait', 'proposeAnswer', 'concludeInconclusive',
    ]],
    [
      'requestVerification without the verify capability (DC-1)',
      outputs.requestVerification,
      { capabilities: ['plan', 'gather', 'synthesize'] },
      'capability_disabled',
      ['requestEvidence', 'replan', 'wait', 'proposeAnswer', 'concludeInconclusive'],
    ],
    [
      'requestAnalysis with gather but without analyze (DC-1)',
      outputs.requestAnalysis,
      { capabilities: ['gather'] },
      'capability_disabled',
      ['requestEvidence', 'wait', 'concludeInconclusive'],
    ],
    ['requestEvidence without its arguments', { kind: 'requestEvidence', rationale: 'r' }, {}, 'invalid_structure', [
      'requestEvidence', 'requestAnalysis', 'requestVerification', 'replan', 'wait', 'proposeAnswer', 'concludeInconclusive',
    ]],
    // T7.3: the model writes `args` as JSON text. Defect caught: text that is not a JSON object crashes the step or
    // becomes a decision; an object where the model must write text is let through.
    ['requestEvidence whose args text is not JSON', { ...outputs.requestEvidence, args: '{q: x' }, {}, 'invalid_args', [
      'requestEvidence', 'requestAnalysis', 'requestVerification', 'replan', 'wait', 'proposeAnswer', 'concludeInconclusive',
    ]],
    [
      'a requestAnalysis sub-question whose args text is a JSON array',
      { ...outputs.requestAnalysis, subquestions: [subquestion('a'), { ...subquestion('b'), args: '["q"]' }] },
      {},
      'invalid_args',
      ['requestEvidence', 'requestAnalysis', 'requestVerification', 'replan', 'wait', 'proposeAnswer', 'concludeInconclusive'],
    ],
    ['requestEvidence with args as an object, not text', { ...outputs.requestEvidence, args: { q: 'x' } }, {}, 'invalid_args', [
      'requestEvidence', 'requestAnalysis', 'requestVerification', 'replan', 'wait', 'proposeAnswer', 'concludeInconclusive',
    ]],
    ['a rationale of 2 001 characters', { kind: 'concludeInconclusive', rationale: 'x'.repeat(2_001) }, {}, 'invalid_structure', [
      'requestEvidence', 'requestAnalysis', 'requestVerification', 'replan', 'wait', 'proposeAnswer', 'concludeInconclusive',
    ]],
    ['a rationale of exactly 2 000 characters', { kind: 'concludeInconclusive', rationale: 'x'.repeat(2_000) }, {}, 'accepted', [
      'requestEvidence', 'requestAnalysis', 'requestVerification', 'replan', 'wait', 'proposeAnswer', 'concludeInconclusive',
    ]],
    [
      'maxFanOut + 1 sub-questions (DC-6)',
      { ...outputs.requestAnalysis, subquestions: [subquestion('a'), subquestion('b'), subquestion('c')] },
      {},
      'fan_out_exceeded',
      ['requestEvidence', 'requestAnalysis', 'requestVerification', 'replan', 'wait', 'proposeAnswer', 'concludeInconclusive'],
    ],
    [
      'replan once maxPlanRevisions replans were made (AC-02.2)',
      outputs.replan,
      { replans: 3 },
      'plan_revisions_exhausted',
      ['requestVerification', 'proposeAnswer', 'concludeInconclusive'],
    ],
    [
      'requestVerification once maxPlanRevisions replans were made is still accepted (AC-02.2)',
      outputs.requestVerification,
      { replans: 3 },
      'accepted',
      ['requestVerification', 'proposeAnswer', 'concludeInconclusive'],
    ],
    [
      'requestEvidence after noveltyWindow steps without novelty (AC-03.1)',
      outputs.requestEvidence,
      { stepsWithoutNovelty: 3 },
      'no_novelty',
      ['proposeAnswer', 'concludeInconclusive'],
    ],
    [
      'requestEvidence one step before the novelty window closes',
      outputs.requestEvidence,
      { stepsWithoutNovelty: 2 },
      'accepted',
      ['requestEvidence', 'requestAnalysis', 'requestVerification', 'replan', 'wait', 'proposeAnswer', 'concludeInconclusive'],
    ],
    [
      'requestVerification once maxVerifyRounds rounds were made',
      outputs.requestVerification,
      { verifyRounds: 3 },
      'verify_rounds_exhausted',
      ['requestEvidence', 'requestAnalysis', 'replan', 'wait', 'proposeAnswer', 'concludeInconclusive'],
    ],
    [
      'a decision creating tasks with 1 000 ms left until notAfter (DC-3)',
      outputs.proposeAnswer,
      { msUntilNotAfter: 1_000 },
      'deadline_too_close',
      ['replan', 'wait', 'concludeInconclusive'],
    ],
    [
      'a decision creating tasks with 1 001 ms left until notAfter',
      outputs.proposeAnswer,
      { msUntilNotAfter: 1_001 },
      'accepted',
      ['requestEvidence', 'requestAnalysis', 'requestVerification', 'replan', 'wait', 'proposeAnswer', 'concludeInconclusive'],
    ],
    [
      'wait without an open task of the investigation',
      outputs.wait,
      { openTasks: 0 },
      'nothing_to_wait_for',
      ['requestEvidence', 'requestAnalysis', 'requestVerification', 'replan', 'proposeAnswer', 'concludeInconclusive'],
    ],
  ])('%s', (_, output, overrides, expected, admissible) => {
    const state: GateState = { ...open, ...overrides };

    const verdict = judgeDecision(output, state);

    if (expected === 'accepted') {
      expect(verdict).toMatchObject({ verdict: 'accepted', decision: { kind: (output as { kind: string }).kind } });
    } else {
      expect(verdict).toMatchObject({ verdict: 'rejected', reason: expected });
    }
    expect(admissibleDecisions(state)).toEqual(admissible);
  });

  // T7.3: the recorded decision keeps `args` as the object the source fetch takes. Defect caught: the JSON text reaches
  // the decision row or the fetch request.
  it('an accepted decision carries its args parsed into objects', () => {
    expect(judgeDecision(outputs.requestEvidence, open)).toMatchObject({ verdict: 'accepted', decision: { args: { q: 'x' } } });
    expect(judgeDecision(outputs.requestAnalysis, open)).toMatchObject({
      verdict: 'accepted',
      decision: { subquestions: [{ text: 'a', args: { q: 'x' } }, { text: 'b', args: { q: 'x' } }] },
    });
  });

  // Defect caught: a proposeAnswer the model sent with `await: false` lets the controller step on while its synthesis runs.
  it.each<[string, unknown, boolean]>([
    ['defaults await to true for a decision creating tasks', outputs.proposeAnswer, true],
    ['keeps await false for another decision creating tasks', { ...outputs.requestEvidence, await: false }, false],
    ['always waits for the synthesis of an accepted proposeAnswer', { ...outputs.proposeAnswer, await: false }, true],
  ])('%s', (_, output, awaits) => {
    expect(judgeDecision(output, open)).toMatchObject({ verdict: 'accepted', decision: { await: awaits } });
  });
});
