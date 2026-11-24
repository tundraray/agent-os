import type { Logger } from '@agent-os/common';
import {
  DeepAgentContentSchema,
  ScriptSchema,
  TRAINER_TOOLS,
} from '@agent-os/contracts';
import type { AgentsRepository, TrainingsRepository } from '@agent-os/db';
import { z } from 'zod';

import type { InCommitAgentTool, ToolRunResult } from '../tools/tool';
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
    .describe(
      'The full new list of scripts; repeat the base ones to keep them',
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

/**
 * `propose_version`, the trainer's proposal (design-training.md, KD-1, «Инструменты тренера»): the one new
 * version of the trained agent — the base one with new prompts and scripts — created inactive with its changes.
 */
export function createProposeVersionTool(deps: {
  readonly trainingRows: Pick<TrainingsRepository, 'find' | 'setChanges'>;
  readonly agentRows: Pick<AgentsRepository, 'findVersion' | 'createVersion'>;
  readonly logger: Logger;
}): InCommitAgentTool<ProposeArgs> {
  const logger = deps.logger.child({ service: 'agents.trainer-tools' });
  return {
    name: PROPOSE_VERSION_TOOL,
    description:
      'Propose the one new version of the trained agent: new prompts of the deep agent and its subagents by name and the full new list of scripts; everything else stays as in the base version. The version is created inactive; a person decides whether to switch it on. One proposal per training.',
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
      const { training, content } = await trainingBase(deps, caller);
      const refused = (text: string): ToolRunResult => {
        logger.info('trainer proposal refused', {
          trainingId: training.id,
          callId,
        });
        return { kind: 'refused', reason: 'invalid_arguments', text };
      };
      // The changes are written with the version, so a training with changes has its version already.
      if (training.changes !== null)
        return refused('This training has proposed its version already.');
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
        scripts: args.scripts,
      });
      if (!parsed.success) return refused(z.prettifyError(parsed.error));
      const created = await deps.agentRows.createVersion({
        agentId: training.agentId,
        content: parsed.data,
        trainingId: training.id,
      });
      // The failed insert aborted the transaction: the throw rolls the call's savepoint back, the call ends a tool error.
      if (created.outcome === 'number_taken')
        throw new Error(
          'A concurrent save took the version number; propose the version again.',
        );
      await deps.trainingRows.setChanges(training.id, args.changes);
      logger.info('trainer proposed a version', {
        trainingId: training.id,
        agentId: training.agentId,
        versionNumber: created.number,
        prompts:
          (args.prompt === undefined ? 0 : 1) + args.subagentPrompts.length,
        scripts: args.scripts.length,
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
