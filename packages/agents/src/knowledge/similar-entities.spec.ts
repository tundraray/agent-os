import { createSecretMasker } from '@agent-os/common';

import { type CheckedOperations, checkOperations, type KnowledgeGraph, type RoundCall } from './check-operations.js';
import type { ChooseEntitiesArgs } from './operations.js';
import type { GraphItem } from './select-knowledge.js';
import {
  applyChoices,
  type EntityChoice,
  proposedEntities,
  similarCandidates,
} from './similar-entities.js';
import type { KnowledgeCloseness } from './vector-store.js';

// UC-10, AC-20.1, DC-17 (design-core.md, KD-4): code offers only close graph entities as candidates and
// merges a new entity only into a candidate the model chose for it; no candidates — no `choose_entities` call.
const RUN = '00000000-0000-4000-8000-000000000001';
const OTHER_RUN = '00000000-0000-4000-8000-000000000002';
const ROUND_AT = new Date('2026-11-20T10:00:00.000Z');

const NAMES = ['billing-api', 'ledger-db', 'invoice-service', 'payments-gateway', 'audit-log'];
const ITEMS: GraphItem[] = [
  ...NAMES.map(
    (name, index): GraphItem => ({
      type: 'entity',
      kind: 'fact',
      id: index + 1,
      name,
      description: `The ${name}`,
      confirmations: 1,
      date: '2026-11-19T10:00:00.000Z',
      outdated: false,
    }),
  ),
  {
    type: 'relation',
    kind: 'searched_nothing',
    id: 1,
    server: 'logs',
    tool: 'search',
    question: 'billing errors',
    confirmations: 1,
    date: '2026-11-19T10:00:00.000Z',
    outdated: false,
  },
];
const GRAPH: KnowledgeGraph = {
  entities: NAMES.map((name, index) => ({ id: index + 1, name, confirmations: 1, confirmedByRunId: OTHER_RUN })),
  relations: [],
};
const CALLS = new Map<string, RoundCall>([['c1', { server: 'crm', tool: 'find', outcome: 'success' }]]);

/** The answer: a new entity close to `billing-api`, and a fact through its ref. */
const OPERATIONS = [
  { op: 'add_entity', ref: 'billing', name: 'billing service', description: 'Bills the customers', evidence: ['c1'] },
  { op: 'add_relation', kind: 'fact', from: 'billing', to: 'e2', label: 'writes to', evidence: ['c1'] },
];

const pairs = (...closeness: [string, number][]): Map<string, KnowledgeCloseness[]> =>
  new Map([['billing', closeness.map(([key, value]) => ({ key, closeness: value }))]]);
const ALL_PAIRS = pairs(['r1', 0.99], ['e9', 0.95], ['e1', 0.93], ['e2', 0.9], ['e3', 0.85], ['e4', 0.82], ['e5', 0.79]);

const KEPT_NEW: Pick<CheckedOperations, 'apply' | 'confirm'> = {
  apply: [
    { type: 'entity', ref: 'billing', name: 'billing service', description: 'Bills the customers' },
    { type: 'relation', kind: 'fact', from: { ref: 'billing' }, to: { id: 2 }, label: 'writes to' },
  ],
  confirm: [],
};

interface Outcome {
  /** Candidate ids per ref; empty — no `choose_entities` call. */
  readonly candidates: Record<string, string[]>;
  readonly rejected: EntityChoice[];
  readonly checked: Pick<CheckedOperations, 'apply' | 'confirm'>;
}

describe('similar entities: candidates by closeness, a merge only by the model choice', () => {
  it.each<[string, Map<string, KnowledgeCloseness[]>, ChooseEntitiesArgs['choices'], Outcome]>([
    [
      'below the threshold, over the limit, a relation and a key without a record are not candidates; "keep" leaves both entities',
      ALL_PAIRS,
      [{ ref: 'billing', id: null }],
      { candidates: { billing: ['e1', 'e2', 'e3'] }, rejected: [], checked: KEPT_NEW },
    ],
    [
      'no candidate reaches the threshold: no choose_entities call, operations as they are',
      pairs(['e1', 0.79]),
      [],
      { candidates: {}, rejected: [], checked: KEPT_NEW },
    ],
    [
      'choosing billing-api: its ref is replaced, add_entity becomes its second confirmation, one entity',
      ALL_PAIRS,
      [{ ref: 'billing', id: 'e1' }],
      {
        candidates: { billing: ['e1', 'e2', 'e3'] },
        rejected: [],
        checked: {
          apply: [{ type: 'relation', kind: 'fact', from: { id: 1 }, to: { id: 2 }, label: 'writes to' }],
          confirm: [{ type: 'entity', id: 1, confirmations: 2, confirmedAt: ROUND_AT, confirmedByRunId: RUN }],
        },
      },
    ],
    [
      'an id not offered for that entity (over the limit, or for another ref) is rejected and the entity stays new',
      ALL_PAIRS,
      [
        { ref: 'billing', id: 'e4' },
        { ref: 'ledger', id: 'e1' },
      ],
      {
        candidates: { billing: ['e1', 'e2', 'e3'] },
        rejected: [
          { ref: 'billing', id: 'e4' },
          { ref: 'ledger', id: 'e1' },
        ],
        checked: KEPT_NEW,
      },
    ],
  ])('%s', (_, pairsByRef, choices, expected) => {
    const similar = similarCandidates(proposedEntities(OPERATIONS), pairsByRef, ITEMS);
    const applied =
      similar.length > 0 ? applyChoices(OPERATIONS, similar, choices) : { operations: OPERATIONS, rejected: [] };
    const { apply, confirm } = checkOperations({
      graph: GRAPH,
      calls: CALLS,
      operations: applied.operations,
      mask: createSecretMasker([]),
      roundAt: ROUND_AT,
      runId: RUN,
    });

    expect({
      candidates: Object.fromEntries(similar.map((entity) => [entity.ref, entity.candidates.map(({ id }) => id)])),
      rejected: applied.rejected,
      checked: { apply, confirm },
    }).toEqual(expected);
  });
});
