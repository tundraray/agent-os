import {
  type AgentVersion,
  nameWinners,
  type RecordHeader,
} from '@agent-os/contracts';

import { listingLine } from '../chat-listing';
import {
  deepAgentDefinition,
  type LearningRun,
  subagentDefinition,
} from '../deep/deep-definition';

/**
 * What a run is started on (data-model design-agents.md, KD-6; «Старт: версия, имя и модель беседы»): the
 * immutable version, the run's name, the team member of a deep agent's version a subagent run is, and the
 * model the start chose by the chain of KD-3. The task input keeps the version by id; the agent reads the
 * version once, when its object is made.
 */
export interface RunStart {
  readonly version: AgentVersion;
  /** The agent's name, the team member's, or the name a call gave a temporary agent. */
  readonly name: string;
  /** The team member of a deep agent's version; `null` — the version's agent itself. */
  readonly subagent: string | null;
  readonly model: string;
}

/**
 * What a step hands the model, computed from the run's start by one pure function (ADR-0017,
 * Implementation Guidance; run-snapshot.md). No port and no database: whatever the run reads live —
 * rights, the listings of whom it may start — is read by its caller.
 */
export interface RunDefinition {
  readonly name: string;
  /** The system prompt. */
  readonly prompt: string;
  readonly model: string;
  readonly maxTurns: number;
  /**
   * System tools the run names: an agent's record tools, a deep agent's `task`. The agent's declaration adds
   * the task-list tools to them; `run_code` and the root's tools are the tools library's.
   */
  readonly tools: readonly string[];
  /** Registry server names, or `*` for every server. */
  readonly servers: readonly string[];
  /**
   * Lines of whom the run may call that the version itself fixes: the team of a deep agent's `task`. An
   * agent's `start_agent` lines depend on what its owner sees now: `agentLines` of its `agents`, read per step.
   */
  readonly startable: readonly string[];
  /** The agent records an agent's version lists to start (`content.agents`); empty for any other run. */
  readonly agents: readonly string[];
  /**
   * The run keeps a task list (design-task-list.md KD-2): the flag of the agent's, the deep agent's or the
   * subagent's own content. The conversation's root keeps one whatever this says.
   */
  readonly taskList: boolean;
  /** `task` takes an instruction with a list of items (deep-agents FR-24): a deep agent's flag, off elsewhere. */
  readonly listDelegation: boolean;
  /**
   * The run learns (self-learning design-core.md KD-2): the deep agent and the servers of its lessons; a
   * subagent of a learning deep agent gets the same. `null` — it does not learn.
   */
  readonly learning: LearningRun | null;
}

/**
 * The definition of a run of any kind — the single entry every reader of a run's version goes through. An
 * agent is read here; a deep agent and its team member in `deep/`.
 */
export function runDefinition(run: RunStart): RunDefinition {
  const { version } = run;
  if (version.kind === 'deep_agent') {
    return run.subagent === null
      ? deepAgentDefinition(run, version)
      : subagentDefinition(run, version, run.subagent);
  }
  if (run.subagent !== null) {
    throw new Error(
      `Run ${run.name} names team member ${run.subagent} of agent version ${version.id}, which has no team`,
    );
  }
  const { content } = version;
  return {
    name: run.name,
    prompt: content.prompt,
    model: run.model,
    maxTurns: content.maxTurns,
    tools: content.tools,
    servers: content.servers,
    startable: [],
    agents: content.agents,
    taskList: content.taskList,
    listDelegation: false,
    learning: null,
  };
}

/**
 * The lines of an agent's `start_agent` (data-model design-agents.md, «Инструменты модели»): the agents of its
 * `agents` that `visible` (its owner's `listVisible` now) holds as agents — never a deep agent — and that win
 * their name (`nameWinners`), so a line never names one the call would not start; in the order of `agents`.
 * The list only decides whom to show: a call starts any agent its name finds (KD-5, rule 1).
 */
export function agentLines(
  agentIds: readonly string[],
  visible: readonly RecordHeader[],
): string[] {
  const winners = nameWinners(
    visible.filter((header) => header.kind === 'agent'),
  );
  return agentIds.flatMap((id) => {
    const header = winners.find((candidate) => candidate.id === id);
    return header === undefined ? [] : [listingLine(header)];
  });
}
