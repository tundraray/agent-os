import type { RunOrigin } from '@agent-os/contracts';
import { z } from 'zod';

import type { AgentView } from '../agent-view';
import { AgentsError } from '../errors';
import type { AgentHistoryEntry } from '../operations/agent-sessions';
import type { ViewOperations } from '../operations/view-operations';
import type { DeepAgentSnapshot } from '../start/snapshot';
import { type DeepAgentBrief, DeepAgentBriefSchema } from './brief';
import { TASK_TOOL } from './deep-definition';

/** One subagent of the run's team, as its snapshot holds it. */
export interface DeepAgentTeamMember {
  readonly name: string;
  readonly maxRuns: number;
  /** The subagent whose report becomes the answer. */
  readonly final: boolean;
}

/**
 * A run of a deep agent (`DeepAgentRunView` of `packages/contracts`) with the agents' views and times as
 * `agents` gives them; `apps/api` turns them into the contract.
 */
export interface DeepAgentRun {
  /** The deep agent record the run started from, at the version confirmed. */
  readonly origin: RunOrigin;
  readonly brief: DeepAgentBrief;
  /** The run's status, model and time are the deep agent's: a run has no state of its own. */
  readonly deepAgent: AgentView;
  /** The subagents of the snapshot; those outside `steps` were not called. */
  readonly team: DeepAgentTeamMember[];
  /** The deep agent's direct children in the order they were created, each with `origin.subagent`. */
  readonly steps: AgentView[];
  /** Every `task` call refused by its subagent's `maxRuns`. */
  readonly limitRefusals: { readonly subagent: string; readonly at: Date }[];
}

/** The operations of agents the run view reads through. */
export type DeepAgentRunSessions = Pick<
  ViewOperations,
  'get' | 'list' | 'history' | 'snapshot'
>;

/** The `subagentType` of a `task` call: the subagent's name in a refusal the view lists. */
const DelegatedSubagentSchema = z.object({ subagentType: z.string() });
const HISTORY_PAGE = 500;

function runNotFound(agentId: string, cause?: unknown): AgentsError {
  return new AgentsError(
    'RUN_NOT_FOUND',
    `Deep agent run ${agentId} is not found`,
    { cause },
  );
}

function teamOf(snapshot: DeepAgentSnapshot): DeepAgentTeamMember[] {
  const { subagents, finalSubagent } = snapshot.content;
  return subagents.map(({ name, maxRuns }) => ({
    name,
    maxRuns,
    final: name === finalSubagent,
  }));
}

/** A missing or another owner's agent is a missing run. */
async function asRun<T>(agentId: string, work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof AgentsError && error.code === 'AGENT_NOT_FOUND')
      throw runNotFound(agentId, error);
    throw error;
  }
}

async function briefOf(
  sessions: DeepAgentRunSessions,
  agentId: string,
  ownerId: string,
): Promise<DeepAgentBrief> {
  const [first] = await sessions.history({ agentId, ownerId, limit: 1 });
  if (first?.kind !== 'task') {
    throw new Error(
      `Deep agent run ${agentId} has no task entry first in its history`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(first.content.text);
  } catch (error) {
    throw new Error(
      `Deep agent run ${agentId} has a task that is not a JSON brief`,
      { cause: error },
    );
  }
  const brief = DeepAgentBriefSchema.safeParse(parsed);
  if (!brief.success) {
    throw new Error(
      `Deep agent run ${agentId} has a task that is not a brief: ${brief.error.message}`,
    );
  }
  return brief.data;
}

/** The deep agent's whole history, page by page. */
async function historyOf(
  sessions: DeepAgentRunSessions,
  agentId: string,
  ownerId: string,
): Promise<AgentHistoryEntry[]> {
  const entries: AgentHistoryEntry[] = [];
  for (;;) {
    const afterSeq = entries.at(-1)?.seq ?? 0;
    const page = await sessions.history({
      agentId,
      ownerId,
      afterSeq,
      limit: HISTORY_PAGE,
    });
    entries.push(...page);
    if (page.length < HISTORY_PAGE) return entries;
  }
}

/** The deep agent's `task` results refused with `run_limit`, at the time each was written (deep-agents/design-task.md KD-6). */
async function limitRefusalsOf(
  sessions: DeepAgentRunSessions,
  agentId: string,
  ownerId: string,
): Promise<DeepAgentRun['limitRefusals']> {
  const refusals: { subagent: string; at: Date }[] = [];
  for (const entry of await historyOf(sessions, agentId, ownerId)) {
    if (entry.kind !== 'tool_result') continue;
    const { tool, refusalReason, args } = entry.content;
    if (tool !== TASK_TOOL || refusalReason !== 'run_limit') continue;
    const parsed = DelegatedSubagentSchema.safeParse(args);
    if (!parsed.success) {
      throw new Error(
        `Deep agent run ${agentId} has a run_limit refusal without a subagent name`,
      );
    }
    refusals.push({ subagent: parsed.data.subagentType, at: entry.createdAt });
  }
  return refusals;
}

/**
 * The run view of a deep agent (deep-agents KD-2, «Маршруты» `/run`), read through the agents operations
 * only: a run is the deep agent's session, its team is the snapshot of its task, the brief is its first
 * history entry. A missing agent, another owner's agent and an agent whose snapshot is not a deep agent's
 * get one and the same `RUN_NOT_FOUND`.
 */
export async function readDeepAgentRun(
  sessions: DeepAgentRunSessions,
  agentId: string,
  ownerId: string,
): Promise<DeepAgentRun> {
  const deepAgent = await asRun(agentId, sessions.get(agentId, ownerId));
  const snapshot = await asRun(agentId, sessions.snapshot(agentId, ownerId));
  if (snapshot?.kind !== 'deep_agent') throw runNotFound(agentId);
  const brief = await briefOf(sessions, agentId, ownerId);
  const tree = await sessions.list(deepAgent.rootId, ownerId);
  return {
    origin: snapshot.origin,
    brief,
    deepAgent,
    team: teamOf(snapshot),
    steps: tree.filter((agent) => agent.parentId === agentId),
    limitRefusals: await limitRefusalsOf(sessions, agentId, ownerId),
  };
}
