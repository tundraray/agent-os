import type { Logger } from '@agent-os/common';
import { ALL_SERVERS, KnowledgeItemKindSchema } from '@agent-os/contracts';
import type { Database } from '@agent-os/db';

import { findServers, listServers } from '../mcp/mcp-servers.repository.js';
import { storedMcpTools } from '../mcp/mcp-tool.js';
import { tokensOfBytes, utf8Bytes } from '../model/token-estimate.js';
import { type LearningRun, learningRunOf } from '../start/snapshot-definition.js';
import type { RunSnapshot } from '../start/snapshot.js';
import { readQuestion } from './knowledge-runs.repository.js';
import { type KnowledgeGraph, readGraph, readKnowledgeSettings } from './knowledge.repository.js';
import { knowledgeText } from './knowledge-text.js';
import { type GraphItem, selectKnowledge, type ToolAlive } from './select-knowledge.js';
import type { KnowledgeCloseness, KnowledgeVectorStore } from './vector-store.js';

export interface KnowledgeBlockDeps {
  /** Reads the graph, the settings, the registry and the question row on every step (KD-6). */
  readonly database: Database;
  readonly store: KnowledgeVectorStore;
}

export interface KnowledgeBlockInput {
  /** The run's snapshot: whether the session learns and the team's servers come from it only (ADR-0017). */
  readonly snapshot: RunSnapshot;
  /** The session's task: the key of its question row. */
  readonly taskId: string;
  readonly logger: Logger;
}

/**
 * The system text of a step (self-learning design-core.md, KD-6; plan Notes 4): the definition's prompt,
 * then an empty line and the knowledge block. The model step and the compaction step both build their
 * `instructions` here, so a compaction call carries the same text as the model call. No block — the
 * prompt unchanged, byte for byte.
 */
export function withKnowledge(prompt: string, block: string | null): string {
  return block === null ? prompt : `${prompt}\n\n${block}`;
}

/**
 * The knowledge block of a run step (KD-6, KD-5, C3 «шаг запуска с графом», Flow 2): `null` without a
 * read for a session that does not learn. Otherwise the graph, read fresh — never cached between steps,
 * so a deleted record is gone from the next step (AC-09.2) — then the settings, the registry for the
 * lessons' tools and the stored question vector; with a vector, the store's closeness. The text depends
 * only on the chosen set, rendered in the common order, so within a session it changes only when the
 * graph, its vectors, the settings, the registry or the question vector change.
 *
 * A failed graph read throws: the step fails as on a failed history read. A failed store query is a
 * warning, and selection runs without closeness pairs. No embeddings call: the handler stored the vector.
 */
export async function knowledgeBlock(
  deps: KnowledgeBlockDeps,
  { snapshot, taskId, logger }: KnowledgeBlockInput,
): Promise<string | null> {
  const learning = sessionLearningOf(snapshot);
  if (learning === null) return null;

  const startedAt = Date.now();
  const { database } = deps;
  const { recordId } = learning;
  const items = graphItemsOf(await readGraph(database, recordId));
  // An empty graph gives no block whatever the rest says: the other reads are skipped.
  if (items.length === 0) {
    logger.info('knowledge block built', {
      taskId,
      recordId,
      graphItems: 0,
      durationMs: Date.now() - startedAt,
    });
    return null;
  }

  const settings = await readKnowledgeSettings(database);
  const toolAlive = await registryToolAlive(database, learning.servers);
  const question = await readQuestion(database, taskId);
  const vector = question?.vector ?? null;
  const model = question?.model ?? null;
  // `limit` — every record of the graph: selection itself decides which pairs it takes (KD-6).
  const closeness =
    vector !== null && model !== null
      ? await closenessOrNone(deps.store, { recordId, taskId, logger }, vector, model, items.length)
      : [];

  const choice = selectKnowledge({ items, settings, toolAlive, closeness });
  const block = knowledgeText(choice.chosen);
  logger.info('knowledge block built', {
    taskId,
    recordId,
    graphItems: items.length,
    hasQuestionVector: vector !== null && model !== null,
    byMeaning: choice.byMeaning,
    byOrder: choice.byOrder,
    left: choice.left,
    blockTokens: block === null ? 0 : tokensOfBytes(utf8Bytes(block)),
    durationMs: Date.now() - startedAt,
  });
  return block;
}

/**
 * The workflow the session learns for and its team's servers (KD-2, KD-5), decided by the snapshot: a
 * coordinator — by the flag of its snapshot, the servers of the executors of its `WorkflowContent`; an
 * executor — by `learning`. `null` — the session does not learn.
 */
export function sessionLearningOf(snapshot: RunSnapshot): LearningRun | null {
  if (snapshot.kind === 'executor') {
    return snapshot.learning === null
      ? null
      : { recordId: snapshot.origin.recordId, servers: snapshot.learning.servers };
  }
  return learningRunOf(snapshot);
}

/**
 * Whether a lesson's tool is still the workflow's (KD-5): its server is on the team (`*` — any) and the
 * registry still lists the server with that tool. The registry only notices a missing server or tool.
 * The run step, the extraction round and the knowledge view all judge by it.
 */
export async function registryToolAlive(database: Database, servers: readonly string[]): Promise<ToolAlive> {
  const anyServer = servers.includes(ALL_SERVERS);
  const rows = anyServer ? await listServers(database) : await findServers(database, servers);
  const tools = new Set(
    rows.flatMap((row) =>
      (storedMcpTools(row.tools) ?? []).map((tool) => toolKey(row.name, tool.tool)),
    ),
  );
  return (server, tool) => tools.has(toolKey(server, tool));
}

function toolKey(server: string, tool: string): string {
  return JSON.stringify([server, tool]);
}

/**
 * The store's closeness of every vector of the question's model to the question; a failure of the store
 * (the extension or the table unavailable) is a warning, and selection runs without pairs (Flow 2).
 */
async function closenessOrNone(
  store: KnowledgeVectorStore,
  ids: { readonly recordId: string; readonly taskId: string; readonly logger: Logger },
  vector: readonly number[],
  model: string,
  limit: number,
): Promise<readonly KnowledgeCloseness[]> {
  try {
    return await store.query(ids.recordId, vector, model, limit);
  } catch (error) {
    ids.logger.warn('knowledge store query failed; selection without closeness', {
      taskId: ids.taskId,
      recordId: ids.recordId,
      model,
      // The cause, not the failed query: the query's parameters carry the question vector.
      error: causeMessage(error),
    });
    return [];
  }
}

function causeMessage(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? error.cause.message : error.message;
}

/**
 * The graph's rows as `selectKnowledge` takes them (`GraphItem`): `date` — the last confirmation, ISO; a
 * fact relation carries its ends' names. A fact whose end is not among the entities read — an entity added
 * between the two reads of `readGraph` — waits for the next read.
 */
export function graphItemsOf(graph: KnowledgeGraph): GraphItem[] {
  const names = new Map(graph.entities.map((row) => [row.id, row.name]));
  const entities = graph.entities.map(
    (row): GraphItem => ({
      type: 'entity',
      kind: KnowledgeItemKindSchema.enum.fact,
      id: row.id,
      confirmations: row.confirmations,
      date: row.confirmedAt.toISOString(),
      outdated: row.outdated,
      name: row.name,
      description: row.description,
    }),
  );
  const relations = graph.relations.flatMap((row): GraphItem[] => {
    const common = {
      type: 'relation' as const,
      id: row.id,
      confirmations: row.confirmations,
      date: row.confirmedAt.toISOString(),
      outdated: row.outdated,
    };
    const kind = KnowledgeItemKindSchema.parse(row.kind);
    if (kind === 'fact') {
      const fromId = required(row.fromEntityId, 'from_entity_id', row.id);
      const toId = required(row.toEntityId, 'to_entity_id', row.id);
      const fromName = names.get(fromId);
      const toName = names.get(toId);
      if (fromName === undefined || toName === undefined) return [];
      return [
        {
          ...common,
          kind,
          from: { id: fromId, name: fromName },
          to: { id: toId, name: toName },
          label: required(row.label, 'label', row.id),
        },
      ];
    }
    const tool = {
      server: required(row.server, 'server', row.id),
      tool: required(row.tool, 'tool', row.id),
      question: required(row.question, 'question', row.id),
    };
    if (kind === 'searched_nothing') return [{ ...common, ...tool, kind }];
    return [
      {
        ...common,
        ...tool,
        kind,
        hint: required(row.hint, 'hint', row.id),
        outcome: required(row.outcome, 'outcome', row.id),
      },
    ];
  });
  return [...entities, ...relations];
}

/** A column the shape CHECK of `agent_knowledge_relations` requires for the relation's kind. */
function required<T>(value: T | null, column: string, relationId: number): T {
  if (value === null) throw new Error(`Knowledge relation ${relationId} has no ${column}`);
  return value;
}
