import { ToolOutcomeSchema } from '@agent-os/contracts';
import { agentMessages, type Executor } from '@agent-os/db';
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';

import { TASK_TOOL } from './deep-definition';

/**
 * The result of a single `task` call that ran: a built-in `task` with `description` (not a list) that ended
 * with the subagent's answer or its failure — a refusal and an interrupt before it was sent ran nothing.
 */
const isSingleTaskResult = and(
  eq(agentMessages.kind, 'tool_result'),
  sql`${agentMessages.content} ->> 'tool' = ${TASK_TOOL}`,
  sql`${agentMessages.content} ->> 'server' is null`,
  sql`${agentMessages.content} -> 'args' -> 'description' is not null`,
  inArray(sql`${agentMessages.content} ->> 'outcome'`, [ToolOutcomeSchema.enum.success, ToolOutcomeSchema.enum.tool_error]),
);

/**
 * How many single assignments each subagent got from the deep agent's `task` calls, whatever was compacted
 * since: what its `maxRuns` counts (deep-agents/design-task.md KD-6). List items and refused or interrupted
 * calls do not count.
 */
export async function singleTaskRuns(reader: Executor, taskId: string): Promise<Map<string, number>> {
  const subagent = sql<string>`${agentMessages.content} -> 'args' ->> 'subagentType'`;
  const rows = await reader
    .select({ subagent, runs: count() })
    .from(agentMessages)
    .where(and(eq(agentMessages.taskId, taskId), isSingleTaskResult))
    .groupBy(subagent);
  return new Map(rows.map((row) => [row.subagent, row.runs]));
}

/**
 * The subagent task of the last single `task` call to the named subagent that finished (KD-6): the final
 * subagent's answer is read through it; `undefined` — none yet.
 */
export async function lastSingleTask(
  reader: Executor,
  taskId: string,
  subagent: string,
): Promise<string | undefined> {
  const [row] = await reader
    .select({ childTaskId: sql<string | null>`${agentMessages.content} ->> 'childTaskId'` })
    .from(agentMessages)
    .where(
      and(
        eq(agentMessages.taskId, taskId),
        isSingleTaskResult,
        sql`${agentMessages.content} -> 'args' ->> 'subagentType' = ${subagent}`,
      ),
    )
    .orderBy(desc(agentMessages.seq))
    .limit(1);
  return row?.childTaskId ?? undefined;
}
