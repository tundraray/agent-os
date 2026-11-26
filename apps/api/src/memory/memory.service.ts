import { Injectable } from '@nestjs/common';
import {
  type AgentMemoryView,
  type MemoryHistoryView,
  type MemoryRecordView,
  MemoryVersionKindSchema,
  type MyMemoryView,
  type RevertMemoryBody,
} from '@agent-os/contracts';
import { MemoryRecords } from '@agent-os/agents';
import {
  Db,
  type ListedMemoryRow,
  MemoriesRepository,
  type MemoryHistoryRow,
  type MemoryOwner,
} from '@agent-os/db';
import { apiError } from '../common/api-error';
import { isUuid } from '../common/is-uuid';
import { libraryError } from '../library/library.errors';
import { LibraryService } from '../library/library.service';
import type { LibraryActor } from '../library/library.types';

/** A deleted record keeps the text of its last version with text; `updatedAt` is its current version's time. */
function viewsOf(rows: readonly ListedMemoryRow[]): MemoryRecordView[] {
  return rows.map(({ id, description, kind, changedAt, lastText }) => ({
    id,
    description,
    text: lastText,
    deleted: kind === MemoryVersionKindSchema.enum.deleted,
    updatedAt: changedAt.toISOString(),
  }));
}

/** The agent's versions carry no author; a person is named by name, without one by email (KD-6). */
function versionViewsOf(rows: readonly MemoryHistoryRow[]) {
  return rows.map(
    ({ version, kind, text, changedAt, authorName, authorEmail }) => ({
      version,
      kind: MemoryVersionKindSchema.parse(kind),
      text,
      changedAt: changedAt.toISOString(),
      changedBy: authorName || authorEmail,
    }),
  );
}

/**
 * The memory screens (self-learning design-memory.md KD-5, memory-hygiene KD-3, KD-6, KD-7): an agent's memory
 * behind the library's access rule (`LibraryService.memoryTarget`), and the employee's own memory, whose owner is
 * only the signed-in employee. Another owner's record answers as a missing one: history and revert 404, delete
 * silent. A revert goes through `MemoryRecords` in this service's transaction.
 */
@Injectable()
export class MemoryService {
  constructor(
    private readonly db: Db,
    private readonly library: LibraryService,
    private readonly rows: MemoriesRepository,
    private readonly records: MemoryRecords,
  ) {}

  async agentMemory(
    actor: LibraryActor,
    agentId: string,
  ): Promise<AgentMemoryView> {
    const target = await this.library.memoryTarget(actor, agentId);
    const rows = await this.rows.list({ agentId: target.agentId });
    return { selfLearning: target.selfLearning, records: viewsOf(rows) };
  }

  async agentHistory(
    actor: LibraryActor,
    agentId: string,
    memoryId: string,
  ): Promise<MemoryHistoryView> {
    const target = await this.library.memoryTarget(actor, agentId);
    return this.historyOf({ agentId: target.agentId }, memoryId);
  }

  async revertAgentMemory(
    actor: LibraryActor,
    agentId: string,
    memoryId: string,
    body: RevertMemoryBody,
  ): Promise<MemoryHistoryView> {
    const target = await this.library.memoryTarget(actor, agentId);
    return this.revert({ agentId: target.agentId }, memoryId, body, actor.id);
  }

  async deleteAgentMemory(
    actor: LibraryActor,
    agentId: string,
    memoryId: string,
  ): Promise<void> {
    const target = await this.library.memoryTarget(actor, agentId);
    if (isUuid(memoryId))
      await this.rows.deleteById({ agentId: target.agentId }, memoryId);
  }

  async myMemory(userId: string): Promise<MyMemoryView> {
    return { records: viewsOf(await this.rows.list({ userId })) };
  }

  myHistory(userId: string, memoryId: string): Promise<MemoryHistoryView> {
    return this.historyOf({ userId }, memoryId);
  }

  revertMyMemory(
    userId: string,
    memoryId: string,
    body: RevertMemoryBody,
  ): Promise<MemoryHistoryView> {
    return this.revert({ userId }, memoryId, body, userId);
  }

  async deleteMyMemory(userId: string, memoryId: string): Promise<void> {
    if (isUuid(memoryId)) await this.rows.deleteById({ userId }, memoryId);
  }

  /** 404 → 409 → 400 (plan Notes 2.6); the new history is read in the revert's transaction. */
  private revert(
    owner: MemoryOwner,
    memoryId: string,
    body: RevertMemoryBody,
    authorId: string,
  ): Promise<MemoryHistoryView> {
    if (!isUuid(memoryId)) throw libraryError('RECORD_NOT_FOUND');
    return this.db.transaction(async () => {
      const change = await this.records.revert(owner, memoryId, body, authorId);
      if (change.kind === 'missing') throw libraryError('RECORD_NOT_FOUND');
      if (change.kind === 'changed')
        throw libraryError('RECORD_VERSION_CONFLICT');
      if (change.kind === 'invalid_source')
        throw apiError(400, 'VALIDATION_FAILED', [
          'version: the current version, a deletion or a version the record never had',
        ]);
      return this.historyOf(owner, memoryId);
    });
  }

  /** The owner's record's history; not a uuid, missing or another owner's — 404. */
  private async historyOf(
    owner: MemoryOwner,
    memoryId: string,
  ): Promise<MemoryHistoryView> {
    if (!isUuid(memoryId)) throw libraryError('RECORD_NOT_FOUND');
    const record = await this.rows.currentById(owner, memoryId);
    if (record === undefined) throw libraryError('RECORD_NOT_FOUND');
    return {
      description: record.description,
      versions: versionViewsOf(await this.rows.history(memoryId)),
    };
  }
}
