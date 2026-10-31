import {
  CoverageSchema,
  type EvidenceRecord,
  KnowledgeStatusSchema,
  ProvenanceSchema,
} from '@agent-os/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { type Database, DRIZZLE } from '../database/database.module.js';
import {
  researchEvidence,
  researchEvidenceContents,
  researchInvestigations,
} from '../database/schema.js';

/** No evidence with this id among the owner's investigations. */
class EvidenceNotFoundError extends Error {
  override readonly name = 'EvidenceNotFoundError';
  readonly code = 'evidence_not_found';
}

/** A stored evidence with its content bytes. */
export interface StoredEvidence {
  record: EvidenceRecord;
  bytes: Uint8Array;
}

/**
 * Reads evidence for its owner: the record and the content bytes, filtered by the
 * investigation's `resource_id` (Security Considerations).
 */
@Injectable()
export class EvidenceReader {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  /** Throws `evidence_not_found` when the evidence is missing or another owner's. */
  async get(evidenceId: string, resourceId: string): Promise<StoredEvidence> {
    if (!resourceId) {
      throw new Error('EvidenceReader: resourceId must not be empty');
    }
    const [row] = await this.db
      .select({
        evidence: researchEvidence,
        content: researchEvidenceContents,
      })
      .from(researchEvidence)
      .innerJoin(
        researchEvidenceContents,
        eq(researchEvidenceContents.evidenceId, researchEvidence.evidenceId),
      )
      .innerJoin(
        researchInvestigations,
        eq(
          researchInvestigations.investigationId,
          researchEvidence.investigationId,
        ),
      )
      .where(
        and(
          eq(researchEvidence.evidenceId, evidenceId),
          eq(researchInvestigations.resourceId, resourceId),
        ),
      );
    if (!row) {
      throw new EvidenceNotFoundError(`Evidence ${evidenceId} not found`);
    }
    const { evidence, content } = row;
    return {
      record: {
        evidenceId: evidence.evidenceId,
        sha256: content.sha256,
        byteSize: content.byteSize,
        taskId: evidence.taskId,
        writtenByAttempt: evidence.writtenByAttempt,
        evidenceKey: evidence.evidenceKey,
        provenance: ProvenanceSchema.parse(evidence.provenance),
        coverage: CoverageSchema.parse(evidence.coverage),
        mediaType: content.mediaType,
        knowledgeStatus: KnowledgeStatusSchema.parse(evidence.knowledgeStatus),
        scope: evidence.scope,
        basis: evidence.basis,
        evidenceVersion: evidence.evidenceVersion,
        createdAt: evidence.createdAt.toISOString(),
      },
      bytes: new Uint8Array(
        content.bytes.buffer,
        content.bytes.byteOffset,
        content.bytes.byteLength,
      ),
    };
  }
}
