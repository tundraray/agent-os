import { buildCodeAnswer, type CodeAnswerEnd, type LatestClaim } from './code-answer.js';

// FR-09 forced-stop rule (Flow 2 Outcome, AC-01.3, AC-03.2): an answer built by code is `partial` when at least one claim
// is supported and `inconclusive` otherwise; only supported claims are established, with their evidence. Defect caught: a
// forced stop answered `inconclusive` although a claim was verified, or an unverified claim delivered as established.
// INT-2 L2 wires one forced stop with a verified claim (`budget_exhausted`, `partial`); the rule's cases are this table.

const ANSWER_ID = '3f0e2c55-8a1b-4d2e-9c7f-6b5a4d3c2b10';
const EVIDENCE_ID = '0d8f6f53-5e3e-4bd4-9d3f-2b6f5d0f5a11';
const supported: LatestClaim = {
  claimId: '7b0c4a8e-9f62-4c1a-b2d4-8f1b6e2a9c33',
  text: 'payments restarted at 10:02',
  evidenceIds: [EVIDENCE_ID],
  status: 'supported',
};
const unverified: LatestClaim = {
  claimId: '9a1d2e3f-4b5c-4d6e-8f70-112233445566',
  text: 'the cache was cold',
  evidenceIds: [],
  status: 'unverified',
};

describe('buildCodeAnswer: the outcome of an answer built by code follows FR-09', () => {
  it.each<[string, readonly LatestClaim[], CodeAnswerEnd, 'partial' | 'inconclusive', string | null, number]>([
    ['a forced stop with a supported claim', [supported, unverified], { stopReason: 'step_limit' }, 'partial', 'step_limit', 1],
    ['a forced stop with no supported claim', [unverified], { stopReason: 'budget_exhausted' }, 'inconclusive', 'budget_exhausted', 0],
    ['concludeInconclusive with a supported claim', [supported], { concluded: true }, 'inconclusive', null, 1],
  ])('%s', (_, claims, end, outcome, stopReason, established) => {
    const answer = buildCodeAnswer(ANSWER_ID, claims, end);

    expect(answer).toMatchObject({ answerId: ANSWER_ID, outcome, stopReason, summary: null });
    expect(answer.established).toHaveLength(established);
    if (established === 1) {
      expect(answer.established[0]).toEqual({
        claimId: supported.claimId,
        text: 'payments restarted at 10:02',
        evidenceIds: [EVIDENCE_ID],
        verified: true,
      });
    }
  });
});
