import { researchPlanRevisions } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { CallEnding } from '../../agents/tool-calls.repository.js';
import type { ToolRegistryEntry } from '../../agents/tool-registry.js';
import type { ImmediateTool } from '../../agents/tools/tool-context.js';
import { SourceNameSchema } from '../../config/agent-config.schema.js';
import {
  attemptsExhausted,
  PLAN_ATTEMPTS_EXHAUSTED,
  PLAN_SOURCES_INVALID,
  type PlanWriteOutcome,
  readPlanWriteOutcomes,
} from '../plan-attempts.js';

/** Bounds of one text and of a list, in line with `memory_write` and `call_agent`. */
const TEXT_MAX_CHARS = 2_000;
const LIST_MAX_ITEMS = 20;
const PlanTextSchema = z.string().max(TEXT_MAX_CHARS);
/** Bounds of a branch's sources and of the reason they were chosen (design-catalog-planning.md, `plan_write`). */
const BRANCH_MAX_SOURCES = 8;
const SOURCE_REASON_MAX_CHARS = 500;

/**
 * A branch of a plan: its question, its approach, the sources it is collected from and why they were chosen. The schema
 * checks only the form; the sources against the catalog are checked in the guarded write.
 */
const PlanBranchSchema = z.object({
  question: PlanTextSchema,
  approach: PlanTextSchema,
  sources: z.array(SourceNameSchema).max(BRANCH_MAX_SOURCES),
  sourceReason: z.string().min(1).max(SOURCE_REASON_MAX_CHARS),
});
type PlanBranch = z.infer<typeof PlanBranchSchema>;

/** A plan revision's readiness criteria and branches (design-engine.md, the plan's revision). */
const PlanOutputSchema = z.object({
  readinessCriteria: z.array(PlanTextSchema).max(LIST_MAX_ITEMS),
  branches: z.array(PlanBranchSchema).max(LIST_MAX_ITEMS),
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
    'approach, the ids of the catalog sources it is collected from and the reason for that choice, and the reason for ' +
    'this revision. Returns the revision number.',
  argsSchema: PlanWriteArgsSchema,
  effect: 'write',
  resultMaxBytes: 1_024,
  readsRunCatalog: true,
};

/** What is wrong with one branch, by its number from 1: ids outside the catalog as the model wrote them, or no source. */
export type InvalidBranch =
  | { readonly branch: number; readonly noSource: true }
  | { readonly branch: number; readonly notInCatalog: readonly string[] };

/**
 * The branches whose sources do not hold (DC-5, AC-06.1): a branch with no source, or with a source outside the run's
 * sources — the planner's catalog. A comparison of ids, never of text. Empty when every branch holds.
 */
function invalidBranches(branches: readonly PlanBranch[], runSources: readonly string[]): InvalidBranch[] {
  const invalid: InvalidBranch[] = [];
  branches.forEach((branch, index) => {
    const number = index + 1;
    if (branch.sources.length === 0) {
      invalid.push({ branch: number, noSource: true });
      return;
    }
    const notInCatalog = [...new Set(branch.sources.filter((sourceId) => !runSources.includes(sourceId)))];
    if (notInCatalog.length > 0) invalid.push({ branch: number, notInCatalog });
  });
  return invalid;
}

/** The ended `plan_write` calls of an investigation, in the order they ended. */
export interface PlanWriteOutcomes {
  read(tx: RuntimeTx, investigationId: string): Promise<readonly PlanWriteOutcome[]>;
}

const POSTGRES_PLAN_WRITE_OUTCOMES: PlanWriteOutcomes = { read: readPlanWriteOutcomes };

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
 * `plan_write` (`write`, design-research-flow.md, design-catalog-planning.md): a new plan revision in
 * `research_plan_revisions`, written in the call's guarded transaction together with its outcome. Under the
 * investigation's advisory lock: exhausted attempts refuse `plan_attempts_exhausted` with no check; a branch with no
 * source or with a source outside the run's sources refuses `plan_sources_invalid`; neither writes a revision.
 */
export function createPlanWriteTool(outcomes: PlanWriteOutcomes = POSTGRES_PLAN_WRITE_OUTCOMES): ImmediateTool {
  return {
    name: PLAN_WRITE_ENTRY.name,
    async run({ tx, run, args }): Promise<CallEnding> {
      const { reason, ...output } = args as PlanWriteArgs;
      // Two runs of one investigation may write at once, and an insert that meets the same number writes nothing: the
      // second plan would be lost under a number that is not its own. The lock also keeps two calls from counting the
      // same series of attempts.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${run.investigationId}, 0))`);
      if (attemptsExhausted(await outcomes.read(tx, run.investigationId))) {
        return { to: 'rejected', outcome: 'rejected', reason: PLAN_ATTEMPTS_EXHAUSTED };
      }
      const invalid = invalidBranches(output.branches, run.sources);
      if (invalid.length > 0) {
        return { to: 'rejected', outcome: 'rejected', reason: PLAN_SOURCES_INVALID, detail: { branches: invalid } };
      }
      const revision = await nextRevision(tx, run.investigationId);
      const plan: PlanContent = { goal: run.config.goal, ...output };
      await tx.insert(researchPlanRevisions).values({ investigationId: run.investigationId, revision, plan, reason });
      return { to: 'done', outcome: 'success', result: { revision } };
    },
  };
}

export const planWriteTool: ImmediateTool = createPlanWriteTool();
