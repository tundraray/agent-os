import type { Logger } from '@agent-os/common';
import type { RecordKind } from '@agent-os/contracts';
import type { RuntimeTx } from '@agent-os/runtime';
import { z } from 'zod';

import type { AccessAudit, AccessGate } from '../../access-gate';
import type { RecordLibrary } from '../../start/record-library';
import {
  auditStartRefusal,
  RECORD_UNAVAILABLE,
  resolveStart,
  type StartDeps,
  type StartRefusal,
  type StartResolution,
  type StartSource,
} from '../../start/resolve-start';
import type { RunSnapshot } from '../../start/snapshot';
import { history } from '../../store/history.repository';
import { FORK_AGENT, type InCommitAgentTool, type ToolCaller } from '../tool';
import { gateStart, type LaunchSet, type StartGate, type StartTarget } from '../tool-gate';
import { logStart } from './start-child';

/** The built-in tool that starts an agent; its description lists whom the session may start. */
export const START_AGENT_TOOL = 'start_agent';

/**
 * How an agent waits for what it started (KD-2): the model reads it in the description and in every
 * result of `start_agent` and `start_deep_agent`, so it ends its turn instead of polling `list_agents`.
 */
export const WAITING_RULE =
  'Do not wait for it with list_agents or any other call: when you have nothing else to do, end your turn with a short text and no tool calls. You are resumed automatically when its report arrives.';

/** Arguments of `start_agent` (design-runtime.md, «Инструменты модели»); there is no `model`. */
export const StartAgentArgsSchema = z.object({
  description: z
    .string()
    .min(1)
    .describe('A few words naming the assignment, shown in the list of agents'),
  agent: z
    .string()
    .min(1)
    .describe(
      `What to start, as the description lists it: the id of an agent, a subagent's name in your team, or "${FORK_AGENT}" for a copy of yourself`,
    ),
  prompt: z.string().min(1).describe('The assignment: everything the agent needs to do the work'),
});
export type StartAgentArgs = z.infer<typeof StartAgentArgsSchema>;

/**
 * The description of `start_agent` the model sees: the lines of whom the session may start (the chat
 * listing, the agent's `agents` or the deep agent's team), each as a list item, and the fork unless the
 * session is a deep agent.
 */
export function describeStartAgent(startable: readonly string[], canFork: boolean): string {
  const lines = startable.length === 0 ? ['(none)'] : startable.map((line) => `- ${line}`);
  return [
    'Start an agent in the background on an assignment. It returns the agentId at once; the agent works on its own, and its report arrives as a message when it finishes.',
    WAITING_RULE,
    ...(canFork ? [`Use agent "${FORK_AGENT}" to start a copy of yourself that sees your history so far.`] : []),
    'Agents you may start:',
    ...lines,
  ].join('\n');
}

export interface StartAgentDeps {
  /** The root's launch set is read from it; `resolveStart` asks it for the record. */
  readonly library: RecordLibrary;
  /** `resolveStart` asks it about the child's model (design-access.md KD-4). */
  readonly access: AccessGate;
  /** `resolveStart` asks it whether the child's model has a ready provider (model-providers KD-2). */
  readonly providers: StartDeps['providers'];
  /** Gets the `access_denied` record of a start refused for its model, in `execute` (KD-6). */
  readonly audit: AccessAudit;
  /** `AGENT_MAX_DEPTH`. */
  readonly maxDepth: number;
  readonly logger: Logger;
}

/** What the call names, before the commit counts a subagent's starts. */
type NamedTarget =
  | Exclude<StartTarget, { kind: 'subagent' }>
  | { readonly kind: 'subagent'; readonly name: string };

/** What `prepare` hands `execute`: the call's target, the caller's launch set and the start procedure's answer. */
interface PreparedStart {
  readonly startedAt: number;
  readonly target: NamedTarget;
  readonly launchSet: LaunchSet;
  /** `null` — nothing was resolved, the gate refuses the target. */
  readonly source: StartSource | null;
  readonly resolution: StartResolution | null;
}

const RecordIdSchema = z.uuid();

/**
 * The call's target before its record's kind is known: a deep agent names its subagents, so only an id
 * that is not a name of its team is taken as a record — to refuse a deep agent's id with its own text.
 */
function targetOf(agent: string, snapshot: RunSnapshot): NamedTarget {
  if (agent === FORK_AGENT) return { kind: 'fork' };
  if (
    snapshot.kind === 'deep_agent' &&
    (snapshot.content.subagents.some((subagent) => subagent.name === agent) ||
      !RecordIdSchema.safeParse(agent).success)
  ) {
    return { kind: 'subagent', name: agent };
  }
  return { kind: 'record', recordId: agent, recordKind: null };
}

/** The caller's launch set (Terms «Набор запуска»): the root's is read live, the others' from the snapshot. */
async function launchSetOf(caller: ToolCaller, library: RecordLibrary): Promise<LaunchSet> {
  const { snapshot } = caller;
  if (snapshot.kind === 'deep_agent') {
    return { kind: 'team', subagents: snapshot.content.subagents };
  }
  if (caller.parentId === null) {
    return { kind: 'root', headers: await library.listVisible(caller.ownerId), tool: 'agent' };
  }
  return { kind: 'agents', ids: snapshot.kind === 'agent' ? snapshot.agents.map((agent) => agent.id) : [] };
}

/**
 * The kind of the record the call names, as the caller's owner sees it (DC-3): the root reads it from its
 * headers, an agent knows the records of its `agents` are agents, any other record is asked of the
 * library on the owner's behalf; `null` — the owner does not see it.
 */
async function recordKindOf(
  recordId: string,
  caller: ToolCaller,
  launchSet: LaunchSet,
  library: RecordLibrary,
): Promise<RecordKind | null> {
  if (launchSet.kind === 'root') {
    return launchSet.headers.find((candidate) => candidate.id === recordId)?.kind ?? null;
  }
  if (launchSet.kind === 'agents' && launchSet.ids.includes(recordId)) return 'agent';
  return (await library.resolve(caller.ownerId, recordId))?.kind ?? null;
}

/**
 * Where the child's snapshot comes from (design-runtime.md, «Откуда берётся снимок»); `null` for a target
 * the gate refuses without the library — a deep agent's fork, a name outside its team, a deep agent's
 * record, a record outside an agent's `agents`.
 */
function sourceOf(target: NamedTarget, caller: ToolCaller, launchSet: LaunchSet): StartSource | null {
  const { snapshot } = caller;
  switch (target.kind) {
    case 'fork':
      return launchSet.kind === 'team' ? null : { kind: 'fork', snapshot };
    case 'subagent':
      return snapshot.kind === 'deep_agent' &&
        snapshot.content.subagents.some((subagent) => subagent.name === target.name)
        ? { kind: 'subagent', deepAgent: snapshot, name: target.name }
        : null;
    case 'record':
      if (target.recordKind === 'deep_agent') return null;
      // The root checks the kind and the switch in the gate (`not_allowed`), so it resolves the record as it is.
      if (launchSet.kind === 'root') {
        return { kind: 'record', recordId: target.recordId, expected: target.recordKind ?? 'agent' };
      }
      return launchSet.kind === 'agents' && launchSet.ids.includes(target.recordId)
        ? { kind: 'record', recordId: target.recordId, expected: 'agent' }
        : null;
  }
}

/**
 * `start_agent` (design-runtime.md, «Инструменты модели», Flow 1, Flow 2; KD-2, KD-5). Before the commit,
 * `prepare` reads the caller's launch set and asks `resolveStart` for the child's snapshot and model on
 * behalf of the caller's owner, so neither the library nor the gate is asked while the commit transaction
 * is open (ADR-0017). In the commit the refusals go in the order of plan Notes 2: `record_unavailable`,
 * then `gateStart` (`not_allowed`, `run_limit`, `depth_limit`), then the model or its provider with the
 * model's id (`model_not_configured` without one). A refusal is
 * the call's result and creates no task; otherwise the child is started on its snapshot and its `agentId`
 * is the result of the same step. A fork gets the caller's snapshot and a link to the caller's history
 * through the last entry before the answer that holds this call. A retried step repeats `prepare`; the
 * snapshot of the committed attempt holds.
 */
export function createStartAgentTool(
  deps: StartAgentDeps,
): InCommitAgentTool<StartAgentArgs, PreparedStart> {
  const logger = deps.logger.child({ service: 'agents.start' });

  function refuse(
    caller: ToolCaller,
    prepared: PreparedStart,
    reason: Extract<StartGate, { kind: 'refused' }>['reason'] | StartRefusal['reason'],
    model: string | null,
    text?: string,
  ) {
    logStart(logger, {
      ownerId: caller.ownerId,
      rootId: caller.rootId,
      parentId: caller.agentId,
      agentId: null,
      source: prepared.source?.kind ?? null,
      ...(prepared.target.kind === 'record' ? { recordId: prepared.target.recordId } : {}),
      resolution: prepared.resolution,
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
    description: describeStartAgent([], true),
    argsSchema: StartAgentArgsSchema,
    mode: 'in_commit',
    // The assignment prompt stays out of the log.
    loggedArgs: ({ agent, description }) => ({ agent, description }),
    async prepare({ args, caller }) {
      const startedAt = Date.now();
      const named = targetOf(args.agent, caller.snapshot);
      const launchSet = await launchSetOf(caller, deps.library);
      if (named.kind === 'record' && !RecordIdSchema.safeParse(named.recordId).success) {
        return { startedAt, target: named, launchSet, source: null, resolution: RECORD_UNAVAILABLE };
      }
      const target: NamedTarget =
        named.kind === 'record'
          ? { ...named, recordKind: await recordKindOf(named.recordId, caller, launchSet, deps.library) }
          : named;
      // A record an agent's owner does not see is refused before the gate, as the start procedure would
      // (plan Notes 2); at a deep agent the gate refuses any id outside its team with the team's text.
      if (target.kind === 'record' && target.recordKind === null && launchSet.kind === 'agents') {
        return { startedAt, target, launchSet, source: null, resolution: RECORD_UNAVAILABLE };
      }
      const source = sourceOf(target, caller, launchSet);
      const resolution =
        source === null ? null : await resolveStart({ ownerId: caller.ownerId, source }, deps);
      return { startedAt, target, launchSet, source, resolution };
    },
    async execute({ callId, args, caller, tx, startChild, prepared }) {
      if (prepared === undefined) {
        throw new Error(`start_agent of agent ${caller.agentId} runs without its prepare`);
      }
      const { resolution } = prepared;
      if (resolution?.kind === 'refused' && resolution.reason === 'record_unavailable') {
        return refuse(caller, prepared, 'record_unavailable', null);
      }

      const target: StartTarget =
        prepared.target.kind === 'subagent'
          ? {
              ...prepared.target,
              startedCount: await history.startedCount(tx, caller.agentId, prepared.target.name),
            }
          : prepared.target;
      const gate = gateStart({
        launchSet: prepared.launchSet,
        target,
        depth: caller.depth,
        maxDepth: deps.maxDepth,
      });
      if (gate.kind === 'refused') return refuse(caller, prepared, gate.reason, null, gate.text);
      if (resolution === null) {
        throw new Error(`start_agent of agent ${caller.agentId} passed the gate with nothing resolved`);
      }
      if (resolution.kind === 'refused') {
        await auditStartRefusal(deps.audit, resolution);
        return refuse(caller, prepared, resolution.reason, resolution.model);
      }

      const { agentId } = await startChild({
        snapshot: resolution.snapshot,
        description: args.description,
        prompt: args.prompt,
        ...(target.kind === 'fork'
          ? { forkedFrom: { agentId: caller.agentId, throughSeq: await seqBeforeAnswer(tx, caller, callId) } }
          : {}),
      });
      logStart(logger, {
        ownerId: caller.ownerId,
        rootId: caller.rootId,
        parentId: caller.agentId,
        agentId,
        source: prepared.source?.kind ?? null,
        resolution,
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

/** The fork's link (KD-7): the last entry of the caller before the `model_answer` that requested this call. */
async function seqBeforeAnswer(tx: RuntimeTx, caller: ToolCaller, callId: string): Promise<number> {
  const answerSeq = await history.answerSeqOf(tx, caller.agentId, callId);
  if (answerSeq === undefined) {
    throw new Error(`No answer of agent ${caller.agentId} requested call ${callId}`);
  }
  return answerSeq - 1;
}
