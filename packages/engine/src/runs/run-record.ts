import { createHash } from 'node:crypto';
import { type Provenance, ProvenanceSchema } from '@agent-os/contracts';
import {
  type Database,
  researchAgentRuns,
  researchClaims,
  researchEvidence,
  researchLlmCalls,
  researchPlanRevisions,
} from '@agent-os/db';
import { type AnyColumn, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { type AgentTree, readAgentTree } from '../agents/agent-tree.js';
import type { AgentProcessConfig } from '../config/agent-config.schema.js';
import {
  frozenProcessConfig,
  type InvestigationView,
  type InvestigationViewStatus,
  toInvestigationView,
} from '../view/investigation-view.js';
import { usageRepository } from '../view/usage.repository.js';
import { engineRunsRepository } from './engine-runs.repository.js';
import type { SourceCatalog } from './source-catalog.js';

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
  /**
   * The source catalog recorded at start, as `readAgentTree` gives it (design-catalog-planning.md, KD-1): a slice is
   * null when it was not read in time; empty for an investigation on model knowledge.
   */
  readonly catalog: SourceCatalog;
  /** As `InvestigationView.answer` gives it, `removed` included; null until the investigation is answered. */
  readonly answer: InvestigationView['answer'];
  /** The latest revision of each claim, in the order the claims were first written. */
  readonly claims: readonly RunRecordClaim[];
  /** By time, then by identifier. */
  readonly evidence: readonly RunRecordEvidence[];
  readonly usage: RunRecordUsage;
  /** The ledger rows by time, then by identifier. */
  readonly calls: readonly RunRecordCall[];
  /** The agent tree with every tool call, its outcome and refusal reason. */
  readonly agentTree: AgentTree;
  /**
   * The plan revisions `plan_write` accepted, by revision number from 1 (design-catalog-planning.md, FR-10): a refused
   * plan writes no revision, so the first one here is the first accepted plan. Empty when no plan was accepted.
   */
  readonly planRevisions: readonly RunRecordPlanRevision[];
}

interface RunRecordPlanRevision {
  readonly revision: number;
  /** The plan as stored: the goal, readiness criteria and branches, each with its `sources`. */
  readonly plan: unknown;
}

type RunRecordUsage = InvestigationView['usage'] & {
  /** The ledger by agent and model, in the order of the agent names, then the models. */
  readonly byAgentAndModel: readonly AgentModelUsage[];
};

/** Calls of one agent's runs on one model, as the ledger recorded them. */
interface AgentModelUsage {
  readonly agentName: string;
  readonly model: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly costUsd: number;
}

interface RunRecordConfig {
  /** The frozen configuration of the investigation (DC-15, DC-29). */
  readonly processConfig: AgentProcessConfig;
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
}

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
  /** The agent of the run that made the call; null for a call outside an agent run. */
  readonly agentName: string | null;
  /** The run's task, `AgentTreeRun.runTaskId`; null for a call outside an agent run. */
  readonly agentRunId: string | null;
}

export type ReadRunRecordResult =
  | { readonly outcome: 'found'; readonly record: RunRecord }
  | { readonly outcome: 'rejected'; readonly code: 'investigation_not_found' };

const NOT_FOUND: ReadRunRecordResult = { outcome: 'rejected', code: 'investigation_not_found' };

const CONFIG_FINGERPRINT_LENGTH = 12;

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
  const processConfig = frozenProcessConfig(runStatus.run.processConfig);
  const [recorded, usageRows, byAgentAndModel, claims, evidence, calls, treeRead, planRevisions] = await Promise.all([
    engineRunsRepository.readRun(db, investigationId),
    usageRepository.byRoleAndModel(db, investigationId),
    usageByAgentAndModel(db, investigationId),
    latestClaims(db, investigationId),
    evidenceOf(db, investigationId),
    callsOf(db, investigationId),
    readAgentTree(db, { investigationId, resourceId: ownerId }),
    planRevisionsOf(db, investigationId),
  ]);
  if (recorded === undefined || treeRead.outcome === 'rejected') {
    // Deleted between the two reads.
    return NOT_FOUND;
  }
  const view = toInvestigationView(runStatus, usageRows);
  return {
    outcome: 'found',
    record: {
      investigationId,
      ownerId,
      query: recorded.query,
      status: view.status,
      config: { processConfig, fingerprint: configFingerprint(processConfig) },
      catalog: treeRead.tree.catalog,
      answer: view.answer,
      claims,
      evidence,
      usage: { ...view.usage, byAgentAndModel },
      calls,
      agentTree: treeRead.tree,
      planRevisions,
    },
  };
}

/**
 * The fingerprint a run record names its configuration by. Stable over the key order a `jsonb` column returns: the same
 * configuration always gives the same fingerprint, so a caller without a record can name a loaded configuration the same way.
 */
export function configFingerprint(config: AgentProcessConfig): string {
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
    })
    .from(researchClaims)
    .where(eq(researchClaims.investigationId, investigationId))
    .orderBy(asc(researchClaims.seq));
  const latest = new Map<string, RunRecordClaim>();
  for (const revision of revisions) {
    latest.set(revision.claimId, { ...revision, atoms: AtomsSchema.parse(revision.atoms) });
  }
  return [...latest.values()];
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

const summedTokens = (column: AnyColumn) => sql<number>`coalesce(sum(${column}), 0)::int`;

/** The ledger rows of the agent runs: a row's usage is null while reserved or unreported, a call with no tokens and no cost. */
async function usageByAgentAndModel(db: Database, investigationId: string): Promise<AgentModelUsage[]> {
  const rows = await db
    .select({
      agentName: researchAgentRuns.agentName,
      model: researchLlmCalls.model,
      calls: sql<number>`count(*)::int`,
      inputTokens: summedTokens(researchLlmCalls.inputTokens),
      outputTokens: summedTokens(researchLlmCalls.outputTokens),
      cacheReadTokens: summedTokens(researchLlmCalls.cacheReadTokens),
      cacheWriteTokens: summedTokens(researchLlmCalls.cacheWriteTokens),
      costUsd: sql<string>`coalesce(sum(${researchLlmCalls.costUsd}), 0)::text`,
    })
    .from(researchLlmCalls)
    .innerJoin(researchAgentRuns, eq(researchAgentRuns.taskId, researchLlmCalls.taskId))
    .where(eq(researchLlmCalls.investigationId, investigationId))
    .groupBy(researchAgentRuns.agentName, researchLlmCalls.model)
    .orderBy(asc(researchAgentRuns.agentName), asc(researchLlmCalls.model));
  return rows.map((row) => ({ ...row, costUsd: Number(row.costUsd) }));
}

function planRevisionsOf(db: Database, investigationId: string): Promise<RunRecordPlanRevision[]> {
  return db
    .select({ revision: researchPlanRevisions.revision, plan: researchPlanRevisions.plan })
    .from(researchPlanRevisions)
    .where(eq(researchPlanRevisions.investigationId, investigationId))
    .orderBy(asc(researchPlanRevisions.revision));
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
      agentName: researchAgentRuns.agentName,
      agentRunId: researchAgentRuns.taskId,
    })
    .from(researchLlmCalls)
    .leftJoin(researchAgentRuns, eq(researchAgentRuns.taskId, researchLlmCalls.taskId))
    .where(eq(researchLlmCalls.investigationId, investigationId))
    .orderBy(asc(researchLlmCalls.createdAt), asc(researchLlmCalls.callId));
}
