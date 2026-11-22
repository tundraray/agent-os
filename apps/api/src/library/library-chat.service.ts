import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { LogFields } from '@agent-os/common';
import {
  LibraryRecordCardSchema,
  type LibraryRecordCard,
  type RecordBody,
} from '@agent-os/contracts';
import {
  type Executor,
  LibraryRecordsRepository,
  type Transaction,
} from '@agent-os/db';
import { isUuid } from '../common/is-uuid';
import { LibraryRecords, recordFields } from './library-records';
import { LibrarySave } from './library-save';
import type {
  ChatChange,
  ChatContext,
  ChatRecordInput,
  ChatRefusal,
  ChatRefusalCode,
  ChatReview,
  ChatSaveResult,
  LibraryActor,
  LibraryRecord,
  PanelServerFacts,
  Refused,
  SaveRequest,
  SaveResult,
  SaveScope,
} from './library.types';
import { chatRecordOf, type ChatRecord } from './record-listing';
import { hasHolders } from './record-view';
import type { RefusedField } from './save-rules';

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

/**
 * The library for the record tools of the main chat (deep-agents KD-3): the records the chat may read,
 * the check before the card and the save of an approved card. Rights and rules are those of the
 * employee's and the panel's saves (`LibrarySave`).
 */
@Injectable()
export class LibraryChatService {
  constructor(
    private readonly records: LibraryRecords,
    private readonly saving: LibrarySave,
    private readonly repository: LibraryRecordsRepository,
  ) {}

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
      this.records.viewerOf(actor.id),
      this.records.allowedModelIds(actor.id),
      actor.isAdmin ? this.records.catalogueModelIds() : [],
    ]);
    return { actor, viewer, servers, allowedModels, catalogueModels };
  }

  /** `list_records`: the records the employee sees and, for an admin, the system records of the panel. */
  chatRecords(context: ChatContext): Promise<ChatRecord[]> {
    const { actor, viewer } = context;
    return this.records.logged(
      'chat_list',
      { viewerId: actor.id },
      async () => {
        const [visible, system] = await Promise.all([
          this.records.visible(this.records.db, viewer),
          actor.isAdmin ? this.records.panel(this.records.db, { list: 'system' }) : [],
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
    return this.records.logged(
      'chat_read',
      { viewerId: context.actor.id, recordId },
      async () => {
        const record = await this.chatTarget(this.records.db, context, recordId);
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
    return this.records.logged(
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
    return this.records.logged(
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
      const check = await this.saving.checkSave(request, this.records.db);
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
    const target = await this.chatTarget(this.records.db, context, change.recordId);
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
    const check = await this.saving.checkSave(request, this.records.db);
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
        await this.saving.save({ ...request, newId: card.recordId }, tx),
        request,
      );
    }
    if (card.previous === null)
      throw new Error(
        `${card.action} card of record ${card.recordId} has no previous version`,
      );
    if (!(await this.repository.lock(tx, card.recordId))) return chatRefused('not_found');
    const target = await this.chatTarget(tx, context, card.recordId);
    const scope = chatScope(target, context, card.action);
    if (scope.outcome === 'refused') return scope;
    const { record: current } = scope;
    if (current.version !== card.previous.version)
      return chatRefused('version_conflict');
    if (card.action === 'delete') {
      await this.records.deleteChecked(tx, context.actor.id, current);
      return { outcome: 'saved', recordId: current.id, version: null };
    }
    if (next === null)
      throw new Error(`edit card of record ${card.recordId} has no record`);
    const request = this.chatSaveRequest(context, scope.scope, current, {
      ...next,
      body: withSelfLearning(next.body, selfLearningOf(current.body)),
    });
    return chatSaved(await this.saving.save(request, tx), request);
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
    const visible = await this.records.visibleOne(executor, context.viewer, recordId);
    if (visible !== undefined || !context.actor.isAdmin) return visible;
    const inPanel = await this.records.panelOne(executor, recordId);
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
}
