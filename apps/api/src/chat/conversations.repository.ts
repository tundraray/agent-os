import { Inject, Injectable } from '@nestjs/common';
import { chatConversations, type DatabaseConnection, type Database } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import { RUNTIME_DATABASE } from '../runtime/runtime.tokens.js';
import type { ThreadCursor } from './thread-cursor.js';

/** A row of `chat_conversations`. */
export type Conversation = typeof chatConversations.$inferSelect;

/** A transaction of the caller or the plain client: both run the same queries. */
export type Executor = Database | RuntimeTx;

/**
 * Times are written truncated to milliseconds: the list cursor keeps `updatedAt` in ms, so the order
 * of the rows and the cursor's comparison read the same value.
 */
const NOW_MS = sql<Date>`date_trunc('milliseconds', now())`;

/** `ORDER BY updated_at DESC, id DESC` — the list order, the one of `chat_conversations_owner_page_idx`. */
const LIST_ORDER = [desc(chatConversations.updatedAt), desc(chatConversations.id)];

/**
 * Drizzle queries of `chat_conversations` (repository-over-transaction.md): the operations that are
 * part of a command take the service's transaction; the rest run on the application's pool. The only
 * table `apps/api` reads (ADR-0004). Another owner's row is exactly as absent as a missing one.
 */
@Injectable()
export class ConversationsRepository {
  private readonly db: Database;

  constructor(@Inject(RUNTIME_DATABASE) database: DatabaseConnection) {
    this.db = database.db;
  }

  /** Runs `work` in one transaction of the pool. */
  transaction<T>(work: (tx: RuntimeTx) => Promise<T>): Promise<T> {
    return this.db.transaction(work);
  }

  /** A new conversation of the owner: empty title, no root. */
  async create(ownerId: string): Promise<Conversation> {
    const [row] = await this.db
      .insert(chatConversations)
      .values({ ownerId, createdAt: NOW_MS, updatedAt: NOW_MS })
      .returning();
    if (row === undefined) throw new Error('chat_conversations insert returned no row');
    return row;
  }

  async get(id: string, ownerId: string): Promise<Conversation | undefined> {
    const [row] = await this.db
      .select()
      .from(chatConversations)
      .where(and(eq(chatConversations.id, id), eq(chatConversations.ownerId, ownerId)));
    return row;
  }

  /**
   * Up to `size + 1` rows of the owner strictly after `cursor` in the list order (from the start
   * without it): the extra row only tells the caller that a next page exists.
   */
  page(ownerId: string, cursor: ThreadCursor | undefined, size: number): Promise<Conversation[]> {
    const owned = eq(chatConversations.ownerId, ownerId);
    const where =
      cursor === undefined
        ? owned
        : and(
            owned,
            sql`(${chatConversations.updatedAt}, ${chatConversations.id}) < (${new Date(cursor.u).toISOString()}::timestamptz, ${cursor.i}::uuid)`,
          );
    return this.db
      .select()
      .from(chatConversations)
      .where(where)
      .orderBy(...LIST_ORDER)
      .limit(size + 1);
  }

  /** Locks the owner's row FOR UPDATE: the first send and the delete of one conversation take turns. */
  async lockForUpdate(tx: RuntimeTx, id: string, ownerId: string): Promise<Conversation | undefined> {
    const [row] = await tx
      .select()
      .from(chatConversations)
      .where(and(eq(chatConversations.id, id), eq(chatConversations.ownerId, ownerId)))
      .for('update');
    return row;
  }

  async setRoot(tx: RuntimeTx, id: string, rootId: string): Promise<void> {
    await tx.update(chatConversations).set({ rootId }).where(eq(chatConversations.id, id));
  }

  /** `updated_at = now()`: the conversation moves to the top of the list. */
  async touch(executor: Executor, id: string): Promise<void> {
    await executor
      .update(chatConversations)
      .set({ updatedAt: NOW_MS })
      .where(eq(chatConversations.id, id));
  }

  /** Sets the owner's title and moves the conversation up; `undefined` for a missing or foreign row. */
  async rename(id: string, ownerId: string, title: string): Promise<Conversation | undefined> {
    const [row] = await this.db
      .update(chatConversations)
      .set({ title, updatedAt: NOW_MS })
      .where(and(eq(chatConversations.id, id), eq(chatConversations.ownerId, ownerId)))
      .returning();
    return row;
  }

  /** Writes a generated title only into an empty one (Invariant 2); `true` when it was written. */
  async setTitleIfEmpty(id: string, title: string): Promise<boolean> {
    const rows = await this.db
      .update(chatConversations)
      .set({ title })
      .where(and(eq(chatConversations.id, id), eq(chatConversations.title, '')))
      .returning({ id: chatConversations.id });
    return rows.length > 0;
  }

  async delete(tx: RuntimeTx, id: string): Promise<void> {
    await tx.delete(chatConversations).where(eq(chatConversations.id, id));
  }

  /** The conversation of a root agent, whoever owns it; the caller checks the owner. */
  async findByRoot(rootId: string): Promise<Conversation | undefined> {
    const [row] = await this.db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.rootId, rootId));
    return row;
  }

  /** The owner's conversations that have a root, in the list order. */
  listWithRoot(ownerId: string): Promise<Conversation[]> {
    return this.db
      .select()
      .from(chatConversations)
      .where(and(eq(chatConversations.ownerId, ownerId), isNotNull(chatConversations.rootId)))
      .orderBy(...LIST_ORDER);
  }
}
