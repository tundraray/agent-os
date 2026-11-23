import { Injectable } from '@nestjs/common';
import {
  type AgentVersion,
  type BuiltinKey,
  type CopyRecordBody,
  type CopyResult,
  type CreateRecordBody,
  type LibraryChoices,
  nameWinner,
  type RecordAudienceBody,
  type RecordDetail,
  type RecordHeader,
  type RecordKind,
  type RecordSummary,
  type ResolvedRecord,
  type UpdateRecordBody,
} from '@agent-os/contracts';
import { AgentsRepository, Db } from '@agent-os/db';
import { AccessService } from '../access/access.service';
import { isUuid } from '../common/is-uuid';
import { SettingsService } from '../settings/settings.service';
import { decideEmployeeAudience } from './audience-rules';
import { planCopy, replaceModel } from './copy-rules';
import {
  LibraryRecords,
  notFound,
  present,
  readOnly,
  recordFields,
  refersToRecords,
} from './library-records';
import { LibrarySave } from './library-save';
import { libraryError } from './library.errors';
import type {
  KnowledgeTarget,
  LibraryActor,
  ServerFacts,
} from './library.types';
import { contentParts } from './record-content';
import { recordHeader, recordSummary, resolvedRecord } from './record-view';
import { recordBody } from './stored-records';

/**
 * The library for the employee and for the `runtime` part (design-library.md, KD-1, KD-2, KD-4–KD-7).
 * Records are read only through the repository's two conditions — visibility and the panel's
 * (ADR-0016) — and an invisible record answers as a missing one. A write and its audit event are one
 * transaction; the facts of the agents package come in as input, so the module does not import `AgentsModule`
 * (KD-6). The admin panel is `LibraryPanelService`, the main chat's record tools `LibraryChatService`.
 */
@Injectable()
export class LibraryService {
  constructor(
    private readonly db: Db,
    private readonly records: LibraryRecords,
    private readonly saving: LibrarySave,
    private readonly repository: AgentsRepository,
    private readonly settings: SettingsService,
    private readonly access: AccessService,
  ) {}

  // ---------- Employee ----------

  /** GET /api/library: the records the viewer sees, by name. */
  list(actor: LibraryActor, facts: ServerFacts): Promise<RecordSummary[]> {
    return this.records.logged(
      'list',
      { viewerId: actor.id },
      async () => {
        const viewer = await this.records.viewerOf(actor.id);
        const [records, context] = await Promise.all([
          this.records.visible(viewer),
          this.records.contextOf(viewer, actor.isAdmin, 'employee', facts),
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
    return this.records.logged(
      'get',
      { viewerId: actor.id, recordId: id },
      async () => {
        const viewer = await this.records.viewerOf(actor.id);
        const record = await this.records.visibleOr404(viewer, id);
        return this.records.detail(
          record,
          viewer,
          actor.isAdmin,
          'employee',
          facts,
        );
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
    return this.records.logged(
      'create',
      { actorId: actor.id, kind: body.kind },
      async () => {
        const author = await this.records.viewerOf(actor.id);
        const result = await this.saving.save({
          scope: 'employee',
          author,
          target: null,
          body,
          servers: facts.usableServers,
        });
        return this.saving.savedDetail(
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
    return this.records.logged(
      'update',
      { actorId: actor.id, recordId: id, fromVersion: body.version },
      async () => {
        const author = await this.records.viewerOf(actor.id);
        const result = await this.saving.save({
          scope: 'employee',
          author,
          target: { id, version: body.version },
          body,
          servers: facts.usableServers,
        });
        return this.saving.savedDetail(
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
   * PUT /api/library/:id/audience (Flow 2): the ban, the owner's roles and the holders are read and the
   * audience written in one transaction. The version stays (DC-11).
   */
  setAudience(
    actor: LibraryActor,
    id: string,
    body: RecordAudienceBody,
    facts: ServerFacts,
  ): Promise<RecordDetail> {
    return this.records.logged(
      'audience',
      { actorId: actor.id, recordId: id, roleIds: body.roleIds },
      async () => {
        if (!isUuid(id)) throw notFound();
        const { record, viewer } = await this.db.transaction(async () => {
          if (!(await this.repository.exists(id))) throw notFound();
          const owner = await this.records.viewerOf(actor.id);
          const before = await this.records.visibleOr404(owner, id);
          if (before.ownerId !== owner.id) throw readOnly();
          const decision = decideEmployeeAudience({
            currentRoleIds: before.holders.roles.map((role) => role.id),
            roleIds: body.roleIds,
            ownerRoleIds: owner.roleIds,
            banned: before.closedAt !== null,
          });
          if (decision.kind === 'refused')
            throw libraryError('RECORD_REJECTED', decision.reason);
          await this.repository.replaceHolders(id, {
            everyone: false,
            roleIds: body.roleIds,
            userIds: [],
          });
          await this.repository.setOfferInChat(id, body.offerInChat);
          const after = present(await this.records.visibleOne(owner, id), id);
          await this.records.audit(owner.id, 'library_audience', before, after);
          return { record: after, viewer: owner };
        });
        return this.records.detail(
          record,
          viewer,
          actor.isAdmin,
          'employee',
          facts,
        );
      },
      recordFields,
    );
  }

  /**
   * POST /api/library/:id/copy (Flow 3): a personal copy for the viewer — a new agent whose version 1 is
   * made from the source's active version; the original stays.
   */
  copy(
    actor: LibraryActor,
    id: string,
    { language }: CopyRecordBody,
    facts: ServerFacts,
  ): Promise<CopyResult> {
    return this.records.logged(
      'copy',
      { actorId: actor.id, recordId: id, language },
      async () => {
        const viewer = await this.records.viewerOf(actor.id);
        const source = await this.records.visibleOr404(viewer, id);
        const [allowedModels, defaultModel, visible, ownNames, systemNames] =
          await Promise.all([
            this.records.allowedModelIds(viewer.id),
            this.access.defaultChatModel(),
            this.records.visibleAgentIds(viewer, refersToRecords(source.body)),
            this.repository.names(viewer.id),
            this.repository.names(null),
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
        const copied = await this.db.transaction(async () => {
          const inserted = await this.repository.insert({
            ownerId: viewer.id,
            name: plan.name,
            description: source.description,
            offerInChat: true,
            kind: plan.body.kind,
            content: plan.body.content,
            authorId: viewer.id,
          });
          if (inserted.outcome === 'name_taken')
            throw libraryError('RECORD_NAME_TAKEN', 'own');
          const record = present(
            await this.records.visibleOne(viewer, inserted.id),
            inserted.id,
          );
          await this.records.audit(
            viewer.id,
            'library_copy',
            null,
            record,
            source.id,
          );
          return record;
        });
        return {
          record: await this.records.detail(
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

  /** DELETE /api/library/:id: only the owner's own record, marked deleted (KD-7). 404, 403 RECORD_READ_ONLY. */
  delete(actor: LibraryActor, id: string): Promise<void> {
    return this.records.logged(
      'delete',
      { actorId: actor.id, recordId: id },
      async () => {
        const viewer = await this.records.viewerOf(actor.id);
        await this.db.transaction(async () => {
          const record = await this.records.visibleOr404(viewer, id);
          if (record.ownerId !== viewer.id) throw readOnly();
          await this.records.deleteChecked(actor.id, record);
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
    return this.records.logged('choices', { viewerId: actor.id }, async () => {
      const [allowedModels, defaultModel, settings] = await Promise.all([
        this.records.allowedModelIds(actor.id),
        this.access.defaultChatModel(),
        this.settings.read('library_settings'),
      ]);
      return {
        servers: [...facts.usableServers].sort(),
        defaultModel:
          defaultModel === null
            ? null
            : replaceModel(defaultModel, { allowedModels, defaultModel }),
        defaultMaxTurns: settings.value.defaultMaxTurns,
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
    return this.records.logged(
      'knowledge_target',
      { viewerId: actor.id, recordId },
      async () => {
        if (!isUuid(recordId)) throw notFound();
        const viewer = await this.records.viewerOf(actor.id);
        const [visible, inPanel] = await Promise.all([
          this.records.visibleOne(viewer, recordId),
          actor.isAdmin ? this.records.panelOne(recordId) : undefined,
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
            ...new Set(
              contentParts(record.body).flatMap((part) => part.servers),
            ),
          ],
        };
      },
    );
  }

  // ---------- For the runtime part ----------

  /** The record to start, as the viewer sees it; `null` for an invisible, deleted or missing one. */
  resolve(viewerId: string, recordId: string): Promise<ResolvedRecord | null> {
    return this.records.logged(
      'resolve',
      { viewerId, recordId },
      async () => {
        if (!isUuid(recordId)) return null;
        const viewer = await this.records.viewerOf(viewerId);
        const record = await this.records.visibleOne(viewer, recordId);
        return record === undefined ? null : resolvedRecord(record, viewerId);
      },
      (record) =>
        record === null ? { outcome: 'not_found' } : recordFields(record),
    );
  }

  /**
   * The agent of `kind` a call names, as the viewer sees it (data-model design-agents.md, KD-5): the winner
   * of the name (`nameWinner` of `@agent-os/contracts`, the one place of the rule) among the records the
   * viewer sees, in the library list's order; `null` alike for an invisible, a deleted and a missing name.
   */
  resolveByName(
    viewerId: string,
    name: string,
    kind: RecordKind,
  ): Promise<ResolvedRecord | null> {
    return this.records.logged(
      'resolve_by_name',
      { viewerId, name, kind },
      async () => {
        const viewer = await this.records.viewerOf(viewerId);
        const records = await this.records.visible(viewer);
        return nameWinner(
          records.map((record) => resolvedRecord(record, viewerId)),
          kind,
          name,
        );
      },
      (record) =>
        record === null ? { outcome: 'not_found' } : recordFields(record),
    );
  }

  /**
   * The default agent with this key and its active version, without a visibility check: it exists always
   * (data-model design-agents.md, «Порт `RecordLibrary`»). A missing one is a broken database.
   */
  resolveBuiltin(builtinKey: BuiltinKey): Promise<ResolvedRecord> {
    return this.records.logged(
      'resolve_builtin',
      { builtinKey },
      async () => {
        const record = await this.records.builtin(builtinKey);
        if (record === undefined)
          throw new Error(`The default agent ${builtinKey} is missing`);
        // No viewer: a default agent is a system one, nobody's own.
        return resolvedRecord(record, null);
      },
      recordFields,
    );
  }

  /**
   * A version by its id with its agent's id and kind and the parsed content, without a visibility check:
   * a conversation reads the version it started on, whose visibility its start checked (KD-6). A missing
   * one is a broken database: a conversation's version is kept by its foreign key.
   */
  version(versionId: string): Promise<AgentVersion> {
    return this.records.logged(
      'version',
      { versionId },
      async () => {
        const row = isUuid(versionId)
          ? await this.repository.findVersion(versionId)
          : undefined;
        if (row === undefined)
          throw new Error(`Agent version ${versionId} is missing`);
        return {
          id: row.id,
          agentId: row.agentId,
          number: row.number,
          ...recordBody(row.kind, row.content),
        };
      },
      (version) => ({
        agentId: version.agentId,
        kind: version.kind,
        number: version.number,
      }),
    );
  }

  /** Every record the viewer sees, without content: the list of the main chat. */
  listVisible(viewerId: string): Promise<RecordHeader[]> {
    return this.records.logged(
      'list_visible',
      { viewerId },
      async () => {
        const viewer = await this.records.viewerOf(viewerId);
        const records = await this.records.visible(viewer);
        return records.map((record) => recordHeader(record, viewerId));
      },
      (headers) => ({ count: headers.length }),
    );
  }
}
