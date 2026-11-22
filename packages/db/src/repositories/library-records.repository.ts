import { CHAT_BUILTIN_KEY } from '@agent-os/contracts';
import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { Executor, Transaction } from '../database';
import { libraryRecords, libraryShares } from '../schema';

/** A row of `library_records`; `kind` and `content` are read by the api, which owns their shape. */
export type LibraryRecordRow = typeof libraryRecords.$inferSelect;

/** A holder row of a record's audience: exactly one of "everyone", a role and an employee is set. */
export type LibraryShareRow = Pick<
  typeof libraryShares.$inferSelect,
  'recordId' | 'everyone' | 'roleId' | 'userId'
>;

/** A record under a sharing ban: no description, no content (AC-09.4). */
export type LibraryBanRow = Pick<LibraryRecordRow, 'id' | 'kind' | 'name' | 'closedAt' | 'ownerId'>;

/** Who looks: the employee, whether they are enabled, and the roles they are in now. */
export interface LibraryViewer {
  readonly id: string;
  readonly active: boolean;
  readonly roleIds: readonly string[];
}

/** One record by id or by the key of a built-in record; none — every record the condition finds. */
export type LibraryRecordKey = { readonly id: string } | { readonly builtinKey: string };

/** One panel record by id, or a panel list: the system records or the shared employee records. */
export type LibraryPanelQuery = { readonly id: string } | { readonly list: 'system' | 'shared' };

export interface NewLibraryRecordRow {
  /** Chosen before the save when a card named it (deep-agents KD-3); absent — the database's. */
  readonly id?: string;
  /** `null` — a system record. */
  readonly ownerId: string | null;
  readonly name: string;
  readonly description: string;
  readonly offerInChat: boolean;
  readonly kind: string;
  readonly content: unknown;
}

export type LibraryInsertOutcome =
  | { readonly outcome: 'inserted'; readonly id: string }
  | { readonly outcome: 'name_taken' };

export interface NewBuiltinLibraryRecordRow extends Omit<NewLibraryRecordRow, 'ownerId'> {
  /** Set by the caller, so built-in records can name each other. */
  readonly id: string;
  readonly builtinKey: string;
  readonly everyone: boolean;
}

export interface LibraryContentChange {
  readonly id: string;
  /** The version the edit started from. */
  readonly version: number;
  readonly name: string;
  readonly description: string;
  /** The kind never changes; only the content is written. */
  readonly content: unknown;
}

/**
 * `stale` — no row in that version: the caller tells a conflict from a gone record. A `name_taken`
 * comes from the database, so a transaction it ran in is aborted and must be rolled back.
 */
export type LibraryUpdateOutcome =
  | { readonly outcome: 'updated'; readonly version: number }
  | { readonly outcome: 'stale' }
  | { readonly outcome: 'name_taken' };

/** The holders a record gets; an employee record holds only roles (the service keeps that). */
export interface LibraryHolderIds {
  readonly everyone: boolean;
  readonly roleIds: readonly string[];
  readonly userIds: readonly string[];
}

/** SQLSTATE unique_violation. */
const UNIQUE_VIOLATION = '23505';
const NAME_INDEXES = new Set(['library_records_owner_name_idx', 'library_records_system_name_idx']);

/** A unique violation of one of the two name indexes; any other unique violation stays an error. */
function isNameCollision(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    const { code, constraint } = current as { code?: unknown; constraint?: unknown };
    if (code === UNIQUE_VIOLATION && typeof constraint === 'string')
      return NAME_INDEXES.has(constraint);
  }
  return false;
}

// ---------- Conditions ----------

/** A holder row of the record being filtered that meets `holder`. */
function holderExists(executor: Executor, holder: SQL): SQL {
  return exists(
    executor
      .select({ one: sql`1` })
      .from(libraryShares)
      .where(and(eq(libraryShares.recordId, libraryRecords.id), holder)),
  );
}

/**
 * The visibility procedure as one condition, its questions in order: a disabled viewer sees nothing;
 * the `chat` record every enabled one; the owner their record; an employee record by one of its
 * roles the viewer is in; a system record by the viewer himself, his role, or "everyone" when he has
 * at least one role.
 */
function visibleTo(executor: Executor, viewer: LibraryViewer): SQL {
  if (!viewer.active) return sql`false`;
  const hasRoles = viewer.roleIds.length > 0;
  const viewerRole = hasRoles ? inArray(libraryShares.roleId, [...viewer.roleIds]) : sql`false`;
  const systemHolder =
    or(
      eq(libraryShares.userId, viewer.id),
      viewerRole,
      hasRoles ? eq(libraryShares.everyone, true) : undefined,
    ) ?? sql`false`;
  return (
    or(
      eq(libraryRecords.builtinKey, CHAT_BUILTIN_KEY),
      eq(libraryRecords.ownerId, viewer.id),
      and(isNotNull(libraryRecords.ownerId), holderExists(executor, viewerRole)),
      and(isNull(libraryRecords.ownerId), holderExists(executor, systemHolder)),
    ) ?? sql`false`
  );
}

/** The panel condition: system records, and employee records open to a role and not banned. */
function inPanel(executor: Executor): SQL {
  return (
    or(
      isNull(libraryRecords.ownerId),
      and(
        isNotNull(libraryRecords.ownerId),
        isNull(libraryRecords.closedAt),
        holderExists(executor, isNotNull(libraryShares.roleId)),
      ),
    ) ?? sql`false`
  );
}

function keyCondition(key: LibraryRecordKey | undefined): SQL | undefined {
  if (key === undefined) return undefined;
  return 'id' in key
    ? eq(libraryRecords.id, key.id)
    : eq(libraryRecords.builtinKey, key.builtinKey);
}

function panelQueryCondition(query: LibraryPanelQuery | undefined): SQL | undefined {
  if (query === undefined) return undefined;
  if ('id' in query) return eq(libraryRecords.id, query.id);
  return query.list === 'system' ? isNull(libraryRecords.ownerId) : isNotNull(libraryRecords.ownerId);
}

/**
 * Drizzle queries of `library_records` and `library_shares` (repository over a transaction): each
 * takes the caller's transaction or the plain client first. The only place that reads and writes the
 * library tables (ADR-0016). Records are read by exactly two methods: {@link findVisible} under the
 * visibility procedure (design-library.md, «Как решается видимость») and {@link findInPanel} under
 * the panel condition, which never finds a personal record (KD-2). The admin right takes no part in
 * either (DC-3). Authors and holders come by id: their names live in `identity`.
 */
@Injectable()
export class LibraryRecordsRepository {
  /**
   * The records the viewer sees, or the one with this id or built-in key when it is visible, by name
   * without regard to case, then id. Every read of the employee routes and of the agents' record
   * operations goes through here (KD-2).
   */
  findVisible(
    executor: Executor,
    viewer: LibraryViewer,
    key?: LibraryRecordKey,
  ): Promise<LibraryRecordRow[]> {
    return this.where(executor, and(visibleTo(executor, viewer), keyCondition(key)) ?? sql`false`);
  }

  /** The records of the admin panel, in the same order: all of them, one list, or one by id when the panel shows it. */
  findInPanel(executor: Executor, query?: LibraryPanelQuery): Promise<LibraryRecordRow[]> {
    return this.where(executor, and(inPanel(executor), panelQueryCondition(query)) ?? sql`false`);
  }

  /** The holder rows of the records, by the id of the holder row. */
  async sharesOf(executor: Executor, recordIds: readonly string[]): Promise<LibraryShareRow[]> {
    if (recordIds.length === 0) return [];
    return executor
      .select({
        recordId: libraryShares.recordId,
        everyone: libraryShares.everyone,
        roleId: libraryShares.roleId,
        userId: libraryShares.userId,
      })
      .from(libraryShares)
      .where(inArray(libraryShares.recordId, [...recordIds]))
      .orderBy(asc(libraryShares.id));
  }

  /** The panel's ban list, by name without regard to case, then id. */
  listBans(executor: Executor): Promise<LibraryBanRow[]> {
    return this.bansWhere(executor);
  }

  /** The ban of one record; `undefined` — the record has none (or is gone). */
  async findBan(executor: Executor, id: string): Promise<LibraryBanRow | undefined> {
    const [ban] = await this.bansWhere(executor, eq(libraryRecords.id, id));
    return ban;
  }

  /**
   * Names of the owner's records, or of the system records when `ownerId` is `null`, the record
   * `exceptId` left out — the input of the name rule (DC-8).
   */
  async names(executor: Executor, ownerId: string | null, exceptId?: string): Promise<string[]> {
    const rows = await executor
      .select({ id: libraryRecords.id, name: libraryRecords.name })
      .from(libraryRecords)
      .where(ownerId === null ? isNull(libraryRecords.ownerId) : eq(libraryRecords.ownerId, ownerId));
    return rows.filter((row) => row.id !== exceptId).map((row) => row.name);
  }

  /**
   * Locks the record row FOR UPDATE inside the caller's transaction, before an audience change, a
   * close or a ban lift reads its state; `false` when the record is gone.
   */
  async lock(tx: Transaction, id: string): Promise<boolean> {
    const [row] = await tx
      .select({ id: libraryRecords.id })
      .from(libraryRecords)
      .where(eq(libraryRecords.id, id))
      .for('update');
    return row !== undefined;
  }

  /**
   * Adds the record in version 1. A name taken under a name index answers `name_taken`, not an error;
   * it comes from the database, so a transaction it ran in is aborted and must be rolled back.
   */
  async insert(executor: Executor, record: NewLibraryRecordRow): Promise<LibraryInsertOutcome> {
    try {
      const [row] = await executor
        .insert(libraryRecords)
        .values({
          ...(record.id === undefined ? {} : { id: record.id }),
          ownerId: record.ownerId,
          name: record.name,
          description: record.description,
          offerInChat: record.offerInChat,
          kind: record.kind,
          content: record.content,
        })
        .returning({ id: libraryRecords.id });
      if (row === undefined) throw new Error('library_records insert returned no row');
      return { outcome: 'inserted', id: row.id };
    } catch (error) {
      if (isNameCollision(error)) return { outcome: 'name_taken' };
      throw error;
    }
  }

  /**
   * Adds the built-in system record with its "everyone" holder unless a record with this key exists;
   * `false` — it exists and is left as it is. Safe for two servers at once.
   */
  async insertBuiltin(executor: Executor, record: NewBuiltinLibraryRecordRow): Promise<boolean> {
    const [row] = await executor
      .insert(libraryRecords)
      .values({
        id: record.id,
        ownerId: null,
        builtinKey: record.builtinKey,
        name: record.name,
        description: record.description,
        offerInChat: record.offerInChat,
        kind: record.kind,
        content: record.content,
      })
      .onConflictDoNothing({ target: libraryRecords.builtinKey })
      .returning({ id: libraryRecords.id });
    if (row === undefined) return false;
    if (record.everyone)
      await executor.insert(libraryShares).values({ recordId: row.id, everyone: true });
    return true;
  }

  /** Saves name, description and content only while the record is in `version`, and raises it by one (KD-5). */
  async updateContent(
    executor: Executor,
    change: LibraryContentChange,
  ): Promise<LibraryUpdateOutcome> {
    try {
      const [row] = await executor
        .update(libraryRecords)
        .set({
          name: change.name,
          description: change.description,
          content: change.content,
          version: sql`${libraryRecords.version} + 1`,
          updatedAt: sql`now()`,
        })
        .where(and(eq(libraryRecords.id, change.id), eq(libraryRecords.version, change.version)))
        .returning({ version: libraryRecords.version });
      return row === undefined ? { outcome: 'stale' } : { outcome: 'updated', version: row.version };
    } catch (error) {
      if (isNameCollision(error)) return { outcome: 'name_taken' };
      throw error;
    }
  }

  /** Replaces the record's holders; the version stays (DC-11). */
  async replaceHolders(
    executor: Executor,
    recordId: string,
    holders: LibraryHolderIds,
  ): Promise<void> {
    await executor.delete(libraryShares).where(eq(libraryShares.recordId, recordId));
    const rows = [
      ...(holders.everyone ? [{ recordId, everyone: true }] : []),
      ...holders.roleIds.map((roleId) => ({ recordId, roleId })),
      ...holders.userIds.map((userId) => ({ recordId, userId })),
    ];
    if (rows.length > 0) await executor.insert(libraryShares).values(rows);
  }

  /** Sets «предлагать в главном чате»; the version stays (DC-11). */
  async setOfferInChat(executor: Executor, id: string, offerInChat: boolean): Promise<void> {
    await executor.update(libraryRecords).set({ offerInChat }).where(eq(libraryRecords.id, id));
  }

  /** Closes sharing (Flow 4): every holder removed and the ban date set, which it returns; the version stays. */
  async closeSharing(executor: Executor, id: string): Promise<Date> {
    await executor.delete(libraryShares).where(eq(libraryShares.recordId, id));
    const [row] = await executor
      .update(libraryRecords)
      .set({ closedAt: sql`now()` })
      .where(eq(libraryRecords.id, id))
      .returning({ closedAt: libraryRecords.closedAt });
    if (row === undefined || row.closedAt === null)
      throw new Error(`library record ${id} has no ban after its close`);
    return row.closedAt;
  }

  /** Lifts the sharing ban; `false` — the record has none (or is gone). The version stays. */
  async liftBan(executor: Executor, id: string): Promise<boolean> {
    const [row] = await executor
      .update(libraryRecords)
      .set({ closedAt: null })
      .where(and(eq(libraryRecords.id, id), isNotNull(libraryRecords.closedAt)))
      .returning({ id: libraryRecords.id });
    return row !== undefined;
  }

  /** Deletes the record; its holders go by cascade. */
  async delete(executor: Executor, id: string): Promise<void> {
    await executor.delete(libraryRecords).where(eq(libraryRecords.id, id));
  }

  /** Records meeting the condition, by name without regard to case, then id. */
  private where(executor: Executor, where: SQL): Promise<LibraryRecordRow[]> {
    return executor
      .select()
      .from(libraryRecords)
      .where(where)
      .orderBy(sql`lower(${libraryRecords.name})`, asc(libraryRecords.id));
  }

  /** Records under a sharing ban meeting the condition, by name, then id. */
  private bansWhere(executor: Executor, where?: SQL): Promise<LibraryBanRow[]> {
    return executor
      .select({
        id: libraryRecords.id,
        kind: libraryRecords.kind,
        name: libraryRecords.name,
        closedAt: libraryRecords.closedAt,
        ownerId: libraryRecords.ownerId,
      })
      .from(libraryRecords)
      .where(and(isNotNull(libraryRecords.closedAt), where))
      .orderBy(sql`lower(${libraryRecords.name})`, asc(libraryRecords.id));
  }
}
