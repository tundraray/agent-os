import {
  researchAgentMessages,
  researchAgentRuns,
  researchAgentToolCalls,
  researchClaims,
  researchEngineRuns,
  researchEvidence,
  researchEvidenceContents,
  researchPlanRevisions,
} from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { and, asc, desc, eq, isNotNull, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { definitionMemoryFingerprint, type SnapshotEntry } from './fingerprint.js';
import type { FormDataReader } from './result-forms.js';

/**
 * The reader a `collect` step gets (design-agent-core.md, «Шаг чтения collect»): the data of the run's own investigation,
 * read inside the guarded transaction of its function — the plan, the claims, the record pages and records, the results
 * of finished runs, the engine row, the definition memory fingerprint of the run's definition by the snapshot, the tool
 * call rows (refused `call_agent` calls with their reason, parent run and number among them) and the tree's
 * `budgetExhausted`. It writes nothing.
 */

const PageContentSchema = z.object({ items: z.array(z.unknown()) });

/** The failure codes whose forced end the run row does not show: the reserve was refused by the investigation's budget. */
const INVESTIGATION_BUDGET_CODE = 'investigation_tokens_exhausted';

/**
 * `budgetExhausted` of an agent tree (DC-16): a `call_agent` of the root refused `budget_exhausted` — the root's rest is
 * the investigation's — a run that ended with class `budget_exhausted`, or a forced end that replaced a reserve refused
 * by the investigation's budget.
 */
export async function treeBudgetExhausted(tx: Pick<RuntimeTx, 'select'>, investigationId: string): Promise<boolean> {
  const [refusedCall] = await tx
    .select({ id: researchAgentToolCalls.id })
    .from(researchAgentToolCalls)
    .innerJoin(researchAgentRuns, eq(researchAgentRuns.taskId, researchAgentToolCalls.runTaskId))
    .where(
      and(
        eq(researchAgentToolCalls.investigationId, investigationId),
        eq(researchAgentToolCalls.toolName, 'call_agent'),
        eq(researchAgentToolCalls.state, 'rejected'),
        eq(researchAgentToolCalls.reason, 'budget_exhausted'),
        eq(researchAgentRuns.depth, 0),
      ),
    )
    .limit(1);
  if (refusedCall !== undefined) return true;
  const [failedRun] = await tx
    .select({ taskId: researchAgentRuns.taskId })
    .from(researchAgentRuns)
    .where(
      and(
        eq(researchAgentRuns.investigationId, investigationId),
        sql`${researchAgentRuns.failure}->>'class' = 'budget_exhausted'`,
      ),
    )
    .limit(1);
  if (failedRun !== undefined) return true;
  const [forcedEnd] = await tx
    .select({ seq: researchAgentMessages.seq })
    .from(researchAgentMessages)
    .where(
      and(
        eq(researchAgentMessages.investigationId, investigationId),
        eq(researchAgentMessages.kind, 'code_notice'),
        sql`${researchAgentMessages.content}->>'code' = 'forced_end'`,
        sql`${researchAgentMessages.content}->>'failureCode' = ${INVESTIGATION_BUDGET_CODE}`,
      ),
    )
    .limit(1);
  return forcedEnd !== undefined;
}

export function createFormDataReader(
  tx: RuntimeTx,
  run: { readonly investigationId: string; readonly snapshotEntries: readonly SnapshotEntry[] },
): FormDataReader {
  const { investigationId } = run;
  return {
    async plan() {
      const [latest] = await tx
        .select({ revision: researchPlanRevisions.revision, plan: researchPlanRevisions.plan })
        .from(researchPlanRevisions)
        .where(eq(researchPlanRevisions.investigationId, investigationId))
        .orderBy(desc(researchPlanRevisions.revision))
        .limit(1);
      return latest ?? null;
    },
    async claims() {
      const rows = await tx
        .selectDistinctOn([researchClaims.claimId], {
          claimId: researchClaims.claimId,
          seq: researchClaims.seq,
          text: researchClaims.text,
          status: researchClaims.status,
          atoms: researchClaims.atoms,
          pointer: researchClaims.pointer,
          confidence: researchClaims.confidence,
          evidenceIds: researchClaims.evidenceIds,
          coverage: researchClaims.coverage,
          taskId: researchClaims.taskId,
        })
        .from(researchClaims)
        .where(eq(researchClaims.investigationId, investigationId))
        .orderBy(researchClaims.claimId, desc(researchClaims.seq));
      return rows.sort((left, right) => left.seq - right.seq).map(({ seq: _seq, ...claim }) => claim);
    },
    recordPages() {
      return tx
        .select({
          page: researchEvidence.evidenceId,
          evidenceKey: researchEvidence.evidenceKey,
          provenance: researchEvidence.provenance,
          coverage: researchEvidence.coverage,
        })
        .from(researchEvidence)
        .where(eq(researchEvidence.investigationId, investigationId))
        .orderBy(asc(researchEvidence.createdAt), asc(researchEvidence.evidenceId));
    },
    async records(page, from) {
      if (!z.uuid().safeParse(page).success) return null;
      const [content] = await tx
        .select({ bytes: researchEvidenceContents.bytes })
        .from(researchEvidenceContents)
        .innerJoin(researchEvidence, eq(researchEvidence.evidenceId, researchEvidenceContents.evidenceId))
        .where(and(eq(researchEvidence.investigationId, investigationId), eq(researchEvidence.evidenceId, page)));
      if (content === undefined) return null;
      const parsed = PageContentSchema.safeParse(JSON.parse(Buffer.from(content.bytes).toString('utf8')));
      return parsed.success ? parsed.data.items.slice(from) : null;
    },
    runs() {
      return tx
        .select({
          run: researchAgentRuns.taskId,
          agent: researchAgentRuns.agentName,
          parent: researchAgentRuns.parentTaskId,
          parentCallIndex: researchAgentRuns.parentCallIndex,
          result: researchAgentRuns.result,
          failure: researchAgentRuns.failure,
        })
        .from(researchAgentRuns)
        .where(
          and(
            eq(researchAgentRuns.investigationId, investigationId),
            or(isNotNull(researchAgentRuns.result), isNotNull(researchAgentRuns.failure)),
          ),
        )
        .orderBy(asc(researchAgentRuns.createdAt), asc(researchAgentRuns.taskId));
    },
    async engineRun() {
      const [row] = await tx.select().from(researchEngineRuns).where(eq(researchEngineRuns.investigationId, investigationId));
      return row ?? null;
    },
    definitionMemoryFingerprint() {
      return Promise.resolve(definitionMemoryFingerprint(run.snapshotEntries));
    },
    toolCalls() {
      return tx
        .select({
          id: researchAgentToolCalls.id,
          run: researchAgentToolCalls.runTaskId,
          turn: researchAgentToolCalls.turn,
          callIndex: researchAgentToolCalls.callIndex,
          toolName: researchAgentToolCalls.toolName,
          arguments: researchAgentToolCalls.arguments,
          state: researchAgentToolCalls.state,
          outcome: researchAgentToolCalls.outcome,
          reason: researchAgentToolCalls.reason,
          childTaskId: researchAgentToolCalls.childTaskId,
          shareTokens: researchAgentToolCalls.shareTokens,
        })
        .from(researchAgentToolCalls)
        .where(eq(researchAgentToolCalls.investigationId, investigationId))
        .orderBy(asc(researchAgentToolCalls.createdAt), asc(researchAgentToolCalls.callIndex));
    },
    budgetExhausted() {
      return treeBudgetExhausted(tx, investigationId);
    },
  };
}
