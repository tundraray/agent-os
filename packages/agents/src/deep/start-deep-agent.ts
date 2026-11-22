import type { Logger } from '@agent-os/common';
import { AGENTS_BRIEF_CONFIRMATION } from '@agent-os/contracts';
import { z } from 'zod';

import type { StartRefusal, StartRequest, StartResolution } from '../start/resolve-start';
import type { InCommitAgentTool } from '../tools/tool';
import { WAITING_RULE } from '../tools/system/start-agent';
import { logStart } from '../tools/system/start-child';
import { type DeepAgentBrief, DeepAgentBriefSchema } from './brief';

/** The root's tool that starts a deep agent on a brief; its description lists the chat's deep agents. */
const START_DEEP_AGENT_TOOL = 'start_deep_agent';

/** Arguments of `start_deep_agent`: the deep agent record and the brief. */
const StartDeepAgentArgsSchema = DeepAgentBriefSchema.extend({
  deepAgent: z.uuid().describe('The id of the deep agent record to start, as the list below gives it'),
});
export type StartDeepAgentArgs = z.infer<typeof StartDeepAgentArgsSchema>;

export interface StartDeepAgentDeps {
  /** The one start procedure (KD-2): the deep agent's snapshot on behalf of the employee. */
  resolveStart(request: StartRequest): Promise<StartResolution>;
  /** Writes the `access_denied` record of a start refused for its model; asked only when that refusal is the outcome. */
  auditStartRefusal(refusal: StartRefusal): Promise<void>;
  /** Whether the root of `ownerId` may start this deep agent record (KD-4, AC-15.2), read live from his library view. */
  rootMayStart(ownerId: string, recordId: string): Promise<boolean>;
  readonly logger: Logger;
}

/**
 * What `prepare` hands `execute`: the start procedure's answer, whether the chat may start the record
 * and when the start began (the log's duration).
 */
export interface PreparedDeepAgentStart {
  readonly resolution: StartResolution;
  readonly inLaunchSet: boolean;
  readonly startedAt: number;
}

type DeepAgentRefusalReason = StartRefusal['reason'] | 'not_allowed';

/** The tool's own text; `describeStartDeepAgent` appends the deep agents the chat offers. */
const DESCRIPTION = [
  'Start a deep agent on a brief. The call shows the employee the brief to confirm, edit or reject;',
  'the deep agent starts only after the employee confirms it, and the result names its run id.',
].join('\n');

/** The description of `start_deep_agent` with the chat's listing: the tool's own text, then the deep agents the chat offers. */
function describeStartDeepAgent(deepAgents: readonly string[]): string {
  const lines = deepAgents.length === 0 ? ['(none)'] : deepAgents.map((line) => `- ${line}`);
  return [DESCRIPTION, 'Deep agents you may start:', ...lines].join('\n');
}

/** The brief as the deep agent's task: always the three fields, in this order. */
function briefJson({ question, boundaries, result }: DeepAgentBrief): string {
  return JSON.stringify({ question, boundaries, result });
}

/**
 * `start_deep_agent` (deep-agents KD-2): a built-in tool of the root. `agents` asks the employee for a
 * decision on the brief; after a confirmation `prepare` resolves the deep agent record of the confirmed
 * arguments through `resolveStart` on behalf of the employee and asks `rootMayStart` whether the chat may
 * start it, both before the commit (ADR-0017), and `execute` starts the deep agent as a child of the
 * caller on the snapshot of the whole team. A refusal is the call's result, in the order of `start_agent`:
 * the record is unavailable, then it is outside the chat's launch set (`not_allowed`, AC-15.2), then its
 * model is not allowed, has no ready provider or is the default and none is chosen; nothing starts. Only
 * a refused model is audited.
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
      description: deepAgents === null ? DESCRIPTION : describeStartDeepAgent(deepAgents),
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
    async prepare({ args, caller }) {
      const startedAt = Date.now();
      const [resolution, inLaunchSet] = await Promise.all([
        deps.resolveStart({
          ownerId: caller.ownerId,
          source: { kind: 'record', recordId: args.deepAgent, expected: 'deep_agent' },
        }),
        deps.rootMayStart(caller.ownerId, args.deepAgent),
      ]);
      return { resolution, inLaunchSet, startedAt };
    },
    async execute({ args, caller, startChild, prepared }) {
      if (prepared === undefined) {
        throw new Error(`start_deep_agent of agent ${caller.agentId} runs without its prepare`);
      }
      const { resolution, inLaunchSet } = prepared;
      // Logged as `start_agent` logs a start; the brief stays out.
      const entry = {
        ownerId: caller.ownerId,
        rootId: caller.rootId,
        parentId: caller.agentId,
        source: 'record' as const,
        recordId: args.deepAgent,
        resolution,
        startedAt: prepared.startedAt,
      };
      const refuse = (reason: DeepAgentRefusalReason, model: string | null) => {
        logStart(logger, { ...entry, agentId: null, refusal: reason });
        return {
          kind: 'refused' as const,
          reason,
          refusalDetail: model === null ? null : { model },
        };
      };
      if (resolution.kind === 'refused' && resolution.reason === 'record_unavailable') {
        return refuse(resolution.reason, null);
      }
      if (!inLaunchSet) return refuse('not_allowed', null);
      if (resolution.kind === 'refused') {
        await deps.auditStartRefusal(resolution);
        return refuse(resolution.reason, resolution.model);
      }

      const { snapshot } = resolution;
      const brief = briefJson(args);
      const { agentId } = await startChild({ snapshot, prompt: brief, description: args.question });
      logStart(logger, { ...entry, agentId, refusal: null });
      return {
        kind: 'done',
        outcome: 'success',
        text: `Deep agent "${snapshot.name}" started in the background, run id ${agentId}. Confirmed brief: ${brief}\nIts answer will arrive as a message when it finishes. ${WAITING_RULE}`,
        childAgentId: agentId,
      };
    },
  };
}
