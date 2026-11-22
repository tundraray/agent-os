import { randomUUID } from 'node:crypto';
import type { LibraryDoubleRecord, ScriptedToolCall } from '@agent-os/agents/testing';
import type { DeepAgentContent, KnowledgeView } from '@agent-os/contracts';
import {
  agentKnowledgeEntities,
  AgentKnowledgeRepository,
  agentKnowledgeRelations,
  agentKnowledgeRuns,
  AgentKnowledgeRunsRepository,
  agentKnowledgeSettings,
  AgentKnowledgeVectorsRepository,
  type Database,
  Db,
  type KnowledgeEmbeddingRow,
  libraryRecords,
  runtimeTasks,
} from '@agent-os/db';
import { and, asc, eq, sql } from 'drizzle-orm';

import { type KnowledgeRun, knowledgeRunOf } from '../../src/knowledge/knowledge-runs';
import {
  KNOWLEDGE_EMBED_TASK_TYPE,
  KNOWLEDGE_EXTRACT_TASK_TYPE,
} from '../../src/knowledge/knowledge-tasks';
import { RECORD_KNOWLEDGE_TOOL } from '../../src/knowledge/operations';
import type { KnowledgeVector, KnowledgeVectorStore } from '../../src/knowledge/vector-store';
import { type AgentsHarness, TEST_AUTHOR_ID, TEST_MODEL_DEFAULT, waitFor } from './agentsHarness';

/**
 * Fixtures of the self-learning tests (design-core.md, Test Strategy): the real `app.library_records` row the
 * graph hangs on, graph rows and vectors written straight into the tables, the size cap, waits on the rows of
 * the background work, and the reads the cases assert on. The reads are the queries of the `@agent-os/db`
 * repositories and the store the package itself uses, so a case has one import place.
 */
const knowledgeRows = (db: Database) => new AgentKnowledgeRepository(new Db(db));
const knowledgeRunRows = (db: Database) => new AgentKnowledgeRunsRepository(new Db(db));

export const readGraph = (db: Database, recordId: string) => knowledgeRows(db).readGraph(recordId);
export const findRunById = async (db: Database, runId: string) =>
  knowledgeRunOf(await knowledgeRunRows(db).findRunById(runId));
export const findEmbeddingRow = (db: Database, recordId: string) =>
  knowledgeRunRows(db).findEmbeddingRow(recordId);
export const readQuestion = (db: Database, taskId: string) => knowledgeRunRows(db).readQuestion(taskId);
export const createPgvectorStore = (db: Database): KnowledgeVectorStore =>
  new AgentKnowledgeVectorsRepository(new Db(db));

/** The agent name of the extraction's model calls: the scripted model's key `{ agent: KNOWLEDGE_EXTRACT_AGENT }`. */
export const KNOWLEDGE_EXTRACT_AGENT = 'knowledge-extract';

/** The extraction answer's tool call with these operations (`record_knowledge`). */
export function recordKnowledge(operations: readonly unknown[]): ScriptedToolCall {
  return { tool: RECORD_KNOWLEDGE_TOOL, args: { operations } };
}

/**
 * A deep agent record of the library double that learns: by `TEST_AUTHOR_ID`, seen by every employee, on
 * the default model, without servers of its own and without a final subagent. Its id is the id of the real row of {@link withLibraryRow}.
 */
export function learningDeepAgent(
  recordId: string,
  subagents: DeepAgentContent['subagents'],
): LibraryDoubleRecord {
  return {
    id: recordId,
    kind: 'deep_agent',
    name: `learning deep agent ${recordId}`,
    ownerId: TEST_AUTHOR_ID,
    everyone: true,
    offerInChat: true,
    content: {
      prompt: 'You run a learning deep agent.',
      servers: [],
      model: TEST_MODEL_DEFAULT,
      maxTurns: 20,
      subagents,
      finalSubagent: null,
      taskList: true,
      listDelegation: true,
      selfLearning: true,
    },
  };
}

/**
 * Runs `body` with a real `app.library_records` row of id `recordId` — the graph and its vectors
 * reference it by a cascading key (KD-1, KD-8) — and afterwards, also when `body` fails, removes what the
 * deep agent left: the question rows of its runs' sessions and their run rows (they reference the sessions,
 * not the record), then the row itself, whose cascade takes the graph, the vectors and the vector row. A
 * system deep agent row, named by its id. `db` must outlive the harnesses: close them inside `body`, so no
 * worker writes after the cleanup.
 */
export async function withLibraryRow<T>(
  db: Database,
  recordId: string,
  body: () => Promise<T>,
): Promise<T> {
  await db.insert(libraryRecords).values({
    id: recordId,
    kind: 'deep_agent',
    ownerId: null,
    name: `knowledge-test-${recordId}`,
    description: 'Self-learning test deep agent',
    content: {},
  });
  try {
    return await body();
  } finally {
    await db.execute(sql`
      WITH RECURSIVE tree AS (
        SELECT run_id AS task_id FROM app.agent_knowledge_runs WHERE record_id = ${recordId}
        UNION
        SELECT task.task_id FROM app.runtime_tasks task JOIN tree ON task.parent_id = tree.task_id)
      DELETE FROM app.agent_knowledge_questions WHERE task_id IN (SELECT task_id FROM tree)`);
    await db.delete(agentKnowledgeRuns).where(eq(agentKnowledgeRuns.recordId, recordId));
    await db.delete(libraryRecords).where(eq(libraryRecords.id, recordId));
  }
}

/**
 * Runs `body` with the knowledge size cap at `limitTokens` (`KNOWLEDGE_LIMIT_TOKENS_MIN` for a graph over the
 * limit) and puts the settings row back as it was afterwards, also when `body` fails.
 */
export async function withKnowledgeLimit<T>(
  db: Database,
  limitTokens: number,
  body: () => Promise<T>,
): Promise<T> {
  const [before] = await db.select().from(agentKnowledgeSettings);
  if (before === undefined) throw new Error('The knowledge settings row is missing');
  await db.update(agentKnowledgeSettings).set({ limitTokens });
  try {
    return await body();
  } finally {
    const { limitTokens: limit, lessonsEnabled, updatedAt } = before;
    await db
      .update(agentKnowledgeSettings)
      .set({ limitTokens: limit, lessonsEnabled, updatedAt });
  }
}

/** A vector of a seeded record, written into the store under the record's key: unit length, of `model`. */
export interface SeedVector {
  readonly model: string;
  readonly values: readonly number[];
}

/** Standing of a seeded record; the defaults are one confirmation, now, not outdated, no vector. */
interface SeedStanding {
  readonly confirmations?: number;
  /** Also its creation time. */
  readonly confirmedAt?: Date;
  readonly outdated?: boolean;
  readonly vector?: SeedVector;
}

/** A graph record to seed; a fact names its ends by the `ref` of seeded entities. */
export type SeedItem = SeedStanding &
  (
    | { readonly kind: 'entity'; readonly ref: string; readonly name: string; readonly description: string }
    | { readonly kind: 'fact'; readonly from: string; readonly to: string; readonly label: string }
    | {
        readonly kind: 'lesson';
        readonly server: string;
        readonly tool: string;
        readonly question: string;
        readonly hint: string;
        readonly outcome: string;
      }
    | {
        readonly kind: 'searched_nothing';
        readonly server: string;
        readonly tool: string;
        readonly question: string;
      }
  );

/** A seeded record: its table id and its store key (`e12`, `r7`). */
export interface SeededItem {
  readonly id: number;
  readonly key: string;
}

/**
 * Writes the records straight into the graph tables of `recordId` (entities first, so facts can name them),
 * as one earlier run added them, and the vectors of those that carry one into the store through the port.
 * Returns the seeded records in the order of `items`. The row of {@link withLibraryRow} removes them.
 */
export async function seedGraph(
  db: Database,
  recordId: string,
  items: readonly SeedItem[],
): Promise<SeededItem[]> {
  const runId = randomUUID();
  const standing = (item: SeedStanding) => ({
    recordId,
    confirmations: item.confirmations ?? 1,
    outdated: item.outdated ?? false,
    sourceRunId: runId,
    confirmedByRunId: runId,
    ...(item.confirmedAt === undefined ? {} : { createdAt: item.confirmedAt, confirmedAt: item.confirmedAt }),
  });
  const seeded = new Map<SeedItem, SeededItem>();
  const entityIds = new Map<string, number>();
  for (const item of items) {
    if (item.kind !== 'entity') continue;
    const [row] = await db
      .insert(agentKnowledgeEntities)
      .values({ ...standing(item), name: item.name, description: item.description })
      .returning({ id: agentKnowledgeEntities.id });
    if (row === undefined) throw new Error(`Entity ${item.ref} was not seeded`);
    entityIds.set(item.ref, row.id);
    seeded.set(item, { id: row.id, key: `e${row.id}` });
  }
  const entityId = (ref: string): number => {
    const id = entityIds.get(ref);
    if (id === undefined) throw new Error(`No seeded entity ${ref}`);
    return id;
  };
  for (const item of items) {
    if (item.kind === 'entity') continue;
    const shape =
      item.kind === 'fact'
        ? { kind: item.kind, fromEntityId: entityId(item.from), toEntityId: entityId(item.to), label: item.label }
        : item.kind === 'lesson'
          ? {
              kind: item.kind,
              server: item.server,
              tool: item.tool,
              question: item.question,
              hint: item.hint,
              outcome: item.outcome,
            }
          : { kind: item.kind, server: item.server, tool: item.tool, question: item.question };
    const [row] = await db
      .insert(agentKnowledgeRelations)
      .values({ ...standing(item), ...shape })
      .returning({ id: agentKnowledgeRelations.id });
    if (row === undefined) throw new Error(`Relation ${item.kind} was not seeded`);
    seeded.set(item, { id: row.id, key: `r${row.id}` });
  }
  const result: SeededItem[] = [];
  const vectors: KnowledgeVector[] = [];
  for (const item of items) {
    const done = seeded.get(item);
    if (done === undefined) throw new Error('A seeded item has no row');
    result.push(done);
    if (item.vector === undefined) continue;
    const kind = item.kind === 'entity' ? 'entity' : 'relation';
    vectors.push({ key: done.key, kind, model: item.vector.model, vector: item.vector.values });
  }
  if (vectors.length > 0) await createPgvectorStore(db).upsert(recordId, vectors);
  return result;
}

/**
 * The vector of a text by its topic, for `ScriptedEmbeddings.vectorOf`: the vector of the first marker the text
 * contains, else `otherwise`. A record's text holds its name or tool and question, a question its task or message,
 * so a marker word puts a record and a question close or far.
 */
export function vectorsByTopic(
  topics: readonly (readonly [marker: string, vector: readonly number[]])[],
  otherwise: readonly number[],
): (text: string) => readonly number[] {
  return (text) => topics.find(([marker]) => text.includes(marker))?.[1] ?? otherwise;
}

/**
 * Waits until the run's extraction is idle — no task in flight, no round asked for — with a round outcome
 * written after `after` (any outcome when `null`: the first round, or the `stopped` the trigger writes), and
 * returns the run row: `lastStatus`, `lastReason`, counts, `lastModel`, `extractedUpTo`, `lastExtractTaskId`.
 */
export function waitForRound(db: Database, runId: string, after: Date | null = null): Promise<KnowledgeRun> {
  return waitFor(
    () => findRunById(db, runId),
    (run) =>
      run !== undefined &&
      run.extractTaskId === null &&
      !run.needsRound &&
      run.lastAt !== null &&
      (after === null || run.lastAt > after),
    `the extraction of run ${runId} to finish a round after ${after?.toISOString() ?? 'its start'}`,
  ) as Promise<KnowledgeRun>;
}

/**
 * Waits until the `knowledge.embed` pass of the deep agent that started after `after` (the round's `lastAt`, or a
 * time taken before a delete) has ended — no pass in flight, none asked for, an outcome written after `after` —
 * and returns the vector row: `lastReason` (`null` — vectors written), `lastModel`.
 */
export function waitForEmbedPass(
  db: Database,
  recordId: string,
  after: Date,
): Promise<KnowledgeEmbeddingRow> {
  return waitFor(
    () => findEmbeddingRow(db, recordId),
    (row) =>
      row !== undefined &&
      row.passTaskId === null &&
      !row.needsPass &&
      row.lastAt !== null &&
      row.lastAt > after,
    `the embedding pass of deep agent ${recordId} after ${after.toISOString()}`,
  ) as Promise<KnowledgeEmbeddingRow>;
}

/** A `knowledge.extract` or `knowledge.embed` task as the runtime keeps it. */
export interface KnowledgeTask {
  readonly taskId: string;
  readonly type: string;
  readonly ownerId: string;
  readonly status: string;
  readonly createdAt: Date;
}

/**
 * The knowledge tasks of a run (`{ runId }`: its `knowledge.extract` tasks) or of a deep agent (`{ recordId }`: its
 * `knowledge.embed` passes), in order of creation.
 */
export async function knowledgeTasksOf(
  db: Database,
  of: { readonly runId: string } | { readonly recordId: string },
): Promise<KnowledgeTask[]> {
  const type = 'runId' in of ? KNOWLEDGE_EXTRACT_TASK_TYPE : KNOWLEDGE_EMBED_TASK_TYPE;
  return db
    .select({
      taskId: runtimeTasks.taskId,
      type: runtimeTasks.type,
      ownerId: runtimeTasks.ownerId,
      status: runtimeTasks.status,
      createdAt: runtimeTasks.createdAt,
    })
    .from(runtimeTasks)
    .where(
      and(eq(runtimeTasks.type, type), sql`${runtimeTasks.input} @> ${JSON.stringify(of)}::jsonb`),
    )
    .orderBy(asc(runtimeTasks.createdSeq));
}

/** The author's view of the graph (`Agents.knowledge.view`), the flag on and the subagents' servers given. */
export function knowledgeView(
  harness: AgentsHarness,
  recordId: string,
  servers: readonly string[],
): Promise<KnowledgeView> {
  return harness.agents.knowledge.view({ recordId, selfLearning: true, servers });
}
