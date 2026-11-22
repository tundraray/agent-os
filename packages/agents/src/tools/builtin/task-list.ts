import type { Logger } from '@agent-os/common';
import { RUN_TASK_TEXT_MAX_LENGTH, type RunTaskStatus, RunTaskStatusSchema } from '@agent-os/contracts';
import { z } from 'zod';

import { descriptionLine } from '../../chat-listing';
import { type PlanItem, planLines } from '../../step/plan-block';
import { type NewRunTask, runTasks } from '../../store/run-tasks.repository';
import type { InCommitAgentTool } from '../tool';

/** The deep agent's tool that keeps the plan of its run (deep-agents KD-5). */
export const TASK_LIST_TOOL = 'task_list';

/** At most this many items in one run's plan; a call that would go past it is refused. */
const TASK_LIST_MAX_ITEMS = 50;

const { waiting, running, done, failed, cancelled } = RunTaskStatusSchema.enum;

/** The moves a deep agent may make (Contract «Список задач», State Transitions); `done`, `cancelled` are final. */
const ALLOWED_MOVES: Readonly<Record<RunTaskStatus, readonly RunTaskStatus[]>> = {
  [waiting]: [running, done, cancelled],
  [running]: [done, cancelled],
  [done]: [],
  [failed]: [],
  [cancelled]: [],
};

const TaskListArgsSchema = z.object({
  // One line each: a text copied from a tool result cannot fake plan lines in the system text, and the stored
  // text is the text shown.
  add: z
    .array(z.string().overwrite(descriptionLine).min(1).max(RUN_TASK_TEXT_MAX_LENGTH))
    .optional()
    .describe('Texts of new plan items, in order; each gets the next number of the run, status waiting'),
  set: z
    .array(
      z.object({
        number: z.number().int().positive().describe('The number of an item of the plan'),
        status: RunTaskStatusSchema.describe('running when you start it; done or cancelled when it ends'),
      }),
    )
    .optional()
    .describe('New statuses of existing items, applied in order after the additions'),
});
export type TaskListArgs = z.infer<typeof TaskListArgsSchema>;

/** What a call changes: the items it adds, the statuses it sets and the whole plan after it. */
export interface TaskListChange {
  readonly kind: 'change';
  readonly added: readonly NewRunTask[];
  readonly changed: readonly { readonly number: number; readonly status: RunTaskStatus }[];
  readonly items: readonly PlanItem[];
}

/** A call the rules refuse: `invalid_arguments` with the text the model reads. */
export interface TaskListRefusal {
  readonly kind: 'refused';
  readonly text: string;
}

/**
 * The rules of `task_list` (Contract «`task_list`», Invariant 2; pure-decision.md): additions take the
 * numbers after the run's largest one, so a number is never reused, then each status is set in order. An
 * empty call, a plan over {@link TASK_LIST_MAX_ITEMS}, a number not in the run, `failed` (set only by the
 * platform) and a move the status diagram does not allow — out of a final status included — are refused.
 */
export function decideTaskList(current: readonly PlanItem[], args: TaskListArgs): TaskListChange | TaskListRefusal {
  const texts = args.add ?? [];
  const moves = args.set ?? [];
  if (texts.length === 0 && moves.length === 0) {
    return { kind: 'refused', text: 'Nothing to do: give items to add, statuses to set, or both.' };
  }
  if (current.length + texts.length > TASK_LIST_MAX_ITEMS) {
    return {
      kind: 'refused',
      text: `A plan holds at most ${TASK_LIST_MAX_ITEMS} items; it has ${current.length}, and ${texts.length} more would go past it.`,
    };
  }
  const last = Math.max(0, ...current.map((item) => item.number));
  const added = texts.map((text, index): NewRunTask => ({ number: last + index + 1, text }));
  const items = new Map<number, PlanItem>(current.map((item) => [item.number, item]));
  for (const item of added) items.set(item.number, { ...item, status: waiting });

  for (const move of moves) {
    const item = items.get(move.number);
    if (item === undefined) return { kind: 'refused', text: `There is no item ${move.number} in the plan.` };
    if (move.status === failed) {
      return { kind: 'refused', text: `Item ${move.number}: the status failed is set only by the platform.` };
    }
    if (!ALLOWED_MOVES[item.status].includes(move.status)) {
      const why = ALLOWED_MOVES[item.status].length === 0 ? `${item.status} is final` : 'that move is not allowed';
      return {
        kind: 'refused',
        text: `Item ${move.number} cannot go from ${item.status} to ${move.status}: ${why}.`,
      };
    }
    items.set(move.number, { ...item, status: move.status });
  }
  return {
    kind: 'change',
    added,
    changed: moves,
    items: [...items.values()].sort((a, b) => a.number - b.number),
  };
}

const DESCRIPTION = [
  'Keep the plan of your run: add its steps as items, mark an item running when you start it and done or',
  'cancelled when it ends. Answers with the whole plan. The plan is kept for the whole run and shown to you',
  'on every step.',
].join(' ');

/**
 * `task_list` (deep-agents KD-5): a built-in tool only a deep agent's definition names. It runs in the
 * step's commit: the rules decide on the plan read in that transaction, and the items are written with the
 * call's `tool_result` (Invariant 1), so a replayed step never writes them twice. The log names the run, the
 * numbers and the statuses — never the items' texts, which are the run's content.
 */
export function createTaskListTool(deps: { readonly logger: Logger }): InCommitAgentTool<TaskListArgs> {
  const logger = deps.logger.child({ service: 'agents.task-list' });
  return {
    name: TASK_LIST_TOOL,
    description: DESCRIPTION,
    argsSchema: TaskListArgsSchema,
    mode: 'in_commit',
    loggedArgs: (args) => ({
      added: Array.isArray(args.add) ? args.add.length : 0,
      set: Array.isArray(args.set) ? args.set.map((move) => ({ number: move?.number, status: move?.status })) : [],
    }),
    async execute({ args, caller, callId, tx }) {
      const ids = { agentId: caller.agentId, rootId: caller.rootId, ownerId: caller.ownerId, callId };
      const current = await runTasks.list(tx, caller.agentId);
      const decision = decideTaskList(current, args);
      if (decision.kind === 'refused') {
        logger.info('task list call refused', { ...ids, items: current.length });
        return { kind: 'refused', reason: 'invalid_arguments', text: decision.text };
      }
      await runTasks.insert(tx, caller.agentId, decision.added);
      for (const move of decision.changed) {
        await runTasks.setStatus(tx, caller.agentId, move.number, move.status);
      }
      logger.info('task list changed', {
        ...ids,
        added: decision.added.map((item) => item.number),
        changed: decision.changed,
        items: decision.items.length,
      });
      return { kind: 'done', outcome: 'success', text: planLines(decision.items).join('\n') };
    },
  };
}
