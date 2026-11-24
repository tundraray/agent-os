import type { Logger } from '@agent-os/common';
import { MEMORY_TOOLS } from '@agent-os/contracts';
import type { MemoriesRepository, MemoryOwner } from '@agent-os/db';
import { z } from 'zod';

import { descriptionLine } from '../../chat-listing';
import type { InCommitAgentTool, ToolCaller, ToolRunResult } from '../tool';

const [REMEMBER_TOOL, READ_MEMORY_TOOL, FORGET_TOOL] = MEMORY_TOOLS;

/**
 * The one rule of whose memory a run sees (KD-4): a deep agent's version with self-learning on, the deep agent
 * and each of its subagents alike; `null` — the run has no memory. The block and all three tools ask it. A training
 * tree has no employee and changes nothing: it reads the agent's memory only (design-training.md KD-3, place 4).
 */
export function memoryOf(
  caller: Pick<ToolCaller, 'run' | 'ownerId' | 'training'>,
): {
  /** The catalogue agent of the run's version: a subagent shares its deep agent's memory. */
  readonly agentId: string;
  /** The employee who owns the run's task; `null` in a training tree. */
  readonly userId: string | null;
  readonly writes: boolean;
} | null {
  const { version } = caller.run;
  if (version.kind !== 'deep_agent' || !version.content.selfLearning)
    return null;
  if (caller.training)
    return { agentId: version.agentId, userId: null, writes: false };
  return { agentId: version.agentId, userId: caller.ownerId, writes: true };
}

const SHARED_AGENT_MEMORY =
  'Records with scope agent are read by every employee who runs this agent: put there only how to do the work; ' +
  "never facts about a person, never content or data taken from the employee's systems. Such things, if worth " +
  'keeping at all, go to scope user.';

const ScopeSchema = z
  .enum(['agent', 'user'])
  .describe(
    'user — about the employee, their preferences and circumstances; agent — about your field of work, its tools ' +
      `and your way of working. ${SHARED_AGENT_MEMORY}`,
  );

const DescriptionSchema = z
  .string()
  .overwrite(descriptionLine)
  .min(1)
  .max(150)
  .describe(
    'One line saying what the record holds; the key of the record, copied exactly from your memory index',
  );

const RecordArgsSchema = z.object({
  scope: ScopeSchema,
  description: DescriptionSchema,
});
type RecordArgs = z.infer<typeof RecordArgsSchema>;

const RememberArgsSchema = RecordArgsSchema.extend({
  text: z.string().trim().min(1).max(4000).describe('The fact itself'),
});
type RememberArgs = z.infer<typeof RememberArgsSchema>;

const MEMORY_RULES = `One record holds one fact. Never store secrets. ${SHARED_AGENT_MEMORY}`;

const REMEMBER_DESCRIPTION = [
  'Save a fact to your memory, kept for your later runs. Its description is one line saying what is inside.',
  'To correct a record, call remember with the same scope and description: its text is replaced.',
  MEMORY_RULES,
].join(' ');

const READ_DESCRIPTION = [
  'Read the text of a record of your memory index by its scope and description.',
  'Memory is a hint where to look, not a source of the answer.',
].join(' ');

const FORGET_DESCRIPTION = [
  'Delete a record of your memory by its scope and description. Delete a record as soon as you see it is wrong.',
  MEMORY_RULES,
].join(' ');

/** The log fields of a call's arguments, as the model wrote them: the scope and the lengths, never the texts. */
function loggedRecordArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const lengthOf = (value: unknown) =>
    typeof value === 'string' ? value.length : null;
  return {
    scope: ScopeSchema.safeParse(args.scope).data ?? null,
    descriptionLength: lengthOf(args.description),
    textLength: lengthOf(args.text),
  };
}

const NO_MEMORY: ToolRunResult = {
  kind: 'refused',
  reason: 'not_allowed',
  text: 'This run has no memory it may change.',
};

/**
 * The three memory tools (design-memory.md KD-2, Contract «Инструменты модели»). Each runs in the step's commit,
 * so a record is written with the call's `tool_result` and a replayed step writes the same record again (the key
 * is owner and description). Whose memory it is comes from `memoryOf`, never from the arguments. The description
 * and the text are masked before they are written or looked up; the log names the scope and lengths only.
 */
export function createMemoryTools(deps: {
  readonly memoryRows: MemoriesRepository;
  readonly maskSecrets: (text: string) => string;
  readonly logger: Logger;
}): [
  InCommitAgentTool<RememberArgs>,
  InCommitAgentTool<RecordArgs>,
  InCommitAgentTool<RecordArgs>,
] {
  const logger = deps.logger.child({ service: 'agents.memory' });
  const { memoryRows, maskSecrets } = deps;

  /**
   * Runs a call on the caller's memory: refused without memory, without the right to change it when `writes`, and
   * in scope user without an employee.
   */
  async function onMemory(
    tool: string,
    input: {
      readonly caller: ToolCaller;
      readonly callId: string;
      readonly args: RecordArgs;
    },
    writes: boolean,
    run: (owner: MemoryOwner, description: string) => Promise<ToolRunResult>,
  ): Promise<ToolRunResult> {
    const { caller, callId, args } = input;
    const memory = memoryOf(caller);
    const fields = {
      tool,
      agentId: memory?.agentId ?? null,
      userId: caller.ownerId,
      taskId: caller.agentId,
      callId,
      ...loggedRecordArgs(args),
    };
    const owner: MemoryOwner | null =
      memory === null || (writes && !memory.writes)
        ? null
        : args.scope === 'agent'
          ? { agentId: memory.agentId }
          : memory.userId === null
            ? null
            : { userId: memory.userId };
    if (owner === null) {
      logger.info('memory call refused', fields);
      return NO_MEMORY;
    }
    const result = await run(owner, maskSecrets(args.description));
    logger.info('memory call done', {
      ...fields,
      outcome: result.kind === 'done' ? result.outcome : result.reason,
    });
    return result;
  }

  const remember: InCommitAgentTool<RememberArgs> = {
    name: REMEMBER_TOOL,
    description: REMEMBER_DESCRIPTION,
    argsSchema: RememberArgsSchema,
    mode: 'in_commit',
    loggedArgs: loggedRecordArgs,
    execute: ({ args, caller, callId }) =>
      onMemory(
        REMEMBER_TOOL,
        { caller, callId, args },
        true,
        async (owner, description) => {
          const created = await memoryRows.remember(
            owner,
            description,
            maskSecrets(args.text),
          );
          return {
            kind: 'done',
            outcome: 'success',
            text: `${created ? 'Saved' : 'Updated'}: ${description}`,
          };
        },
      ),
  };

  const read: InCommitAgentTool<RecordArgs> = {
    name: READ_MEMORY_TOOL,
    description: READ_DESCRIPTION,
    argsSchema: RecordArgsSchema,
    mode: 'in_commit',
    loggedArgs: loggedRecordArgs,
    execute: ({ args, caller, callId }) =>
      onMemory(
        READ_MEMORY_TOOL,
        { caller, callId, args },
        false,
        async (owner, description) => {
          const row = await memoryRows.read(owner, description);
          // The tool result reaches the model inside the data envelope (`provider-messages.ts`).
          return row === undefined
            ? {
                kind: 'done',
                outcome: 'empty',
                text: 'There is no such record',
              }
            : { kind: 'done', outcome: 'success', text: row.text };
        },
      ),
  };

  const forget: InCommitAgentTool<RecordArgs> = {
    name: FORGET_TOOL,
    description: FORGET_DESCRIPTION,
    argsSchema: RecordArgsSchema,
    mode: 'in_commit',
    loggedArgs: loggedRecordArgs,
    execute: ({ args, caller, callId }) =>
      onMemory(
        FORGET_TOOL,
        { caller, callId, args },
        true,
        async (owner, description) =>
          (await memoryRows.forget(owner, description))
            ? {
                kind: 'done',
                outcome: 'success',
                text: `Deleted: ${description}`,
              }
            : {
                kind: 'done',
                outcome: 'empty',
                text: 'There is no such record',
              },
      ),
  };

  return [remember, read, forget];
}
