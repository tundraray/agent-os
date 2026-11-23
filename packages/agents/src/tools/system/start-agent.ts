import type { MessagesRepository } from '@agent-os/db';
import type { Logger } from '@agent-os/common';
import {
  type ChipRecord,
  RecordNameSchema,
  START_AGENT_TOOL,
} from '@agent-os/contracts';
import { z } from 'zod';

import type { AccessAudit, AccessGate } from '../../access-gate';
import type { RecordLibrary } from '../../start/record-library';
import type { History } from '../../store/history';
import {
  auditStartRefusal,
  type NamedStartResolution,
  resolveNamedStart,
  resolveStart,
  type StartDeps,
  type StartRefusal,
} from '../../start/resolve-start';
import { FORK_AGENT, type InCommitAgentTool, type ToolCaller } from '../tool';
import { gateStart, type StartGate, type StartTarget } from './tool-gate';
import { logStart, type StartLogEntry } from './start-child';

/**
 * How an agent waits for what it started (KD-2): the model reads it in the description and in every
 * result of `start_agent` and `start_deep_agent`, so it ends its turn instead of polling `list_agents`.
 */
export const WAITING_RULE =
  'Do not wait for it with list_agents or any other call: when you have nothing else to do, end your turn with a short text and no tool calls. You are resumed automatically when its report arrives.';

/** Arguments of `start_agent` (data-model design-agents.md, «Инструменты модели»); there is no `model`. */
export const StartAgentArgsSchema = z.object({
  description: z
    .string()
    .min(1)
    .describe('A few words naming the assignment, shown in the list of agents'),
  agent: RecordNameSchema.describe(
    `The name of the agent to start, as the description lists it, or "${FORK_AGENT}" for a copy of yourself`,
  ),
  prompt: z
    .string()
    .min(1)
    .describe('The assignment: everything the agent needs to do the work'),
});
export type StartAgentArgs = z.infer<typeof StartAgentArgsSchema>;

/**
 * What a name starts when the message carries a chip, said in the descriptions of `start_agent` and
 * `start_deep_agent`: `resolveNamedStart` starts the chosen record, not the winner of the name.
 */
export const CHIP_RULE =
  'When the employee chose a record for the message you are answering, its name starts exactly that record, whoever else has the name.';

/**
 * The description of `start_agent` the model sees: the lines of the agents the caller is shown (the chat
 * listing or the agent's `agents`), each as a list item, the fork, what any other name starts — the agent
 * of that name the owner sees (KD-5), else a temporary agent — and what the name of a message's chip starts.
 */
function describeStartAgent(startable: readonly string[]): string {
  const lines =
    startable.length === 0 ? ['(none)'] : startable.map((line) => `- ${line}`);
  return [
    'Start an agent in the background on an assignment. It returns the agentId at once; the agent works on its own, and its report arrives as a message when it finishes.',
    WAITING_RULE,
    `Use agent "${FORK_AGENT}" to start a copy of yourself that sees your history so far.`,
    'Agents you may start, by name:',
    ...lines,
    "A name not listed here still starts the agent of that name the employee you work for can see — their own first, then a colleague's, then a system one; only a name none of these has starts a temporary general-purpose agent under that name, with your assignment.",
    CHIP_RULE,
  ].join('\n');
}

export interface StartAgentDeps {
  /** The start procedure asks it for the agent a name starts. */
  readonly library: RecordLibrary;
  /** The start procedure asks it about the child's model (design-access.md KD-4). */
  readonly access: AccessGate;
  /** The start procedure asks it whether the child's model has a ready provider (model-providers KD-2). */
  readonly providers: StartDeps['providers'];
  /** Gets the `access_denied` record of a start refused for its model, in `execute` (KD-6). */
  readonly audit: AccessAudit;
  /** `AGENT_MAX_DEPTH`. */
  readonly maxDepth: number;
  /** The fork's link is read from the caller's history. */
  readonly messageRows: MessagesRepository;
  /** The chip of the message a call by name answers is read from the caller's history. */
  readonly history: Pick<History, 'answeredChip'>;
  readonly logger: Logger;
}

/** What `prepare` hands `execute`: the call's target and the start procedure's answer. */
interface PreparedStart {
  readonly startedAt: number;
  readonly target: StartTarget;
  readonly resolution: NamedStartResolution;
  /** The chip of the message a call by name answers; `null` — none, and for a fork. */
  readonly chip: ChipRecord | null;
}

/**
 * `start_agent` (data-model design-agents.md, KD-5, Flow 1, «Инструменты модели»). Before the commit,
 * `prepare` asks the start procedure for the child's version and model on behalf of the caller's owner, the
 * caller's model the second link of the chain (KD-3): a fork repeats the caller's start; a name starts the
 * record the employee chose for the message the call answers, when it is the chip's name, else the winner of
 * the name among the agents the owner sees, else a temporary general-purpose agent under that name.
 * So neither the library nor the gate is asked while the commit transaction is open (ADR-0017). In the
 * commit the refusals go in order: `gateStart` (`not_allowed` for a deep agent's name, `depth_limit`), then
 * the model or its provider with the model's id (`model_not_configured` without one). A refusal is the call's
 * result and creates no task; otherwise the child is started on its version and its `agentId` is the result
 * of the same step. A fork gets the caller's version, name and model and a link to the caller's history
 * through the last entry before the answer that holds this call. A retried step repeats `prepare`; the start
 * of the committed attempt holds.
 */
export function createStartAgentTool(
  deps: StartAgentDeps,
): InCommitAgentTool<StartAgentArgs, PreparedStart> {
  const logger = deps.logger.child({ service: 'agents.start' });

  function refuse(
    caller: ToolCaller,
    args: StartAgentArgs,
    prepared: PreparedStart,
    reason:
      | Extract<StartGate, { kind: 'refused' }>['reason']
      | StartRefusal['reason'],
    model: string | null,
    text?: string,
  ) {
    logStart(logger, {
      ownerId: caller.ownerId,
      rootId: caller.rootId,
      parentId: caller.agentId,
      agentId: null,
      ...loggedStart(args, prepared),
      refusal: reason,
      startedAt: prepared.startedAt,
    });
    return {
      kind: 'refused' as const,
      reason,
      refusalDetail: model === null ? null : { model },
      ...(text === undefined ? {} : { text }),
    };
  }

  return {
    name: START_AGENT_TOOL,
    description: describeStartAgent([]),
    argsSchema: StartAgentArgsSchema,
    mode: 'in_commit',
    // The agents the caller is shown: the chat's listing, an agent's `agents`; none listed without them.
    describe: ({ startable }) => ({
      description: describeStartAgent(startable ?? []),
    }),
    // The assignment prompt stays out of the log.
    loggedArgs: ({ agent, description }) => ({ agent, description }),
    async prepare({ callId, args, caller }) {
      const startedAt = Date.now();
      const { ownerId } = caller;
      const callerModel = caller.run.model;
      if (args.agent === FORK_AGENT) {
        const resolution = await resolveStart(
          { ownerId, source: { kind: 'fork', run: caller.run }, callerModel },
          deps,
        );
        return { startedAt, target: { kind: 'fork' }, resolution, chip: null };
      }
      const chip = await deps.history.answeredChip(caller.agentId, callId);
      const resolution = await resolveNamedStart(
        { ownerId, name: args.agent, kind: 'agent', callerModel, chip },
        deps,
      );
      const recordKind =
        resolution.kind === 'other_kind' ? resolution.found : 'agent';
      return {
        startedAt,
        target: { kind: 'name', recordKind },
        resolution,
        chip,
      };
    },
    async execute({ callId, args, caller, startChild, prepared }) {
      if (prepared === undefined) {
        throw new Error(
          `start_agent of agent ${caller.agentId} runs without its prepare`,
        );
      }
      const { target, resolution } = prepared;
      const gate = gateStart({
        target,
        depth: caller.depth,
        maxDepth: deps.maxDepth,
      });
      if (gate.kind === 'refused')
        return refuse(caller, args, prepared, gate.reason, null, gate.text);
      if (resolution.kind === 'other_kind') {
        throw new Error(
          `start_agent of agent ${caller.agentId} passed the gate with the name of a ${resolution.found}`,
        );
      }
      if (resolution.kind === 'refused') {
        await auditStartRefusal(deps.audit, resolution);
        return refuse(
          caller,
          args,
          prepared,
          resolution.reason,
          resolution.model,
        );
      }

      const { agentId } = await startChild({
        run: resolution.run,
        description: args.description,
        prompt: args.prompt,
        ...(target.kind === 'fork'
          ? {
              forkedFrom: {
                agentId: caller.agentId,
                throughSeq: await seqBeforeAnswer(
                  deps.messageRows,
                  caller,
                  callId,
                ),
              },
            }
          : {}),
      });
      logStart(logger, {
        ownerId: caller.ownerId,
        rootId: caller.rootId,
        parentId: caller.agentId,
        agentId,
        ...loggedStart(args, prepared),
        refusal: null,
        startedAt: prepared.startedAt,
      });
      return {
        kind: 'done',
        outcome: 'success',
        text: `Agent started in the background, agentId ${agentId}. Its report will arrive as a message when it finishes. ${WAITING_RULE}`,
        childAgentId: agentId,
      };
    },
  };
}

/** The source, the name, the chip and the start procedure's answer of a call, as its start log names them. */
function loggedStart(
  args: StartAgentArgs,
  { target, resolution, chip }: PreparedStart,
): Pick<StartLogEntry, 'source' | 'name' | 'chipRecordId' | 'resolution'> {
  return {
    source: target.kind,
    ...(target.kind === 'name' ? { name: args.agent } : {}),
    ...(chip === null ? {} : { chipRecordId: chip.id }),
    resolution: resolution.kind === 'other_kind' ? null : resolution,
  };
}

/** The fork's link (KD-7): the last entry of the caller before the `model_answer` that requested this call. */
async function seqBeforeAnswer(
  messageRows: MessagesRepository,
  caller: ToolCaller,
  callId: string,
): Promise<number> {
  const answerSeq = await messageRows.answerSeqOf(caller.agentId, callId);
  if (answerSeq === undefined) {
    throw new Error(
      `No answer of agent ${caller.agentId} requested call ${callId}`,
    );
  }
  return answerSeq - 1;
}
