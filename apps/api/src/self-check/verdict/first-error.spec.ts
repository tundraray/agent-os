import {
  countFirstErrorsByRole,
  type FirstErrorRun,
  findFirstError,
} from './first-error.js';

const KEY_TRACE = 'trace-key';
const KEY_PAGE = 'page-key';
const OTHER_PAGE = 'page-other';

const claim = (claimId: string, status: string, evidenceIds: string[]) => ({
  claimId,
  status,
  evidenceIds,
});

/** A run that collected the key page and an unrelated one; the claims and verdict vary by row. */
const run = (overrides: Partial<FirstErrorRun>): FirstErrorRun => ({
  keyTraceIds: [KEY_TRACE],
  pages: [
    { evidenceId: KEY_PAGE, traceIds: ['trace-noise', KEY_TRACE] },
    { evidenceId: OTHER_PAGE, traceIds: ['trace-noise'] },
  ],
  claims: [],
  establishedClaimIds: [],
  verdict: 'cause_not_established',
  ...overrides,
});

// DC-16, UC-16: the stage follows the data path of the run - pages, claim statuses, the answer and the verdict code.
describe('findFirstError', () => {
  it.each<[string, Partial<FirstErrorRun>, string, string]>([
    [
      'the key records were not collected',
      {
        pages: [{ evidenceId: OTHER_PAGE, traceIds: ['trace-noise'] }],
        claims: [claim('c1', 'supported', [OTHER_PAGE])],
      },
      'controller',
      'сбор — controller',
    ],
    [
      'no claim cites the key records',
      { claims: [claim('c1', 'supported', [OTHER_PAGE])] },
      'worker',
      'анализ — worker',
    ],
    [
      'the claim citing them stayed unverified',
      { claims: [claim('c1', 'unverified', [KEY_PAGE])] },
      'controller',
      'сбор — controller',
    ],
    [
      'only a causal claim cites them',
      { claims: [claim('c1', 'causal', [KEY_PAGE])] },
      'worker',
      'анализ — worker',
    ],
    [
      'the claim citing them was refuted',
      { claims: [claim('c1', 'refuted', [KEY_PAGE])] },
      'verifier',
      'проверка — verifier',
    ],
    [
      'the claim citing them was insufficient',
      { claims: [claim('c1', 'insufficient', [KEY_PAGE])] },
      'verifier',
      'проверка — verifier',
    ],
    [
      'the supported claim is not in «Установлено»',
      { claims: [claim('c1', 'supported', [KEY_PAGE])] },
      'synthesis',
      'ответ — synthesis',
    ],
    [
      'supported in «Установлено», wrong_cause',
      {
        claims: [claim('c1', 'supported', [KEY_PAGE])],
        establishedClaimIds: ['c1'],
        verdict: 'wrong_cause',
      },
      'verifier',
      'проверка — verifier',
    ],
    [
      'supported in «Установлено», cause_not_grounded',
      {
        claims: [claim('c1', 'supported', [KEY_PAGE])],
        establishedClaimIds: ['c1'],
        verdict: 'cause_not_grounded',
      },
      'worker',
      'анализ — worker',
    ],
    [
      'supported in «Установлено», cause_not_established',
      {
        claims: [claim('c1', 'supported', [KEY_PAGE])],
        establishedClaimIds: ['c1'],
        verdict: 'cause_not_established',
      },
      'worker',
      'анализ — worker',
    ],
    [
      'supported in «Установлено», cause_not_linked',
      {
        claims: [claim('c1', 'supported', [KEY_PAGE])],
        establishedClaimIds: ['c1'],
        verdict: 'cause_not_linked',
      },
      'synthesis',
      'ответ — synthesis',
    ],
    [
      'supported is taken before causal and refuted',
      {
        claims: [
          claim('c1', 'refuted', [KEY_PAGE]),
          claim('c2', 'causal', [KEY_PAGE]),
          claim('c3', 'supported', [KEY_PAGE]),
        ],
      },
      'synthesis',
      'ответ — synthesis',
    ],
    [
      'causal is taken before refuted and unverified',
      {
        claims: [
          claim('c1', 'unverified', [KEY_PAGE]),
          claim('c2', 'refuted', [KEY_PAGE]),
          claim('c3', 'causal', [KEY_PAGE]),
        ],
      },
      'worker',
      'анализ — worker',
    ],
    [
      'a supported claim not citing the key records is not taken',
      {
        claims: [
          claim('c1', 'supported', [OTHER_PAGE]),
          claim('c2', 'refuted', [KEY_PAGE]),
        ],
        establishedClaimIds: ['c1'],
      },
      'verifier',
      'проверка — verifier',
    ],
  ])('%s', (_case, overrides, role, stage) => {
    expect(findFirstError(run(overrides))).toEqual({ role, stage });
  });

  it('rejects a claim status the scheme does not know', () => {
    expect(() =>
      findFirstError(run({ claims: [claim('c1', 'pending', [KEY_PAGE])] })),
    ).toThrow(/pending/);
  });
});

// DC-16, UC-16: the run summary counts first-error stages per role, every role present.
describe('countFirstErrorsByRole', () => {
  it('counts one per role for the three runs of UC-16', () => {
    const roles = [
      run({ pages: [{ evidenceId: OTHER_PAGE, traceIds: ['trace-noise'] }] }),
      run({ claims: [claim('c1', 'refuted', [KEY_PAGE])] }),
      run({ claims: [claim('c1', 'causal', [KEY_PAGE])] }),
    ].map((failed) => findFirstError(failed).role);

    expect(countFirstErrorsByRole(roles)).toEqual({
      controller: 1,
      worker: 1,
      verifier: 1,
      synthesis: 0,
    });
  });
});
