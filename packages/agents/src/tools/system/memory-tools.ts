import type { Logger } from '@agent-os/common';
import { MEMORY_TOOLS, MemoryVersionNumberSchema } from '@agent-os/contracts';
import type { CurrentMemoryRow, MemoryOwner } from '@agent-os/db';
import { z } from 'zod';

import { descriptionLine } from '../../chat-listing';
import type { MemoryChange, MemoryRecords } from '../../store/memory-records';
import type { InCommitAgentTool, ToolCaller, ToolRunResult } from '../tool';
import { memoryCheckReason } from './memory-check';

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

const VersionSchema = MemoryVersionNumberSchema.describe(
  'The version number of the record you read with read_memory or got from remember',
);

const RememberArgsSchema = RecordArgsSchema.extend({
  text: z.string().trim().min(1).max(4000).describe('The fact itself'),
  version: VersionSchema.optional(),
});
type RememberArgs = z.infer<typeof RememberArgsSchema>;

const ForgetArgsSchema = RecordArgsSchema.extend({ version: VersionSchema });
type ForgetArgs = z.infer<typeof ForgetArgsSchema>;

const MEMORY_RULES = `One record holds one fact. Never store secrets. ${SHARED_AGENT_MEMORY}`;

const CHANGED_RULE =
  'If the call is refused with memory_changed, the record has changed since you read it: decide again from the ' +
  'current version and text the refusal carries.';

const REMEMBER_DESCRIPTION = [
  'Save a fact to your memory, kept for your later runs. Its description is one line saying what is inside.',
  'To create a record, call remember without a version.',
  'To correct a record, first read it with read_memory, then call remember with the same scope and description',
  'and the version you read: its text is replaced.',
  CHANGED_RULE,
  MEMORY_RULES,
].join(' ');

const READ_DESCRIPTION = [
  'Read the version number and the text of a record of your memory index by its scope and description.',
  'Pass that version to remember or forget to change the record.',
  'Memory is a hint where to look, not a source of the answer.',
].join(' ');

const FORGET_DESCRIPTION = [
  'Delete a record of your memory by its scope, description and the version you read with read_memory.',
  'Delete a record as soon as you see it is wrong.',
  CHANGED_RULE,
  MEMORY_RULES,
].join(' ');

/**
 * The log fields of a call's arguments, as the model wrote them: the scope, the lengths and the version, never the
 * texts.
 */
function loggedRecordArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const lengthOf = (value: unknown) =>
    typeof value === 'string' ? value.length : null;
  return {
    scope: ScopeSchema.safeParse(args.scope).data ?? null,
    descriptionLength: lengthOf(args.description),
    textLength: lengthOf(args.text),
    version: typeof args.version === 'number' ? args.version : null,
  };
}

const NO_MEMORY: ToolRunResult = {
  kind: 'refused',
  reason: 'not_allowed',
  text: 'This run has no memory it may change.',
};

const NO_RECORD: ToolRunResult = {
  kind: 'done',
  outcome: 'empty',
  text: 'There is no such record',
};

const NO_RECORD_TO_CHANGE: ToolRunResult = {
  kind: 'done',
  outcome: 'empty',
  text: 'There is no such record; to create it, call remember without a version.',
};

const CHECK_TEXTS = {
  looks_like_secret:
    'Not saved: the description or the text looks like a secret. Never store secrets in memory.',
  looks_like_instruction:
    'Not saved: the description or the text looks like an instruction to a model. Store facts, not orders.',
} as const;

/** The refusal of a change from a version the record is no longer on: its current version and text. */
function changedResult(current: CurrentMemoryRow): ToolRunResult {
  return {
    kind: 'refused',
    reason: 'memory_changed',
    text:
      current.text === null
        ? `Not changed: the record was deleted at version ${current.version}. To create it again, call remember without a version.`
        : `Not changed: the record is at version ${current.version} now. Decide again from its current text:\n${current.text}`,
  };
}

/** The tool result of a change of a record; `missing` is answered with `noRecord`. */
function changeResult(
  change: MemoryChange,
  noRecord: ToolRunResult,
  writtenText: (version: number) => string,
): ToolRunResult {
  switch (change.kind) {
    case 'written':
      return {
        kind: 'done',
        outcome: 'success',
        text: writtenText(change.version),
      };
    case 'changed':
      return changedResult(change.current);
    case 'missing':
      return noRecord;
  }
}

/**
 * The three memory tools (design-memory.md KD-2; memory-hygiene KD-2, KD-4, Contract «Инструменты модели»). Each
 * runs in the step's commit, so a change is written with the call's `tool_result`; a replayed step changes from the
 * same version, since the lost attempt wrote nothing. A change goes by the version the model read, through
 * `MemoryRecords`. Whose memory it is comes from `memoryOf`, never from the arguments. The description and the text
 * are masked, then `remember` checks them against the bb patterns before writing; the log names the scope, the
 * lengths and the version only.
 */
export function createMemoryTools(deps: {
  readonly records: MemoryRecords;
  readonly maskSecrets: (text: string) => string;
  readonly logger: Logger;
}): [
  InCommitAgentTool<RememberArgs>,
  InCommitAgentTool<RecordArgs>,
  InCommitAgentTool<ForgetArgs>,
] {
  const logger = deps.logger.child({ service: 'agents.memory' });
  const { records, maskSecrets } = deps;

  /**
   * Runs a call on the caller's memory: refused without memory. In a training tree a change is recorded, not
   * written or checked, and answered with `trainingText` as a real one would be; scope user there has no record.
   */
  async function onMemory(
    tool: string,
    input: {
      readonly caller: ToolCaller;
      readonly callId: string;
      readonly args: RecordArgs;
    },
    trainingText: ((description: string) => string) | null,
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
    if (memory === null) {
      logger.info('memory call refused', fields);
      return NO_MEMORY;
    }
    const description = maskSecrets(args.description);
    if (trainingText !== null && !memory.writes) {
      logger.info('memory call recorded', fields);
      return {
        kind: 'done',
        outcome: 'recorded',
        text: trainingText(description),
      };
    }
    const result =
      args.scope === 'agent'
        ? await run({ agentId: memory.agentId }, description)
        : memory.userId === null
          ? NO_RECORD
          : await run({ userId: memory.userId }, description);
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
        (description) => `Saved: ${description}`,
        async (owner, description) => {
          const text = maskSecrets(args.text);
          const unsafe =
            memoryCheckReason(description) ?? memoryCheckReason(text);
          if (unsafe !== null)
            return {
              kind: 'refused',
              reason: unsafe,
              text: CHECK_TEXTS[unsafe],
            };
          const change =
            args.version === undefined
              ? await records.create(owner, description, text)
              : await records.change(owner, description, text, args.version);
          return changeResult(
            change,
            NO_RECORD_TO_CHANGE,
            (version) => `Saved: ${description} (version ${version})`,
          );
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
        null,
        async (owner, description) => {
          const record = await records.read(owner, description);
          // The tool result reaches the model inside the data envelope (`provider-messages.ts`).
          return record === undefined
            ? NO_RECORD
            : {
                kind: 'done',
                outcome: 'success',
                text: `Version ${record.version}\n${record.text}`,
              };
        },
      ),
  };

  const forget: InCommitAgentTool<ForgetArgs> = {
    name: FORGET_TOOL,
    description: FORGET_DESCRIPTION,
    argsSchema: ForgetArgsSchema,
    mode: 'in_commit',
    loggedArgs: loggedRecordArgs,
    execute: ({ args, caller, callId }) =>
      onMemory(
        FORGET_TOOL,
        { caller, callId, args },
        (description) => `Deleted: ${description}`,
        async (owner, description) =>
          changeResult(
            await records.forget(owner, description, args.version),
            NO_RECORD,
            () => `Deleted: ${description}`,
          ),
      ),
  };

  return [remember, read, forget];
}
