import { type Database, researchAgentMemory } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { and, asc, eq, gt, type SQL } from 'drizzle-orm';

/** The kinds of a note (design-agent-core.md, `memory_write`). */
export type NoteKind = 'finding' | 'tried' | 'dead_end' | 'note';

/** A reference of a note to a record or a claim of the same investigation; `memory_write` checks it belongs (DC-4). */
export interface NoteRef {
  readonly type: 'record' | 'claim';
  readonly id: string;
}

export interface NewNote {
  readonly investigationId: string;
  /** The run and agent that write the note. */
  readonly runTaskId: string;
  readonly agentName: string;
  readonly kind: NoteKind;
  readonly text: string;
  readonly refs: readonly NoteRef[];
}

export type NoteRow = typeof researchAgentMemory.$inferSelect;

/** What `memory_read` filters by: the kind, the authoring agent, the notes after a note number. */
export interface NoteFilter {
  readonly kind?: NoteKind;
  readonly author?: string;
  readonly after?: number;
}

/**
 * `research_agent_memory` (FR-03): notes are only added. Their number comes from the table's database sequence, never
 * from «the largest number plus one», so two notes written at the same time are both kept with distinct numbers
 * (AC-03.3); the numbers grow in the order of writing.
 */
export const investigationMemoryRepository = {
  /** Adds the note inside the caller's guarded transaction and returns its number. */
  async append(tx: RuntimeTx, note: NewNote): Promise<number> {
    const [row] = await tx
      .insert(researchAgentMemory)
      .values({
        investigationId: note.investigationId,
        runTaskId: note.runTaskId,
        agentName: note.agentName,
        kind: note.kind,
        text: note.text,
        refs: [...note.refs],
      })
      .returning({ seq: researchAgentMemory.seq });
    if (row === undefined) throw new Error(`note of run ${note.runTaskId} was not written`);
    return row.seq;
  },

  /** The investigation's notes passing `filter`, oldest first (the newest last), at most `limit`. */
  read(db: Database | RuntimeTx, investigationId: string, filter: NoteFilter, limit: number): Promise<NoteRow[]> {
    const conditions: SQL[] = [eq(researchAgentMemory.investigationId, investigationId)];
    if (filter.kind !== undefined) conditions.push(eq(researchAgentMemory.kind, filter.kind));
    if (filter.author !== undefined) conditions.push(eq(researchAgentMemory.agentName, filter.author));
    if (filter.after !== undefined) conditions.push(gt(researchAgentMemory.seq, filter.after));
    return db
      .select()
      .from(researchAgentMemory)
      .where(and(...conditions))
      .orderBy(asc(researchAgentMemory.seq))
      .limit(limit);
  },
};
