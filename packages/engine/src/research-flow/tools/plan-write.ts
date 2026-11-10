import { researchPlanRevisions } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { ToolRegistryEntry } from '../../agents/tool-registry.js';
import type { ImmediateTool } from '../../agents/tools/tool-context.js';

/** Bounds of one text and of a list, in line with `memory_write` and `call_agent`. */
const TEXT_MAX_CHARS = 2_000;
const LIST_MAX_ITEMS = 20;
const PlanTextSchema = z.string().max(TEXT_MAX_CHARS);

/** A plan revision's readiness criteria and branches (design-engine.md, the plan's revision). */
const PlanOutputSchema = z.object({
  readinessCriteria: z.array(PlanTextSchema).max(LIST_MAX_ITEMS),
  branches: z.array(z.object({ question: PlanTextSchema, approach: PlanTextSchema })).max(LIST_MAX_ITEMS),
});

/** A plan revision as stored: the goal of the configuration with the criteria and branches of the revision. */
interface PlanContent extends z.infer<typeof PlanOutputSchema> {
  readonly goal: string;
}

const PlanWriteArgsSchema = z.strictObject({ ...PlanOutputSchema.shape, reason: PlanTextSchema.min(1) });
type PlanWriteArgs = z.infer<typeof PlanWriteArgsSchema>;

export const PLAN_WRITE_ENTRY: ToolRegistryEntry = {
  name: 'plan_write',
  description:
    'Writes a new revision of the investigation plan: its readiness criteria, its branches, each a question with its ' +
    'approach, and the reason for this revision. Returns the revision number.',
  argsSchema: PlanWriteArgsSchema,
  effect: 'write',
  resultMaxBytes: 1_024,
};

/** The number after the plan's last revision, in the call's transaction; 1 for the first. */
async function nextRevision(tx: RuntimeTx, investigationId: string): Promise<number> {
  const [latest] = await tx
    .select({ revision: researchPlanRevisions.revision })
    .from(researchPlanRevisions)
    .where(eq(researchPlanRevisions.investigationId, investigationId))
    .orderBy(desc(researchPlanRevisions.revision))
    .limit(1);
  return (latest?.revision ?? 0) + 1;
}

/**
 * `plan_write` (`write`, design-research-flow.md): a new plan revision in `research_plan_revisions`, written
 * in the call's guarded transaction together with its outcome. Returns its number.
 */
export const planWriteTool: ImmediateTool = {
  name: PLAN_WRITE_ENTRY.name,
  async run({ tx, run, args }) {
    const { reason, ...output } = args as PlanWriteArgs;
    // Two runs of one investigation may write at once, and an insert that meets the same number writes nothing: the second
    // plan would be lost under a number that is not its own.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${run.investigationId}, 0))`);
    const revision = await nextRevision(tx, run.investigationId);
    const plan: PlanContent = { goal: run.config.goal, ...output };
    await tx.insert(researchPlanRevisions).values({ investigationId: run.investigationId, revision, plan, reason });
    return { to: 'done', outcome: 'success', result: { revision } };
  },
};
