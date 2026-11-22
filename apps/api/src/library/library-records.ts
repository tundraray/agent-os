import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { LogFields, Logger } from '@agent-os/common';
import type { RecordAuthor, RecordBody, RecordDetail } from '@agent-os/contracts';
import type { Database, DatabaseConnection, Executor, Transaction } from '@agent-os/db';
import { AccessService } from '../access/access.service';
import { AuditLog } from '../audit/audit-log.repository';
import { isUuid } from '../common/is-uuid';
import { IdentityDirectory, type UserName } from '../identity/identity-directory';
import { APP_LOGGER } from '../logging/app-logger';
import { RUNTIME_DATABASE } from '../runtime/runtime.tokens';
import { libraryError } from './library.errors';
import {
  deleteRecord,
  findBan,
  findPanelRecords,
  findVisibleRecords,
  listBans,
  type PanelQuery,
  type RecordKey,
  type StoredBan,
  type StoredRecord,
  type Viewer,
} from './library.repository';
import type {
  BannedRecordRow,
  LibraryRecord,
  ServerFacts,
} from './library.types';
import { auditSample, recordDetail, type ViewContext } from './record-view';

type ViewScope = ViewContext['scope'];

type LibraryAuditKind =
  | 'library_create'
  | 'library_update'
  | 'library_audience'
  | 'library_copy'
  | 'library_delete'
  | 'library_close'
  | 'library_unban';

export const AUDIT_OBJECT_TYPE = 'library_record';

export function notFound(): HttpException {
  return libraryError('RECORD_NOT_FOUND');
}

export function readOnly(): HttpException {
  return libraryError('RECORD_READ_ONLY');
}

/** Whether the content names other records: the agents an agent may start. */
export function refersToRecords(body: RecordBody): boolean {
  return body.kind === 'agent' && body.content.agents.length > 0;
}

/** The record just read inside its own transaction; missing means the code is wrong, not the request. */
export function present(
  record: LibraryRecord | undefined,
  id: string,
): LibraryRecord {
  if (record === undefined)
    throw new Error(`library record ${id} is missing in its own transaction`);
  return record;
}

export function recordFields(record: {
  id: string;
  kind: string;
  version: number;
}): LogFields {
  return { recordId: record.id, kind: record.kind, version: record.version };
}

/** A role or an employee by id, with the place of its name in the database's order of names. */
interface Placed<T> {
  readonly row: T;
  readonly place: number;
}

/** Rows that came in the database's order of names, by id; equal names share a place. */
function placedById<T extends { id: string; name: string }>(
  rows: readonly T[],
): Map<string, Placed<T>> {
  const result = new Map<string, Placed<T>>();
  let place = 0;
  let previous: string | undefined;
  for (const row of rows) {
    if (row.name !== previous) place += 1;
    previous = row.name;
    result.set(row.id, { row, place });
  }
  return result;
}

/** The holders named, by name, then the id of the holder row — the order `ids` came in; a missing one is left out. */
function namedHolders(
  ids: readonly string[],
  names: ReadonlyMap<string, Placed<{ id: string; name: string }>>,
): { id: string; name: string }[] {
  return ids
    .flatMap((id) => names.get(id) ?? [])
    .sort((a, b) => a.place - b.place)
    .map(({ row }) => ({ id: row.id, name: row.name }));
}

function authorOf(user: UserName): RecordAuthor {
  return { id: user.id, name: user.name, disabled: !user.active };
}

/**
 * What the library's services share: the reads of records — the repository's two conditions
 * (ADR-0016) with authors and holders named through `IdentityDirectory` on the same executor — who
 * looks, the delete, the audit event and the one log record of an operation.
 */
@Injectable()
export class LibraryRecords {
  readonly db: Database;

  constructor(
    @Inject(RUNTIME_DATABASE) database: DatabaseConnection,
    private readonly identity: IdentityDirectory,
    private readonly access: AccessService,
    private readonly auditLog: AuditLog,
    @Inject(APP_LOGGER) private readonly logger: Logger,
  ) {
    this.db = database.db;
  }

  // ---------- Reads ----------

  /** The records the viewer sees, or the one with this id or built-in key when it is visible (KD-2). */
  async visible(
    executor: Executor,
    viewer: Viewer,
    key?: RecordKey,
  ): Promise<LibraryRecord[]> {
    return this.named(executor, await findVisibleRecords(executor, viewer, key));
  }

  /** The records of the admin panel: all of them, one list, or one by id when the panel shows it. */
  async panel(executor: Executor, query?: PanelQuery): Promise<LibraryRecord[]> {
    return this.named(executor, await findPanelRecords(executor, query));
  }

  /** The panel's ban list. */
  async bans(executor: Executor): Promise<BannedRecordRow[]> {
    return this.namedBans(executor, await listBans(executor));
  }

  /** The ban of one record; `undefined` — the record has none (or is gone). */
  async ban(
    executor: Executor,
    id: string,
  ): Promise<BannedRecordRow | undefined> {
    const stored = await findBan(executor, id);
    const [ban] = await this.namedBans(executor, stored ? [stored] : []);
    return ban;
  }

  /** Who looks: enabled or not and his roles now, read at every operation (KD-2). */
  async viewerOf(id: string): Promise<Viewer> {
    const [active, roleIds] = await Promise.all([
      this.identity.isActive(id),
      this.identity.rolesOf(id),
    ]);
    return { id, active, roleIds };
  }

  async contextOf(
    viewer: Viewer,
    isAdmin: boolean,
    scope: ViewScope,
    facts: ServerFacts,
  ): Promise<ViewContext> {
    return {
      viewerId: viewer.id,
      isAdmin,
      roleIds: viewer.roleIds,
      scope,
      usableServers: facts.usableServers,
      allowedModels: await this.allowedModelIds(viewer.id),
    };
  }

  async detail(
    record: LibraryRecord,
    viewer: Viewer,
    isAdmin: boolean,
    scope: ViewScope,
    facts: ServerFacts,
  ): Promise<RecordDetail> {
    return recordDetail(record, await this.contextOf(viewer, isAdmin, scope, facts));
  }

  /** Ids of the agent records the viewer sees; read only when the content names records. */
  async visibleAgentIds(
    executor: Executor,
    viewer: Viewer,
    needed: boolean,
  ): Promise<string[]> {
    if (!needed) return [];
    const records = await findVisibleRecords(executor, viewer);
    return records.filter((record) => record.body.kind === 'agent').map((record) => record.id);
  }

  async visibleOne(
    executor: Executor,
    viewer: Viewer,
    id: string,
  ): Promise<LibraryRecord | undefined> {
    const [record] = await this.visible(executor, viewer, { id });
    return record;
  }

  async panelOne(
    executor: Executor,
    id: string,
  ): Promise<LibraryRecord | undefined> {
    const [record] = await this.panel(executor, { id });
    return record;
  }

  /** A number that is not a UUID is answered without the database (DC-2). */
  async visibleOr404(
    executor: Executor,
    viewer: Viewer,
    id: string,
  ): Promise<LibraryRecord> {
    const record = isUuid(id)
      ? await this.visibleOne(executor, viewer, id)
      : undefined;
    if (record === undefined) throw notFound();
    return record;
  }

  async panelOr404(
    executor: Executor,
    id: string,
  ): Promise<LibraryRecord> {
    const record = isUuid(id) ? await this.panelOne(executor, id) : undefined;
    if (record === undefined) throw notFound();
    return record;
  }

  async allowedModelIds(ownerId: string): Promise<string[]> {
    return (await this.access.allowedModels(ownerId)).map((model) => model.id);
  }

  /** Chat models of the catalogue: a record's model is a chat model, never an embedding one. */
  async catalogueModelIds(): Promise<string[]> {
    return (await this.access.listModels())
      .filter((model) => model.purpose === 'chat')
      .map((model) => model.id);
  }

  /** The records with their authors and holders by name; the order of the records stays. */
  private async named(
    executor: Executor,
    stored: readonly StoredRecord[],
  ): Promise<LibraryRecord[]> {
    const [roles, users] = await Promise.all([
      this.identity.roleNames(
        executor,
        stored.flatMap((record) => record.holders.roleIds),
      ),
      this.identity.userNames(
        executor,
        stored.flatMap((record) => [
          ...record.holders.userIds,
          ...(record.ownerId === null ? [] : [record.ownerId]),
        ]),
      ),
    ]);
    const roleById = placedById(roles);
    const userById = placedById(users);
    return stored.map((record) => {
      const { ownerId } = record;
      const owner = ownerId === null ? null : userById.get(ownerId);
      if (owner === undefined)
        throw new Error(`library_records owner ${ownerId} is missing`);
      return {
        ...record,
        author: owner && authorOf(owner.row),
        holders: {
          everyone: record.holders.everyone,
          roles: namedHolders(record.holders.roleIds, roleById),
          users: namedHolders(record.holders.userIds, userById),
        },
      };
    });
  }

  /** The bans with their authors; a ban whose record has no author among the employees is left out. */
  private async namedBans(
    executor: Executor,
    stored: readonly StoredBan[],
  ): Promise<BannedRecordRow[]> {
    const users = await this.identity.userNames(
      executor,
      stored.flatMap((ban) => ban.ownerId ?? []),
    );
    const userById = new Map(users.map((user) => [user.id, user]));
    return stored.flatMap(({ ownerId, ...ban }) => {
      const owner = ownerId === null ? undefined : userById.get(ownerId);
      return owner === undefined ? [] : [{ ...ban, author: authorOf(owner) }];
    });
  }

  // ---------- Writes ----------

  /** Deletes the record unless it is built-in (AC-12.2); its holders go by cascade. */
  async deleteChecked(
    tx: Transaction,
    actorId: string,
    record: LibraryRecord,
  ): Promise<void> {
    if (record.builtinKey !== null)
      throw libraryError('RECORD_REJECTED', 'builtin');
    await deleteRecord(tx, record.id);
    await this.audit(tx, actorId, 'library_delete', record, null);
  }

  /** One event per action, in the action's transaction, with the KD-7 sample only. */
  audit(
    tx: Transaction,
    actorId: string,
    kind: LibraryAuditKind,
    before: LibraryRecord | null,
    after: LibraryRecord | null,
    copiedFrom?: string,
  ): Promise<void> {
    const subject = after ?? before;
    if (subject === null) throw new Error(`${kind} audit without a record`);
    return this.auditLog.record(tx, {
      kind,
      actor: actorId,
      objectType: AUDIT_OBJECT_TYPE,
      objectId: subject.id,
      before: before && auditSample(before),
      after: after && auditSample(after, copiedFrom),
      outcome: 'ok',
    });
  }

  // ---------- Log ----------

  /**
   * Runs one operation and logs it once: who, which record, its kind and version, the outcome or the
   * refusal's code and reason, the duration. Never a prompt, a description or content.
   */
  async logged<T>(
    operation: string,
    fields: LogFields,
    action: () => Promise<T>,
    outcomeFields: (result: T) => LogFields = () => ({}),
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await action();
      this.logger.info('library operation', {
        operation,
        ...fields,
        outcome: 'ok',
        ...outcomeFields(result),
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      if (error instanceof HttpException) {
        const answer = error.getResponse();
        const { errorCode, reason } =
          typeof answer === 'object'
            ? (answer as { errorCode?: unknown; reason?: unknown })
            : {};
        this.logger.info('library operation refused', {
          operation,
          ...fields,
          outcome: 'refused',
          errorCode,
          reason,
          durationMs: Date.now() - startedAt,
        });
      } else {
        this.logger.error('library operation failed', {
          operation,
          ...fields,
          outcome: 'failed',
          error,
          durationMs: Date.now() - startedAt,
        });
      }
      throw error;
    }
  }
}
