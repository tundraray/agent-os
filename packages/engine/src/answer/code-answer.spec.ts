import { buildCodeAnswer, type CodeAnswerEnd, type LatestClaim } from './code-answer.js';

// FR-09 forced-stop rule (Flow 2 Outcome, AC-01.3, AC-03.2): an answer built by code is `partial` when at least one claim
// is supported and `inconclusive` otherwise; only supported claims are established, with their stored basis and group.
// AC-16.4, invariant 2: a causal claim is never established, and no model chose summary items, so there are none.
// Defects caught: a forced stop answered `inconclusive` although a claim was verified, an unverified or causal claim
// delivered as established, a group recomputed or dropped instead of the stored one, a summary on a code answer.
// INT-2 L2 wires one forced stop with a verified claim (`budget_exhausted`, `partial`); the rule's cases are this table.

const ANSWER_ID = '3f0e2c55-8a1b-4d2e-9c7f-6b5a4d3c2b10';
const EVIDENCE_ID = '0d8f6f53-5e3e-4bd4-9d3f-2b6f5d0f5a11';
const supported: LatestClaim = {
  claimId: '7b0c4a8e-9f62-4c1a-b2d4-8f1b6e2a9c33',
  text: 'payments restarted at 10:02',
  evidenceIds: [EVIDENCE_ID],
  status: 'supported',
  confidence: 'medium',
};
const causal: LatestClaim = {
  claimId: '5c6d7e8f-9a0b-4c1d-8e2f-334455667788',
  text: 'the restart caused the refunds to fail',
  evidenceIds: [EVIDENCE_ID],
  status: 'causal',
  confidence: null,
};
const unverified: LatestClaim = {
  claimId: '9a1d2e3f-4b5c-4d6e-8f70-112233445566',
  text: 'the cache was cold',
  evidenceIds: [],
  status: 'unverified',
  confidence: null,
};

describe('buildCodeAnswer: the outcome of an answer built by code follows FR-09', () => {
  it.each<[string, readonly LatestClaim[], CodeAnswerEnd, 'partial' | 'inconclusive', string | null, number]>([
    ['a forced stop with a supported claim', [supported, causal, unverified], { stopReason: 'step_limit' }, 'partial', 'step_limit', 1],
    ['a forced stop with no supported claim', [causal, unverified], { stopReason: 'budget_exhausted' }, 'inconclusive', 'budget_exhausted', 0],
    ['concludeInconclusive with a supported claim', [supported], { concluded: true }, 'inconclusive', null, 1],
  ])('%s', (_, claims, end, outcome, stopReason, established) => {
    const answer = buildCodeAnswer(ANSWER_ID, claims, end);

    expect(answer).toMatchObject({ answerId: ANSWER_ID, outcome, stopReason, summary: null, summaryItems: [] });
    expect(answer.established).toHaveLength(established);
    if (established === 1) {
      expect(answer.established[0]).toEqual({
        claimId: supported.claimId,
        text: 'payments restarted at 10:02',
        evidenceIds: [EVIDENCE_ID],
        verified: true,
        confidence: 'medium',
      });
    }
  });
});
