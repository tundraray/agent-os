import type { Logger } from '@agent-os/common';
import {
  AGENTS_BRIEF_CONFIRMATION,
  type ChipRecord,
  RecordNameSchema,
  START_DEEP_AGENT_TOOL,
} from '@agent-os/contracts';
import type { z } from 'zod';

import type {
  NamedStartRequest,
  NamedStartResolution,
  StartRefusal,
} from '../start/resolve-start';
import type { InCommitAgentTool } from '../tools/tool';
import { CHIP_RULE, WAITING_RULE } from '../tools/system/start-agent';
import { logStart } from '../tools/system/start-child';
import { type DeepAgentBrief, DeepAgentBriefSchema } from './brief';

/** Arguments of `start_deep_agent`: the name of the deep agent and the brief. */
const StartDeepAgentArgsSchema = DeepAgentBriefSchema.extend({
  deepAgent: RecordNameSchema.describe(
    'The name of the deep agent to start, as the list below gives it',
  ),
});
export type StartDeepAgentArgs = z.infer<typeof StartDeepAgentArgsSchema>;

export interface StartDeepAgentDeps {
  /**
   * The start procedure by name (data-model design-agents.md, KD-5): the deep agent's version and model on
   * behalf of the employee.
   */
  resolveNamedStart(request: NamedStartRequest): Promise<NamedStartResolution>;
  /** The chip of the message the call answers, read from the caller's history (`History.answeredChip`). */
  answeredChip(agentId: string, callId: string): Promise<ChipRecord | null>;
  /** Writes the `access_denied` record of a start refused for its model; asked only when that refusal is the outcome. */
  auditStartRefusal(refusal: StartRefusal): Promise<void>;
  readonly logger: Logger;
}

/** What `prepare` hands `execute`: the start procedure's answer and when the start began (the log's duration). */
export interface PreparedDeepAgentStart {
  readonly resolution: NamedStartResolution;
  /** The chip of the message the call answers; `null` — none. */
  readonly chip: ChipRecord | null;
  readonly startedAt: number;
}

type DeepAgentRefusalReason = StartRefusal['reason'] | 'not_allowed';

/** DC-27: the name of an agent is started by `start_agent`, never by this tool. */
const AGENT_NAME_TEXT =
  'This name is an agent, not a deep agent: start it with start_agent.';

/** The tool's own text; `describeStartDeepAgent` appends the deep agents the chat offers. */
const DESCRIPTION = [
  'Start a deep agent on a brief. The call shows the employee the brief to confirm, edit or reject;',
  'the deep agent starts only after the employee confirms it, and the result names its run id.',
].join('\n');

/** The description of `start_deep_agent` with the chat's listing: the tool's own text, then the deep agents the chat offers. */
function describeStartDeepAgent(deepAgents: readonly string[]): string {
  const lines =
    deepAgents.length === 0
      ? ['(none)']
      : deepAgents.map((line) => `- ${line}`);
  return [
    DESCRIPTION,
    'Deep agents you may start, by name:',
    ...lines,
    "A name not listed here still starts the deep agent of that name the employee can see — their own first, then a colleague's, then a system one; only a name none of these has starts a temporary deep agent under that name, on the brief.",
    CHIP_RULE,
  ].join('\n');
}

/** The brief as the deep agent's task: always the three fields, in this order. */
function briefJson({ question, boundaries, result }: DeepAgentBrief): string {
  return JSON.stringify({ question, boundaries, result });
}

/**
 * `start_deep_agent` (deep-agents KD-2; data-model design-agents.md, KD-5): a built-in tool of the root.
 * `agents` asks the employee for a decision on the brief; after a confirmation `prepare` resolves the deep
 * agent the confirmed name starts on behalf of the employee — the record he chose for the message the call
 * answers, when it is the chip's name, else the winner of the name among the deep agents he sees, else a
 * temporary deep agent under that name — before the commit (ADR-0017), and `execute` starts it
 * as a child of the caller on its version, with the whole team. A refusal is the call's result: the name of
 * an agent the employee sees (`not_allowed`, DC-27), then a model that is not allowed, has no ready provider
 * or none chosen; nothing starts. Only a refused model is audited.
 */
export function createStartDeepAgentTool(
  deps: StartDeepAgentDeps,
): InCommitAgentTool<StartDeepAgentArgs, PreparedDeepAgentStart> {
  const logger = deps.logger.child({ service: 'agents.start_deep_agent' });

  return {
    name: START_DEEP_AGENT_TOOL,
    description: DESCRIPTION,
    argsSchema: StartDeepAgentArgsSchema,
    mode: 'in_commit',
    rootOnly: true,
    // Without a listing (the call check) the tool keeps its own text.
    describe: ({ deepAgents }) => ({
      description:
        deepAgents === null ? DESCRIPTION : describeStartDeepAgent(deepAgents),
    }),
    // The brief stays out of the log.
    loggedArgs: ({ deepAgent }) => ({ deepAgent }),
    confirmation: {
      kind: AGENTS_BRIEF_CONFIRMATION,
      editableArgs: true,
      content(args): StartDeepAgentArgs {
        return {
          deepAgent: args.deepAgent,
          question: args.question,
          boundaries: args.boundaries,
          result: args.result,
        };
      },
    },
    async prepare({ callId, args, caller }) {
      const startedAt = Date.now();
      const chip = await deps.answeredChip(caller.agentId, callId);
      const resolution = await deps.resolveNamedStart({
        ownerId: caller.ownerId,
        name: args.deepAgent,
        kind: 'deep_agent',
        // The version's model, else the chat's (data-model design-agents.md, KD-3).
        callerModel: caller.run.model,
        chip,
      });
      return { resolution, chip, startedAt };
    },
    async execute({ args, caller, startChild, prepared }) {
      if (prepared === undefined) {
        throw new Error(
          `start_deep_agent of agent ${caller.agentId} runs without its prepare`,
        );
      }
      const { resolution, chip } = prepared;
      // Logged as `start_agent` logs a start; the brief stays out.
      const entry = {
        ownerId: caller.ownerId,
        rootId: caller.rootId,
        parentId: caller.agentId,
        source: 'name' as const,
        name: args.deepAgent,
        ...(chip === null ? {} : { chipRecordId: chip.id }),
        resolution: resolution.kind === 'other_kind' ? null : resolution,
        startedAt: prepared.startedAt,
      };
      const refuse = (
        reason: DeepAgentRefusalReason,
        model: string | null,
        text?: string,
      ) => {
        logStart(logger, { ...entry, agentId: null, refusal: reason });
        return {
          kind: 'refused' as const,
          reason,
          refusalDetail: model === null ? null : { model },
          ...(text === undefined ? {} : { text }),
        };
      };
      if (resolution.kind === 'other_kind')
        return refuse('not_allowed', null, AGENT_NAME_TEXT);
      if (resolution.kind === 'refused') {
        await deps.auditStartRefusal(resolution);
        return refuse(resolution.reason, resolution.model);
      }

      const { run } = resolution;
      const brief = briefJson(args);
      const { agentId } = await startChild({
        run,
        prompt: brief,
        description: args.question,
      });
      logStart(logger, { ...entry, agentId, refusal: null });
      return {
        kind: 'done',
        outcome: 'success',
        text: `Deep agent "${run.name}" started in the background, run id ${agentId}. Confirmed brief: ${brief}\nIts answer will arrive as a message when it finishes. ${WAITING_RULE}`,
        childAgentId: agentId,
      };
    },
  };
}
