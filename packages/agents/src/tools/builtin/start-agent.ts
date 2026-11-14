import type { RuntimeTx } from '@agent-os/runtime';
import { z } from 'zod';

import type { DefinitionHeader } from '../../definitions/definition.js';
import { chooseModel, type ModelChoice } from '../../model/model-choice.js';
import { type Session, sessions } from '../../store/sessions.repository.js';
import { toolCalls } from '../../store/tool-calls.repository.js';
import { FORK_AGENT, type InCommitAgentTool, type ToolCaller } from '../tool.js';
import { gateStart } from '../tool-gate.js';
import type { StartChildDeps } from './start-child.js';

const START_AGENT_TOOL = 'start_agent';

/**
 * How an agent waits for what it started (KD-2): the model reads it in the description and in every
 * result of `start_agent` and `start_workflow`, so it ends its turn instead of polling `list_agents`.
 */
export const WAITING_RULE =
  'Do not wait for it with list_agents or any other call: when you have nothing else to do, end your turn with a short text and no tool calls. You are resumed automatically when its report arrives.';

/** Arguments of `start_agent` (design-agents.md, «Инструменты»). */
export const StartAgentArgsSchema = z.object({
  description: z
    .string()
    .min(1)
    .describe('A few words naming the assignment, shown in the list of agents'),
  agent: z
    .string()
    .min(1)
    .describe(`Name of the agent definition to start, or "${FORK_AGENT}" for a copy of yourself`),
  prompt: z.string().min(1).describe('The assignment: everything the agent needs to do the work'),
  model: z
    .string()
    .min(1)
    .optional()
    .describe('Model of the agent, e.g. anthropic/claude-haiku-5-5; the definition decides when omitted'),
});
export type StartAgentArgs = z.infer<typeof StartAgentArgsSchema>;

/**
 * The description of `start_agent` the model sees, with the headers of the definitions the session
 * may start (its definition's `agents`, or `limits.agents`).
 */
export function describeStartAgent(headers: readonly DefinitionHeader[]): string {
  const agents =
    headers.length === 0
      ? ['(none)']
      : headers.map((header) => `- ${header.name}: ${header.description}`);
  return [
    'Start an agent in the background on an assignment. It returns the agentId at once; the agent works on its own, and its report arrives as a message when it finishes.',
    WAITING_RULE,
    `Use agent "${FORK_AGENT}" to start a copy of yourself that sees your history so far.`,
    'Agents you may start:',
    ...agents,
  ].join('\n');
}

/**
 * `start_agent` in the commit transaction (Flow 2; DC-4, KD-7): the caller's list and counts, the depth
 * and the model are checked by `gateStart`; a refusal is the call's result and creates no task.
 * Otherwise the child is started by the spawn helper and its `agentId` is the result of the same step.
 * A fork gets the caller's definition and model and a link to the caller's history through the last
 * entry before the answer that holds this call.
 */
export function createStartAgentTool(deps: StartChildDeps): InCommitAgentTool<StartAgentArgs> {
  return {
    name: START_AGENT_TOOL,
    title: 'Запустить агента',
    argLabels: { description: 'Название', agent: 'Агент', prompt: 'Задание', model: 'Модель' },
    description: describeStartAgent([]),
    argsSchema: StartAgentArgsSchema,
    mode: 'in_commit',
    async execute({ callId, args, caller, tx, startChild }) {
      const session = await callerSession(tx, caller);
      const callerDefinition = deps.catalog.get(session.definition);
      if (callerDefinition === undefined) {
        throw new Error(`Agent ${caller.agentId} runs definition ${session.definition}, which is not in the catalog`);
      }
      const isFork = args.agent === FORK_AGENT;
      const childDefinition = isFork ? callerDefinition : deps.catalog.get(args.agent);
      if (childDefinition === undefined) return { kind: 'refused', reason: 'not_allowed' };

      const model: ModelChoice = isFork
        ? { kind: 'chosen', model: session.model }
        : chooseModel({
            launchModel: args.model ?? null,
            definitionModel: childDefinition.model ?? null,
            defaultModel: deps.defaultModel,
            pricedModels: deps.pricedModels(),
          });
      const gate = gateStart({
        agent: args.agent,
        definitionAgents: callerDefinition.agents,
        limits: session.limits,
        startedCount: await toolCalls.startedCount(tx, caller.agentId, args.agent),
        depth: caller.depth,
        maxDepth: deps.maxDepth,
        model,
      });
      if (gate.kind === 'refused') return gate;

      const { agentId } = await startChild({
        definition: childDefinition.name,
        description: args.description,
        prompt: args.prompt,
        model: gate.model,
        ...(isFork
          ? { forkedFrom: { agentId: caller.agentId, throughSeq: await seqBeforeAnswer(tx, caller, callId) } }
          : {}),
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

async function callerSession(tx: RuntimeTx, caller: ToolCaller): Promise<Session> {
  const session = await sessions.get(tx, caller.agentId);
  if (session === undefined) {
    throw new Error(`Agent ${caller.agentId} calls start_agent without a session`);
  }
  return session;
}

/**
 * The fork's link (KD-7): the last entry of the caller before the `model_answer` that requested this
 * call — the call is still open while it runs, so its row holds the answer's `seq`.
 */
async function seqBeforeAnswer(tx: RuntimeTx, caller: ToolCaller, callId: string): Promise<number> {
  const call = (await toolCalls.open(tx, caller.agentId)).find((row) => row.callId === callId);
  if (call === undefined) {
    throw new Error(`Call ${callId} of agent ${caller.agentId} is not open while it runs`);
  }
  return call.answerSeq - 1;
}
