import type { Logger } from '@agent-os/common';
import {
  DeepAgentContentSchema,
  roundFailed,
  roundJudged,
  ScriptSchema,
  SessionTaskStatusSchema,
  TRAINER_TOOLS,
} from '@agent-os/contracts';
import type {
  AgentTrainingRow,
  AgentVersionRow,
  AgentsRepository,
  ConversationTasksRepository,
  TrainingsRepository,
} from '@agent-os/db';
import { z } from 'zod';

import type { InCommitAgentTool, ToolRunResult } from '../tools/tool';
import { FIX_TASK } from './pool';
import { trainingBase } from './training-reads';

const PROPOSE_VERSION_TOOL = TRAINER_TOOLS[5];

const ProposeArgsSchema = z.object({
  prompt: z
    .string()
    .optional()
    .describe(
      'The new system prompt of the deep agent; omit to keep the base one',
    ),
  subagentPrompts: z
    .array(z.object({ name: z.string(), prompt: z.string() }))
    .default([])
    .describe(
      'New prompts of subagents by name; a subagent left out keeps its prompt',
    ),
  scripts: z
    .array(ScriptSchema)
    .optional()
    .describe(
      'The full new list of scripts; repeat the base ones to keep them, omit to keep the base list',
    ),
  changes: z
    .string()
    .trim()
    .min(1)
    .max(4000)
    .describe(
      'What changed and why, for the employee who decides on the version',
    ),
});
type ProposeArgs = z.infer<typeof ProposeArgsSchema>;

const SUMMARY_TASK = 4;
const { completed, in_progress: inProgress } = SessionTaskStatusSchema.enum;

type ProposeDeps = Parameters<typeof createProposeVersionTool>[0];

/**
 * Why a test run may not propose a version now (create-and-test design-trainer-dialog.md, Flow 4), or `null`:
 * the last round judged whole, and either the automatic fix — a failure in round 1, one version, task 3 in
 * progress — or a request after the summary task is closed; never while a training of the agent runs or after
 * the agent is deleted.
 */
async function testRunRefusal(
  deps: ProposeDeps,
  training: AgentTrainingRow,
  proposed: readonly AgentVersionRow[],
): Promise<string | null> {
  const { tests } = training;
  if (!roundJudged(tests, 1 + proposed.length))
    return 'Propose a version only after every test of the last round is judged.';
  const pool = await deps.sessionTaskRows.list(training.id);
  const status = (number: number) =>
    pool.find((task) => task.number === number)?.status;
  const fix =
    proposed.length === 0 &&
    roundFailed(tests, 1) &&
    status(FIX_TASK) === inProgress;
  if (!fix && status(SUMMARY_TASK) !== completed)
    return 'Propose a version only to fix the failures of the first round or on a request of the employee after the summary.';
  if ((await deps.trainingRows.running(training.agentId))?.description === null)
    return 'A training of this agent is running: no version can be proposed until it ends.';
  if ((await deps.agentRows.findAny(training.agentId))?.deletedAt != null)
    return 'The agent was deleted: no version can be proposed.';
  return null;
}

/**
 * `propose_version`, the trainer's proposal (design-training.md, KD-1, «Инструменты тренера»): the one new
 * version of the trained agent — the base one with new prompts and scripts — created inactive with its changes.
 */
export function createProposeVersionTool(deps: {
  readonly trainingRows: Pick<TrainingsRepository, 'find' | 'running'>;
  readonly agentRows: Pick<
    AgentsRepository,
    | 'findVersion'
    | 'findTrainingVersion'
    | 'trainingVersions'
    | 'findAny'
    | 'createVersion'
  >;
  readonly sessionTaskRows: Pick<ConversationTasksRepository, 'list'>;
  readonly logger: Logger;
}): InCommitAgentTool<ProposeArgs> {
  const logger = deps.logger.child({ service: 'agents.trainer-tools' });
  return {
    name: PROPOSE_VERSION_TOOL,
    description:
      'Propose the one new version of the trained agent: new prompts of the deep agent and its subagents by name and the full new list of scripts; everything else stays as in the base version. The version is created inactive; a person decides whether to switch it on. One proposal per training; in a test run, one per round, built from its latest version.',
    argsSchema: ProposeArgsSchema,
    mode: 'in_commit',
    loggedArgs: (args) => ({
      promptChars: typeof args.prompt === 'string' ? args.prompt.length : null,
      subagentPrompts: Array.isArray(args.subagentPrompts)
        ? args.subagentPrompts.length
        : null,
      scripts: Array.isArray(args.scripts) ? args.scripts.length : null,
    }),
    async execute({ args, caller, callId }) {
      const base = await trainingBase(deps, caller);
      if ('kind' in base) return base;
      const { training } = base;
      const refused = (text: string): ToolRunResult => {
        logger.info('trainer proposal refused', {
          trainingId: training.id,
          callId,
        });
        return { kind: 'refused', reason: 'invalid_arguments', text };
      };
      // A test run builds each version from its latest one, which `trainingBase` reads (KD-7).
      const { content } = base;
      if (training.description === null) {
        if (
          (await deps.agentRows.findTrainingVersion(training.id)) !== undefined
        )
          return refused('This training has proposed its version already.');
      } else {
        const proposed = await deps.agentRows.trainingVersions(training.id);
        const refusal = await testRunRefusal(deps, training, proposed);
        if (refusal !== null) return refused(refusal);
      }
      const unknown = args.subagentPrompts.findIndex(
        (entry) =>
          !content.subagents.some((subagent) => subagent.name === entry.name),
      );
      if (unknown !== -1)
        return refused(`subagentPrompts.${unknown}.name: no such subagent`);
      const parsed = DeepAgentContentSchema.safeParse({
        ...content,
        prompt: args.prompt ?? content.prompt,
        subagents: content.subagents.map((subagent) => ({
          ...subagent,
          prompt:
            args.subagentPrompts.find((entry) => entry.name === subagent.name)
              ?.prompt ?? subagent.prompt,
        })),
        scripts: args.scripts ?? content.scripts,
      });
      if (!parsed.success) return refused(z.prettifyError(parsed.error));
      const created = await deps.agentRows.createVersion({
        agentId: training.agentId,
        content: parsed.data,
        trainingId: training.id,
        changes: args.changes,
      });
      // The failed insert aborted the transaction: the throw rolls the call's savepoint back, the call ends a tool error.
      if (created.outcome === 'number_taken')
        throw new Error(
          'A concurrent save took the version number; propose the version again.',
        );
      logger.info('trainer proposed a version', {
        trainingId: training.id,
        agentId: training.agentId,
        versionNumber: created.number,
        prompts:
          (args.prompt === undefined ? 0 : 1) + args.subagentPrompts.length,
        scripts: parsed.data.scripts.length,
        callId,
      });
      return {
        kind: 'done',
        outcome: 'success',
        text: `Version ${created.number} proposed; it is not active.`,
      };
    },
  };
}
