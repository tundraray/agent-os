import type { ToolOutcome } from '@agent-os/contracts';

import {
  ENTITY_ID_PATTERN,
  KNOWLEDGE_OPERATIONS_MAX,
  type KnowledgeOperation,
  KnowledgeOperationSchema,
} from './operations';

/** Outcome of a call of the extraction input: only these outcomes are taken into it. */
export type RoundCallOutcome = Extract<ToolOutcome, 'success' | 'empty' | 'tool_error'>;

/** A tool call of the round's input, cited by its number `c…`. */
export interface RoundCall {
  readonly server: string;
  readonly tool: string;
  readonly outcome: RoundCallOutcome;
}

/** An entity of the graph as re-read in the round's commit (the fields of its row the check needs). */
export interface GraphEntity {
  readonly id: number;
  readonly name: string;
  readonly confirmations: number;
  readonly confirmedByRunId: string;
}

/** A relation of the graph as re-read in the round's commit; fields off its `kind` are `null`. */
export interface GraphRelation {
  readonly id: number;
  readonly kind: string;
  readonly fromEntityId: number | null;
  readonly toEntityId: number | null;
  readonly label: string | null;
  readonly server: string | null;
  readonly tool: string | null;
  readonly question: string | null;
  readonly hint: string | null;
  readonly outcome: string | null;
  readonly confirmations: number;
  readonly confirmedByRunId: string;
}

export interface KnowledgeGraph {
  readonly entities: readonly GraphEntity[];
  readonly relations: readonly GraphRelation[];
}

export interface CheckOperationsInput {
  /** The workflow's graph read again after `lockGraph` (Invariant 5). */
  readonly graph: KnowledgeGraph;
  /** The calls of the round's input by number `c…`. */
  readonly calls: ReadonlyMap<string, RoundCall>;
  /** The `operations` of the answer as they are. */
  readonly operations: readonly unknown[];
  /** Redacts secrets; the caller passes `createSecretMasker([])` (FR-05). */
  readonly mask: (text: string) => string;
  /** The round's commit time: the date of every confirmation. */
  readonly roundAt: Date;
  /** The coordinator task of the run being extracted. */
  readonly runId: string;
}

/** An end of a new fact: an entity of the graph, or a new entity of this answer by its `ref`. */
export type EntityEnd = { readonly id: number } | { readonly ref: string };

/** A new record to insert, in the answer's order: a `ref` is always inserted before what uses it. */
export type KnowledgeAddition =
  | { readonly type: 'entity'; readonly ref: string; readonly name: string; readonly description: string }
  | {
      readonly type: 'relation';
      readonly kind: 'fact';
      readonly from: EntityEnd;
      readonly to: EntityEnd;
      readonly label: string;
    }
  | {
      readonly type: 'relation';
      readonly kind: 'lesson';
      readonly server: string;
      readonly tool: string;
      readonly question: string;
      readonly hint: string;
      readonly outcome: string;
    }
  | {
      readonly type: 'relation';
      readonly kind: 'searched_nothing';
      readonly server: string;
      readonly tool: string;
      readonly question: string;
    };

type RelationAddition = Extract<KnowledgeAddition, { type: 'relation' }>;

export interface KnowledgeItemRef {
  readonly type: 'entity' | 'relation';
  readonly id: number;
}

/** The values a confirmed record gets; it also stops being outdated. */
export interface KnowledgeConfirmation extends KnowledgeItemRef {
  readonly confirmations: number;
  readonly confirmedAt: Date;
  readonly confirmedByRunId: string;
}

/**
 * - `too_many` — beyond `KNOWLEDGE_OPERATIONS_MAX` in the answer;
 * - `malformed` — not one of the operations, or a text too long after masking;
 * - `unknown_item` — an `e…` / `r…` id not in the graph;
 * - `unknown_ref` — a `ref` not declared by an accepted `add_entity` earlier in the answer;
 * - `unknown_call` — a `c…` not in the round's input;
 * - `evidence_mismatch` — a cited call does not fit the record: a fact needs `success`, a lesson the
 *   same server and tool, «searched — found nothing» the same server and tool with `empty` (DC-11);
 * - `repeated` — the record (or `ref`) was already taken by an earlier operation of the answer.
 */
export type OperationRejectionReason =
  | 'too_many'
  | 'malformed'
  | 'unknown_item'
  | 'unknown_ref'
  | 'unknown_call'
  | 'evidence_mismatch'
  | 'repeated';

export interface OperationRejection {
  /** The operation after masking. */
  readonly op: unknown;
  readonly reason: OperationRejectionReason;
}

export interface CheckedOperations {
  readonly apply: KnowledgeAddition[];
  readonly confirm: KnowledgeConfirmation[];
  readonly outdated: KnowledgeItemRef[];
  readonly rejected: OperationRejection[];
}

type Target =
  | { readonly type: 'entity'; readonly item: GraphEntity }
  | { readonly type: 'relation'; readonly item: GraphRelation };

/** What one operation comes to before the repeat check; `key` names the record it takes. */
type Verdict =
  | { readonly kind: 'reject'; readonly reason: OperationRejectionReason }
  | { readonly kind: 'add'; readonly key: string; readonly addition: KnowledgeAddition }
  | { readonly kind: 'confirm'; readonly key: string; readonly target: Target; readonly ref?: string }
  | { readonly kind: 'outdated'; readonly key: string; readonly target: Target };

interface Context {
  readonly entities: ReadonlyMap<number, GraphEntity>;
  readonly relations: ReadonlyMap<number, GraphRelation>;
  readonly graph: KnowledgeGraph;
  readonly calls: ReadonlyMap<string, RoundCall>;
  /** `ref`s of accepted `add_entity` operations so far. */
  readonly refs: Map<string, EntityEnd>;
}

/**
 * Decides the fate of each operation of the model's answer (design-core.md, KD-4, «Как применяются
 * операции»): apply it, turn it into a confirmation of an existing record, or reject it with a reason.
 * One operation's rejection does not touch the others. Records are found by id or by an exact repeat
 * after case and spaces are folded — never by likeness. No I/O, no logging: the caller logs.
 */
export function checkOperations(input: CheckOperationsInput): CheckedOperations {
  const result: CheckedOperations = { apply: [], confirm: [], outdated: [], rejected: [] };
  const context: Context = {
    entities: new Map(input.graph.entities.map((entity) => [entity.id, entity])),
    relations: new Map(input.graph.relations.map((relation) => [relation.id, relation])),
    graph: input.graph,
    calls: input.calls,
    refs: new Map(),
  };
  const taken = new Set<string>();

  input.operations.forEach((raw, index) => {
    const op = maskStrings(raw, input.mask);
    const verdict = index >= KNOWLEDGE_OPERATIONS_MAX ? reject('too_many') : decide(op, context);
    if (verdict.kind === 'reject') {
      result.rejected.push({ op, reason: verdict.reason });
      return;
    }
    if (taken.has(verdict.key)) {
      result.rejected.push({ op, reason: 'repeated' });
      return;
    }
    taken.add(verdict.key);
    if (verdict.kind === 'add') {
      if (verdict.addition.type === 'entity') {
        context.refs.set(verdict.addition.ref, { ref: verdict.addition.ref });
      }
      result.apply.push(verdict.addition);
    } else if (verdict.kind === 'confirm') {
      if (verdict.ref !== undefined) context.refs.set(verdict.ref, { id: verdict.target.item.id });
      result.confirm.push(confirmation(verdict.target, input));
    } else {
      result.outdated.push({ type: verdict.target.type, id: verdict.target.item.id });
    }
  });
  return result;
}

function decide(raw: unknown, context: Context): Verdict {
  const parsed = KnowledgeOperationSchema.safeParse(raw);
  if (!parsed.success) return reject('malformed');
  const op = parsed.data;
  switch (op.op) {
    case 'mark_outdated': {
      const target = findItem(op.id, context);
      return target === null ? reject('unknown_item') : { kind: 'outdated', key: op.id, target };
    }
    case 'confirm': {
      const target = findItem(op.id, context);
      if (target === null) return reject('unknown_item');
      const proof = checkEvidence(op.evidence, fitOfTarget(target), context);
      return proof ?? { kind: 'confirm', key: op.id, target };
    }
    case 'add_entity':
      return decideEntity(op, context);
    case 'add_relation':
      return decideRelation(op, context);
  }
}

function decideEntity(op: Extract<KnowledgeOperation, { op: 'add_entity' }>, context: Context): Verdict {
  if (context.refs.has(op.ref)) return reject('repeated');
  const proof = checkEvidence(op.evidence, fitsFact, context);
  if (proof !== null) return proof;
  const name = fold(op.name);
  const existing = context.graph.entities.find((entity) => fold(entity.name) === name);
  if (existing !== undefined) {
    const target: Target = { type: 'entity', item: existing };
    return { kind: 'confirm', key: `e${existing.id}`, target, ref: op.ref };
  }
  return {
    kind: 'add',
    key: `new entity ${name}`,
    addition: { type: 'entity', ref: op.ref, name: op.name, description: op.description },
  };
}

function decideRelation(
  op: Extract<KnowledgeOperation, { op: 'add_relation' }>,
  context: Context,
): Verdict {
  let addition: RelationAddition;
  let fit: CallFit;
  if (op.kind === 'fact') {
    const from = resolveEnd(op.from, context);
    if (typeof from === 'string') return reject(from);
    const to = resolveEnd(op.to, context);
    if (typeof to === 'string') return reject(to);
    addition = { type: 'relation', kind: 'fact', from, to, label: op.label };
    fit = fitsFact;
  } else {
    const tool = { server: op.server, tool: op.tool, question: op.question };
    addition =
      op.kind === 'lesson'
        ? { type: 'relation', kind: 'lesson', ...tool, hint: op.hint, outcome: op.outcome }
        : { type: 'relation', kind: 'searched_nothing', ...tool };
    fit = fitsTool(op.server, op.tool, op.kind === 'searched_nothing');
  }
  const proof = checkEvidence(op.evidence, fit, context);
  if (proof !== null) return proof;
  const key = relationKey(addition);
  const existing = context.graph.relations.find((row) => relationKey(fromRow(row)) === key);
  if (existing !== undefined) {
    return { kind: 'confirm', key: `r${existing.id}`, target: { type: 'relation', item: existing } };
  }
  return { kind: 'add', key: `new relation ${key}`, addition };
}

type CallFit = (call: RoundCall) => boolean;

const fitsFact: CallFit = (call) => call.outcome === 'success';

function fitsTool(server: string, tool: string, empty: boolean): CallFit {
  return (call) => call.server === server && call.tool === tool && (!empty || call.outcome === 'empty');
}

function fitOfTarget(target: Target): CallFit {
  if (target.type === 'entity') return fitsFact;
  const { kind, server, tool } = target.item;
  if (kind === 'fact') return fitsFact;
  return fitsTool(server ?? '', tool ?? '', kind === 'searched_nothing');
}

/** Every cited call is in the round's input and fits the record; `null` when the evidence holds. */
function checkEvidence(evidence: readonly string[], fit: CallFit, context: Context): Verdict | null {
  const calls = evidence.map((id) => context.calls.get(id));
  if (calls.some((call) => call === undefined)) return reject('unknown_call');
  if (!calls.every((call) => call !== undefined && fit(call))) return reject('evidence_mismatch');
  return null;
}

function findItem(id: string, context: Context): Target | null {
  const number = Number(id.slice(1));
  if (ENTITY_ID_PATTERN.test(id)) {
    const item = context.entities.get(number);
    return item === undefined ? null : { type: 'entity', item };
  }
  const item = context.relations.get(number);
  return item === undefined ? null : { type: 'relation', item };
}

function resolveEnd(end: string, context: Context): EntityEnd | 'unknown_item' | 'unknown_ref' {
  if (ENTITY_ID_PATTERN.test(end)) {
    const id = Number(end.slice(1));
    return context.entities.has(id) ? { id } : 'unknown_item';
  }
  return context.refs.get(end) ?? 'unknown_ref';
}

/** The exact-repeat key of a relation: its kind, ends and texts, case and spaces folded. */
function relationKey(addition: RelationAddition): string {
  const parts =
    addition.kind === 'fact'
      ? [addition.kind, endKey(addition.from), endKey(addition.to), addition.label]
      : addition.kind === 'lesson'
        ? [addition.kind, addition.server, addition.tool, addition.question, addition.hint, addition.outcome]
        : [addition.kind, addition.server, addition.tool, addition.question];
  return JSON.stringify(parts.map(fold));
}

function endKey(end: EntityEnd): string {
  return 'id' in end ? `e${end.id}` : `ref ${end.ref}`;
}

/** A graph row in the shape of an addition, so both get the same key. */
function fromRow(row: GraphRelation): RelationAddition {
  const text = (value: string | null): string => value ?? '';
  if (row.kind === 'fact') {
    return {
      type: 'relation',
      kind: 'fact',
      from: { id: row.fromEntityId ?? 0 },
      to: { id: row.toEntityId ?? 0 },
      label: text(row.label),
    };
  }
  const tool = { server: text(row.server), tool: text(row.tool), question: text(row.question) };
  return row.kind === 'lesson'
    ? { type: 'relation', kind: 'lesson', ...tool, hint: text(row.hint), outcome: text(row.outcome) }
    : { type: 'relation', kind: 'searched_nothing', ...tool };
}

/** +1, the round's date and run; a run that was the last to confirm the record does not add again. */
function confirmation(target: Target, input: CheckOperationsInput): KnowledgeConfirmation {
  const { item } = target;
  return {
    type: target.type,
    id: item.id,
    confirmations: item.confirmedByRunId === input.runId ? item.confirmations : item.confirmations + 1,
    confirmedAt: input.roundAt,
    confirmedByRunId: input.runId,
  };
}

/** Secrets go before the length check and the repeat comparison (FR-05). */
function maskStrings(raw: unknown, mask: (text: string) => string): unknown {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return raw;
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => [key, typeof value === 'string' ? mask(value) : value]),
  );
}

function fold(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function reject(reason: OperationRejectionReason): Verdict {
  return { kind: 'reject', reason };
}
