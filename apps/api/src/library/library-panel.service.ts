import { Injectable } from '@nestjs/common';
import type {
  BannedRecord,
  CreateRecordBody,
  RecordDetail,
  RecordSummary,
  SystemRecordAudienceBody,
  UpdateRecordBody,
} from '@agent-os/contracts';
import { Db, LibraryRecordsRepository } from '@agent-os/db';
import { AuditLog } from '../audit/audit-log';
import { isUuid } from '../common/is-uuid';
import { IdentityDirectory } from '../identity/identity-directory';
import { decideSystemAudience } from './audience-rules';
import {
  AUDIT_OBJECT_TYPE,
  LibraryRecords,
  notFound,
  present,
  readOnly,
  recordFields,
} from './library-records';
import { LibrarySave } from './library-save';
import { libraryError } from './library.errors';
import type {
  LibraryActor,
  LibraryRecord,
  PanelServerFacts,
  ServerFacts,
} from './library.types';
import { banAuditSample, bannedRecord, recordSummary } from './record-view';

/** An empty audience: after a close (Flow 4). */
const NO_HOLDERS: LibraryRecord['holders'] = {
  everyone: false,
  roles: [],
  users: [],
};

/**
 * The library of the admin panel (design-library.md, KD-2): system records and the employee records
 * open to a role, read under the panel condition; a record outside it answers as a missing one. A write
 * and its audit event are one transaction.
 */
@Injectable()
export class LibraryPanelService {
  constructor(
    private readonly db: Db,
    private readonly records: LibraryRecords,
    private readonly saving: LibrarySave,
    private readonly repository: LibraryRecordsRepository,
    private readonly identity: IdentityDirectory,
    private readonly auditLog: AuditLog,
  ) {}

  /** GET /api/admin/library/system and /shared: whole audience, the author's `disabled`. */
  panelList(
    actor: LibraryActor,
    list: 'system' | 'shared',
    facts: ServerFacts,
  ): Promise<RecordSummary[]> {
    return this.records.logged(
      'panel_list',
      { viewerId: actor.id, list },
      async () => {
        const viewer = await this.records.viewerOf(actor.id);
        const [records, context] = await Promise.all([
          this.records.panel({ list }),
          this.records.contextOf(viewer, actor.isAdmin, 'panel', facts),
        ]);
        return records.map((record) => recordSummary(record, context));
      },
      (records) => ({ count: records.length }),
    );
  }

  /** GET /api/admin/library/bans: no description, no content. */
  bans(actor: LibraryActor): Promise<BannedRecord[]> {
    return this.records.logged(
      'bans',
      { viewerId: actor.id },
      async () => (await this.records.bans()).map(bannedRecord),
      (rows) => ({ count: rows.length }),
    );
  }

  /** GET /api/admin/library/:id: a system record or a role-shared employee record; any other — 404. */
  panelGet(
    actor: LibraryActor,
    id: string,
    facts: ServerFacts,
  ): Promise<RecordDetail> {
    return this.records.logged(
      'panel_get',
      { viewerId: actor.id, recordId: id },
      async () => {
        const viewer = await this.records.viewerOf(actor.id);
        const record = await this.records.panelOr404(id);
        return this.records.detail(record, viewer, actor.isAdmin, 'panel', facts);
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
    return this.records.logged(
      'create_system',
      { actorId: actor.id, kind: body.kind },
      async () => {
        const author = await this.records.viewerOf(actor.id);
        const result = await this.saving.save({
          scope: 'system',
          author,
          target: null,
          body,
          servers: facts.registryServers,
        });
        return this.saving.savedDetail(result, author, actor.isAdmin, 'panel', facts);
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
    return this.records.logged(
      'update_system',
      { actorId: actor.id, recordId: id, fromVersion: body.version },
      async () => {
        const author = await this.records.viewerOf(actor.id);
        const result = await this.saving.save({
          scope: 'system',
          author,
          target: { id, version: body.version },
          body,
          servers: facts.registryServers,
        });
        return this.saving.savedDetail(result, author, actor.isAdmin, 'panel', facts);
      },
      recordFields,
    );
  }

  /** PUT /api/admin/library/:id/audience: like the employee's; the version stays (DC-11). */
  setSystemAudience(
    actor: LibraryActor,
    id: string,
    body: SystemRecordAudienceBody,
    facts: ServerFacts,
  ): Promise<RecordDetail> {
    return this.records.logged(
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
        const record = await this.db.transaction(async () => {
          if (!(await this.repository.exists(id))) throw notFound();
          const before = await this.records.panelOr404(id);
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
          await this.repository.replaceHolders(id, body);
          await this.repository.setOfferInChat(id, body.offerInChat);
          const after = present(await this.records.panelOne(id), id);
          await this.records.audit(actor.id, 'library_audience', before, after);
          return after;
        });
        const viewer = await this.records.viewerOf(actor.id);
        return this.records.detail(record, viewer, actor.isAdmin, 'panel', facts);
      },
      recordFields,
    );
  }

  /** DELETE /api/admin/library/:id: a built-in record — 422 `builtin`. */
  deleteSystem(actor: LibraryActor, id: string): Promise<void> {
    return this.records.logged(
      'delete_system',
      { actorId: actor.id, recordId: id },
      () =>
        this.db.transaction(async () => {
          const record = await this.records.panelOr404(id);
          if (record.ownerId !== null) throw readOnly();
          await this.records.deleteChecked(actor.id, record);
        }),
    );
  }

  /**
   * POST /api/admin/library/:id/close (Flow 4): every holder removed and the ban set. Only an
   * employee record the panel lists; any other — 404. Locked like the owner's audience change.
   */
  close(actor: LibraryActor, id: string): Promise<void> {
    return this.records.logged(
      'close',
      { actorId: actor.id, recordId: id },
      async () => {
        if (!isUuid(id)) throw notFound();
        await this.db.transaction(async () => {
          if (!(await this.repository.exists(id))) throw notFound();
          const before = await this.records.panelOr404(id);
          if (before.ownerId === null) throw notFound();
          const closedAt = await this.repository.closeSharing(id);
          const after = { ...before, holders: NO_HOLDERS, closedAt };
          await this.records.audit(actor.id, 'library_close', before, after);
        });
      },
    );
  }

  /** DELETE /api/admin/library/:id/ban: no ban — 404. The version stays (DC-11). */
  unban(actor: LibraryActor, id: string): Promise<void> {
    return this.records.logged(
      'unban',
      { actorId: actor.id, recordId: id },
      async () => {
        if (!isUuid(id)) throw notFound();
        await this.db.transaction(async () => {
          if (!(await this.repository.exists(id))) throw notFound();
          const ban = await this.records.ban(id);
          if (ban === undefined || !(await this.repository.liftBan(id))) throw notFound();
          await this.auditLog.record({
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
}
