import {
  AgentContentSchema,
  CHAT_BUILTIN_KEY,
  DeepAgentContentSchema,
  RecordKindSchema,
  type RecordBody,
} from '@agent-os/contracts';
import { type Executor, libraryRecords, libraryShares } from '@agent-os/db';
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

/**
 * Drizzle queries of `library_records` and `library_shares` (repository-over-transaction.md): each
 * takes the caller's transaction or the plain client first. The only place that reads and writes the
 * library tables (ADR-0016). Records are read by exactly two functions: {@link findVisibleRecords}
 * under the visibility procedure (design-library.md, «Как решается видимость») and
 * {@link findPanelRecords} under the panel condition, which never finds a personal record (KD-2).
 * The admin right takes no part in either (DC-3). Authors and holders come by id: their names live in
 * `identity` and are added by `LibraryRecords`.
 */

/** Who looks: the employee, whether they are enabled, and the roles they are in now. */
export interface Viewer {
  readonly id: string;
  readonly active: boolean;
  readonly roleIds: readonly string[];
}

/** The audience of a record as stored: "everyone", roles and employees, each in the order of its row's id. */
export interface StoredHolders {
  readonly everyone: boolean;
  readonly roleIds: readonly string[];
  readonly userIds: readonly string[];
}

/** A stored record with its audience. */
export interface StoredRecord {
  readonly id: string;
  /** `null` — a system record. */
  readonly ownerId: string | null;
  readonly name: string;
  readonly description: string;
  readonly offerInChat: boolean;
  readonly builtinKey: string | null;
  readonly version: number;
  /** When an admin closed sharing; `null` — not closed. */
  readonly closedAt: Date | null;
  readonly updatedAt: Date;
  readonly body: RecordBody;
  readonly holders: StoredHolders;
}

/** One record by id or by the key of a built-in record; none — every record the condition finds. */
export type RecordKey = { readonly id: string } | { readonly builtinKey: string };

/** One panel record by id, or a panel list: the system records or the shared employee records. */
export type PanelQuery =
  | { readonly id: string }
  | { readonly list: 'system' | 'shared' };

/** A stored record under a sharing ban: no description, no content (AC-09.4). */
export interface StoredBan {
  readonly id: string;
  readonly kind: RecordBody['kind'];
  readonly name: string;
  /** `null` — a system record. */
  readonly ownerId: string | null;
  readonly closedAt: Date;
}

const NO_HOLDERS: StoredHolders = { everyone: false, roleIds: [], userIds: [] };

/** SQLSTATE unique_violation. */
const UNIQUE_VIOLATION = '23505';
const NAME_INDEXES = new Set([
  'library_records_owner_name_idx',
  'library_records_system_name_idx',
]);

/** A unique violation of one of the two name indexes; any other unique violation stays an error. */
function isNameCollision(error: unknown): boolean {
  for (let current = error; current instanceof Error; current = current.cause) {
    const { code, constraint } = current as {
      code?: unknown;
      constraint?: unknown;
    };
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
function visibleTo(executor: Executor, viewer: Viewer): SQL {
  if (!viewer.active) return sql`false`;
  const hasRoles = viewer.roleIds.length > 0;
  const viewerRole = hasRoles
    ? inArray(libraryShares.roleId, [...viewer.roleIds])
    : sql`false`;
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
      and(
        isNotNull(libraryRecords.ownerId),
        holderExists(executor, viewerRole),
      ),
      and(
        isNull(libraryRecords.ownerId),
        holderExists(executor, systemHolder),
      ),
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

function keyCondition(key: RecordKey | undefined): SQL | undefined {
  if (key === undefined) return undefined;
  return 'id' in key
    ? eq(libraryRecords.id, key.id)
    : eq(libraryRecords.builtinKey, key.builtinKey);
}

function panelQueryCondition(query: PanelQuery | undefined): SQL | undefined {
  if (query === undefined) return undefined;
  if ('id' in query) return eq(libraryRecords.id, query.id);
  return query.list === 'system'
    ? isNull(libraryRecords.ownerId)
    : isNotNull(libraryRecords.ownerId);
}

// ---------- Reads ----------

/** The kind and the content of a stored row, checked by the kind's schema. */
function recordBody(kind: string, content: unknown): RecordBody {
  return RecordKindSchema.parse(kind) === 'agent'
    ? { kind: 'agent', content: AgentContentSchema.parse(content) }
    : { kind: 'deep_agent', content: DeepAgentContentSchema.parse(content) };
}

/** The holders of the records, by record id; roles and employees each by the id of the holder row. */
async function holdersOf(
  executor: Executor,
  recordIds: readonly string[],
): Promise<Map<string, StoredHolders>> {
  const result = new Map<string, StoredHolders>();
  if (recordIds.length === 0) return result;
  const rows = await executor
    .select({
      recordId: libraryShares.recordId,
      everyone: libraryShares.everyone,
      roleId: libraryShares.roleId,
      userId: libraryShares.userId,
    })
    .from(libraryShares)
    .where(inArray(libraryShares.recordId, [...recordIds]))
    .orderBy(asc(libraryShares.id));
  for (const row of rows) {
    const current = result.get(row.recordId) ?? NO_HOLDERS;
    result.set(row.recordId, {
      everyone: current.everyone || row.everyone,
      roleIds:
        row.roleId === null ? current.roleIds : [...current.roleIds, row.roleId],
      userIds:
        row.userId === null ? current.userIds : [...current.userIds, row.userId],
    });
  }
  return result;
}

/** Records meeting the condition, by name without regard to case, then id, with holders. */
async function recordsWhere(
  executor: Executor,
  where: SQL,
): Promise<StoredRecord[]> {
  const rows = await executor
    .select()
    .from(libraryRecords)
    .where(where)
    .orderBy(sql`lower(${libraryRecords.name})`, asc(libraryRecords.id));
  const holders = await holdersOf(
    executor,
    rows.map((record) => record.id),
  );
  return rows.map((record) => ({
    id: record.id,
    ownerId: record.ownerId,
    name: record.name,
    description: record.description,
    offerInChat: record.offerInChat,
    builtinKey: record.builtinKey,
    version: record.version,
    closedAt: record.closedAt,
    updatedAt: record.updatedAt,
    body: recordBody(record.kind, record.content),
    holders: holders.get(record.id) ?? NO_HOLDERS,
  }));
}

/**
 * The records the viewer sees, or the one with this id or built-in key when it is visible. Every read
 * of the employee routes and of the `runtime` operations goes through here (KD-2).
 */
export function findVisibleRecords(
  executor: Executor,
  viewer: Viewer,
  key?: RecordKey,
): Promise<StoredRecord[]> {
  return recordsWhere(
    executor,
    and(visibleTo(executor, viewer), keyCondition(key)) ?? sql`false`,
  );
}

/** The records of the admin panel: all of them, one list, or one by id when the panel shows it. */
export function findPanelRecords(
  executor: Executor,
  query?: PanelQuery,
): Promise<StoredRecord[]> {
  return recordsWhere(
    executor,
    and(inPanel(executor), panelQueryCondition(query)) ?? sql`false`,
  );
}

/** Records under a sharing ban meeting the condition, by name, then id: no description, no content. */
async function bansWhere(
  executor: Executor,
  where?: SQL,
): Promise<StoredBan[]> {
  const rows = await executor
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
  return rows.map((row) => {
    if (row.closedAt === null)
      throw new Error(`library_records ban row ${row.id} is broken`);
    return {
      id: row.id,
      kind: RecordKindSchema.parse(row.kind),
      name: row.name,
      ownerId: row.ownerId,
      closedAt: row.closedAt,
    };
  });
}

/** The panel's ban list. */
export function listBans(executor: Executor): Promise<StoredBan[]> {
  return bansWhere(executor);
}

/** The ban of one record; `undefined` — the record has none (or is gone). */
export async function findBan(
  executor: Executor,
  id: string,
): Promise<StoredBan | undefined> {
  const [ban] = await bansWhere(executor, eq(libraryRecords.id, id));
  return ban;
}

/**
 * Names of the owner's records, or of the system records when `ownerId` is `null`, the record
 * `exceptId` left out — the input of the name rule (DC-8).
 */
export async function recordNames(
  executor: Executor,
  ownerId: string | null,
  exceptId?: string,
): Promise<string[]> {
  const rows = await executor
    .select({ id: libraryRecords.id, name: libraryRecords.name })
    .from(libraryRecords)
    .where(
      ownerId === null
        ? isNull(libraryRecords.ownerId)
        : eq(libraryRecords.ownerId, ownerId),
    );
  return rows.filter((row) => row.id !== exceptId).map((row) => row.name);
}

/**
 * Locks the record row FOR UPDATE inside the caller's transaction, before an audience change, a
 * close or a ban lift reads its state; `false` when the record is gone.
 */
export async function lockRecord(
  executor: Executor,
  id: string,
): Promise<boolean> {
  const [row] = await executor
    .select({ id: libraryRecords.id })
    .from(libraryRecords)
    .where(eq(libraryRecords.id, id))
    .for('update');
  return row !== undefined;
}

// ---------- Writes ----------

export interface NewRecord {
  /** Chosen before the save when a card named it (deep-agents KD-3); absent — the database's. */
  readonly id?: string;
  /** `null` — a system record. */
  readonly ownerId: string | null;
  readonly name: string;
  readonly description: string;
  readonly offerInChat: boolean;
  readonly body: RecordBody;
}

export type InsertOutcome =
  | { readonly outcome: 'inserted'; readonly id: string }
  | { readonly outcome: 'name_taken' };

/**
 * Adds the record in version 1. A name taken under a name index answers `name_taken`, not an error;
 * it comes from the database, so a transaction it ran in is aborted and must be rolled back.
 */
export async function insertRecord(
  executor: Executor,
  record: NewRecord,
): Promise<InsertOutcome> {
  try {
    const [row] = await executor
      .insert(libraryRecords)
      .values({
        ...(record.id === undefined ? {} : { id: record.id }),
        ownerId: record.ownerId,
        name: record.name,
        description: record.description,
        offerInChat: record.offerInChat,
        kind: record.body.kind,
        content: record.body.content,
      })
      .returning({ id: libraryRecords.id });
    if (row === undefined)
      throw new Error('library_records insert returned no row');
    return { outcome: 'inserted', id: row.id };
  } catch (error) {
    if (isNameCollision(error)) return { outcome: 'name_taken' };
    throw error;
  }
}

export interface NewBuiltinRecord extends Omit<NewRecord, 'ownerId'> {
  /** Set by the caller, so built-in records can name each other. */
  readonly id: string;
  readonly builtinKey: string;
  readonly everyone: boolean;
}

/**
 * Adds the built-in system record with its "everyone" holder unless a record with this key exists;
 * `false` — it exists and is left as it is. Safe for two servers at once.
 */
export async function insertBuiltinRecord(
  executor: Executor,
  record: NewBuiltinRecord,
): Promise<boolean> {
  const [row] = await executor
    .insert(libraryRecords)
    .values({
      id: record.id,
      ownerId: null,
      builtinKey: record.builtinKey,
      name: record.name,
      description: record.description,
      offerInChat: record.offerInChat,
      kind: record.body.kind,
      content: record.body.content,
    })
    .onConflictDoNothing({ target: libraryRecords.builtinKey })
    .returning({ id: libraryRecords.id });
  if (row === undefined) return false;
  if (record.everyone)
    await executor
      .insert(libraryShares)
      .values({ recordId: row.id, everyone: true });
  return true;
}

export interface ContentChange {
  readonly id: string;
  /** The version the edit started from. */
  readonly version: number;
  readonly name: string;
  readonly description: string;
  /** The kind never changes; only the content is written. */
  readonly body: RecordBody;
}

/**
 * `stale` — no row in that version: the caller tells a conflict from a gone record. A `name_taken`
 * comes from the database, so a transaction it ran in is aborted and must be rolled back.
 */
export type UpdateOutcome =
  | { readonly outcome: 'updated'; readonly version: number }
  | { readonly outcome: 'stale' }
  | { readonly outcome: 'name_taken' };

/** Saves name, description and content only while the record is in `version`, and raises it by one (KD-5). */
export async function updateRecordContent(
  executor: Executor,
  change: ContentChange,
): Promise<UpdateOutcome> {
  try {
    const [row] = await executor
      .update(libraryRecords)
      .set({
        name: change.name,
        description: change.description,
        content: change.body.content,
        version: sql`${libraryRecords.version} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(libraryRecords.id, change.id),
          eq(libraryRecords.version, change.version),
        ),
      )
      .returning({ version: libraryRecords.version });
    return row === undefined
      ? { outcome: 'stale' }
      : { outcome: 'updated', version: row.version };
  } catch (error) {
    if (isNameCollision(error)) return { outcome: 'name_taken' };
    throw error;
  }
}

/** The holders a record gets; an employee record holds only roles (the service keeps that). */
export interface HolderIds {
  readonly everyone: boolean;
  readonly roleIds: readonly string[];
  readonly userIds: readonly string[];
}

/** Replaces the record's holders; the version stays (DC-11). */
export async function replaceHolders(
  executor: Executor,
  recordId: string,
  holders: HolderIds,
): Promise<void> {
  await executor
    .delete(libraryShares)
    .where(eq(libraryShares.recordId, recordId));
  const rows = [
    ...(holders.everyone ? [{ recordId, everyone: true }] : []),
    ...holders.roleIds.map((roleId) => ({ recordId, roleId })),
    ...holders.userIds.map((userId) => ({ recordId, userId })),
  ];
  if (rows.length > 0) await executor.insert(libraryShares).values(rows);
}

/** Sets «предлагать в главном чате»; the version stays (DC-11). */
export async function setOfferInChat(
  executor: Executor,
  id: string,
  offerInChat: boolean,
): Promise<void> {
  await executor
    .update(libraryRecords)
    .set({ offerInChat })
    .where(eq(libraryRecords.id, id));
}

/** Closes sharing (Flow 4): every holder removed and the ban date set, which it returns; the version stays. */
export async function closeSharing(
  executor: Executor,
  id: string,
): Promise<Date> {
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
export async function liftBan(executor: Executor, id: string): Promise<boolean> {
  const [row] = await executor
    .update(libraryRecords)
    .set({ closedAt: null })
    .where(and(eq(libraryRecords.id, id), isNotNull(libraryRecords.closedAt)))
    .returning({ id: libraryRecords.id });
  return row !== undefined;
}

/** Deletes the record; its holders go by cascade. */
export async function deleteRecord(
  executor: Executor,
  id: string,
): Promise<void> {
  await executor.delete(libraryRecords).where(eq(libraryRecords.id, id));
}
