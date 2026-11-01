import { type Database, researchLlmCalls } from '@agent-os/db';
import { type AnyColumn, eq, sql } from 'drizzle-orm';

/** One role and model of the investigation's ledger, summed over its calls (AC-11.1). */
export interface RoleModelUsageRow {
  readonly role: string;
  readonly model: string;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  /** The `numeric` sum as Postgres returns it. */
  readonly costUsd: string;
}

const summed = (column: AnyColumn) => sql<number>`coalesce(sum(${column}), 0)::int`;

/**
 * Queries of `research_llm_calls` for the view (ADR-0003: drizzle-orm). A row's usage is null while it is reserved or
 * when the provider reported none: it counts as a call with no tokens and no cost.
 */
export const usageRepository = {
  async byRoleAndModel(db: Database, investigationId: string): Promise<RoleModelUsageRow[]> {
    return db
      .select({
        role: researchLlmCalls.role,
        model: researchLlmCalls.model,
        calls: sql<number>`count(*)::int`,
        inputTokens: summed(researchLlmCalls.inputTokens),
        outputTokens: summed(researchLlmCalls.outputTokens),
        cacheReadTokens: summed(researchLlmCalls.cacheReadTokens),
        cacheWriteTokens: summed(researchLlmCalls.cacheWriteTokens),
        costUsd: sql<string>`coalesce(sum(${researchLlmCalls.costUsd}), 0)::text`,
      })
      .from(researchLlmCalls)
      .where(eq(researchLlmCalls.investigationId, investigationId))
      .groupBy(researchLlmCalls.role, researchLlmCalls.model);
  },
};
