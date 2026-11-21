import { Inject, Injectable } from '@nestjs/common';
import type { Agents } from '@agent-os/agents';
import type { DraftActionRequest, DraftView } from '@agent-os/contracts';
import type { Database, DatabaseConnection } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { AGENTS } from '../agents/agents.tokens';
import { isUuid } from '../common/is-uuid';
import { libraryError } from '../library/library.errors';
import { LibraryService } from '../library/library.service';
import { RUNTIME_DATABASE } from '../runtime/runtime.tokens';
import { httpError } from './chat.errors';
import { toDraftView } from './conversation-view';
import {
  type Draft,
  listDrafts,
  lockDraft,
  resolveDraft,
  setDraftRefusal,
} from './drafts.repository';

/**
 * The employee's answer to a record draft (design-runtime.md, KD-6, Flow 3, DC-8, DC-9): the draft is
 * found only in the employee's own conversation, and its row is locked for the whole action, so a
 * draft is resolved once and a superseded one is never saved. The library record is created or changed
 * only here, by `LibraryService.saveOwn` in the draft's transaction with the servers usable to the
 * employee; a refusal of `saveOwn` keeps the draft waiting with its reason.
 */
@Injectable()
export class DraftsService {
  private readonly db: Database;

  constructor(
    @Inject(RUNTIME_DATABASE) database: DatabaseConnection,
    private readonly library: LibraryService,
    @Inject(AGENTS) private readonly agents: Agents,
  ) {
    this.db = database.db;
  }

  /** Every draft of a conversation, oldest first; the caller has checked the conversation's owner. */
  async list(conversationId: string): Promise<DraftView[]> {
    return (await listDrafts(this.db, conversationId)).map(toDraftView);
  }

  /**
   * One action on the draft `draftId` of the owner's conversation `threadId`. A missing draft, another
   * employee's, one of another conversation and an id that is not a UUID answer the same 404
   * DRAFT_NOT_FOUND; a draft of a deleted conversation answers as another employee's (its rows stay,
   * its root session does not). A draft that no longer waits — 409 DRAFT_RESOLVED.
   */
  async act(
    threadId: string,
    draftId: string,
    ownerId: string,
    action: DraftActionRequest,
  ): Promise<DraftView> {
    if (!isUuid(threadId) || !isUuid(draftId))
      throw httpError('DRAFT_NOT_FOUND');
    if ((await this.agents.sessions.root(threadId, ownerId)) === undefined)
      throw httpError('DRAFT_NOT_FOUND');
    const usableServers =
      action.action === 'save' ? await this.agents.mcp.usable(ownerId) : [];
    const draft = await this.db.transaction(async (tx) => {
      const locked = await lockDraft(tx, {
        draftId,
        conversationId: threadId,
        ownerId,
      });
      if (locked === undefined) throw httpError('DRAFT_NOT_FOUND');
      if (locked.state !== 'pending') throw httpError('DRAFT_RESOLVED');
      switch (action.action) {
        case 'save':
          return this.save(
            tx,
            locked,
            ownerId,
            action.name ?? locked.name,
            usableServers,
          );
        case 'reject':
          return resolveDraft(tx, locked.id, {
            state: 'rejected',
            name: locked.name,
            savedRecordId: null,
          });
        case 'saved_in_editor':
          return this.savedInEditor(tx, locked, ownerId, action.recordId);
      }
    });
    return toDraftView(draft);
  }

  /**
   * `saveOwn` in the transaction that locked the draft's row, so the record, its audit event and the
   * draft's resolution commit together: saved — the draft ends; refused — it waits with the reason.
   */
  private async save(
    tx: RuntimeTx,
    draft: Draft,
    ownerId: string,
    name: string,
    usableServers: readonly string[],
  ): Promise<Draft> {
    const target =
      draft.recordId === null || draft.baseVersion === null
        ? null
        : { id: draft.recordId, version: draft.baseVersion };
    const result = await this.library.saveOwn(
      ownerId,
      {
        target,
        kind: draft.body.kind,
        name,
        description: draft.description,
        content: draft.body.content,
      },
      usableServers,
      tx,
    );
    if (result.outcome === 'refused')
      return setDraftRefusal(tx, draft.id, result.reason);
    return resolveDraft(tx, draft.id, {
      state: 'saved',
      name,
      savedRecordId: result.record.id,
    });
  }

  /**
   * The employee saved the draft through the editor as their own record `recordId`; another's, an
   * invisible or a missing record is 404 RECORD_NOT_FOUND and the draft keeps waiting.
   */
  private async savedInEditor(
    tx: RuntimeTx,
    draft: Draft,
    ownerId: string,
    recordId: string,
  ): Promise<Draft> {
    const record = await this.library.resolve(ownerId, recordId);
    if (record === null || !record.mine) throw libraryError('RECORD_NOT_FOUND');
    return resolveDraft(tx, draft.id, {
      state: 'saved_in_editor',
      name: draft.name,
      savedRecordId: record.id,
    });
  }
}
