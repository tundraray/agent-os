import { and, desc, eq, or, sql } from 'drizzle-orm';
import type { Db } from '../db';
import { memories } from '../schema';

/** A row of `memories`. */
export type MemoryRow = typeof memories.$inferSelect;

/** The owner of a record: an agent (agent scope) or an employee (employee scope). */
export type MemoryOwner = { agentId: string } | { userId: string };

function ownedBy(owner: MemoryOwner) {
  return 'agentId' in owner
    ? eq(memories.agentId, owner.agentId)
    : eq(memories.userId, owner.userId);
}

function recordOf(owner: MemoryOwner, description: string) {
  return and(ownedBy(owner), eq(memories.description, description));
}

const newestFirst = [desc(memories.updatedAt), memories.id];

/** Drizzle queries of `memories` (self-learning design-memory.md KD-1): a record is keyed by owner and description. */
export class MemoriesRepository {
  constructor(private readonly db: Db) {}

  /**
   * Descriptions visible to a run — the agent's and the employee's, the agent's only without an employee —
   * most recently changed first, stable order.
   */
  index(
    visible: { agentId: string; userId: string | null },
    limit: number,
  ): Promise<Pick<MemoryRow, 'agentId' | 'userId' | 'description'>[]> {
    return this.db.client
      .select({
        agentId: memories.agentId,
        userId: memories.userId,
        description: memories.description,
      })
      .from(memories)
      .where(
        or(
          eq(memories.agentId, visible.agentId),
          visible.userId === null
            ? undefined
            : eq(memories.userId, visible.userId),
        ),
      )
      .orderBy(...newestFirst)
      .limit(limit);
  }

  /** Creates the record or replaces the text of the one with the same description; true when created. */
  async remember(
    owner: MemoryOwner,
    description: string,
    text: string,
  ): Promise<boolean> {
    const [row] = await this.db.client
      .insert(memories)
      .values({ ...owner, description, text })
      .onConflictDoUpdate({
        target:
          'agentId' in owner
            ? [memories.agentId, memories.description]
            : [memories.userId, memories.description],
        set: { text, updatedAt: sql`now()` },
      })
      .returning({ created: sql<boolean>`(xmax = 0)` });
    return row!.created;
  }

  async read(
    owner: MemoryOwner,
    description: string,
  ): Promise<MemoryRow | undefined> {
    const [row] = await this.db.client
      .select()
      .from(memories)
      .where(recordOf(owner, description));
    return row;
  }

  /** Removes the record; false when there was none. */
  async forget(owner: MemoryOwner, description: string): Promise<boolean> {
    const rows = await this.db.client
      .delete(memories)
      .where(recordOf(owner, description))
      .returning({ id: memories.id });
    return rows.length > 0;
  }

  /** The owner's records, most recently changed first. */
  list(owner: MemoryOwner): Promise<MemoryRow[]> {
    return this.db.client
      .select()
      .from(memories)
      .where(ownedBy(owner))
      .orderBy(...newestFirst);
  }

  /** Removes the record only when it belongs to the owner. */
  async deleteById(owner: MemoryOwner, id: string): Promise<void> {
    await this.db.client
      .delete(memories)
      .where(and(ownedBy(owner), eq(memories.id, id)));
  }
}
