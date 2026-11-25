import { DeepAgentContentSchema, type TrainingView } from '@agent-os/contracts';
import type {
  MessagesRepository,
  RuntimeModelCallsRepository,
} from '@agent-os/db';
import type { Task } from '@agent-os/runtime';

/** The outcomes of a run's calls that count as its errors (design-training.md, `TrainingView`). */
const ERROR_OUTCOMES = ['tool_error', 'transport_failure', 'refused'];

/** A run's numbers: a replay of a training or a run of a test run's test. */
export type RunNumbers = TrainingView['totals']['base'];

/** The run and every task under it, from the tree in creation order. */
function subtreeOf(tree: readonly Task[], runId: string): string[] {
  const ids = new Set([runId]);
  for (const task of tree)
    if (task.parentId !== null && ids.has(task.parentId)) ids.add(task.taskId);
  return [...ids];
}

/** A run's errors (a failed run counts one more), its tool calls and its cost, counted on read. */
export async function runNumbers(
  rows: {
    readonly messages: Pick<MessagesRepository, 'toolResultCounts'>;
    readonly modelCalls: Pick<RuntimeModelCallsRepository, 'sumTasks'>;
  },
  tree: readonly Task[],
  runId: string,
): Promise<RunNumbers> {
  const ids = subtreeOf(tree, runId);
  const [counts, cost] = await Promise.all([
    rows.messages.toolResultCounts(ids, ERROR_OUTCOMES),
    rows.modelCalls.sumTasks(ids),
  ]);
  const failed = tree.some(
    (task) => task.taskId === runId && task.status === 'failed',
  );
  return {
    errors: counts.matching + (failed ? 1 : 0),
    toolCalls: counts.calls,
    costUsd: Number(cost),
  };
}

/** The prompts and scripts of a version, side by side with the other on a result screen. */
export function versionTexts(
  content: unknown,
): NonNullable<TrainingView['proposal']['base']> {
  const { prompt, subagents, scripts } = DeepAgentContentSchema.parse(content);
  return {
    prompt,
    subagents: subagents.map(({ name, prompt }) => ({ name, prompt })),
    scripts,
  };
}

export function sum(runs: readonly (RunNumbers | null)[]): RunNumbers {
  return runs.reduce<RunNumbers>(
    (total, run) =>
      run === null
        ? total
        : {
            errors: total.errors + run.errors,
            toolCalls: total.toolCalls + run.toolCalls,
            costUsd: total.costUsd + run.costUsd,
          },
    { errors: 0, toolCalls: 0, costUsd: 0 },
  );
}
