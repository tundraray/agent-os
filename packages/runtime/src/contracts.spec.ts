import {
  CoverageSchema,
  EvidenceInputSchema,
  FailureReasonSchema,
  HandlerResultSchema,
} from '@agent-os/contracts';

const TASK_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';

const coverage = {
  completeness: 'complete',
  totalMatched: 3,
  totalRelation: 'eq',
  returned: 3,
  truncated: false,
  continuation: null,
};

const evidence = {
  evidenceKey: 'page-1',
  provenance: {
    sourceId: 'fixture',
    toolName: 'search',
    normalizedArgs: { q: 'x' },
    snapshot: '2026-10-31T00:00:00Z',
  },
  coverage,
  content: { mediaType: 'application/json', bytes: new Uint8Array([1, 2]) },
};

// AC-03.4: evidence with status `supported` and no scope, basis or version is rejected by the contract.
describe('EvidenceInputSchema — supported requires scope, basis, evidenceVersion', () => {
  const supported = {
    knowledgeStatus: 'supported',
    scope: 'repo:agent-os',
    basis: 'ticket list page 1',
    evidenceVersion: 1,
  };

  it.each([
    ['supported with scope, basis and version', supported, true],
    ['supported without scope', { ...supported, scope: undefined }, false],
    ['supported without basis', { ...supported, basis: undefined }, false],
    [
      'supported without evidenceVersion',
      { ...supported, evidenceVersion: undefined },
      false,
    ],
    [
      'observed without scope, basis and version',
      { knowledgeStatus: 'observed' },
      true,
    ],
    ['knowledgeStatus omitted (putEvidence writes observed)', {}, true],
  ])('%s → valid: %s', (_name, status, valid) => {
    expect(
      EvidenceInputSchema.safeParse({ ...evidence, ...status }).success,
    ).toBe(valid);
  });
});

// Risk: an inconsistent coverage is stored and mcp-source reports a wrong completeness.
describe('CoverageSchema — cross-field rules', () => {
  it.each([
    ['exact total with returned = total', {}, true],
    [
      'unknown total without relation',
      { totalMatched: null, totalRelation: null },
      true,
    ],
    ['total without relation', { totalRelation: null }, false],
    ['relation without total', { totalMatched: null }, false],
    ['returned above an exact total', { returned: 4 }, false],
    [
      'returned above a lower bound',
      { totalRelation: 'gte', returned: 4 },
      true,
    ],
    ['truncated and complete', { truncated: true }, false],
    [
      'truncated and partial',
      { truncated: true, completeness: 'partial' },
      true,
    ],
  ])('%s → valid: %s', (_name, patch, valid) => {
    expect(CoverageSchema.safeParse({ ...coverage, ...patch }).success).toBe(
      valid,
    );
  });
});

const failure = {
  class: 'tool_error',
  code: 'tool_error',
  message: 'source returned an error',
  cause: null,
  attempt: 1,
  toolCalls: 1,
  retries: 0,
};

// Risk: `wait` without `waitFor` or `failed` without `failure` is accepted and the runtime fails when it writes the outcome.
describe('HandlerResultSchema — cross-field rules', () => {
  const result = {
    kind: 'completed',
    answerOrDelta: null,
    evidenceRefs: [],
    coverage: null,
    missingEvidence: [],
    warnings: [],
    proposedTasks: [],
  };

  it.each([
    ['completed', {}, true],
    ['failed with failure', { kind: 'failed', failure }, true],
    ['failed without failure', { kind: 'failed' }, false],
    ['wait with waitFor', { kind: 'wait', waitFor: [TASK_ID] }, true],
    ['wait without waitFor', { kind: 'wait' }, false],
    ['wait with empty waitFor', { kind: 'wait', waitFor: [] }, false],
    // Catches: `yield` rejected as invalid_handler_result by the dispatcher (KD-6).
    ['yield without failure and waitFor', { kind: 'yield' }, true],
  ])('%s → valid: %s', (_name, patch, valid) => {
    expect(HandlerResultSchema.safeParse({ ...result, ...patch }).success).toBe(
      valid,
    );
  });
});

// Risk: a cascade failure is stored without its direct and root cause tasks.
describe('FailureReasonSchema — dependency_failed names its causes', () => {
  const cascade = {
    ...failure,
    class: 'dependency_failed',
    code: 'dependency_failed',
    dependencyTaskId: TASK_ID,
    rootCauseTaskId: TASK_ID,
  };

  it.each([
    ['with both causes', cascade, true],
    [
      'without dependencyTaskId',
      { ...cascade, dependencyTaskId: undefined },
      false,
    ],
    [
      'without rootCauseTaskId',
      { ...cascade, rootCauseTaskId: undefined },
      false,
    ],
  ])('%s → valid: %s', (_name, value, valid) => {
    expect(FailureReasonSchema.safeParse(value).success).toBe(valid);
  });
});
