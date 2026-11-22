import type {
  RecordHeader,
  ResolvedRecord,
  RunOrigin,
} from '@agent-os/contracts';

import { descriptionLine } from '../chat-listing';
import { deepAgentDefinition } from '../deep/deep-definition';
import type {
  AgentSnapshot,
  DeepAgentSnapshot,
  RunSnapshot,
  StartableAgent,
} from './snapshot';

/**
 * What a step hands the model, computed from the run's snapshot by one pure function (ADR-0017,
 * Implementation Guidance; design-runtime.md KD-1, KD-5). No port and no database: whatever the run
 * reads live — rights, the chat listing — is read by its caller.
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
   * Lines of whom the run may call, in the order the description lists them: the agents of an agent's
   * `start_agent`, the subagents of a deep agent's `task`.
   */
  readonly startable: readonly string[];
  /**
   * The run keeps a task list (design-task-list.md KD-2): the flag of the snapshot's content — the agent's, the
   * deep agent's or the subagent's own. It gives the four task tools, the task block and the end-of-turn rule. The
   * conversation's root keeps one whatever this says.
   */
  readonly taskList: boolean;
  /** `task` takes an instruction with a list of items (deep-agents FR-24): a deep agent's flag, off elsewhere. */
  readonly listDelegation: boolean;
}

/** A line of an agent's `start_agent`: the record id it is started by, its name and description. */
function startableLine(agent: StartableAgent): string {
  return descriptionLine(`${agent.id}: ${agent.name} — ${agent.description}`);
}

/**
 * The definition of a run of any kind — the single entry every reader of a snapshot goes through. An agent and
 * a subagent are read here; a deep agent's definition is built in `deep/`.
 */
export function snapshotDefinition(snapshot: RunSnapshot): RunDefinition {
  switch (snapshot.kind) {
    case 'agent':
      return {
        name: snapshot.name,
        prompt: snapshot.content.prompt,
        model: snapshot.content.model,
        maxTurns: snapshot.content.maxTurns,
        tools: snapshot.content.tools,
        servers: snapshot.content.servers,
        startable: snapshot.agents.map(startableLine),
        taskList: snapshot.content.taskList,
        listDelegation: false,
      };
    case 'subagent':
      return {
        name: snapshot.name,
        prompt: snapshot.content.prompt,
        model: snapshot.content.model,
        maxTurns: snapshot.content.maxTurns,
        tools: [],
        servers: snapshot.content.servers,
        startable: [],
        taskList: snapshot.content.taskList,
        listDelegation: false,
      };
    case 'deep_agent':
      return deepAgentDefinition(snapshot);
  }
}

function originOf(record: ResolvedRecord): RunOrigin {
  return {
    recordId: record.id,
    kind: record.kind,
    version: record.version,
    name: record.name,
    author:
      record.author === null
        ? null
        : { id: record.author.id, name: record.author.name },
    builtinKey: record.builtinKey,
    subagent: null,
  };
}

/** `content` with its `null` model replaced by `defaultModel`; `null` — it has no model to take. */
function withModel<T extends { readonly model: string | null }>(
  content: T,
  defaultModel: string | null,
): (T & { readonly model: string }) | null {
  const model = content.model ?? defaultModel;
  return model === null ? null : { ...content, model };
}

/**
 * The snapshot of a record resolved for the starter: an agent keeps the records of its `agents` that
 * `visible` (the starter's `listVisible` at the start) holds as agents — never a deep agent (DC-3); a
 * deep agent is its content with the whole team. A `null` model of the agent, the deep agent or any
 * subagent becomes `defaultModel`, the default chat model at the start (model-providers design-core.md
 * KD-5); `null` — a model is `null` and no default chat model is chosen.
 */
export function recordSnapshot(
  record: ResolvedRecord,
  visible: readonly RecordHeader[],
  defaultModel: string | null,
): AgentSnapshot | DeepAgentSnapshot | null {
  const origin = originOf(record);
  if (record.kind === 'deep_agent') {
    const content = withModel(record.content, defaultModel);
    const subagents = record.content.subagents.map((subagent) =>
      withModel(subagent, defaultModel),
    );
    if (content === null || !subagents.every((subagent) => subagent !== null))
      return null;
    return {
      kind: 'deep_agent',
      name: record.name,
      origin,
      content: { ...content, subagents },
    };
  }
  const content = withModel(record.content, defaultModel);
  if (content === null) return null;
  const agents = content.agents.flatMap((id): StartableAgent[] => {
    const header = visible.find(
      (candidate) => candidate.id === id && candidate.kind === 'agent',
    );
    return header === undefined
      ? []
      : [{ id: header.id, name: header.name, description: header.description }];
  });
  return { kind: 'agent', name: record.name, origin, content, agents };
}
