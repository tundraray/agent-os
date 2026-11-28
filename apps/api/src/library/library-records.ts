import { HttpException, Inject, Injectable } from '@nestjs/common';
import { LOGGER, type LogFields, type Logger } from '@agent-os/common';
import type {
  ConnectedSkill,
  RecordAuthor,
  RecordBody,
  RecordDetail,
} from '@agent-os/contracts';
import {
  type AgentPanelQuery,
  type AgentRecordRow,
  AgentsRepository,
  type LibraryViewer,
} from '@agent-os/db';
import { AccessService } from '../access/access.service';
import { AuditLog } from '../audit/audit-log';
import { isUuid } from '../common/is-uuid';
import {
  IdentityDirectory,
  type UserName,
} from '../identity/identity-directory';
import { libraryError } from './library.errors';
import type {
  BannedRecordRow,
  LibraryRecord,
  ServerFacts,
} from './library.types';
import { contentSkills } from './record-content';
import { auditSample, recordDetail, type ViewContext } from './record-view';
import { decideDelete } from './save-rules';
import {
  toStoredBan,
  toStoredRecords,
  type StoredBan,
  type StoredRecord,
} from './stored-records';

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

/** Whether the content names other records: the agents an agent may start, the skills of its list. */
export function refersToRecords(body: RecordBody): boolean {
  return (
    (body.kind === 'agent' && body.content.agents.length > 0) ||
    contentSkills(body).length > 0
  );
}

/** Ids of the records the viewer sees that a content may name, by kind. */
export interface VisibleRecordIds {
  readonly agentIds: readonly string[];
  readonly skillIds: readonly string[];
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

function idsOfKind(
  rows: readonly AgentRecordRow[],
  kind: RecordBody['kind'],
): string[] {
  return rows.filter((row) => row.kind === kind).map((row) => row.id);
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
 * (ADR-0016) with authors and holders named through `IdentityDirectory` — who
 * looks, the delete, the audit event and the one log record of an operation.
 */
@Injectable()
export class LibraryRecords {
  constructor(
    private readonly repository: AgentsRepository,
    private readonly identity: IdentityDirectory,
    private readonly access: AccessService,
    private readonly auditLog: AuditLog,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  // ---------- Reads ----------

  /** The records the viewer sees, or the one with this id when it is visible (KD-2). */
  async visible(viewer: LibraryViewer, id?: string): Promise<LibraryRecord[]> {
    return this.named(
      await this.stored(await this.repository.findVisible(viewer, id)),
    );
  }

  /** The undeleted records with these ids, without a visibility check: the skills of a version's list (agent-guidance KD-6). */
  async notDeleted(ids: readonly string[]): Promise<LibraryRecord[]> {
    return this.named(
      await this.stored(await this.repository.findNotDeleted(ids)),
    );
  }

  /** The default agent with this key, without a visibility check (data-model design-agents.md, «Порт `RecordLibrary`»). */
  async builtin(builtinKey: string): Promise<LibraryRecord | undefined> {
    const row = await this.repository.findBuiltin(builtinKey);
    const [record] = await this.named(await this.stored(row ? [row] : []));
    return record;
  }

  /** The records of the admin panel: all of them, one list, or one by id when the panel shows it. */
  async panel(query?: AgentPanelQuery): Promise<LibraryRecord[]> {
    return this.named(
      await this.stored(await this.repository.findInPanel(query)),
    );
  }

  /** The panel's ban list. */
  async bans(): Promise<BannedRecordRow[]> {
    const rows = await this.repository.listBans();
    return this.namedBans(rows.map(toStoredBan));
  }

  /** The ban of one record; `undefined` — the record has none (or is gone). */
  async ban(id: string): Promise<BannedRecordRow | undefined> {
    const row = await this.repository.findBan(id);
    const [ban] = await this.namedBans(row ? [toStoredBan(row)] : []);
    return ban;
  }

  /** Who looks: enabled or not and his roles now, read at every operation (KD-2). */
  async viewerOf(id: string): Promise<LibraryViewer> {
    // One after another: inside a caller's transaction (a schedule's chip) every read shares one client.
    const active = await this.identity.isActive(id);
    const roleIds = await this.identity.rolesOf(id);
    return { id, active, roleIds };
  }

  async contextOf(
    viewer: LibraryViewer,
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
    viewer: LibraryViewer,
    isAdmin: boolean,
    scope: ViewScope,
    facts: ServerFacts,
  ): Promise<RecordDetail> {
    return recordDetail(
      record,
      await this.contextOf(viewer, isAdmin, scope, facts),
      await this.connectedSkills(record.body),
    );
  }

  /**
   * The undeleted skills of an agent's list, in its order, whoever views the record; no text (agent-guidance
   * AC-06.7).
   */
  private async connectedSkills(body: RecordBody): Promise<ConnectedSkill[]> {
    const ids = contentSkills(body);
    const rows = await this.repository.findNotDeleted(ids);
    return ids.flatMap((id) => {
      const row = rows.find(
        (candidate) => candidate.id === id && candidate.kind === 'skill',
      );
      return row === undefined
        ? []
        : [{ id: row.id, name: row.name, description: row.description }];
    });
  }

  /** Ids of the agents and the skills the viewer sees; read only when the content names records. */
  async visibleRecordIds(
    viewer: LibraryViewer,
    needed: boolean,
  ): Promise<VisibleRecordIds> {
    if (!needed) return { agentIds: [], skillIds: [] };
    const rows = await this.repository.findVisible(viewer);
    return {
      agentIds: idsOfKind(rows, 'agent'),
      skillIds: idsOfKind(rows, 'skill'),
    };
  }

  /** Ids of the system skills of the panel: the skills a system record may hold (agent-guidance DC-4). */
  async systemSkillIds(needed: boolean): Promise<string[]> {
    if (!needed) return [];
    return idsOfKind(
      await this.repository.findInPanel({ list: 'system' }),
      'skill',
    );
  }

  async visibleOne(
    viewer: LibraryViewer,
    id: string,
  ): Promise<LibraryRecord | undefined> {
    const [record] = await this.visible(viewer, id);
    return record;
  }

  async panelOne(id: string): Promise<LibraryRecord | undefined> {
    const [record] = await this.panel({ id });
    return record;
  }

  /** A number that is not a UUID is answered without the database (DC-2). */
  async visibleOr404(
    viewer: LibraryViewer,
    id: string,
  ): Promise<LibraryRecord> {
    const record = isUuid(id) ? await this.visibleOne(viewer, id) : undefined;
    if (record === undefined) throw notFound();
    return record;
  }

  async panelOr404(id: string): Promise<LibraryRecord> {
    const record = isUuid(id) ? await this.panelOne(id) : undefined;
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

  /** The record rows with their holders; the order of the records stays. */
  private async stored(
    rows: readonly AgentRecordRow[],
  ): Promise<StoredRecord[]> {
    const shares = await this.repository.sharesOf(
      rows.map((record) => record.id),
    );
    return toStoredRecords(rows, shares);
  }

  /** The records with their authors and holders by name; the order of the records stays. */
  private async named(
    stored: readonly StoredRecord[],
  ): Promise<LibraryRecord[]> {
    // One after another, as `viewerOf`: a schedule's chip resolves its record inside the trigger's transaction.
    const roles = await this.identity.roleNames(
      stored.flatMap((record) => record.holders.roleIds),
    );
    const users = await this.identity.userNames(
      stored.flatMap((record) => [
        ...record.holders.userIds,
        ...(record.ownerId === null ? [] : [record.ownerId]),
      ]),
    );
    const roleById = placedById(roles);
    const userById = placedById(users);
    return stored.map((record) => {
      const { ownerId } = record;
      const owner = ownerId === null ? null : userById.get(ownerId);
      if (owner === undefined)
        throw new Error(`agents owner ${ownerId} is missing`);
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
    stored: readonly StoredBan[],
  ): Promise<BannedRecordRow[]> {
    const users = await this.identity.userNames(
      stored.flatMap((ban) => ban.ownerId ?? []),
    );
    const userById = new Map(users.map((user) => [user.id, user]));
    return stored.flatMap(({ ownerId, ...ban }) => {
      const owner = ownerId === null ? undefined : userById.get(ownerId);
      return owner === undefined ? [] : [{ ...ban, author: authorOf(owner) }];
    });
  }

  // ---------- Writes ----------

  /**
   * Marks the record deleted unless it is a default agent (AC-12.2; data-model design-agents.md, KD-7):
   * its versions stay for the conversations that run on them.
   */
  async deleteChecked(actorId: string, record: LibraryRecord): Promise<void> {
    const decision = decideDelete(record);
    if (decision.kind === 'refused')
      throw libraryError('RECORD_REJECTED', decision.reason);
    await this.repository.markDeleted(record.id);
    await this.audit(actorId, 'library_delete', record, null);
  }

  /** One event per action, in the action's transaction, with the KD-7 sample only. */
  audit(
    actorId: string,
    kind: LibraryAuditKind,
    before: LibraryRecord | null,
    after: LibraryRecord | null,
    copiedFrom?: string,
  ): Promise<void> {
    const subject = after ?? before;
    if (subject === null) throw new Error(`${kind} audit without a record`);
    return this.auditLog.record({
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
