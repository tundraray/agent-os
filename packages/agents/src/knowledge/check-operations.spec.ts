import { createSecretMasker, rememberSecret } from '@agent-os/common';

import {
  type CheckedOperations,
  checkOperations,
  type KnowledgeAddition,
  type KnowledgeGraph,
  type OperationRejectionReason,
  type RoundCall,
} from './check-operations.js';

// UC-6 (design-core.md, «Как применяются операции»): AC-04.1, AC-04.2, AC-05.1, AC-16.1, AC-16.2, DC-6,
// DC-11, `too_many`. Each operation is applied, becomes a confirmation of an existing record or is
// rejected with a reason; a bad one never voids the rest.
const RUN = '00000000-0000-4000-8000-000000000001';
const OTHER_RUN = '00000000-0000-4000-8000-000000000002';
const ROUND_AT = new Date('2026-11-20T10:00:00.000Z');
const SECRET = 'sk-live-0123456789abcdef';
rememberSecret(SECRET);

const relationFields = { fromEntityId: null, toEntityId: null, label: null, hint: null, outcome: null };
const GRAPH: KnowledgeGraph = {
  entities: [
    { id: 1, name: 'billing-api', confirmations: 1, confirmedByRunId: OTHER_RUN },
    { id: 2, name: 'ledger-db', confirmations: 3, confirmedByRunId: RUN },
  ],
  relations: [
    {
      ...relationFields,
      id: 1,
      kind: 'lesson',
      server: 'logs',
      tool: 'search',
      question: 'error lookup',
      hint: 'filter by service',
      outcome: 'found the traces',
      confirmations: 1,
      confirmedByRunId: OTHER_RUN,
    },
  ],
};
const CALLS = new Map<string, RoundCall>([
  ['c1', { server: 'logs', tool: 'search', outcome: 'success' }],
  ['c2', { server: 'logs', tool: 'search', outcome: 'empty' }],
  ['c3', { server: 'crm', tool: 'find', outcome: 'success' }],
]);

const entity = (ref: string, name: string, description = 'A service') => ({
  op: 'add_entity',
  ref,
  name,
  description,
  evidence: ['c3'],
});
const confirm = (id: string, evidence: string[]) => ({ op: 'confirm', id, evidence });
const toolRelation = (kind: string, evidence: string[]) => ({
  op: 'add_relation',
  kind,
  server: 'logs',
  tool: 'search',
  question: 'deploy lookup',
  ...(kind === 'lesson' ? { hint: 'filter by tag', outcome: 'found it' } : {}),
  evidence,
});
const confirmed = (type: 'entity' | 'relation', id: number, confirmations: number) => ({
  type,
  id,
  confirmations,
  confirmedAt: ROUND_AT,
  confirmedByRunId: RUN,
});
const newEntity = (ref: string, name: string, description = 'A service'): KnowledgeAddition => ({
  type: 'entity',
  ref,
  name,
  description,
});

const MANY = Array.from({ length: 51 }, (_, i) => entity(`n${i}`, `service ${i}`));

type Outcome = Omit<CheckedOperations, 'rejected'> & { rejected: OperationRejectionReason[] };
const none: Outcome = { apply: [], confirm: [], outdated: [], rejected: [] };

describe('checkOperations decides each operation by id, evidence and exact repeat', () => {
  it.each<[string, unknown[], Outcome]>([
    [
      'AC-04.1: a new fact joins the existing entity e1',
      [
        entity('invoice', 'invoice-service'),
        { op: 'add_relation', kind: 'fact', from: 'invoice', to: 'e1', label: 'calls', evidence: ['c3'] },
      ],
      {
        ...none,
        apply: [
          newEntity('invoice', 'invoice-service'),
          { type: 'relation', kind: 'fact', from: { ref: 'invoice' }, to: { id: 1 }, label: 'calls' },
        ],
      },
    ],
    [
      'AC-04.1: " Billing-API " confirms e1, and a relation through its ref joins e1, no second entity',
      [
        entity('billing', ' Billing-API '),
        entity('ledger', 'ledger'),
        { op: 'add_relation', kind: 'fact', from: 'billing', to: 'ledger', label: 'writes to', evidence: ['c3'] },
      ],
      {
        ...none,
        apply: [
          newEntity('ledger', 'ledger'),
          { type: 'relation', kind: 'fact', from: { id: 1 }, to: { ref: 'ledger' }, label: 'writes to' },
        ],
        confirm: [confirmed('entity', 1, 2)],
      },
    ],
    [
      'AC-16.1: a lesson confirmed with a logs.search call gets its second confirmation and the round date',
      [confirm('r1', ['c1'])],
      { ...none, confirm: [confirmed('relation', 1, 2)] },
    ],
    [
      'AC-16.2: a lesson confirmation citing a call of another tool is rejected',
      [confirm('r1', ['c3'])],
      { ...none, rejected: ['evidence_mismatch'] },
    ],
    [
      'AC-16.2: a confirmation citing a call not in the input is rejected',
      [confirm('e1', ['c9'])],
      { ...none, rejected: ['unknown_call'] },
    ],
    [
      'a record the same run confirmed last keeps its count and gets the round date',
      [confirm('e2', ['c3'])],
      { ...none, confirm: [confirmed('entity', 2, 3)] },
    ],
    [
      'DC-6: unknown id, unknown ref, a repeated id and a malformed operation are rejected, the rest applies',
      [
        confirm('e9', ['c3']),
        { op: 'add_relation', kind: 'fact', from: 'ghost', to: 'e1', label: 'uses', evidence: ['c3'] },
        confirm('e1', ['c3']),
        confirm('e1', ['c3']),
        { op: 'add_entity', name: 'no ref, no evidence' },
        { op: 'mark_outdated', id: 'r1' },
      ],
      {
        ...none,
        confirm: [confirmed('entity', 1, 2)],
        outdated: [{ type: 'relation', id: 1 }],
        rejected: ['unknown_item', 'unknown_ref', 'repeated', 'malformed'],
      },
    ],
    [
      'DC-11: a lesson needs a call of its tool, "searched - found nothing" an empty one',
      [
        toolRelation('lesson', ['c3']),
        toolRelation('searched_nothing', ['c1']),
        toolRelation('searched_nothing', ['c2']),
      ],
      {
        ...none,
        apply: [
          { type: 'relation', kind: 'searched_nothing', server: 'logs', tool: 'search', question: 'deploy lookup' },
        ],
        rejected: ['evidence_mismatch', 'evidence_mismatch'],
      },
    ],
    [
      'the 51st operation is rejected as too_many, the first 50 apply',
      MANY,
      {
        ...none,
        apply: MANY.slice(0, 50).map((op) => newEntity(op.ref, op.name)),
        rejected: ['too_many'],
      },
    ],
    [
      'AC-05.1: a secret of the process memory is redacted before the checks',
      [entity('vault', 'vault', `Opens with ${SECRET} only`)],
      { ...none, apply: [newEntity('vault', 'vault', 'Opens with [redacted] only')] },
    ],
  ])('%s', (_, operations, expected) => {
    const result = checkOperations({
      graph: GRAPH,
      calls: CALLS,
      operations,
      mask: createSecretMasker([]),
      roundAt: ROUND_AT,
      runId: RUN,
    });
    expect({ ...result, rejected: result.rejected.map(({ reason }) => reason) }).toEqual(expected);
  });
});
