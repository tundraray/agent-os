import type { KnowledgeCounts, KnowledgeItemState, KnowledgePlacement, KnowledgeSelection } from '@agent-os/contracts';
import { utf8Bytes } from '../model/token-estimate.js';
import { KNOWLEDGE_RULE, knowledgeKey, knowledgeLine, knowledgeText } from './knowledge-text.js';
import {
  type EmbeddingState,
  type GraphItem,
  knowledgeViewParts,
  selectKnowledge,
  type ToolAlive,
} from './select-knowledge.js';
import type { KnowledgeCloseness } from './vector-store.js';

// UC-5 (self-learning design-core.md): AC-04.3, AC-17.1 (outdated relation and a lesson whose tool is gone
// are `outdated` and out of the text), DC-12 (a returned tool brings the lesson back), AC-18.1 / AC-06.3
// (up to half by closeness, the rest in the common order, the most confirmed record without a vector is
// in), AC-06.1–AC-06.3 (no pairs — the whole limit in the common order; a smaller limit cuts the same
// order, least confirmed first, older among equals), AC-15.3 (`lessons_off`, a gone-tool lesson stays
// `outdated`), DC-9 (the same set gives the same text byte for byte), `placement`, `counts`, `selection`.

/** Every record's step line is 1 000 bytes — 250 tokens — so limits count records. */
const RECORD_BYTES = 1_000;

function day(n: number): string {
  return `2026-11-${n.toString().padStart(2, '0')}T10:00:00.000Z`;
}

/** Appends `pad` to the record's last free text. */
function withPad(item: GraphItem, pad: string): GraphItem {
  if (item.type === 'entity') return { ...item, description: item.description + pad };
  if (item.kind === 'fact') return { ...item, label: item.label + pad };
  if (item.kind === 'lesson') return { ...item, hint: item.hint + pad };
  return { ...item, question: item.question + pad };
}

/** Pads the record's last free text until its step line is `RECORD_BYTES` long (a trailing space of the text becomes inner). */
function padded(item: GraphItem): GraphItem {
  const oneX = utf8Bytes(knowledgeLine(withPad(item, 'x')));
  return withPad(item, 'x'.repeat(RECORD_BYTES - oneX + 1));
}

function entity(id: number, name: string, confirmations: number, date: number): GraphItem {
  return padded({
    type: 'entity',
    kind: 'fact',
    id,
    name,
    description: `about ${name} `,
    confirmations,
    date: day(date),
    outdated: false,
  });
}

const GRAPH: readonly GraphItem[] = [
  entity(1, 'billing-api', 5, 10),
  entity(2, 'payment-gateway', 4, 10),
  entity(3, 'ledger', 3, 12),
  entity(4, 'invoices', 3, 11),
  entity(5, 'refunds', 1, 9),
  entity(6, 'chargebacks', 1, 8),
  padded({
    type: 'relation',
    kind: 'fact',
    id: 7,
    from: { id: 1, name: 'billing-api' },
    to: { id: 2, name: 'payment-gateway' },
    label: 'calls ',
    confirmations: 9,
    date: day(10),
    outdated: true,
  }),
  padded({
    type: 'relation',
    kind: 'lesson',
    id: 8,
    server: 'logs',
    tool: 'search',
    question: 'payment errors',
    hint: 'filter by service ',
    outcome: 'found the errors',
    confirmations: 2,
    date: day(10),
    outdated: false,
  }),
  padded({
    type: 'relation',
    kind: 'lesson',
    id: 9,
    server: 'legacy',
    tool: 'grep',
    question: 'payment errors',
    hint: 'grep the archive ',
    outcome: 'found the errors',
    confirmations: 6,
    date: day(10),
    outdated: false,
  }),
  padded({
    type: 'relation',
    kind: 'searched_nothing',
    id: 10,
    server: 'logs',
    tool: 'search',
    question: 'gateway timeouts ',
    confirmations: 1,
    date: day(5),
    outdated: false,
  }),
];

/** `legacy.grep` is gone from the registry; `logs.search` is there. */
const REGISTRY: ToolAlive = (server, tool) => server === 'logs' && tool === 'search';
const ALL_TOOLS: ToolAlive = () => true;

const MODEL = 'voyage/voyage-3';
const ACTIVE_KEYS = ['e1', 'e2', 'e3', 'e4', 'r8', 'e5', 'e6', 'r10'];
const ON: EmbeddingState = {
  model: MODEL,
  lastFailure: null,
  vectors: ACTIVE_KEYS.map((key) => ({ key, model: MODEL })),
};

interface Row {
  readonly name: string;
  readonly limitTokens: number;
  readonly lessonsEnabled?: boolean;
  readonly toolAlive?: ToolAlive;
  readonly closeness?: readonly KnowledgeCloseness[];
  readonly selfLearning?: boolean;
  readonly embedding?: EmbeddingState;
  /** Keys of the chosen records in the order of the block's lines; `[]` — no block. */
  readonly chosen?: readonly string[];
  /** Other pairs that choose the same set: the text must be the same byte for byte. */
  readonly sameTextWith?: readonly KnowledgeCloseness[];
  readonly order?: readonly string[];
  readonly states?: Readonly<Record<string, KnowledgeItemState>>;
  readonly placements?: Readonly<Record<string, KnowledgePlacement>>;
  readonly counts?: KnowledgeCounts;
  readonly selection?: KnowledgeSelection;
}

const ALL_ORDER = ['e1', 'e2', 'e3', 'e4', 'r8', 'e5', 'e6', 'r10', 'r7', 'r9'];

const ON_PLACEMENTS: Record<string, KnowledgePlacement> = {
  e1: 'always',
  e2: 'always',
  e3: 'by_topic',
  e4: 'by_topic',
  r8: 'by_topic',
  e5: 'by_topic',
  e6: 'by_topic',
  r10: 'by_topic',
  r7: null,
  r9: null,
};

const OFF_PLACEMENTS: Record<string, KnowledgePlacement> = {
  e1: 'always',
  e2: 'always',
  e3: 'always',
  e4: 'always',
  r8: 'does_not_fit',
  e5: 'does_not_fit',
  e6: 'does_not_fit',
  r10: 'does_not_fit',
  r7: null,
  r9: null,
};

const NO_PLACEMENTS: Record<string, KnowledgePlacement> = Object.fromEntries(ALL_ORDER.map((key) => [key, null]));

const ROWS: readonly Row[] = [
  {
    name: 'half by closeness, the rest in the common order; outdated and gone-tool records are out',
    limitTokens: 1_000,
    closeness: [
      { key: 'r7', closeness: 0.99 },
      { key: 'e99', closeness: 0.95 },
      { key: 'e5', closeness: 0.9 },
      { key: 'e6', closeness: 0.8 },
      { key: 'e2', closeness: 0.5 },
    ],
    chosen: ['e1', 'e2', 'e5', 'e6'],
    sameTextWith: [
      { key: 'e6', closeness: 0.97 },
      { key: 'e5', closeness: 0.96 },
    ],
    order: ALL_ORDER,
    states: { r7: 'outdated', r9: 'outdated', r8: 'active', r10: 'active' },
    placements: ON_PLACEMENTS,
    counts: { active: 8, always: 2, beyond: 6, outdated: 2, percent: 200 },
    selection: { state: 'on' },
  },
  {
    name: 'equal closeness goes by id',
    limitTokens: 1_000,
    closeness: [
      { key: 'e6', closeness: 0.8 },
      { key: 'e5', closeness: 0.8 },
      { key: 'e4', closeness: 0.8 },
    ],
    chosen: ['e1', 'e2', 'e4', 'e5'],
  },
  {
    name: 'no pairs: the whole limit in the common order, the older of equals is cut',
    limitTokens: 1_500,
    chosen: ['e1', 'e2', 'e3', 'e4', 'r8', 'e5'],
  },
  {
    name: 'a smaller limit cuts the same order, the least confirmed first',
    limitTokens: 1_000,
    chosen: ['e1', 'e2', 'e3', 'e4'],
  },
  {
    name: 'a record larger than the limit: nothing chosen, no block',
    limitTokens: 200,
    chosen: [],
  },
  {
    name: 'lessons off: lessons_off in place among active, the gone-tool lesson stays outdated',
    limitTokens: 1_500,
    lessonsEnabled: false,
    chosen: ['e1', 'e2', 'e3', 'e4', 'e5', 'e6'],
    order: ALL_ORDER,
    states: { r8: 'lessons_off', r9: 'outdated', r10: 'active', r7: 'outdated' },
    placements: { ...ON_PLACEMENTS, e3: 'always', r8: null },
    counts: { active: 7, always: 3, beyond: 4, outdated: 1, percent: 117 },
  },
  {
    name: 'a returned tool brings the lesson back',
    limitTokens: 1_500,
    toolAlive: ALL_TOOLS,
    chosen: ['r9', 'e1', 'e2', 'e3', 'e4', 'r8'],
    states: { r9: 'active' },
  },
  {
    name: 'preparing: active records without a vector of the current model',
    limitTokens: 1_000,
    embedding: {
      ...ON,
      vectors: [
        ...ACTIVE_KEYS.filter((key) => key !== 'e1' && key !== 'e2').map((key) => ({ key, model: MODEL })),
        { key: 'e2', model: 'voyage/voyage-2' },
        { key: 'r9', model: MODEL },
      ],
    },
    placements: ON_PLACEMENTS,
    selection: { state: 'preparing', pending: 2 },
  },
  {
    name: 'off, no embedding model: always in the whole limit, the rest does not fit',
    limitTokens: 1_000,
    embedding: { ...ON, model: null },
    placements: OFF_PLACEMENTS,
    counts: { active: 8, always: 4, beyond: 4, outdated: 2, percent: 200 },
    selection: { state: 'off', reason: 'model_not_selected', model: null },
  },
  {
    name: 'off, the last attempt failed at the provider',
    limitTokens: 1_000,
    embedding: { ...ON, lastFailure: { reason: 'provider_unavailable', model: MODEL } },
    placements: OFF_PLACEMENTS,
    selection: { state: 'off', reason: 'provider_failed', model: MODEL },
  },
  {
    name: "one employee's owner_disabled does not turn selection off",
    limitTokens: 1_000,
    embedding: { ...ON, lastFailure: { reason: 'owner_disabled', model: MODEL } },
    selection: { state: 'on' },
  },
  {
    name: 'all active fit: no placement, every active counts as always',
    limitTokens: 2_000,
    placements: NO_PLACEMENTS,
    counts: { active: 8, always: 8, beyond: 0, outdated: 2, percent: 100 },
  },
  {
    name: 'self-learning off: no placement',
    limitTokens: 1_000,
    selfLearning: false,
    placements: NO_PLACEMENTS,
  },
];

describe('selectKnowledge and knowledgeViewParts (UC-5)', () => {
  it.each(ROWS)('$name', (row) => {
    const settings = { limitTokens: row.limitTokens, lessonsEnabled: row.lessonsEnabled ?? true };
    const toolAlive = row.toolAlive ?? REGISTRY;
    const choice = selectKnowledge({ items: GRAPH, settings, toolAlive, closeness: row.closeness ?? [] });
    const text = knowledgeText(choice.chosen);

    if (row.chosen !== undefined) {
      expect(choice.chosen.map(knowledgeKey)).toEqual(row.chosen);
      if (row.chosen.length === 0) {
        expect(text).toBeNull();
      } else {
        expect(text?.startsWith(`${KNOWLEDGE_RULE}\n<data source="knowledge"`)).toBe(true);
        expect(text?.split('\n').slice(2, -1)).toEqual(choice.chosen.map(knowledgeLine));
      }
    }
    if (row.sameTextWith !== undefined) {
      const other = selectKnowledge({ items: [...GRAPH].reverse(), settings, toolAlive, closeness: row.sameTextWith });
      expect(knowledgeText(other.chosen)).toBe(text);
    }

    const view = knowledgeViewParts({
      items: GRAPH,
      settings,
      toolAlive,
      selfLearning: row.selfLearning ?? true,
      embedding: row.embedding ?? ON,
    });
    const byKey = new Map(view.items.map((item) => [knowledgeKey(item), item]));
    if (row.order !== undefined) expect(view.items.map(knowledgeKey)).toEqual(row.order);
    for (const [key, state] of Object.entries(row.states ?? {})) expect(byKey.get(key)?.state).toBe(state);
    if (row.placements !== undefined) {
      expect(Object.fromEntries(view.items.map((item) => [knowledgeKey(item), item.placement]))).toEqual(
        row.placements,
      );
    }
    if (row.counts !== undefined) expect(view.counts).toEqual(row.counts);
    if (row.selection !== undefined) expect(view.selection).toEqual(row.selection);
  });
});
