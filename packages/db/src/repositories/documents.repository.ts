import {
  CHAT_TASK_TYPE,
  HistoryEntryKindSchema,
  HistoryEventSchema,
} from '@agent-os/contracts';
import { and, asc, desc, eq, gt, inArray, isNull, ne, sql } from 'drizzle-orm';
import { alias, type PgSelect } from 'drizzle-orm/pg-core';
import type { Db } from '../db';
import {
  agents,
  agentVersions,
  conversations,
  documents,
  messages,
  runtimeTasks,
} from '../schema';

/** A row of `documents`. */
export type DocumentRow = typeof documents.$inferSelect;

/** A document in a list: the conversation that last wrote it is named by its `name`. */
const summary = {
  id: documents.id,
  conversationId: documents.conversationId,
  title: documents.title,
  description: documents.description,
  report: documents.report,
  writer: conversations.name,
  chars: sql<number>`char_length(${documents.text})`,
  updatedAt: documents.updatedAt,
};

const newestFirst = [desc(documents.updatedAt), desc(documents.id)];

const runConversation = alias(conversations, 'run_conversation');
const runVersion = alias(agentVersions, 'run_version');
const parentTask = alias(runtimeTasks, 'parent_task');

/**
 * Drizzle queries of `documents` (self-learning design-notepad.md KD-1, KD-4, KD-6): the notepad of a run is
 * the documents of its conversation. Tools write them in the step's commit.
 */
export class DocumentsRepository {
  constructor(private readonly db: Db) {}

  async create(
    row: Pick<
      typeof documents.$inferInsert,
      | 'conversationId'
      | 'title'
      | 'description'
      | 'text'
      | 'report'
      | 'updatedBy'
    >,
  ): Promise<DocumentRow> {
    const [created] = await this.db.client
      .insert(documents)
      .values(row)
      .returning();
    return created!;
  }

  async findInRun(runId: string, id: number): Promise<DocumentRow | undefined> {
    const [row] = await this.db.client
      .select()
      .from(documents)
      .where(and(eq(documents.conversationId, runId), eq(documents.id, id)));
    return row;
  }

  /**
   * Writes the text only when the document is unchanged since `readUpdatedAt` was read (invariant 3);
   * false when it changed.
   */
  async updateText(
    id: number,
    readUpdatedAt: Date,
    text: string,
    updatedBy: string,
  ): Promise<boolean> {
    const rows = await this.db.client
      .update(documents)
      .set({ text, updatedBy, updatedAt: sql`now()` })
      .where(and(eq(documents.id, id), eq(documents.updatedAt, readUpdatedAt)))
      .returning({ id: documents.id });
    return rows.length > 0;
  }

  /** The run's notepad in the order of creation. */
  listRun(runId: string) {
    return this.db.client
      .select(summary)
      .from(documents)
      .innerJoin(conversations, eq(conversations.id, documents.updatedBy))
      .where(eq(documents.conversationId, runId))
      .orderBy(asc(documents.id));
  }

  /**
   * The newest report document of the run written after its last `continued` event, or after its start
   * when it was never continued (KD-4).
   */
  async latestReport(
    runId: string,
  ): Promise<Pick<DocumentRow, 'id' | 'title'> | undefined> {
    const lastContinued = sql`(select max(${messages.createdAt}) from ${messages} where ${messages.conversationId} = ${runId} and ${messages.kind} = ${HistoryEntryKindSchema.enum.event} and ${messages.content} ->> 'event' = ${HistoryEventSchema.enum.continued})`;
    const [row] = await this.db.client
      .select({ id: documents.id, title: documents.title })
      .from(documents)
      .where(
        and(
          eq(documents.conversationId, runId),
          eq(documents.report, true),
          gt(documents.updatedAt, sql`coalesce(${lastContinued}, '-infinity')`),
        ),
      )
      .orderBy(...newestFirst)
      .limit(1);
    return row;
  }

  /** Past documents of the run's agent for its employee, most recently changed first (KD-6). */
  past(run: { runId: string; ownerId: string }, limit: number) {
    return this.db.client
      .select({
        id: documents.id,
        title: documents.title,
        description: documents.description,
        updatedAt: documents.updatedAt,
      })
      .from(documents)
      .where(inArray(documents.conversationId, this.pastRuns(run)))
      .orderBy(...newestFirst)
      .limit(limit);
  }

  /** A past document by its number, under the same rule as `past`. */
  async findPast(
    run: { runId: string; ownerId: string },
    id: number,
  ): Promise<DocumentRow | undefined> {
    const [row] = await this.db.client
      .select()
      .from(documents)
      .where(
        and(
          inArray(documents.conversationId, this.pastRuns(run)),
          eq(documents.id, id),
        ),
      );
    return row;
  }

  /** Documents of every run in the tree, most recently changed first, with the run's task status. */
  listInTree(rootId: string) {
    return this.inTree(
      this.db.client
        .select({ ...summary, status: runtimeTasks.status })
        .from(documents)
        .$dynamic(),
    )
      .where(eq(runtimeTasks.rootId, rootId))
      .orderBy(...newestFirst);
  }

  async findInTree(rootId: string, id: number) {
    const [row] = await this.inTree(
      this.db.client
        .select({
          ...summary,
          status: runtimeTasks.status,
          text: documents.text,
        })
        .from(documents)
        .$dynamic(),
    ).where(and(eq(runtimeTasks.rootId, rootId), eq(documents.id, id)));
    return row;
  }

  /** Joins documents with their writer's conversation and their run's task. */
  private inTree<Query extends PgSelect>(query: Query) {
    return query
      .innerJoin(conversations, eq(conversations.id, documents.updatedBy))
      .innerJoin(
        runtimeTasks,
        eq(runtimeTasks.taskId, documents.conversationId),
      );
  }

  /**
   * Conversations whose documents are past for the run (KD-6): same employee, a version of the same agent,
   * an agent without a built-in key, a tree not deleted, a run started from a chat, not the current run.
   */
  private pastRuns({ runId, ownerId }: { runId: string; ownerId: string }) {
    const runAgent = this.db.client
      .select({ agentId: runVersion.agentId })
      .from(runConversation)
      .innerJoin(runVersion, eq(runVersion.id, runConversation.agentVersionId))
      .where(eq(runConversation.id, runId));
    return this.db.client
      .select({ id: conversations.id })
      .from(conversations)
      .innerJoin(
        agentVersions,
        eq(agentVersions.id, conversations.agentVersionId),
      )
      .innerJoin(agents, eq(agents.id, agentVersions.agentId))
      .innerJoin(runtimeTasks, eq(runtimeTasks.taskId, conversations.id))
      .innerJoin(parentTask, eq(parentTask.taskId, runtimeTasks.parentId))
      .where(
        and(
          eq(conversations.ownerId, ownerId),
          inArray(agentVersions.agentId, runAgent),
          isNull(agents.builtinKey),
          isNull(runtimeTasks.deletedAt),
          eq(parentTask.type, CHAT_TASK_TYPE),
          ne(conversations.id, runId),
        ),
      );
  }
}
