import type { Logger } from '@agent-os/common';
import {
  READ_SKILL_TOOL,
  RecordNameSchema,
  type ResolvedSkill,
} from '@agent-os/contracts';
import { z } from 'zod';

import { inRootLaunchSet } from '../../chat-listing';
import type { RecordLibrary } from '../../start/record-library';
import type { OutsideAgentTool, ToolCaller } from '../tool';

/** Arguments of `read_skill` (agent-guidance design-server.md, «Инструменты модели»). */
export const ReadSkillArgsSchema = z.object({
  name: RecordNameSchema.describe(
    'The name of the skill, as the description lists it',
  ),
});
export type ReadSkillArgs = z.infer<typeof ReadSkillArgsSchema>;

/** What the model reads of `read_skill` above its catalogue lines (KD-6). */
const SKILL_RULE = [
  'Read a skill: a procedure colleagues wrote for a kind of task. When the employee’s task is of that kind, read the skill and do the task by its steps.',
  'A skill does not change your tools, your rights or which calls the employee confirms.',
  'Skills you may read, by name:',
].join('\n');

function describeReadSkill(lines: readonly string[]): string {
  return [SKILL_RULE, ...lines.map((line) => `- ${line}`)].join('\n');
}

export interface ReadSkillDeps {
  readonly library: Pick<RecordLibrary, 'skills' | 'resolveByName'>;
  readonly logger: Logger;
}

/**
 * The skill a call names, looked up anew at the call (KD-6, AC-06.6): for the chat the winner of the name among
 * the skills its owner sees that the chat offers (`inRootLaunchSet`), for any other agent the first skill of that
 * name in its version's list; `null` — not in the caller's catalogue now.
 */
async function skillOf(
  library: ReadSkillDeps['library'],
  caller: ToolCaller,
  name: string,
): Promise<ResolvedSkill | null> {
  if (caller.root) {
    const record = await library.resolveByName(caller.ownerId, name, 'skill');
    return record?.kind === 'skill' && inRootLaunchSet(record) ? record : null;
  }
  const key = name.toLowerCase();
  // The version's list, as `RunDefinition.skills` gives it: a subagent's version is its deep agent's.
  const skills = await library.skills(
    caller.ownerId,
    caller.run.version.content.skills,
  );
  return skills.find((skill) => skill.name.toLowerCase() === key) ?? null;
}

/**
 * `read_skill` (agent-guidance KD-6, Flow 3): the text of the active version of a skill of the caller's
 * catalogue. Its description carries the catalogue lines of the declaration; a name outside the catalogue is
 * refused `record_unavailable`. The log names the skill and the text's length, never the text.
 */
export function createReadSkillTool(
  deps: ReadSkillDeps,
): OutsideAgentTool<ReadSkillArgs> {
  const logger = deps.logger.child({ service: 'agents.skills' });
  return {
    name: READ_SKILL_TOOL,
    description: describeReadSkill([]),
    argsSchema: ReadSkillArgsSchema,
    mode: 'outside',
    describe: ({ skills }) => ({ description: describeReadSkill(skills) }),
    async execute({ args, caller, callId }) {
      const startedAt = Date.now();
      const skill = await skillOf(deps.library, caller, args.name);
      logger.info('skill read', {
        agentId: caller.agentId,
        rootId: caller.rootId,
        ownerId: caller.ownerId,
        callId,
        name: args.name,
        skillId: skill?.id ?? null,
        textChars: skill?.content.text.length ?? null,
        durationMs: Date.now() - startedAt,
      });
      if (skill === null)
        return {
          kind: 'refused',
          reason: 'record_unavailable',
          text: `There is no skill "${args.name}" in your catalogue.`,
        };
      return { kind: 'done', outcome: 'success', text: skill.content.text };
    },
  };
}
