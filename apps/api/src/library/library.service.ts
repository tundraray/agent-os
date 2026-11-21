import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { LogFields, Logger } from '@agent-os/common';
import type { z } from 'zod';
import {
  CreateRecordBodySchema,
  type BannedRecord,
  type CopyResult,
  type CreateRecordBody,
  type LibraryChoices,
  type RecordAudienceBody,
  type RecordBody,
  type RecordDetail,
  type RecordHeader,
  type RecordSummary,
  type ResolvedRecord,
  type SaveOwnRefusalSchema,
  type SystemRecordAudienceBody,
  type UpdateRecordBody,
} from '@agent-os/contracts';
import type { Database, DatabaseConnection } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { AccessService } from '../access/access.service';
import { AuditLog, SYSTEM_ACTOR } from '../audit/audit-log';
import type { Executor } from '../common/executor';
import { isUuid } from '../common/is-uuid';
import { IdentityDirectory } from '../identity/identity-directory';
import { APP_LOGGER } from '../logging/app-logger';
import { RUNTIME_DATABASE } from '../runtime/runtime.tokens';
import {
  decideEmployeeAudience,
  decideSystemAudience,
} from './audience-rules';
import { planCopy, replaceModel } from './copy-rules';
import { readLibrarySettings } from './library-settings.repository';
import { kindChangedError, libraryError } from './library.errors';
import {
  closeSharing,
  deleteRecord,
  findBan,
  findPanelRecords,
  findVisibleRecords,
  insertBuiltinRecord,
  insertRecord,
  liftBan,
  listBans,
  lockRecord,
  recordNames,
  replaceHolders,
  setOfferInChat,
  updateRecordContent,
  type LibraryRecord,
  type RecordKey,
  type Viewer,
} from './library.repository';
import {
  auditSample,
  banAuditSample,
  bannedRecord,
  hasHolders,
  recordDetail,
  recordHeader,
  recordSummary,
  resolvedRecord,
  type ViewContext,
  type VisibleVersions,
} from './record-view';
import { decideSave, type SaveChoices, type SaveInput } from './save-rules';

/** The employee of a route: the id from the session and the admin right (`req.user`). */
export interface LibraryActor {
  readonly id: string;
  readonly isAdmin: boolean;
}

/** Facts only `Agents` has, given by the caller (KD-4, port-module-split.md): servers usable to the actor. */
export interface ServerFacts {
  readonly usableServers: readonly string[];
}

/** An admin on a system record chooses from the whole MCP registry. */
export interface PanelServerFacts extends ServerFacts {
  readonly registryServers: readonly string[];
}

/** Input of `seedBuiltin`: the caller sets the id, so built-in records can name each other. */
export interface BuiltinRecordInput {
  readonly id: string;
  readonly builtinKey: string;
  readonly name: string;
  readonly description: string;
  readonly everyone: boolean;
  readonly body: RecordBody;
}

/** Input of `saveOwn`: the record edited and the version the edit started from, or `null` for a new one. */
export interface OwnRecordInput {
  readonly target: { readonly id: string; readonly version: number } | null;
  readonly kind: string;
  readonly name: string;
  readonly description: string;
  readonly content: unknown;
}

/** A workflow whose knowledge graph is open to the actor: what the knowledge routes need. */
export interface KnowledgeTarget {
  readonly recordId: string;
  /** The flag of the workflow's last version. */
  readonly selfLearning: boolean;
  /** The servers of the executors of the last version, without repeats (`*` as is). */
  readonly servers: readonly string[];
}

/** Why a save is refused; `saveOwn` answers it as is (design-library.md, «Для части `runtime`»). */
export type SaveRefusal = z.infer<typeof SaveOwnRefusalSchema>;

export type SaveOwnResult =
  | { readonly outcome: 'saved'; readonly record: RecordDetail }
  | { readonly outcome: 'refused'; readonly reason: SaveRefusal };

type SaveScope = 'employee' | 'system';
type ViewScope = ViewContext['scope'];

interface SaveRequest {
  readonly scope: SaveScope;
  readonly author: Viewer;
  readonly target: { readonly id: string; readonly version: number } | null;
  readonly body: CreateRecordBody;
  /** Servers usable to the author (employee) or the MCP registry (system). */
  readonly servers: readonly string[];
  /** `saveOwn`: a record with holders is not the caller's to change from the chat (AC-18.5). */
  readonly refuseShared: boolean;
}

type SaveResult =
  | { readonly outcome: 'saved'; readonly record: LibraryRecord }
  | { readonly outcome: 'refused'; readonly refusal: SaveRefusal };

/** Thrown inside a save transaction to roll it back; caught right outside it. */
class SaveRefused {
  constructor(readonly refusal: SaveRefusal) {}
}

type LibraryAuditKind =
  | 'library_create'
  | 'library_update'
  | 'library_audience'
  | 'library_copy'
  | 'library_delete'
  | 'library_close'
  | 'library_unban';

const AUDIT_OBJECT_TYPE = 'library_record';

/** An empty audience: after a close (Flow 4). */
const NO_HOLDERS: LibraryRecord['holders'] = {
  everyone: false,
  roles: [],
  users: [],
};

function notFound(): HttpException {
  return libraryError('RECORD_NOT_FOUND');
}

function readOnly(): HttpException {
  return libraryError('RECORD_READ_ONLY');
}

/** The HTTP answer of a refused save. `shared` is asked for only by `saveOwn`. */
function saveRefusalError(refusal: SaveRefusal): HttpException {
  switch (refusal) {
    case 'not_found':
      return notFound();
    case 'read_only':
      return readOnly();
    case 'version_conflict':
      return libraryError('RECORD_VERSION_CONFLICT');
    case 'name_taken':
      return libraryError('RECORD_NAME_TAKEN', 'own');
    case 'system_name':
      return libraryError('RECORD_NAME_TAKEN', 'system');
    case 'invalid':
      return kindChangedError();
    case 'shared':
      throw new Error('a route save asked for the saveOwn refusal "shared"');
    default:
      return libraryError('RECORD_REJECTED', refusal);
  }
}

/** Whether the content names other records: agents to start, or executor sources. */
function refersToRecords(body: RecordBody): boolean {
  return body.kind === 'agent'
    ? body.content.agents.length > 0
    : body.content.executors.some((executor) => executor.source !== null);
}

/** The record just read inside its own transaction; missing means the code is wrong, not the request. */
function present(record: LibraryRecord | undefined, id: string): LibraryRecord {
  if (record === undefined)
    throw new Error(`library record ${id} is missing in its own transaction`);
  return record;
}

function recordFields(record: {
  id: string;
  kind: string;
  version: number;
}): LogFields {
  return { recordId: record.id, kind: record.kind, version: record.version };
}

/**
 * The library (design-library.md, KD-1, KD-2, KD-4–KD-7): the employee's operations, the admin
 * panel's and the operations of the `runtime` part. Records are read only through the repository's
 * two conditions — visibility and the panel's (ADR-0016) — and an invisible record answers as a
 * missing one. A write and its audit event are one transaction; the facts of `Agents` come in as
 * input, so the module does not import `AgentsModule` (KD-6).
 */
@Injectable()
export class LibraryService {
  private readonly db: Database;

  constructor(
    @Inject(RUNTIME_DATABASE) database: DatabaseConnection,
    private readonly identity: IdentityDirectory,
    private readonly access: AccessService,
    private readonly auditLog: AuditLog,
    @Inject(APP_LOGGER) private readonly logger: Logger,
  ) {
    this.db = database.db;
  }

  // ---------- Employee ----------

  /** GET /api/library: the records the viewer sees, by name. */
  list(actor: LibraryActor, facts: ServerFacts): Promise<RecordSummary[]> {
    return this.logged(
      'list',
      { viewerId: actor.id },
      async () => {
        const viewer = await this.viewerOf(actor.id);
        const [records, context] = await Promise.all([
          findVisibleRecords(this.db, viewer),
          this.contextOf(viewer, actor.isAdmin, 'employee', facts),
        ]);
        return records.map((record) => recordSummary(record, context));
      },
      (records) => ({ count: records.length }),
    );
  }

  /** GET /api/library/:id. 404 RECORD_NOT_FOUND. */
  get(
    actor: LibraryActor,
    id: string,
    facts: ServerFacts,
  ): Promise<RecordDetail> {
    return this.logged(
      'get',
      { viewerId: actor.id, recordId: id },
      async () => {
        const viewer = await this.viewerOf(actor.id);
        const record = await this.visibleOr404(this.db, viewer, id);
        return this.detail(record, viewer, actor.isAdmin, 'employee', facts);
      },
      recordFields,
    );
  }

  /** POST /api/library: a personal record in version 1, offered in the chat, no ban (DC-1). */
  create(
    actor: LibraryActor,
    body: CreateRecordBody,
    facts: ServerFacts,
  ): Promise<RecordDetail> {
    return this.logged(
      'create',
      { actorId: actor.id, kind: body.kind },
      async () => {
        const author = await this.viewerOf(actor.id);
        const result = await this.save({
          scope: 'employee',
          author,
          target: null,
          body,
          servers: facts.usableServers,
          refuseShared: false,
        });
        return this.savedDetail(
          result,
          author,
          actor.isAdmin,
          'employee',
          facts,
        );
      },
      recordFields,
    );
  }

  /** PUT /api/library/:id. 404, 403 RECORD_READ_ONLY, 409, 422. */
  update(
    actor: LibraryActor,
    id: string,
    body: UpdateRecordBody,
    facts: ServerFacts,
  ): Promise<RecordDetail> {
    return this.logged(
      'update',
      { actorId: actor.id, recordId: id, fromVersion: body.version },
      async () => {
        const author = await this.viewerOf(actor.id);
        const result = await this.save({
          scope: 'employee',
          author,
          target: { id, version: body.version },
          body,
          servers: facts.usableServers,
          refuseShared: false,
        });
        return this.savedDetail(
          result,
          author,
          actor.isAdmin,
          'employee',
          facts,
        );
      },
      recordFields,
    );
  }

  /**
   * PUT /api/library/:id/audience (Flow 2): the row is locked first, then the ban, the owner's roles
   * and the holders are read, so a close running at the same time is seen (Invariant 2). The version
   * stays (DC-11).
   */
  setAudience(
    actor: LibraryActor,
    id: string,
    body: RecordAudienceBody,
    facts: ServerFacts,
  ): Promise<RecordDetail> {
    return this.logged(
      'audience',
      { actorId: actor.id, recordId: id, roleIds: body.roleIds },
      async () => {
        if (!isUuid(id)) throw notFound();
        const { record, viewer } = await this.db.transaction(async (tx) => {
          if (!(await lockRecord(tx, id))) throw notFound();
          const owner = await this.viewerOf(actor.id);
          const before = await this.visibleOr404(tx, owner, id);
          if (before.ownerId !== owner.id) throw readOnly();
          const decision = decideEmployeeAudience({
            currentRoleIds: before.holders.roles.map((role) => role.id),
            roleIds: body.roleIds,
            ownerRoleIds: owner.roleIds,
            banned: before.closedAt !== null,
          });
          if (decision.kind === 'refused')
            throw libraryError('RECORD_REJECTED', decision.reason);
          await replaceHolders(tx, id, {
            everyone: false,
            roleIds: body.roleIds,
            userIds: [],
          });
          await setOfferInChat(tx, id, body.offerInChat);
          const after = present(await this.visibleOne(tx, owner, id), id);
          await this.audit(tx, owner.id, 'library_audience', before, after);
          return { record: after, viewer: owner };
        });
        return this.detail(record, viewer, actor.isAdmin, 'employee', facts);
      },
      recordFields,
    );
  }

  /** POST /api/library/:id/copy (Flow 3): a personal copy for the viewer; the original stays. */
  copy(
    actor: LibraryActor,
    id: string,
    facts: ServerFacts,
  ): Promise<CopyResult> {
    return this.logged(
      'copy',
      { actorId: actor.id, recordId: id },
      async () => {
        const viewer = await this.viewerOf(actor.id);
        const source = await this.visibleOr404(this.db, viewer, id);
        const [allowedModels, defaultModel, visible, ownNames, systemNames] =
          await Promise.all([
            this.allowedModelIds(viewer.id),
            this.access.defaultChatModel(),
            this.visibleAgents(this.db, viewer, refersToRecords(source.body)),
            recordNames(this.db, viewer.id),
            recordNames(this.db, null),
          ]);
        const plan = planCopy({
          name: source.name,
          body: source.body,
          takenNames: [...ownNames, ...systemNames],
          usableServers: facts.usableServers,
          allowedModels,
          defaultModel,
          visibleAgentIds: [...visible.keys()],
        });
        const copied = await this.db.transaction(async (tx) => {
          const inserted = await insertRecord(tx, {
            ownerId: viewer.id,
            name: plan.name,
            description: source.description,
            offerInChat: true,
            body: plan.body,
          });
          if (inserted.outcome === 'name_taken')
            throw libraryError('RECORD_NAME_TAKEN', 'own');
          const record = present(
            await this.visibleOne(tx, viewer, inserted.id),
            inserted.id,
          );
          await this.audit(
            tx,
            viewer.id,
            'library_copy',
            null,
            record,
            source.id,
          );
          return record;
        });
        return {
          record: await this.detail(
            copied,
            viewer,
            actor.isAdmin,
            'employee',
            facts,
          ),
          removedServers: plan.removedServers,
          replacedModels: plan.replacedModels,
          removedAgents: plan.removedAgents,
        };
      },
      (result) => ({ ...recordFields(result.record), copiedFrom: id }),
    );
  }

  /** DELETE /api/library/:id: only the owner's own record. 404, 403 RECORD_READ_ONLY. */
  delete(actor: LibraryActor, id: string): Promise<void> {
    return this.logged(
      'delete',
      { actorId: actor.id, recordId: id },
      async () => {
        const viewer = await this.viewerOf(actor.id);
        await this.db.transaction(async (tx) => {
          const record = await this.visibleOr404(tx, viewer, id);
          if (record.ownerId !== viewer.id) throw readOnly();
          await this.deleteChecked(tx, actor.id, record);
        });
      },
    );
  }

  /**
   * GET /api/library/choices: the servers usable to the employee, the model of a new record — the
   * replacement of Flow 3 applied to the default chat model: itself when allowed, else the first
   * allowed, else itself; `null` while none is chosen (KD-5) — and «Максимум шагов» of a new record
   * from the library's settings.
   */
  choices(actor: LibraryActor, facts: ServerFacts): Promise<LibraryChoices> {
    return this.logged('choices', { viewerId: actor.id }, async () => {
      const [allowedModels, defaultModel, settings] = await Promise.all([
        this.allowedModelIds(actor.id),
        this.access.defaultChatModel(),
        readLibrarySettings(this.db),
      ]);
      return {
        servers: [...facts.usableServers].sort(),
        defaultModel:
          defaultModel === null
            ? null
            : replaceModel(defaultModel, { allowedModels, defaultModel }),
        defaultMaxTurns: settings.defaultMaxTurns,
      };
    });
  }

  /**
   * The access rule of /api/library/:id/knowledge (self-learning KD-7, auth-boundary.md): open to the
   * workflow's author and to an admin when the workflow is in the panel. Built on the two reads that
   * do not throw, so the panel is asked after a failed visibility: a workflow neither visible nor in
   * the admin's panel, missing, or an agent — 404 RECORD_NOT_FOUND; visible but not open — 403
   * KNOWLEDGE_FORBIDDEN. Writes nothing.
   */
  knowledgeTarget(
    actor: LibraryActor,
    recordId: string,
  ): Promise<KnowledgeTarget> {
    return this.logged(
      'knowledge_target',
      { viewerId: actor.id, recordId },
      async () => {
        if (!isUuid(recordId)) throw notFound();
        const viewer = await this.viewerOf(actor.id);
        const [visible, inPanel] = await Promise.all([
          this.visibleOne(this.db, viewer, recordId),
          actor.isAdmin ? this.panelOne(this.db, recordId) : undefined,
        ]);
        const record = visible ?? inPanel;
        if (record === undefined || record.body.kind !== 'workflow')
          throw notFound();
        if (record.ownerId !== viewer.id && inPanel === undefined)
          throw libraryError('KNOWLEDGE_FORBIDDEN');
        const { content } = record.body;
        return {
          recordId: record.id,
          selfLearning: content.selfLearning,
          servers: [
            ...new Set(
              content.executors.flatMap((executor) => executor.servers),
            ),
          ],
        };
      },
    );
  }

  // ---------- Admin panel ----------

  /** GET /api/admin/library/system and /shared: whole audience, the author's `disabled`. */
  panelList(
    actor: LibraryActor,
    list: 'system' | 'shared',
    facts: ServerFacts,
  ): Promise<RecordSummary[]> {
    return this.logged(
      'panel_list',
      { viewerId: actor.id, list },
      async () => {
        const viewer = await this.viewerOf(actor.id);
        const [records, context] = await Promise.all([
          findPanelRecords(this.db, { list }),
          this.contextOf(viewer, actor.isAdmin, 'panel', facts),
        ]);
        return records.map((record) => recordSummary(record, context));
      },
      (records) => ({ count: records.length }),
    );
  }

  /** GET /api/admin/library/bans: no description, no content. */
  bans(actor: LibraryActor): Promise<BannedRecord[]> {
    return this.logged(
      'bans',
      { viewerId: actor.id },
      async () => (await listBans(this.db)).map(bannedRecord),
      (rows) => ({ count: rows.length }),
    );
  }

  /** GET /api/admin/library/:id: a system record or a role-shared employee record; any other — 404. */
  panelGet(
    actor: LibraryActor,
    id: string,
    facts: ServerFacts,
  ): Promise<RecordDetail> {
    return this.logged(
      'panel_get',
      { viewerId: actor.id, recordId: id },
      async () => {
        const viewer = await this.viewerOf(actor.id);
        const record = await this.panelOr404(this.db, id);
        return this.detail(record, viewer, actor.isAdmin, 'panel', facts);
      },
      recordFields,
    );
  }

  /** POST /api/admin/library: a system record without holders — only admins see it. */
  createSystem(
    actor: LibraryActor,
    body: CreateRecordBody,
    facts: PanelServerFacts,
  ): Promise<RecordDetail> {
    return this.logged(
      'create_system',
      { actorId: actor.id, kind: body.kind },
      async () => {
        const author = await this.viewerOf(actor.id);
        const result = await this.save({
          scope: 'system',
          author,
          target: null,
          body,
          servers: facts.registryServers,
          refuseShared: false,
        });
        return this.savedDetail(result, author, actor.isAdmin, 'panel', facts);
      },
      recordFields,
    );
  }

  /** PUT /api/admin/library/:id: a role-shared employee record — 403 RECORD_READ_ONLY (FR-09). */
  updateSystem(
    actor: LibraryActor,
    id: string,
    body: UpdateRecordBody,
    facts: PanelServerFacts,
  ): Promise<RecordDetail> {
    return this.logged(
      'update_system',
      { actorId: actor.id, recordId: id, fromVersion: body.version },
      async () => {
        const author = await this.viewerOf(actor.id);
        const result = await this.save({
          scope: 'system',
          author,
          target: { id, version: body.version },
          body,
          servers: facts.registryServers,
          refuseShared: false,
        });
        return this.savedDetail(result, author, actor.isAdmin, 'panel', facts);
      },
      recordFields,
    );
  }

  /** PUT /api/admin/library/:id/audience: locked like the employee's; the version stays (DC-11). */
  setSystemAudience(
    actor: LibraryActor,
    id: string,
    body: SystemRecordAudienceBody,
    facts: ServerFacts,
  ): Promise<RecordDetail> {
    return this.logged(
      'system_audience',
      {
        actorId: actor.id,
        recordId: id,
        everyone: body.everyone,
        roleIds: body.roleIds,
        userIds: body.userIds,
      },
      async () => {
        if (!isUuid(id)) throw notFound();
        const record = await this.db.transaction(async (tx) => {
          if (!(await lockRecord(tx, id))) throw notFound();
          const before = await this.panelOr404(tx, id);
          if (before.ownerId !== null) throw readOnly();
          const existing = await this.identity.existing(body);
          const decision = decideSystemAudience({
            builtinKey: before.builtinKey,
            roleIds: body.roleIds,
            userIds: body.userIds,
            existingRoleIds: existing.roleIds,
            existingUserIds: existing.userIds,
          });
          if (decision.kind === 'refused')
            throw libraryError('RECORD_REJECTED', decision.reason);
          await replaceHolders(tx, id, body);
          await setOfferInChat(tx, id, body.offerInChat);
          const after = present(await this.panelOne(tx, id), id);
          await this.audit(tx, actor.id, 'library_audience', before, after);
          return after;
        });
        const viewer = await this.viewerOf(actor.id);
        return this.detail(record, viewer, actor.isAdmin, 'panel', facts);
      },
      recordFields,
    );
  }

  /** DELETE /api/admin/library/:id: a built-in record — 422 `builtin`. */
  deleteSystem(actor: LibraryActor, id: string): Promise<void> {
    return this.logged(
      'delete_system',
      { actorId: actor.id, recordId: id },
      () =>
        this.db.transaction(async (tx) => {
          const record = await this.panelOr404(tx, id);
          if (record.ownerId !== null) throw readOnly();
          await this.deleteChecked(tx, actor.id, record);
        }),
    );
  }

  /**
   * POST /api/admin/library/:id/close (Flow 4): every holder removed and the ban set. Only an
   * employee record the panel lists; any other — 404. Locked like the owner's audience change.
   */
  close(actor: LibraryActor, id: string): Promise<void> {
    return this.logged(
      'close',
      { actorId: actor.id, recordId: id },
      async () => {
        if (!isUuid(id)) throw notFound();
        await this.db.transaction(async (tx) => {
          if (!(await lockRecord(tx, id))) throw notFound();
          const before = await this.panelOr404(tx, id);
          if (before.ownerId === null) throw notFound();
          const closedAt = await closeSharing(tx, id);
          const after = { ...before, holders: NO_HOLDERS, closedAt };
          await this.audit(tx, actor.id, 'library_close', before, after);
        });
      },
    );
  }

  /** DELETE /api/admin/library/:id/ban: no ban — 404. The version stays (DC-11). */
  unban(actor: LibraryActor, id: string): Promise<void> {
    return this.logged(
      'unban',
      { actorId: actor.id, recordId: id },
      async () => {
        if (!isUuid(id)) throw notFound();
        await this.db.transaction(async (tx) => {
          if (!(await lockRecord(tx, id))) throw notFound();
          const ban = await findBan(tx, id);
          if (ban === undefined || !(await liftBan(tx, id))) throw notFound();
          await this.auditLog.record(tx, {
            kind: 'library_unban',
            actor: actor.id,
            objectType: AUDIT_OBJECT_TYPE,
            objectId: id,
            before: banAuditSample(ban, ban.closedAt),
            after: banAuditSample(ban, null),
            outcome: 'ok',
          });
        });
      },
    );
  }

  // ---------- For the runtime part ----------

  /** The record to start, as the viewer sees it; `null` for an invisible, deleted or missing one. */
  resolve(viewerId: string, recordId: string): Promise<ResolvedRecord | null> {
    return this.resolveBy('resolve', viewerId, { id: recordId });
  }

  /** The same by the key of a built-in record. */
  resolveBuiltin(
    viewerId: string,
    builtinKey: string,
  ): Promise<ResolvedRecord | null> {
    return this.resolveBy('resolve_builtin', viewerId, { builtinKey });
  }

  /** Every record the viewer sees, without content: the list of the main chat. */
  listVisible(viewerId: string): Promise<RecordHeader[]> {
    return this.logged(
      'list_visible',
      { viewerId },
      async () => {
        const viewer = await this.viewerOf(viewerId);
        const records = await findVisibleRecords(this.db, viewer);
        return records.map((record) => recordHeader(record, viewerId));
      },
      (headers) => ({ count: headers.length }),
    );
  }

  /**
   * Adds a built-in system record unless one with its key exists; an existing one is left as the admin
   * made it. `library_create` from `system`. `false` — it existed (another server seeded it first).
   */
  seedBuiltin(input: BuiltinRecordInput): Promise<boolean> {
    return this.logged(
      'seed_builtin',
      {
        actorId: SYSTEM_ACTOR,
        recordId: input.id,
        builtinKey: input.builtinKey,
      },
      () =>
        this.db.transaction(async (tx) => {
          const inserted = await insertBuiltinRecord(tx, {
            ...input,
            offerInChat: true,
          });
          if (!inserted) return false;
          const record = present(await this.panelOne(tx, input.id), input.id);
          await this.audit(tx, SYSTEM_ACTOR, 'library_create', null, record);
          return true;
        }),
      (created) => ({ created }),
    );
  }

  /**
   * Creates or edits the caller's personal record for the chat's creation tool (`runtime` FR-18) by
   * the path of POST and PUT /api/library, and refuses a record with holders (`shared`, AC-18.5).
   * `executor` is the caller's transaction when the save must commit with the caller's own writes
   * (the draft's resolution); the record and its audit event are then written in a savepoint of it.
   */
  saveOwn(
    ownerId: string,
    input: OwnRecordInput,
    usableServers: readonly string[],
    executor: Executor = this.db,
  ): Promise<SaveOwnResult> {
    return this.logged(
      'save_own',
      { actorId: ownerId, recordId: input.target?.id ?? null },
      async (): Promise<SaveOwnResult> => {
        const parsed = CreateRecordBodySchema.safeParse({
          kind: input.kind,
          name: input.name,
          description: input.description,
          content: input.content,
        });
        if (!parsed.success) return { outcome: 'refused', reason: 'invalid' };
        const author = await this.viewerOf(ownerId);
        const result = await this.save(
          {
            scope: 'employee',
            author,
            target: input.target,
            body: parsed.data,
            servers: usableServers,
            refuseShared: true,
          },
          executor,
        );
        if (result.outcome === 'refused')
          return { outcome: 'refused', reason: result.refusal };
        const record = await this.detail(
          result.record,
          author,
          false,
          'employee',
          {
            usableServers,
          },
        );
        return { outcome: 'saved', record };
      },
      (result) =>
        result.outcome === 'saved'
          ? recordFields(result.record)
          : { outcome: 'refused', reason: result.reason },
    );
  }

  // ---------- Save ----------

  /**
   * The one save path of POST and PUT (employee and panel) and of `saveOwn` (Flow 1): visibility → the
   * right to change → the rule → the versioned write and its audit event in one transaction. A refusal
   * writes nothing. On the plain client the write opens its own transaction; on the caller's
   * transaction it is a savepoint, so a `name_taken` from the database rolls back only the save and
   * the caller's transaction goes on.
   */
  private async save(
    request: SaveRequest,
    executor: Executor = this.db,
  ): Promise<SaveResult> {
    // A disabled author sees no record, so whatever was written could not be read back (KD-2).
    if (!request.author.active)
      return { outcome: 'refused', refusal: 'not_found' };
    let previous: LibraryRecord | null = null;
    if (request.target !== null) {
      const { id } = request.target;
      const record = isUuid(id)
        ? await this.readOne(executor, request.scope, request.author, id)
        : undefined;
      if (record === undefined)
        return { outcome: 'refused', refusal: 'not_found' };
      const owner = request.scope === 'employee' ? request.author.id : null;
      if (record.ownerId !== owner)
        return { outcome: 'refused', refusal: 'read_only' };
      // Answered before the other refusals; `updateSaved` checks it again under the row lock.
      if (request.refuseShared && hasHolders(record))
        return { outcome: 'refused', refusal: 'shared' };
      if (record.body.kind !== request.body.kind)
        return { outcome: 'refused', refusal: 'invalid' };
      previous = record;
    }
    const decision = decideSave(
      await this.saveInput(executor, request, previous),
    );
    if (decision.kind === 'name_taken')
      return {
        outcome: 'refused',
        refusal: decision.reason === 'own' ? 'name_taken' : 'system_name',
      };
    if (decision.kind === 'refused')
      return { outcome: 'refused', refusal: decision.reason };
    const write = (tx: RuntimeTx): Promise<LibraryRecord> =>
      previous === null
        ? this.insertSaved(tx, request)
        : this.updateSaved(tx, request, previous);
    try {
      const record = await executor.transaction(write);
      return { outcome: 'saved', record };
    } catch (error) {
      if (error instanceof SaveRefused)
        return { outcome: 'refused', refusal: error.refusal };
      throw error;
    }
  }

  /** The input of the save rule: other records' names, the author's choices, the agents he sees. */
  private async saveInput(
    executor: Executor,
    request: SaveRequest,
    previous: LibraryRecord | null,
  ): Promise<SaveInput> {
    const { scope, author, body } = request;
    const exceptId = previous?.id;
    const [ownNames, systemNames, visible, models] = await Promise.all([
      scope === 'employee' ? recordNames(executor, author.id, exceptId) : [],
      recordNames(executor, null, scope === 'system' ? exceptId : undefined),
      this.visibleAgents(executor, author, refersToRecords(body)),
      scope === 'employee'
        ? this.allowedModelIds(author.id)
        : this.catalogueModelIds(),
    ]);
    const visibleAgentIds = [...visible.keys()];
    const choices: SaveChoices =
      scope === 'employee'
        ? {
            scope,
            usableServers: request.servers,
            allowedModels: models,
            visibleAgentIds,
          }
        : {
            scope,
            registryServers: request.servers,
            catalogueModels: models,
            visibleAgentIds,
          };
    return {
      name: body.name,
      body,
      previous: previous && { name: previous.name, body: previous.body },
      takenNames: { own: ownNames, system: systemNames },
      choices,
    };
  }

  private async insertSaved(
    tx: RuntimeTx,
    request: SaveRequest,
  ): Promise<LibraryRecord> {
    const { scope, author, body } = request;
    const inserted = await insertRecord(tx, {
      ownerId: scope === 'employee' ? author.id : null,
      name: body.name,
      description: body.description,
      offerInChat: true,
      body,
    });
    if (inserted.outcome === 'name_taken') throw new SaveRefused('name_taken');
    const record = present(
      await this.readOne(tx, scope, author, inserted.id),
      inserted.id,
    );
    await this.audit(tx, author.id, 'library_create', null, record);
    return record;
  }

  /**
   * `name_taken` aborts the transaction, so it is thrown and the transaction rolled back. The `shared`
   * refusal is checked again here: an audience change keeps the version and locks the row, so the
   * holders read after this update are those of the record being saved (AC-18.5).
   */
  private async updateSaved(
    tx: RuntimeTx,
    request: SaveRequest,
    previous: LibraryRecord,
  ): Promise<LibraryRecord> {
    const { scope, author, body } = request;
    const updated = await updateRecordContent(tx, {
      id: previous.id,
      version: request.target?.version ?? previous.version,
      name: body.name,
      description: body.description,
      body,
    });
    if (updated.outcome === 'name_taken') throw new SaveRefused('name_taken');
    const current = await this.readOne(tx, scope, author, previous.id);
    if (updated.outcome === 'stale')
      throw new SaveRefused(
        current === undefined ? 'not_found' : 'version_conflict',
      );
    const record = present(current, previous.id);
    if (request.refuseShared && hasHolders(record))
      throw new SaveRefused('shared');
    await this.audit(tx, author.id, 'library_update', previous, record);
    return record;
  }

  private async savedDetail(
    result: SaveResult,
    author: Viewer,
    isAdmin: boolean,
    scope: ViewScope,
    facts: ServerFacts,
  ): Promise<RecordDetail> {
    if (result.outcome === 'refused') throw saveRefusalError(result.refusal);
    return this.detail(result.record, author, isAdmin, scope, facts);
  }

  // ---------- Reads ----------

  /** Who looks: enabled or not and his roles now, read at every operation (KD-2). */
  private async viewerOf(id: string): Promise<Viewer> {
    const [active, roleIds] = await Promise.all([
      this.identity.isActive(id),
      this.identity.rolesOf(id),
    ]);
    return { id, active, roleIds };
  }

  private async contextOf(
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

  private async detail(
    record: LibraryRecord,
    viewer: Viewer,
    isAdmin: boolean,
    scope: ViewScope,
    facts: ServerFacts,
  ): Promise<RecordDetail> {
    const [context, versions] = await Promise.all([
      this.contextOf(viewer, isAdmin, scope, facts),
      this.visibleAgents(this.db, viewer, refersToRecords(record.body)),
    ]);
    return recordDetail(record, context, versions);
  }

  /** Agent records the viewer sees, id → version; read only when the content names records. */
  private async visibleAgents(
    executor: Executor,
    viewer: Viewer,
    needed: boolean,
  ): Promise<VisibleVersions> {
    if (!needed) return new Map();
    const records = await findVisibleRecords(executor, viewer);
    return new Map(
      records
        .filter((record) => record.body.kind === 'agent')
        .map((record) => [record.id, record.version]),
    );
  }

  private async resolveBy(
    operation: string,
    viewerId: string,
    key: RecordKey,
  ): Promise<ResolvedRecord | null> {
    return this.logged(
      operation,
      { viewerId, ...key },
      async () => {
        if ('id' in key && !isUuid(key.id)) return null;
        const viewer = await this.viewerOf(viewerId);
        const [record] = await findVisibleRecords(this.db, viewer, key);
        return record === undefined ? null : resolvedRecord(record, viewerId);
      },
      (record) =>
        record === null ? { outcome: 'not_found' } : recordFields(record),
    );
  }

  /** The one record an employee route (visibility) or a panel route (panel condition) may touch. */
  private async readOne(
    executor: Executor,
    scope: SaveScope,
    viewer: Viewer,
    id: string,
  ): Promise<LibraryRecord | undefined> {
    return scope === 'employee'
      ? this.visibleOne(executor, viewer, id)
      : this.panelOne(executor, id);
  }

  private async visibleOne(
    executor: Executor,
    viewer: Viewer,
    id: string,
  ): Promise<LibraryRecord | undefined> {
    const [record] = await findVisibleRecords(executor, viewer, { id });
    return record;
  }

  private async panelOne(
    executor: Executor,
    id: string,
  ): Promise<LibraryRecord | undefined> {
    const [record] = await findPanelRecords(executor, { id });
    return record;
  }

  /** A number that is not a UUID is answered without the database (DC-2). */
  private async visibleOr404(
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

  private async panelOr404(
    executor: Executor,
    id: string,
  ): Promise<LibraryRecord> {
    const record = isUuid(id) ? await this.panelOne(executor, id) : undefined;
    if (record === undefined) throw notFound();
    return record;
  }

  private async allowedModelIds(ownerId: string): Promise<string[]> {
    return (await this.access.allowedModels(ownerId)).map((model) => model.id);
  }

  /** Chat models of the catalogue: a record's model is a chat model, never an embedding one. */
  private async catalogueModelIds(): Promise<string[]> {
    return (await this.access.listModels())
      .filter((model) => model.purpose === 'chat')
      .map((model) => model.id);
  }

  // ---------- Writes ----------

  /** Deletes the record unless it is built-in (AC-12.2); its holders go by cascade. */
  private async deleteChecked(
    tx: RuntimeTx,
    actorId: string,
    record: LibraryRecord,
  ): Promise<void> {
    if (record.builtinKey !== null)
      throw libraryError('RECORD_REJECTED', 'builtin');
    await deleteRecord(tx, record.id);
    await this.audit(tx, actorId, 'library_delete', record, null);
  }

  /** One event per action, in the action's transaction, with the KD-7 sample only. */
  private audit(
    tx: RuntimeTx,
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
  private async logged<T>(
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
