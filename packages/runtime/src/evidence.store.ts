import { createHash, randomUUID } from 'node:crypto';
import {
  KnowledgeStatusSchema,
  TaskStatusSchema,
  type EvidenceInput,
  type EvidenceRef,
} from '@agent-os/contracts';
import { and, eq } from 'drizzle-orm';
import {
  researchEvidence,
  researchEvidenceContents,
  researchTasks,
} from '@agent-os/db';
import type { RuntimeTx } from './guarded-transition.js';

/** The attempt that writes the evidence: its task and fencing token. */
export interface EvidenceWriter {
  taskId: string;
  attempt: number;
}

export type PutEvidenceResult =
  | { status: 'stored' | 'existing'; ref: EvidenceRef }
  /** The attempt is not the task's current one, or the task row is gone. */
  | { status: 'fenced' };

/**
 * Evidence and its content (`bytea` with `sha256` and size, KD-6) inside the caller's
 * transaction. Idempotent by the task's evidence key: a repeat returns the stored ref.
 */
export class EvidenceStore {
  /**
   * Stores the evidence of the writer's attempt. The first touch is the task row
   * (FOR KEY SHARE, as the FK check of the insert): only a `running` task with this attempt
   * accepts it. Writes `observed`, the only status `putEvidence` writes. Throws when the key is
   * already stored with other content: provenance and content are immutable.
   */
  async put(
    tx: RuntimeTx,
    writer: EvidenceWriter,
    evidence: EvidenceInput,
  ): Promise<PutEvidenceResult> {
    const [task] = await tx
      .select({ investigationId: researchTasks.investigationId })
      .from(researchTasks)
      .where(
        and(
          eq(researchTasks.taskId, writer.taskId),
          eq(researchTasks.status, TaskStatusSchema.enum.running),
          eq(researchTasks.attempt, writer.attempt),
        ),
      )
      .for('key share');
    if (!task) return { status: 'fenced' };

    const { bytes } = evidence.content;
    const content = Buffer.from(
      bytes.buffer,
      bytes.byteOffset,
      bytes.byteLength,
    );
    const sha256 = createHash('sha256').update(content).digest('hex');
    const [inserted] = await tx
      .insert(researchEvidence)
      .values({
        evidenceId: randomUUID(),
        investigationId: task.investigationId,
        taskId: writer.taskId,
        evidenceKey: evidence.evidenceKey,
        writtenByAttempt: writer.attempt,
        knowledgeStatus: KnowledgeStatusSchema.enum.observed,
        scope: evidence.scope ?? null,
        basis: evidence.basis ?? null,
        evidenceVersion: evidence.evidenceVersion ?? null,
        provenance: evidence.provenance,
        coverage: evidence.coverage,
      })
      .onConflictDoNothing({
        target: [researchEvidence.taskId, researchEvidence.evidenceKey],
      })
      .returning({ evidenceId: researchEvidence.evidenceId });

    if (inserted) {
      await tx.insert(researchEvidenceContents).values({
        evidenceId: inserted.evidenceId,
        mediaType: evidence.content.mediaType,
        bytes: content,
        sha256,
        byteSize: content.byteLength,
      });
      const ref = {
        evidenceId: inserted.evidenceId,
        sha256,
        byteSize: content.byteLength,
      };
      return { status: 'stored', ref };
    }
    return {
      status: 'existing',
      ref: await this.existingRef(tx, writer, evidence, sha256),
    };
  }

  private async existingRef(
    tx: RuntimeTx,
    writer: EvidenceWriter,
    evidence: EvidenceInput,
    sha256: string,
  ): Promise<EvidenceRef> {
    const [existing] = await tx
      .select({
        evidenceId: researchEvidence.evidenceId,
        sha256: researchEvidenceContents.sha256,
        byteSize: researchEvidenceContents.byteSize,
      })
      .from(researchEvidence)
      .innerJoin(
        researchEvidenceContents,
        eq(researchEvidenceContents.evidenceId, researchEvidence.evidenceId),
      )
      .where(
        and(
          eq(researchEvidence.taskId, writer.taskId),
          eq(researchEvidence.evidenceKey, evidence.evidenceKey),
        ),
      );
    if (!existing) {
      throw new Error(
        `Evidence "${evidence.evidenceKey}" of task ${writer.taskId} conflicted but is not readable`,
      );
    }
    if (existing.sha256 !== sha256) {
      throw new Error(
        `Evidence "${evidence.evidenceKey}" of task ${writer.taskId} is already stored with other content`,
      );
    }
    return existing;
  }
}
