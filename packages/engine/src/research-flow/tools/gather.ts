import { type Coverage, CoverageSchema, type TaskSpec } from '@agent-os/contracts';
import { researchEvidence } from '@agent-os/db';
import type { Clock, RuntimeTx } from '@agent-os/runtime';
import type { SourceRegistry } from '@agent-os/sources';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import type { CallEnding } from '../../agents/tool-calls.repository.js';
import type { ToolRegistryEntry } from '../../agents/tool-registry.js';
import { type AgentRunContext, cutToFit, jsonBytes, type TaskTool, type TaskToolPreparation } from '../../agents/tools/tool-context.js';
import { gatherKeyFields, SOURCE_FETCH_WORKFLOW } from '../../capabilities/gather-key.js';
import { SourceNameSchema } from '../../config/agent-config.schema.js';
import type { EngineLogger } from '../../ports.js';

const SOURCE_UNAVAILABLE = 'source_unavailable';
const RESULT_MAX_BYTES = 16 * 1_024;
/** The `source.fetch` budget of a gather: the agents form of a configuration has no task budgets. */
const SOURCE_FETCH_BUDGET = { maxToolCalls: 20, maxRetries: 3 } as const;
/** The runtime refuses a task deadline below this (`TaskBudget.deadlineMs`). */
const MIN_TASK_DEADLINE_MS = 1_000;
const MAX_TASK_DEADLINE_MS = 3_600_000;

/** The time left until the run's `notAfter`, or null when it is at or below the runtime's minimum (OQ-7: 1 s left starts no task). */
function taskDeadlineMs(deps: { readonly clock: Clock }, run: { readonly notAfter: Date }): number | null {
  const deadlineMs = Math.min(MAX_TASK_DEADLINE_MS, Math.floor(run.notAfter.getTime() - deps.clock.now().getTime()));
  return deadlineMs <= MIN_TASK_DEADLINE_MS ? null : deadlineMs;
}

const GatherArgsSchema = z.strictObject({
  sourceId: SourceNameSchema,
  toolName: SourceNameSchema,
  args: z.record(z.string(), z.unknown()),
  completeness: z.enum(['all', 'sample']),
});
type GatherArgs = z.infer<typeof GatherArgsSchema>;

export const GATHER_ENTRY: ToolRegistryEntry = {
  name: 'gather',
  description:
    'Collects records from one source of this run: its sourceId and toolName, the args of that tool, and completeness - ' +
    '"all" for every matching record, "sample" for the first page. Returns the page id of the stored records (morePages ' +
    'when there are several), the normalized query, the number of records returned and whether they were truncated. The ' +
    'same request again costs nothing and returns the same page, marked repeat.',
  argsSchema: GatherArgsSchema,
  effect: 'task',
  resultMaxBytes: RESULT_MAX_BYTES,
  readsRunSources: true,
};

/** What a stored page of a `source.fetch` task gives the result. */
export interface GatherPage {
  readonly pageId: string;
  readonly provenance: unknown;
  readonly coverage: Coverage;
}

/** The stored pages of a task, in any order. */
export interface GatherPages {
  read(tx: RuntimeTx, investigationId: string, pageIds: readonly string[]): Promise<readonly GatherPage[]>;
}

const POSTGRES_GATHER_PAGES: GatherPages = {
  async read(tx, investigationId, pageIds) {
    const rows = await tx
      .select({ pageId: researchEvidence.evidenceId, provenance: researchEvidence.provenance, coverage: researchEvidence.coverage })
      .from(researchEvidence)
      .where(and(eq(researchEvidence.investigationId, investigationId), inArray(researchEvidence.evidenceId, [...pageIds])));
    return rows.map((row) => ({ ...row, coverage: CoverageSchema.parse(row.coverage) }));
  },
};

export interface GatherToolDeps {
  readonly sources: Pick<SourceRegistry, 'resolveTool' | 'currentSnapshot'>;
  readonly clock: Clock;
  readonly logger: EngineLogger;
  /** The evidence table by default. */
  readonly pages?: GatherPages;
}

/** What the preparation hands to the specification: the checked request and its source's pinned snapshot. */
interface PreparedGather {
  readonly request: GatherArgs;
  readonly snapshot: string;
}

const DENIED: TaskToolPreparation = {
  kind: 'ending',
  ending: { to: 'rejected', outcome: 'access_denied', reason: 'access_denied' },
};

/** A collection that produced no page: a result of the call with its reason, not a refusal. */
const UNAVAILABLE_ENDING: CallEnding = {
  to: 'done',
  outcome: 'tool_error',
  reason: SOURCE_UNAVAILABLE,
  result: { reason: SOURCE_UNAVAILABLE },
};
const UNAVAILABLE: TaskToolPreparation = { kind: 'ending', ending: UNAVAILABLE_ENDING };

/** The narrowed sources of a child run are guarded here alone: the default rights port allows everything. */
function isSourceOfRun(run: AgentRunContext, request: GatherArgs): boolean {
  return (
    run.sources.includes(request.sourceId) &&
    run.config.sources.some((source) => source.sourceId === request.sourceId && source.toolName === request.toolName)
  );
}

const NormalizedProvenanceSchema = z.object({ normalizedArgs: z.record(z.string(), z.unknown()) });

/** The arguments of the first page as the source was asked, without the paging cursor. */
function queryOf(page: GatherPage): Record<string, unknown> {
  const { cursor: _cursor, ...query } = NormalizedProvenanceSchema.parse(page.provenance).normalizedArgs;
  return query;
}

/** A whole result within the tool's limit; over it, the query — the only part of unbounded size — as a cut JSON text. */
function fitResult(query: Record<string, unknown>, rest: Record<string, unknown>): unknown {
  const whole = { query, ...rest };
  if (jsonBytes(whole) <= RESULT_MAX_BYTES) return whole;
  return cutToFit(JSON.stringify(query), RESULT_MAX_BYTES, (cut) => ({ queryText: cut, queryCut: true, ...rest }));
}

/**
 * `gather` (`task`, design-research-flow.md, DC-11): a `source.fetch` task of the same specification as `proposeGather`'s,
 * so one dedup key names one request over one snapshot and the source is called once. The rights port runs first (the
 * executor), then the sources of the run and the allowlist, the arguments, the snapshot, the search for a live task and
 * the rest of the time.
 */
export function createGatherTool(deps: GatherToolDeps): TaskTool {
  const pages = deps.pages ?? POSTGRES_GATHER_PAGES;

  function specOf(run: AgentRunContext, { request, snapshot }: PreparedGather): TaskSpec {
    return {
      investigationId: run.investigationId,
      ...gatherKeyFields(request, snapshot),
      dependsOn: [],
      budget: {
        ...SOURCE_FETCH_BUDGET,
        // A subscription to a live task ignores it, but the schema of `propose` is checked before the deduplication.
        deadlineMs: taskDeadlineMs(deps, run) ?? MIN_TASK_DEADLINE_MS,
        maxTokens: 0,
      },
    };
  }

  return {
    name: GATHER_ENTRY.name,

    sourceOf: (args) => (args as GatherArgs).sourceId,

    async prepare({ run, args, signal, findLiveTask }) {
      const request = args as GatherArgs;
      if (!isSourceOfRun(run, request)) return DENIED;
      const resolved = deps.sources.resolveTool({ workflowType: SOURCE_FETCH_WORKFLOW, sourceId: request.sourceId, toolName: request.toolName });
      if (resolved === null) return DENIED;
      if (!resolved.tool.argsSchema.safeParse(request.args).success) {
        return { kind: 'ending', ending: { to: 'rejected', outcome: 'rejected', reason: 'invalid_arguments' } };
      }
      let snapshot: string;
      try {
        snapshot = await deps.sources.currentSnapshot(request.sourceId, signal);
      } catch (error) {
        if (signal.aborted) return { kind: 'stopped' };
        // One warning per unreadable snapshot, with the source and the error class, without the request.
        deps.logger.warn('source snapshot could not be read: the gather is a failed collection', {
          investigationId: run.investigationId,
          taskId: run.runTaskId,
          sourceId: request.sourceId,
          errorClass: error instanceof Error ? error.name : typeof error,
          outcome: SOURCE_UNAVAILABLE,
        });
        return UNAVAILABLE;
      }
      const prepared: PreparedGather = { request, snapshot };
      const live = await findLiveTask(specOf(run, prepared));
      // A tool call has no `deadline` of its own; a live task is waited for whatever the time left.
      if (live === undefined && taskDeadlineMs(deps, run) === null) return UNAVAILABLE;
      return { kind: 'task', prepared, repeat: live !== undefined };
    },

    taskSpec: ({ run, prepared }) => specOf(run, prepared as PreparedGather),

    async ending({ tx, call, child, repeat }) {
      if (child.status !== 'succeeded') return UNAVAILABLE_ENDING;
      const stored = new Map((await pages.read(tx, call.investigationId, child.outputRefs)).map((page) => [page.pageId, page]));
      const ordered = child.outputRefs.map((pageId) => {
        const page = stored.get(pageId);
        if (page === undefined) throw new Error(`page ${pageId} of task ${child.taskId} is missing`);
        return page;
      });
      const [first] = ordered;
      if (first === undefined) throw new Error(`succeeded task ${child.taskId} stored no page`);
      const returned = ordered.reduce((sum, page) => sum + page.coverage.returned, 0);
      const more = ordered.slice(1).map((page) => page.pageId);
      const result = fitResult(queryOf(first), {
        page: first.pageId,
        ...(more.length > 0 ? { morePages: more } : {}),
        returned,
        // The cursor left after the last page: an earlier page always has one, and it was followed.
        truncated: ordered.at(-1)?.coverage.truncated ?? false,
        ...(repeat ? { repeat: true } : {}),
      });
      return { to: 'done', outcome: returned === 0 ? 'empty' : 'success', result };
    },
  };
}
