import { randomUUID } from 'node:crypto';
import { HttpException, Inject, Injectable } from '@nestjs/common';
import type { LogFields, Logger } from '@agent-os/common';
import {
  type BannedRecord,
  type CopyRecordBody,
  type CopyResult,
  type CreateRecordBody,
  type LibraryChoices,
  LibraryRecordCardSchema,
  type LibraryRecordCard,
  type LibraryRejectReason,
  type RecordAudienceBody,
  type RecordBody,
  type RecordDetail,
  type RecordHeader,
  type RecordSummary,
  type ResolvedRecord,
  type SystemRecordAudienceBody,
  type UpdateRecordBody,
} from '@agent-os/contracts';
import type { Database, DatabaseConnection, Executor, Transaction } from '@agent-os/db';
import { AccessService } from '../access/access.service';
import { AuditLog, SYSTEM_ACTOR } from '../audit/audit-log.repository';
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
import { chatRecordOf, type ChatRecord } from './record-listing';
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
} from './record-view';
import { contentParts } from './record-content';
import {
  decideSave,
  type RefusedField,
  type SaveChoices,
  type SaveInput,
} from './save-rules';

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

/** A deep agent whose knowledge graph is open to the actor: what the knowledge routes need. */
export interface KnowledgeTarget {
  readonly recordId: string;
  /** The flag of the deep agent's last version. */
  readonly selfLearning: boolean;
  /** The servers of the deep agent and of its subagents in the last version, without repeats (`*` as is). */
  readonly servers: readonly string[];
}

/** Why a save is refused; each route answers it with its own error. */
export type SaveRefusal =
  | 'not_found'
  | 'read_only'
  | 'version_conflict'
  | 'name_taken'
  | 'system_name'
  | 'invalid'
  | LibraryRejectReason;

type SaveScope = 'employee' | 'system';
type ViewScope = ViewContext['scope'];

interface SaveRequest {
  readonly scope: SaveScope;
  readonly author: Viewer;
  readonly target: { readonly id: string; readonly version: number } | null;
  readonly body: CreateRecordBody;
  /** Servers usable to the author (employee) or the MCP registry (system). */
  readonly servers: readonly string[];
  /** The id of a new record chosen before the save (a chat card, deep-agents KD-3); absent — the database's. */
  readonly newId?: string;
  /**
   * The models the author may choose, read before a transaction opened (the chat's save runs in the step's
   * transaction); absent — read here: allowed to the employee, or the chat models of the catalogue.
   */
  readonly models?: readonly string[];
}

/** A refusal of the save, with the part of the record the rule is about when a rule of the content decided. */
interface Refused {
  readonly outcome: 'refused';
  readonly refusal: SaveRefusal;
  readonly field?: RefusedField;
}

type SaveResult =
  | { readonly outcome: 'saved'; readonly record: LibraryRecord }
  | Refused;

/** What the checks before the write decided: the stored record an edit changes, or the refusal. */
type SaveCheck =
  | { readonly outcome: 'allowed'; readonly previous: LibraryRecord | null }
  | Refused;

/** Thrown inside a save transaction to roll it back; caught right outside it. */
class SaveRefused {
  constructor(readonly refusal: SaveRefusal) {}
}

/** A record's name, description and kind with its content, as a chat change names it. */
export interface ChatRecordInput {
  readonly name: string;
  readonly description: string;
  readonly body: RecordBody;
}

/**
 * A change the main chat asks for (deep-agents KD-3). The self-learning flag in `body` is not the
 * chat's: the service sets it — off on create, the stored one on edit.
 */
export type ChatChange =
  | {
      readonly action: 'create';
      readonly system: boolean;
      readonly record: ChatRecordInput;
    }
  | {
      readonly action: 'edit';
      readonly recordId: string;
      readonly record: ChatRecordInput;
    }
  | { readonly action: 'delete'; readonly recordId: string };

/** The facts a chat call is decided with, read before any transaction ({@link LibraryService.chatContext}). */
export interface ChatContext {
  readonly actor: LibraryActor;
  readonly viewer: Viewer;
  /** The servers usable to the employee and, for an admin, the MCP registry. */
  readonly servers: PanelServerFacts;
  readonly allowedModels: readonly string[];
  /** The chat models of the catalogue; empty for a non-admin. */
  readonly catalogueModels: readonly string[];
}

/**
 * Why a chat change is refused: a refusal of the save, or a rule only the chat has — a record with
 * holders (`shared`), a system record for a non-admin (`admin_only`).
 */
export type ChatRefusalCode = SaveRefusal | 'shared' | 'admin_only';

/** A refused chat change, with the part of the record the rule is about when one is. */
export interface ChatRefusal {
  readonly outcome: 'refused';
  readonly refusal: ChatRefusalCode;
  readonly field?: RefusedField;
  /** The servers the record may name — usable to the employee, or the registry — when a rule of the content refused. */
  readonly allowedServers?: readonly string[];
}

/** The answer of the check before the card: the refusal, or the card's content. */
export type ChatReview =
  | ChatRefusal
  | { readonly outcome: 'card'; readonly card: LibraryRecordCard };

/** The answer of the save of an approved card; `version` `null` — the record was deleted. */
export type ChatSaveResult =
  | ChatRefusal
  | {
      readonly outcome: 'saved';
      readonly recordId: string;
      readonly version: number | null;
    };

/** The field of a create's `system` argument: only an admin creates a system record. */
const SYSTEM_FIELD: RefusedField = { path: 'system', values: [] };

function chatRefused(
  refusal: ChatRefusalCode,
  field?: RefusedField,
): ChatRefusal {
  return { outcome: 'refused', refusal, ...(field === undefined ? {} : { field }) };
}

/** A refusal of the save rules, with the servers the request could choose from. */
function chatRefusedBy(refused: Refused, request: SaveRequest): ChatRefusal {
  return {
    ...chatRefused(refused.refusal, refused.field),
    allowedServers: request.servers,
  };
}

function chatSaved(result: SaveResult, request: SaveRequest): ChatSaveResult {
  return result.outcome === 'refused'
    ? chatRefusedBy(result, request)
    : {
        outcome: 'saved',
        recordId: result.record.id,
        version: result.record.version,
      };
}

function chatOutcomeFields(
  result: ChatReview | ChatSaveResult,
): LogFields {
  return result.outcome === 'refused'
    ? { outcome: 'refused', reason: result.refusal, path: result.field?.path ?? null }
    : { outcome: result.outcome };
}

/**
 * Which rules a chat change of `record` follows (Invariant 4): an admin's change of a system record the
 * panel's, the employee's own record shared with no one the employee's; any other record is refused —
 * missing or not seen, another employee's, shared, a system record for a non-admin, a built-in one to
 * delete.
 */
function chatScope(
  record: LibraryRecord | undefined,
  context: ChatContext,
  action: 'edit' | 'delete',
):
  | ChatRefusal
  | {
      readonly outcome: 'allowed';
      readonly scope: SaveScope;
      readonly record: LibraryRecord;
    } {
  if (record === undefined) return chatRefused('not_found');
  if (record.ownerId === null) {
    if (!context.actor.isAdmin) return chatRefused('admin_only');
    if (action === 'delete' && record.builtinKey !== null)
      return chatRefused('builtin');
    return { outcome: 'allowed', scope: 'system', record };
  }
  if (record.ownerId !== context.viewer.id) return chatRefused('read_only');
  if (hasHolders(record)) return chatRefused('shared');
  return { outcome: 'allowed', scope: 'employee', record };
}

/** The stored flag of a deep agent; an agent has none. */
function selfLearningOf(body: RecordBody): boolean {
  return body.kind === 'deep_agent' && body.content.selfLearning;
}

/** The body with the self-learning flag set, which only a deep agent holds. */
function withSelfLearning(body: RecordBody, selfLearning: boolean): RecordBody {
  return body.kind === 'deep_agent'
    ? { kind: 'deep_agent', content: { ...body.content, selfLearning } }
    : body;
}

/** The content of a `library.record` card (Contract «Содержимое карточки `library.record`»). */
function libraryRecordCard(card: {
  readonly action: LibraryRecordCard['action'];
  readonly recordId: string;
  readonly system: boolean;
  readonly next: ChatRecordInput | null;
  readonly previous: LibraryRecord | null;
}): LibraryRecordCard {
  const { next, previous } = card;
  const kind = next?.body.kind ?? previous?.body.kind;
  return LibraryRecordCardSchema.parse({
    action: card.action,
    recordId: card.recordId,
    kind,
    system: card.system,
    next: next && {
      name: next.name,
      description: next.description,
      content: next.body.content,
    },
    previous: previous && {
      name: previous.name,
      description: previous.description,
      content: previous.body.content,
      version: previous.version,
    },
  });
}

/** The record an approved card saves; `null` on delete. */
function cardRecordOf(card: LibraryRecordCard): ChatRecordInput | null {
  if (card.kind === 'agent') {
    const { next } = card;
    return next && {
      name: next.name,
      description: next.description,
      body: { kind: 'agent', content: next.content },
    };
  }
  const { next } = card;
  return next && {
    name: next.name,
    description: next.description,
    body: { kind: 'deep_agent', content: next.content },
  };
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

/** The HTTP answer of a refused save. */
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
    default:
      return libraryError('RECORD_REJECTED', refusal);
  }
}

/** Whether the content names other records: the agents an agent may start. */
function refersToRecords(body: RecordBody): boolean {
  return body.kind === 'agent' && body.content.agents.length > 0;
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
    { language }: CopyRecordBody,
    facts: ServerFacts,
  ): Promise<CopyResult> {
    return this.logged(
      'copy',
      { actorId: actor.id, recordId: id, language },
      async () => {
        const viewer = await this.viewerOf(actor.id);
        const source = await this.visibleOr404(this.db, viewer, id);
        const [allowedModels, defaultModel, visible, ownNames, systemNames] =
          await Promise.all([
            this.allowedModelIds(viewer.id),
            this.access.defaultChatModel(),
            this.visibleAgentIds(this.db, viewer, refersToRecords(source.body)),
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
          visibleAgentIds: visible,
          language,
          builtinKey: source.builtinKey,
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
   * deep agent's author and to an admin when the deep agent is in the panel. Built on the two reads that
   * do not throw, so the panel is asked after a failed visibility: a deep agent neither visible nor in
   * the admin's panel, missing, or an agent — 404 RECORD_NOT_FOUND; visible but not open — 403
   * KNOWLEDGE_FORBIDDEN. The servers are those of the lesson tools: the deep agent's own and every
   * subagent's (deep-agents KD-1). Writes nothing.
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
        if (record === undefined || record.body.kind !== 'deep_agent')
          throw notFound();
        if (record.ownerId !== viewer.id && inPanel === undefined)
          throw libraryError('KNOWLEDGE_FORBIDDEN');
        return {
          recordId: record.id,
          selfLearning: record.body.content.selfLearning,
          servers: [
            ...new Set(contentParts(record.body).flatMap((part) => part.servers)),
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

  // ---------- For the main chat (deep-agents KD-3) ----------

  /**
   * The facts a chat call is decided with, read outside any transaction: who the employee is now, the
   * servers he may use (or the registry for an admin's system record) and the models he may choose. The
   * save runs in the step's transaction, which must not wait on other reads (design-access.md KD-4).
   */
  async chatContext(
    actor: LibraryActor,
    servers: PanelServerFacts,
  ): Promise<ChatContext> {
    const [viewer, allowedModels, catalogueModels] = await Promise.all([
      this.viewerOf(actor.id),
      this.allowedModelIds(actor.id),
      actor.isAdmin ? this.catalogueModelIds() : [],
    ]);
    return { actor, viewer, servers, allowedModels, catalogueModels };
  }

  /** `list_records`: the records the employee sees and, for an admin, the system records of the panel. */
  chatRecords(context: ChatContext): Promise<ChatRecord[]> {
    const { actor, viewer } = context;
    return this.logged(
      'chat_list',
      { viewerId: actor.id },
      async () => {
        const [visible, system] = await Promise.all([
          findVisibleRecords(this.db, viewer),
          actor.isAdmin ? findPanelRecords(this.db, { list: 'system' }) : [],
        ]);
        const seen = new Set(visible.map((record) => record.id));
        return [
          ...visible,
          ...system.filter((record) => !seen.has(record.id)),
        ].map((record) => chatRecordOf(record, viewer.id));
      },
      (records) => ({ count: records.length }),
    );
  }

  /** `read_record`: a record the chat may read, or `null` — missing or not seen, answered alike. */
  chatRecord(
    context: ChatContext,
    recordId: string,
  ): Promise<ChatRecord | null> {
    return this.logged(
      'chat_read',
      { viewerId: context.actor.id, recordId },
      async () => {
        const record = await this.chatTarget(this.db, context, recordId);
        return record === undefined
          ? null
          : chatRecordOf(record, context.viewer.id);
      },
      (record) =>
        record === null ? { outcome: 'not_found' } : recordFields(record),
    );
  }

  /**
   * The check before the card (Flow 1): the rights to the record and the rules of its content, without a
   * write. The card names the record — on create the id chosen now — and the version the employee sees.
   */
  reviewChatChange(
    context: ChatContext,
    change: ChatChange,
  ): Promise<ChatReview> {
    return this.logged(
      'chat_review',
      {
        actorId: context.actor.id,
        action: change.action,
        recordId: change.action === 'create' ? null : change.recordId,
      },
      () => this.reviewed(context, change),
      chatOutcomeFields,
    );
  }

  /**
   * The save of an approved card in the step's transaction (Invariant 3): the row is locked, the same
   * checks run again on the version the card showed — another version is `version_conflict` — and the
   * record's version and its audit event are written at a savepoint of the step's transaction. The
   * self-learning flag is the stored one on an edit and off on a create (Invariant 4).
   */
  saveChatChange(
    tx: Transaction,
    context: ChatContext,
    card: LibraryRecordCard,
  ): Promise<ChatSaveResult> {
    return this.logged(
      'chat_save',
      {
        actorId: context.actor.id,
        action: card.action,
        recordId: card.recordId,
        fromVersion: card.previous?.version ?? null,
      },
      () => this.savedFromCard(tx, context, card),
      chatOutcomeFields,
    );
  }

  private async reviewed(
    context: ChatContext,
    change: ChatChange,
  ): Promise<ChatReview> {
    if (change.action === 'create') {
      if (change.system && !context.actor.isAdmin)
        return chatRefused('admin_only', SYSTEM_FIELD);
      const next = {
        ...change.record,
        body: withSelfLearning(change.record.body, false),
      };
      const scope = change.system ? 'system' : 'employee';
      const request = this.chatSaveRequest(context, scope, null, next);
      const check = await this.checkSave(request, this.db);
      if (check.outcome === 'refused') return chatRefusedBy(check, request);
      return {
        outcome: 'card',
        card: libraryRecordCard({
          action: 'create',
          recordId: randomUUID(),
          system: change.system,
          next,
          previous: null,
        }),
      };
    }
    const target = await this.chatTarget(this.db, context, change.recordId);
    const scope = chatScope(target, context, change.action);
    if (scope.outcome === 'refused') return scope;
    const { record: previous } = scope;
    const system = previous.ownerId === null;
    if (change.action === 'delete')
      return {
        outcome: 'card',
        card: libraryRecordCard({
          action: 'delete',
          recordId: previous.id,
          system,
          next: null,
          previous,
        }),
      };
    const next = {
      ...change.record,
      body: withSelfLearning(change.record.body, selfLearningOf(previous.body)),
    };
    const request = this.chatSaveRequest(context, scope.scope, previous, next);
    const check = await this.checkSave(request, this.db);
    if (check.outcome === 'refused') return chatRefusedBy(check, request);
    return {
      outcome: 'card',
      card: libraryRecordCard({
        action: 'edit',
        recordId: previous.id,
        system,
        next,
        previous,
      }),
    };
  }

  private async savedFromCard(
    tx: Transaction,
    context: ChatContext,
    card: LibraryRecordCard,
  ): Promise<ChatSaveResult> {
    const next = cardRecordOf(card);
    if (card.action === 'create') {
      if (next === null)
        throw new Error(`create card of record ${card.recordId} has no record`);
      if (card.system && !context.actor.isAdmin)
        return chatRefused('admin_only', SYSTEM_FIELD);
      const scope = card.system ? 'system' : 'employee';
      const request = this.chatSaveRequest(context, scope, null, {
        ...next,
        body: withSelfLearning(next.body, false),
      });
      return chatSaved(
        await this.save({ ...request, newId: card.recordId }, tx),
        request,
      );
    }
    if (card.previous === null)
      throw new Error(
        `${card.action} card of record ${card.recordId} has no previous version`,
      );
    if (!(await lockRecord(tx, card.recordId))) return chatRefused('not_found');
    const target = await this.chatTarget(tx, context, card.recordId);
    const scope = chatScope(target, context, card.action);
    if (scope.outcome === 'refused') return scope;
    const { record: current } = scope;
    if (current.version !== card.previous.version)
      return chatRefused('version_conflict');
    if (card.action === 'delete') {
      await this.deleteChecked(tx, context.actor.id, current);
      return { outcome: 'saved', recordId: current.id, version: null };
    }
    if (next === null)
      throw new Error(`edit card of record ${card.recordId} has no record`);
    const request = this.chatSaveRequest(context, scope.scope, current, {
      ...next,
      body: withSelfLearning(next.body, selfLearningOf(current.body)),
    });
    return chatSaved(await this.save(request, tx), request);
  }

  /**
   * The record a chat call names: one the employee sees, or for an admin a system record of the panel.
   * Missing, not seen — another employee's private record among them — and an id that is not a UUID
   * answer alike, so the chat learns nothing of a record it cannot see.
   */
  private async chatTarget(
    executor: Executor,
    context: ChatContext,
    recordId: string,
  ): Promise<LibraryRecord | undefined> {
    if (!isUuid(recordId)) return undefined;
    const visible = await this.visibleOne(executor, context.viewer, recordId);
    if (visible !== undefined || !context.actor.isAdmin) return visible;
    const inPanel = await this.panelOne(executor, recordId);
    return inPanel?.ownerId === null ? inPanel : undefined;
  }

  /** The save request of a chat change: the employee's choices, or the panel's for an admin's system record. */
  private chatSaveRequest(
    context: ChatContext,
    scope: SaveScope,
    previous: LibraryRecord | null,
    record: ChatRecordInput,
  ): SaveRequest {
    return {
      scope,
      author: context.viewer,
      target: previous && { id: previous.id, version: previous.version },
      body: {
        name: record.name,
        description: record.description,
        ...record.body,
      },
      servers:
        scope === 'employee'
          ? context.servers.usableServers
          : context.servers.registryServers,
      models:
        scope === 'employee' ? context.allowedModels : context.catalogueModels,
    };
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

  // ---------- Save ----------

  /**
   * The one save path of POST and PUT (employee and panel) and of the chat's save (Flow 1): visibility →
   * the right to change → the rule → the versioned write and its audit event in one transaction. A refusal
   * writes nothing. On the plain client the write opens its own transaction; on the caller's
   * transaction it is a savepoint, so a `name_taken` from the database rolls back only the save and
   * the caller's transaction goes on.
   */
  private async save(
    request: SaveRequest,
    executor: Executor = this.db,
  ): Promise<SaveResult> {
    const check = await this.checkSave(request, executor);
    if (check.outcome === 'refused') return check;
    const { previous } = check;
    const write = (tx: Transaction): Promise<LibraryRecord> =>
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

  /** The checks of {@link save} before its write; writes nothing, so the chat asks it before the card. */
  private async checkSave(
    request: SaveRequest,
    executor: Executor,
  ): Promise<SaveCheck> {
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
        field: { path: decision.path, values: decision.values },
      };
    if (decision.kind === 'refused')
      return {
        outcome: 'refused',
        refusal: decision.reason,
        field: { path: decision.path, values: decision.values },
      };
    return { outcome: 'allowed', previous };
  }

  /** The input of the save rule: other records' names, the author's choices, the agents he sees. */
  private async saveInput(
    executor: Executor,
    request: SaveRequest,
    previous: LibraryRecord | null,
  ): Promise<SaveInput> {
    const { scope, author, body } = request;
    const exceptId = previous?.id;
    const [ownNames, systemNames, visibleAgentIds, models] = await Promise.all([
      scope === 'employee' ? recordNames(executor, author.id, exceptId) : [],
      recordNames(executor, null, scope === 'system' ? exceptId : undefined),
      this.visibleAgentIds(executor, author, refersToRecords(body)),
      request.models ??
        (scope === 'employee'
          ? this.allowedModelIds(author.id)
          : this.catalogueModelIds()),
    ]);
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
    tx: Transaction,
    request: SaveRequest,
  ): Promise<LibraryRecord> {
    const { scope, author, body } = request;
    const inserted = await insertRecord(tx, {
      ...(request.newId === undefined ? {} : { id: request.newId }),
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
   * `name_taken` aborts the transaction, so it is thrown and the transaction rolled back.
   */
  private async updateSaved(
    tx: Transaction,
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
    return recordDetail(record, await this.contextOf(viewer, isAdmin, scope, facts));
  }

  /** Ids of the agent records the viewer sees; read only when the content names records. */
  private async visibleAgentIds(
    executor: Executor,
    viewer: Viewer,
    needed: boolean,
  ): Promise<string[]> {
    if (!needed) return [];
    const records = await findVisibleRecords(executor, viewer);
    return records.filter((record) => record.body.kind === 'agent').map((record) => record.id);
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
  private audit(
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
