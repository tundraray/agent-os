import { Injectable } from '@nestjs/common';
import type {
  AgentMemoryView,
  MemoryRecordView,
  MyMemoryView,
} from '@agent-os/contracts';
import { MemoriesRepository, type MemoryRow } from '@agent-os/db';
import { isUuid } from '../common/is-uuid';
import { LibraryService } from '../library/library.service';
import type { LibraryActor } from '../library/library.types';

function viewsOf(rows: readonly MemoryRow[]): MemoryRecordView[] {
  return rows.map(({ id, description, text, updatedAt }) => ({
    id,
    description,
    text,
    updatedAt: updatedAt.toISOString(),
  }));
}

/**
 * The memory screens (self-learning design-memory.md KD-5): an agent's memory behind the library's access rule
 * (`LibraryService.memoryTarget`), and the employee's own memory, whose owner is only the signed-in employee. A
 * delete acts only inside its owner and is silent: a record already gone, another owner's or an id that is not a
 * uuid changes nothing.
 */
@Injectable()
export class MemoryService {
  constructor(
    private readonly library: LibraryService,
    private readonly rows: MemoriesRepository,
  ) {}

  async agentMemory(
    actor: LibraryActor,
    agentId: string,
  ): Promise<AgentMemoryView> {
    const target = await this.library.memoryTarget(actor, agentId);
    const rows = await this.rows.list({ agentId: target.agentId });
    return { selfLearning: target.selfLearning, records: viewsOf(rows) };
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

  async deleteMyMemory(userId: string, memoryId: string): Promise<void> {
    if (isUuid(memoryId)) await this.rows.deleteById({ userId }, memoryId);
  }
}
