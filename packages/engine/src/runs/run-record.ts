import { createHash } from 'node:crypto';
import { type Provenance, ProvenanceSchema } from '@agent-os/contracts';
import { type Database, researchClaims, researchEvidence, researchLlmCalls, researchTasks } from '@agent-os/db';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { VERIFY_WORKFLOW } from '../capabilities/verify.js';
import { type ProcessConfig, ProcessConfigSchema } from '../config/process-config.schema.js';
import { controllerRepository, type DecisionRow } from '../controller/decisions.repository.js';
import { type InvestigationView, type InvestigationViewStatus, toInvestigationView } from '../view/investigation-view.js';
import { usageRepository } from '../view/usage.repository.js';
import { engineRunsRepository } from './engine-runs.repository.js';
import type { SourceSnapshots } from './source-snapshots.js';

/**
 * Everything the self-check needs about a finished or running investigation (design-self-check.md, Contract
 * Definitions: `RunRecord`). Values are passed on as the engine stores them, so the `engine` part can add fields and
 * statuses without this contract changing.
 */
export interface RunRecord {
  readonly investigationId: string;
  readonly ownerId: string;
  readonly query: string;
  /** The value of `InvestigationView.status`, whatever its source (design-lifecycle.md, KD-1). */
  readonly status: InvestigationViewStatus;
  readonly config: RunRecordConfig;
  /** Null for an investigation started before the slices were recorded; a slice is null when it was not read in time. */
  readonly sourceSnapshots: SourceSnapshots | null;
  /** As `InvestigationView.answer` gives it, `removed` included; null until the investigation is answered. */
  readonly answer: InvestigationView['answer'];
  /** The latest revision of each claim, in the order the claims were first written. */
  readonly claims: readonly RunRecordClaim[];
  /** Every recorded controller output by step and call, attempts before a task restart included. */
  readonly decisions: readonly RunRecordDecision[];
  /** By time, then by identifier. */
  readonly evidence: readonly RunRecordEvidence[];
  readonly usage: InvestigationView['usage'];
  /** The ledger rows by time, then by identifier. */
  readonly calls: readonly RunRecordCall[];
}

interface RunRecordConfig {
  /** The frozen `ProcessConfig` of the investigation (DC-15). */
  readonly processConfig: ProcessConfig;
  /** The first 12 hexadecimal characters of SHA-256 of the configuration with its keys sorted at every depth. */
  readonly fingerprint: string;
}

interface RunRecordClaim {
  readonly claimId: string;
  readonly text: string;
  /** Any status the engine stores for a claim revision. */
  readonly status: string;
  /** Each atom as the latest revision stores it. */
  readonly atoms: readonly unknown[];
  /** The evidence pages the claim rests on: the pages of its pointer, or the basis of its check. */
  readonly evidenceIds: readonly string[];
  // The fields the engine part adds (design-engine.md, Contract Definitions, «RunRecord — добавленные поля»).
  // `readRunRecord` always sets them; they stay optional in the type, so a record a consumer builds by hand without
  // them is still a run record (design-self-check.md: the engine part adds fields without the contract changing).
  /** The pages and record numbers the claim rests on, as stored; null on revisions written before agent-quality. */
  readonly pointer?: unknown;
  /** The type the verifier's assessment gave; null until a check decided it. */
  readonly claimType?: string | null;
  /** The confidence group of a `supported` claim; null otherwise. */
  readonly confidence?: string | null;
  /**
   * The verifier's answer and whether it broke the form; on an `insufficient` decided without a call, no answer and the
   * reason (`pointer_invalid`, `needs_narrowing`); null on a revision no check wrote.
   */
  readonly assessment?: unknown;
  /** The check task whose transcripts hold the verifier call; null when the latest revision is not a check's. */
  readonly checkTaskId?: string | null;
}

interface RunRecordDecisionBase {
  readonly decisionId: string;
  readonly step: number;
  readonly callIndex: number;
  /** The controller model, or code without a model call (KD-8). */
  readonly decidedBy: string;
  readonly decidedAt: Date;
}

type RunRecordDecision =
  | (RunRecordDecisionBase & { readonly status: 'accepted'; readonly kind: string })
  | (RunRecordDecisionBase & {
      readonly status: 'rejected';
      /** Null when the model named no recognised kind. */
      readonly kind: string | null;
      /** The code from the engine's closed list of rejection reasons. */
      readonly rejectionReason: string;
    });

interface RunRecordEvidence {
  readonly evidenceId: string;
  /** Where the records came from, with the slice they were read on. */
  readonly provenance: Provenance;
  readonly createdAt: Date;
}

interface RunRecordCall {
  readonly callId: string;
  readonly role: string;
  readonly model: string;
  /** The ledger status: `reserved`, then `settled`, `failed` or `abandoned`. */
  readonly status: string;
  readonly createdAt: Date;
  readonly closedAt: Date | null;
}

export type ReadRunRecordResult =
  | { readonly outcome: 'found'; readonly record: RunRecord }
  | { readonly outcome: 'rejected'; readonly code: 'investigation_not_found' };

const NOT_FOUND: ReadRunRecordResult = { outcome: 'rejected', code: 'investigation_not_found' };

const CONFIG_FINGERPRINT_LENGTH = 12;

const SourceSnapshotsSchema = z.record(z.string(), z.string().nullable()).nullable();
const AtomsSchema = z.array(z.unknown());

/**
 * Reads the run record of an investigation over the database alone, without building an engine. Another owner, an
 * absent or a deleted investigation (its rows go with it) answers `investigation_not_found`, as `readInvestigation`
 * does.
 */
export async function readRunRecord(
  db: Database,
  { investigationId, ownerId }: { readonly investigationId: string; readonly ownerId: string },
): Promise<ReadRunRecordResult> {
  if (!z.uuid().safeParse(investigationId).success) {
    return NOT_FOUND;
  }
  const runStatus = await engineRunsRepository.readStatus(db, investigationId, ownerId);
  if (runStatus === undefined) {
    return NOT_FOUND;
  }
  const [recorded, usageRows, claims, decisions, evidence, calls] = await Promise.all([
    controllerRepository.readRun(db, investigationId),
    usageRepository.byRoleAndModel(db, investigationId),
    latestClaims(db, investigationId),
    controllerRepository.decisionsOf(db, investigationId),
    evidenceOf(db, investigationId),
    callsOf(db, investigationId),
  ]);
  if (recorded === undefined) {
    // Deleted between the two reads.
    return NOT_FOUND;
  }
  const view = toInvestigationView(runStatus, usageRows);
  const processConfig = ProcessConfigSchema.parse(runStatus.run.processConfig);
  return {
    outcome: 'found',
    record: {
      investigationId,
      ownerId,
      query: recorded.query,
      status: view.status,
      config: { processConfig, fingerprint: configFingerprint(processConfig) },
      sourceSnapshots: SourceSnapshotsSchema.parse(runStatus.run.sourceSnapshots),
      answer: view.answer,
      claims,
      decisions: decisions.map(toDecision),
      evidence,
      usage: view.usage,
      calls,
    },
  };
}

/**
 * The fingerprint a run record names its configuration by. Stable over the key order a `jsonb` column returns: the same
 * configuration always gives the same fingerprint, so a caller without a record can name a loaded configuration the same way.
 */
export function configFingerprint(config: ProcessConfig): string {
  return createHash('sha256')
    .update(JSON.stringify(sortedKeys(config)), 'utf8')
    .digest('hex')
    .slice(0, CONFIG_FINGERPRINT_LENGTH);
}

/** The value with the keys of every object sorted; arrays keep their order. */
function sortedKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortedKeys((value as Record<string, unknown>)[key])]),
  );
}

/** Revisions are only appended, so the last one read in `seq` order is the latest; a Map keeps first-written order. */
async function latestClaims(db: Database, investigationId: string): Promise<RunRecordClaim[]> {
  const revisions = await db
    .select({
      claimId: researchClaims.claimId,
      text: researchClaims.text,
      status: researchClaims.status,
      atoms: researchClaims.atoms,
      evidenceIds: researchClaims.evidenceIds,
      pointer: researchClaims.pointer,
      claimType: researchClaims.claimType,
      confidence: researchClaims.confidence,
      assessment: researchClaims.assessment,
      taskId: researchClaims.taskId,
      workflowType: researchTasks.workflowType,
    })
    .from(researchClaims)
    .innerJoin(researchTasks, eq(researchTasks.taskId, researchClaims.taskId))
    .where(eq(researchClaims.investigationId, investigationId))
    .orderBy(asc(researchClaims.seq));
  const latest = new Map<string, RunRecordClaim>();
  for (const { taskId, workflowType, ...revision } of revisions) {
    latest.set(revision.claimId, {
      ...revision,
      atoms: AtomsSchema.parse(revision.atoms),
      checkTaskId: workflowType === VERIFY_WORKFLOW ? taskId : null,
    });
  }
  return [...latest.values()];
}

/** The table's CHECKs tie the kind to `accepted` and the reason to `rejected`; a row breaking them is a defect. */
function toDecision(row: DecisionRow): RunRecordDecision {
  const base: RunRecordDecisionBase = {
    decisionId: row.decisionId,
    step: row.step,
    callIndex: row.callIndex,
    decidedBy: row.decidedBy,
    decidedAt: row.createdAt,
  };
  if (row.status === 'accepted' && row.kind !== null) {
    return { ...base, status: 'accepted', kind: row.kind };
  }
  if (row.status === 'rejected' && row.rejectionReason !== null) {
    return { ...base, status: 'rejected', kind: row.kind, rejectionReason: row.rejectionReason };
  }
  throw new Error(`research_decisions row ${row.decisionId} breaks the status, kind and reason rule`);
}

async function evidenceOf(db: Database, investigationId: string): Promise<RunRecordEvidence[]> {
  const rows = await db
    .select({
      evidenceId: researchEvidence.evidenceId,
      provenance: researchEvidence.provenance,
      createdAt: researchEvidence.createdAt,
    })
    .from(researchEvidence)
    .where(eq(researchEvidence.investigationId, investigationId))
    .orderBy(asc(researchEvidence.createdAt), asc(researchEvidence.evidenceId));
  return rows.map((row) => ({ ...row, provenance: ProvenanceSchema.parse(row.provenance) }));
}

function callsOf(db: Database, investigationId: string): Promise<RunRecordCall[]> {
  return db
    .select({
      callId: researchLlmCalls.callId,
      role: researchLlmCalls.role,
      model: researchLlmCalls.model,
      status: researchLlmCalls.status,
      createdAt: researchLlmCalls.createdAt,
      closedAt: researchLlmCalls.closedAt,
    })
    .from(researchLlmCalls)
    .where(eq(researchLlmCalls.investigationId, investigationId))
    .orderBy(asc(researchLlmCalls.createdAt), asc(researchLlmCalls.callId));
}
