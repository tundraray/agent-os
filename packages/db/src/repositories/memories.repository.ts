import { MemoryVersionKindSchema } from '@agent-os/contracts';
import {
  and,
  desc,
  eq,
  isNotNull,
  isNull,
  ne,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';
import type { Db } from '../db';
import { identityUsers, memories, memoryVersions } from '../schema';

/** A row of `memories`. */
export type MemoryRow = typeof memories.$inferSelect;

/** A row of `memory_versions`. */
export type MemoryVersionRow = typeof memoryVersions.$inferSelect;

/** A row of `memory_versions` to insert. */
export type NewMemoryVersionRow = typeof memoryVersions.$inferInsert;

/** The owner of a record: an agent (agent scope) or an employee (employee scope). */
export type MemoryOwner = { agentId: string } | { userId: string };

/** A record with its current version. */
export interface CurrentMemoryRow {
  readonly id: string;
  readonly description: string;
  readonly version: number;
  readonly kind: string;
  readonly text: string | null;
}

/** A record of the memory screens: its current version's kind and time, and the text of its last version with text. */
export interface ListedMemoryRow {
  readonly id: string;
  readonly description: string;
  readonly kind: string;
  readonly changedAt: Date;
  readonly lastText: string;
}

/** A version of the history, with its author's name and email (both null for the agent's versions). */
export interface MemoryHistoryRow {
  readonly version: number;
  readonly kind: string;
  readonly text: string | null;
  readonly changedAt: Date;
  readonly authorName: string | null;
  readonly authorEmail: string | null;
}

function ownedBy(owner: MemoryOwner) {
  return 'agentId' in owner
    ? eq(memories.agentId, owner.agentId)
    : eq(memories.userId, owner.userId);
}

/** Joins a record to its current version. */
const currentVersionOf = and(
  eq(memoryVersions.memoryId, memories.id),
  eq(memoryVersions.version, memories.currentVersion),
);

const live = ne(memoryVersions.kind, MemoryVersionKindSchema.enum.deleted);

const newestFirst = [desc(memoryVersions.changedAt), memories.id];

const CURRENT_COLUMNS = {
  id: memories.id,
  description: memories.description,
  version: memoryVersions.version,
  kind: memoryVersions.kind,
  text: memoryVersions.text,
};

/**
 * Drizzle queries of `memories` and `memory_versions` (memory-hygiene KD-1): a record is keyed by owner and
 * description, its texts live in immutable versions, the record points to the current one. The version rule
 * (which number comes next, when the pointer moves) is the service's (`MemoryRecords`).
 */
export class MemoriesRepository {
  constructor(private readonly db: Db) {}

  /**
   * Descriptions of the live records visible to a run — the agent's and the employee's, the agent's only without
   * an employee — most recently changed first, stable order.
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
      .innerJoin(memoryVersions, currentVersionOf)
      .where(
        and(
          or(
            eq(memories.agentId, visible.agentId),
            visible.userId === null
              ? undefined
              : eq(memories.userId, visible.userId),
          ),
          live,
        ),
      )
      .orderBy(...newestFirst)
      .limit(limit);
  }

  /** The owner's record of this description with its current version. */
  async current(
    owner: MemoryOwner,
    description: string,
  ): Promise<CurrentMemoryRow | undefined> {
    const [row] = await this.db.client
      .select(CURRENT_COLUMNS)
      .from(memories)
      .innerJoin(memoryVersions, currentVersionOf)
      .where(and(ownedBy(owner), eq(memories.description, description)));
    return row;
  }

  /** The owner's record of this id with its current version. */
  async currentById(
    owner: MemoryOwner,
    id: string,
  ): Promise<CurrentMemoryRow | undefined> {
    const [row] = await this.db.client
      .select(CURRENT_COLUMNS)
      .from(memories)
      .innerJoin(memoryVersions, currentVersionOf)
      .where(and(ownedBy(owner), eq(memories.id, id)));
    return row;
  }

  /** Inserts a record with an empty pointer; its id, or nothing when the owner already has this description. */
  async insertRecord(
    owner: MemoryOwner,
    description: string,
  ): Promise<string | undefined> {
    const [row] = await this.db.client
      .insert(memories)
      .values({ ...owner, description })
      .onConflictDoNothing({
        target:
          'agentId' in owner
            ? [memories.agentId, memories.description]
            : [memories.userId, memories.description],
      })
      .returning({ id: memories.id });
    return row?.id;
  }

  /** Inserts a version; false when the record already has this number. */
  async insertVersion(version: NewMemoryVersionRow): Promise<boolean> {
    const rows = await this.db.client
      .insert(memoryVersions)
      .values(version)
      .onConflictDoNothing({
        target: [memoryVersions.memoryId, memoryVersions.version],
      })
      .returning({ version: memoryVersions.version });
    return rows.length > 0;
  }

  /** Moves the pointer to `next` only from `expected` (`null` — a new record); true when it moved. */
  async movePointer(change: {
    readonly id: string;
    readonly expected: number | null;
    readonly next: number;
  }): Promise<boolean> {
    const rows = await this.db.client
      .update(memories)
      .set({ currentVersion: change.next })
      .where(
        and(
          eq(memories.id, change.id),
          change.expected === null
            ? isNull(memories.currentVersion)
            : eq(memories.currentVersion, change.expected),
        ),
      )
      .returning({ id: memories.id });
    return rows.length > 0;
  }

  async version(
    memoryId: string,
    version: number,
  ): Promise<MemoryVersionRow | undefined> {
    const [row] = await this.db.client
      .select()
      .from(memoryVersions)
      .where(
        and(
          eq(memoryVersions.memoryId, memoryId),
          eq(memoryVersions.version, version),
        ),
      );
    return row;
  }

  /** The owner's records, deleted ones included, most recently changed first. */
  list(owner: MemoryOwner): Promise<ListedMemoryRow[]> {
    return this.listWhere(ownedBy(owner));
  }

  /** The owner's live records, most recently changed first. */
  listLive(owner: MemoryOwner): Promise<ListedMemoryRow[]> {
    return this.listWhere(and(ownedBy(owner), live));
  }

  private listWhere(where: SQL | undefined): Promise<ListedMemoryRow[]> {
    const lastWithText = this.db.client
      .select({ text: sql<string>`${memoryVersions.text}`.as('last_text') })
      .from(memoryVersions)
      .where(
        and(
          eq(memoryVersions.memoryId, memories.id),
          isNotNull(memoryVersions.text),
        ),
      )
      .orderBy(desc(memoryVersions.version))
      .limit(1)
      .as('last_with_text');
    return this.db.client
      .select({
        id: memories.id,
        description: memories.description,
        kind: memoryVersions.kind,
        changedAt: memoryVersions.changedAt,
        lastText: lastWithText.text,
      })
      .from(memories)
      .innerJoin(memoryVersions, currentVersionOf)
      .innerJoinLateral(lastWithText, sql`true`)
      .where(where)
      .orderBy(...newestFirst);
  }

  /** The record's versions, newest first, with their authors. */
  history(memoryId: string): Promise<MemoryHistoryRow[]> {
    return this.db.client
      .select({
        version: memoryVersions.version,
        kind: memoryVersions.kind,
        text: memoryVersions.text,
        changedAt: memoryVersions.changedAt,
        authorName: identityUsers.name,
        authorEmail: identityUsers.email,
      })
      .from(memoryVersions)
      .leftJoin(identityUsers, eq(identityUsers.id, memoryVersions.authorId))
      .where(eq(memoryVersions.memoryId, memoryId))
      .orderBy(desc(memoryVersions.version));
  }

  /** Removes the record with all its versions, only when it belongs to the owner. */
  async deleteById(owner: MemoryOwner, id: string): Promise<void> {
    await this.db.client
      .delete(memories)
      .where(and(ownedBy(owner), eq(memories.id, id)));
  }
}
