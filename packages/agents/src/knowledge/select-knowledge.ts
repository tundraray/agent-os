import type {
  EmbeddingFailureReason,
  KnowledgeCounts,
  KnowledgeItem,
  KnowledgeItemState,
  KnowledgePlacement,
  KnowledgeSelection,
  KnowledgeSettings,
} from '@agent-os/contracts';
import { tokensOfBytes, utf8Bytes } from '../model/token-estimate.js';
import { knowledgeKey, knowledgeLine } from './knowledge-text.js';
import type { KnowledgeCloseness, KnowledgeVectorKey } from './vector-store.js';

/** The share of the limit the first pass gives to the records closest to the question (KD-6, FR-06). */
const KNOWLEDGE_BY_MEANING_SHARE = 1 / 2;

type WithoutComputed<Item> = Item extends unknown ? Omit<Item, 'state' | 'placement'> : never;

/**
 * A graph record as read from the tables: the view's fields without the computed `state` and
 * `placement`, and `outdated` — the model's mark. `date` is ISO, as in the view.
 */
export type GraphItem = WithoutComputed<KnowledgeItem> & { readonly outdated: boolean };

/** Whether the workflow still has the tool: in the registry and on the team's servers (`*` — any), KD-5. */
export type ToolAlive = (server: string, tool: string) => boolean;

export type SelectionSettings = Pick<KnowledgeSettings, 'limitTokens' | 'lessonsEnabled'>;

export interface SelectKnowledgeInput {
  readonly items: readonly GraphItem[];
  readonly settings: SelectionSettings;
  readonly toolAlive: ToolAlive;
  /** The store's pairs for the question vector; empty without a question vector, at extraction or on a store failure. */
  readonly closeness: readonly KnowledgeCloseness[];
}

export interface KnowledgeChoice {
  /** The chosen records in the common order — what the block renders, whatever pass picked them. */
  readonly chosen: readonly GraphItem[];
  /** How many the first pass took by closeness. */
  readonly byMeaning: number;
  /** How many the second pass took in the common order. */
  readonly byOrder: number;
  /** `active` records that did not fit. */
  readonly left: number;
}

/** A record with its key and its size in tokens — the estimate of its step line. */
interface Sized {
  readonly item: GraphItem;
  readonly key: string;
  readonly tokens: number;
}

/**
 * What goes into a run's prompt (KD-6; UC-5, AC-04.3, AC-06.1–AC-06.3, AC-15.3, AC-17.1, AC-18.1, DC-9,
 * DC-12; pure-decision.md). Only `active` records take part. The first pass takes records by closeness,
 * closest first, among equals by id, while the next one fits in `floor(limitTokens × share)`; a key
 * without an `active` record is dropped. The second pass fills the rest of the limit in the common order
 * and stops at the first record that does not fit; a record without a vector of the current model has
 * no pair, so only this pass can take it. No pairs — the whole limit in the common order.
 */
export function selectKnowledge({ items, settings, toolAlive, closeness }: SelectKnowledgeInput): KnowledgeChoice {
  const active = activeInCommonOrder(items, settings, toolAlive);
  const byMeaning = takeWhileFits(closestFirst(active, closeness), halfOf(settings.limitTokens));
  const taken = new Set(byMeaning);
  const byOrder = takeWhileFits(
    active.filter((record) => !taken.has(record)),
    settings.limitTokens - tokensOf(byMeaning),
  );
  for (const record of byOrder) taken.add(record);
  return {
    chosen: active.filter((record) => taken.has(record)).map((record) => record.item),
    byMeaning: byMeaning.length,
    byOrder: byOrder.length,
    left: active.length - taken.size,
  };
}

/** What the screen needs besides the graph's own fields: the embedding service's and the store's state. */
export interface EmbeddingState {
  /** `Agents.embeddings.model()`: the current model, `null` on `model_not_configured`. */
  readonly model: string | null;
  /** The workflow's last embedding attempt, when it failed: its reason and model. */
  readonly lastFailure: { readonly reason: EmbeddingFailureReason; readonly model: string } | null;
  /** `list` of the workflow's collection. */
  readonly vectors: readonly Pick<KnowledgeVectorKey, 'key' | 'model'>[];
}

export interface KnowledgeViewPartsInput {
  readonly items: readonly GraphItem[];
  readonly settings: SelectionSettings;
  readonly toolAlive: ToolAlive;
  /** The flag of the workflow's last version. */
  readonly selfLearning: boolean;
  readonly embedding: EmbeddingState;
}

export interface KnowledgeViewParts {
  readonly selection: KnowledgeSelection;
  readonly counts: KnowledgeCounts;
  /** Every record in the common order, `outdated` last in the same order, `lessons_off` among `active`. */
  readonly items: KnowledgeItem[];
}

/**
 * The computed fields of `KnowledgeView` (design-core.md, Contract `KnowledgeView`, `KnowledgeItem`):
 * `state` (`outdated` before `lessons_off`), `placement`, `counts`, the order of `items` and `selection`.
 * `always` is the start of the common order that fits in the part of the limit left to the second pass —
 * `limitTokens` minus the half while selection is `on` or `preparing`, the whole limit while it is `off`.
 */
export function knowledgeViewParts({
  items,
  settings,
  toolAlive,
  selfLearning,
  embedding,
}: KnowledgeViewPartsInput): KnowledgeViewParts {
  const all = inCommonOrder(items.map(sized));
  const states = new Map(all.map((record) => [record, stateOf(record.item, settings, toolAlive)]));
  const active = all.filter((record) => states.get(record) === 'active');
  const selection = selectionOf(embedding, active);
  const total = tokensOf(active);
  const allFit = total <= settings.limitTokens;
  const byMeaningOn = selection.state !== 'off';
  const always = new Set(
    selfLearning && !allFit
      ? takeWhileFits(active, byMeaningOn ? settings.limitTokens - halfOf(settings.limitTokens) : settings.limitTokens)
      : [],
  );
  const placementOf = (record: Sized): KnowledgePlacement => {
    if (states.get(record) !== 'active' || !selfLearning || allFit) return null;
    if (always.has(record)) return 'always';
    return byMeaningOn ? 'by_topic' : 'does_not_fit';
  };
  const alwaysCount = allFit ? active.length : always.size;
  const view = (record: Sized): KnowledgeItem => viewItem(record.item, states.get(record) ?? 'active', placementOf(record));
  return {
    selection,
    counts: {
      active: active.length,
      always: alwaysCount,
      beyond: active.length - alwaysCount,
      outdated: all.filter(
        (record) =>
          states.get(record) === 'outdated' && (settings.lessonsEnabled || record.item.kind !== 'lesson'),
      ).length,
      percent: Math.ceil((total * 100) / settings.limitTokens),
    },
    items: [
      ...all.filter((record) => states.get(record) !== 'outdated').map(view),
      ...all.filter((record) => states.get(record) === 'outdated').map(view),
    ],
  };
}

/** Embedding failures that put selection `off` with `provider_failed`; `owner_disabled` is one employee's refusal. */
const PROVIDER_FAILURES: ReadonlySet<EmbeddingFailureReason> = new Set([
  'provider_missing',
  'provider_disabled',
  'provider_key_missing',
  'provider_key_rejected',
  'provider_unavailable',
  'provider_error',
  'dimension_mismatch',
]);

/** The first state that applies, top to bottom (Contract `KnowledgeSelection`). */
function selectionOf(embedding: EmbeddingState, active: readonly Sized[]): KnowledgeSelection {
  if (embedding.model === null) return { state: 'off', reason: 'model_not_selected', model: null };
  const failure = embedding.lastFailure;
  if (failure !== null && PROVIDER_FAILURES.has(failure.reason)) {
    return { state: 'off', reason: 'provider_failed', model: failure.model };
  }
  const withVector = new Set(
    embedding.vectors.filter((vector) => vector.model === embedding.model).map((vector) => vector.key),
  );
  const pending = active.filter((record) => !withVector.has(record.key)).length;
  return pending > 0 ? { state: 'preparing', pending } : { state: 'on' };
}

/**
 * The record's state (KD-5, FR-15, FR-17): `outdated` when the model marked it or its tool is gone —
 * a returned tool makes it `active` again (DC-12) — before `lessons_off` for a lesson while lessons are off.
 */
function stateOf(item: GraphItem, settings: SelectionSettings, toolAlive: ToolAlive): KnowledgeItemState {
  if (item.outdated) return 'outdated';
  if (item.type === 'relation' && item.kind !== 'fact' && !toolAlive(item.server, item.tool)) return 'outdated';
  if (item.kind === 'lesson' && !settings.lessonsEnabled) return 'lessons_off';
  return 'active';
}

function activeInCommonOrder(
  items: readonly GraphItem[],
  settings: SelectionSettings,
  toolAlive: ToolAlive,
): Sized[] {
  return inCommonOrder(items.filter((item) => stateOf(item, settings, toolAlive) === 'active').map(sized));
}

function sized(item: GraphItem): Sized {
  return { item, key: knowledgeKey(item), tokens: tokensOfBytes(utf8Bytes(knowledgeLine(item))) };
}

/** Terms «Общий порядок»: more confirmations first, among equals newer first, then by id. */
function inCommonOrder(records: readonly Sized[]): Sized[] {
  return [...records].sort(
    (a, b) =>
      b.item.confirmations - a.item.confirmations ||
      Date.parse(b.item.date) - Date.parse(a.item.date) ||
      byId(a, b),
  );
}

/** The records that have a pair, closest first, among equals by id; a key without a record is dropped (Invariant 10). */
function closestFirst(records: readonly Sized[], closeness: readonly KnowledgeCloseness[]): Sized[] {
  const byKey = new Map(records.map((record) => [record.key, record]));
  const scored = new Map<Sized, number>();
  for (const pair of closeness) {
    const record = byKey.get(pair.key);
    if (record !== undefined && !scored.has(record)) scored.set(record, pair.closeness);
  }
  return [...scored]
    .sort(([a, aCloseness], [b, bCloseness]) => bCloseness - aCloseness || byId(a, b))
    .map(([record]) => record);
}

/** By id, an entity before a relation of the same id. */
function byId(a: Sized, b: Sized): number {
  return a.item.id - b.item.id || typeRank(a.item) - typeRank(b.item);
}

function typeRank(item: GraphItem): number {
  return item.type === 'entity' ? 0 : 1;
}

/** The records from the start, while the next one fits in the budget: it stops at the first that does not. */
function takeWhileFits(records: readonly Sized[], budget: number): Sized[] {
  const taken: Sized[] = [];
  let used = 0;
  for (const record of records) {
    if (used + record.tokens > budget) break;
    used += record.tokens;
    taken.push(record);
  }
  return taken;
}

function halfOf(limitTokens: number): number {
  return Math.floor(limitTokens * KNOWLEDGE_BY_MEANING_SHARE);
}

function tokensOf(records: readonly Sized[]): number {
  return records.reduce((sum, record) => sum + record.tokens, 0);
}

function viewItem(item: GraphItem, state: KnowledgeItemState, placement: KnowledgePlacement): KnowledgeItem {
  const { outdated: _outdated, ...fields } = item;
  return { ...fields, state, placement };
}
