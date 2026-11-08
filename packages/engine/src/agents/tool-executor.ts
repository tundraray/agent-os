import type { TaskSpec } from '@agent-os/contracts';
import { computeDedupKey, type InvestigationService, type RuntimeTx, type TaskScheduler } from '@agent-os/runtime';
import { runOccupiedTokens } from '../model/ledger.js';
import { childSources, childTaskSpec } from './agent-task-spec.js';
import type { ToolAccessPolicy } from './tool-access-policy.js';
import type { CallContext, CallEnding, ToolCallRow, TransitionResult, toolCallsRepository } from './tool-calls.repository.js';
import type { ToolRegistry, ToolRegistryEntry } from './tool-registry.js';
import { type CallAgentArgs, childrenStarted, decideCallAgent } from './tools/call-agent.js';
import { checkFinish } from './tools/finish.js';
import { investigationReadTool } from './tools/investigation-read.js';
import { memoryReadTool } from './tools/memory-read.js';
import { memoryWriteTool } from './tools/memory-write.js';
import type { AgentRunContext, ImmediateTool } from './tools/tool-context.js';

/**
 * The executor of an agent's tool calls (design-agent-core.md, KD-3, C3 `ToolExecutor`). For each call of a turn, in
 * order, the code decides only what it can check without reading text: the turn's call limit, whether the definition has
 * the tool, whether `finish` is alone, whether the arguments pass the schema, whether the rights port allows it, and —
 * for `call_agent` — the tree's limits and the share (KD-4). Then it runs the call by its effect class. Every step is a
 * guarded write in the mode `requireActive`, so after a stop no call goes on (ADR-0006, invariant 10).
 */

const FINISH = 'finish';
const CALL_AGENT = 'call_agent';

/** What the share and the limits of `call_agent` are read from, inside the call's guarded transaction. */
export interface AgentTreeReads {
  occupiedTokens(tx: RuntimeTx, runTaskId: string): Promise<number>;
  childrenStarted(tx: RuntimeTx, runTaskId: string): Promise<number>;
}

export const POSTGRES_AGENT_TREE: AgentTreeReads = { occupiedTokens: runOccupiedTokens, childrenStarted };

export interface ToolExecutorDeps {
  readonly registry: ToolRegistry;
  /** The tools of classes `read` and `write` by name; {@link baseImmediateTools} for the base tools. */
  readonly tools: ReadonlyMap<string, ImmediateTool>;
  readonly accessPolicy: ToolAccessPolicy;
  readonly calls: Pick<typeof toolCallsRepository, 'transition'>;
  readonly tree: AgentTreeReads;
  readonly scheduler: Pick<TaskScheduler, 'propose'>;
  readonly investigations: Pick<InvestigationService, 'listForThread'>;
  readonly clock: { now(): Date };
  /** `AGENT_DEADLINE_MARGIN_MS` and `RUNTIME_LEASE_MS`: a child's deadline (DC-27). */
  readonly timings: { readonly deadlineMarginMs: number; readonly leaseMs: number };
}

/**
 * How a turn's calls went. `executed`: every call that could go on did — `finish` is the lone call whose result passed
 * its form's schema, left for the handler to write with the run's result; `waitFor` the child tasks of the turn the run
 * waits for. `stopping` or `fenced`: a guarded write was refused, and no later call of the turn started.
 */
export type TurnExecution =
  | {
      readonly outcome: 'executed';
      readonly finish: { readonly callId: string; readonly result: unknown } | null;
      readonly waitFor: readonly string[];
    }
  | { readonly outcome: 'stopping' | 'fenced' };

export interface ToolExecutor {
  /** Executes the calls of one turn — all of them, in their order — skipping those that already have an outcome. */
  executeTurn(ctx: CallContext, run: AgentRunContext, calls: readonly ToolCallRow[]): Promise<TurnExecution>;
}

/** The immediate base tools with their result limits from the registry. */
export function baseImmediateTools(registry: ToolRegistry): ReadonlyMap<string, ImmediateTool> {
  const limit = (name: string) => registry.get(name)?.resultMaxBytes ?? 0;
  const tools = [memoryReadTool(limit('memory_read')), memoryWriteTool, investigationReadTool(limit('investigation_read'))];
  return new Map(tools.map((tool) => [tool.name, tool]));
}

const refusal = (reason: string, detail?: unknown): CallEnding => ({
  to: 'rejected',
  outcome: 'rejected',
  reason,
  ...(detail === undefined ? {} : { detail }),
});

/** What the code decides before a call runs: a refusal, the result of a lone `finish`, or the tool with its arguments. */
type Precheck =
  | { readonly kind: 'ending'; readonly ending: CallEnding }
  | { readonly kind: 'finish'; readonly result: unknown }
  | { readonly kind: 'run'; readonly entry: ToolRegistryEntry; readonly args: unknown };

function precheck(
  call: ToolCallRow,
  turn: { readonly position: number; readonly size: number },
  context: { readonly run: AgentRunContext; readonly registry: ToolRegistry },
): Precheck {
  const { definition, resultSchema } = context.run;
  if (turn.position >= definition.limits.maxCallsPerTurn) {
    return { kind: 'ending', ending: refusal('calls_per_turn_limit', { maxCallsPerTurn: definition.limits.maxCallsPerTurn }) };
  }
  const entry = context.registry.get(call.toolName);
  if (entry === undefined || (call.toolName !== FINISH && !definition.tools.includes(call.toolName))) {
    return { kind: 'ending', ending: refusal('tool_not_in_definition') };
  }
  if (entry.effect === 'finish') {
    if (turn.size > 1) return { kind: 'ending', ending: refusal('finish_not_alone') };
    const checked = checkFinish(call.arguments, resultSchema);
    return checked.valid ? { kind: 'finish', result: checked.result } : { kind: 'ending', ending: refusal('invalid_result') };
  }
  const schema = entry.argsSchema;
  const parsed = schema === 'result_form' ? resultSchema.safeParse(call.arguments) : schema.safeParse(call.arguments);
  if (!parsed.success) return { kind: 'ending', ending: refusal('invalid_arguments') };
  return { kind: 'run', entry, args: parsed.data };
}

/** The subscriber key of a child task: the parent run and its call. */
const requesterKey = (call: ToolCallRow): string => `agent-call:${call.runTaskId}:${call.callIndex}`;

type Step = { readonly kind: 'next' } | { readonly kind: 'wait'; readonly taskId: string } | { readonly kind: 'stop'; readonly outcome: 'stopping' | 'fenced' };

/** A transition's result as the turn sees it: refused writes stop the turn; anything else goes on. */
function stepOf(result: TransitionResult): Step {
  if (result.outcome === 'fenced' || result.outcome === 'stopping') return { kind: 'stop', outcome: result.outcome };
  if (result.call.state === 'waiting' && result.call.childTaskId !== null) return { kind: 'wait', taskId: result.call.childTaskId };
  return { kind: 'next' };
}

export function createToolExecutor(deps: ToolExecutorDeps): ToolExecutor {
  const end = (ctx: CallContext, call: ToolCallRow, ending: CallEnding) =>
    deps.calls.transition(ctx, { callId: call.id, from: ['requested'] }, async () => ending);

  /** A task the investigation already has for this recorded specification, in any status (KD-3). */
  async function existingTask(run: AgentRunContext, spec: TaskSpec): Promise<string | undefined> {
    const dedupKey = computeDedupKey(spec);
    const investigations = await deps.investigations.listForThread(run.resourceId, run.threadId);
    const tasks = investigations.find((investigation) => investigation.investigationId === run.investigationId)?.tasks;
    return tasks?.find((task) => task.dedupKey === dedupKey)?.taskId;
  }

  /**
   * `starting` → `waiting`: the child task of the recorded specification is proposed — or, on a retry, found — and its
   * id recorded. A refused admission (`maxTasks` or the `tool_calls` pool) ends the call `task_limit`, and its share no
   * longer counts (KD-4).
   */
  async function proposeChild(ctx: CallContext, run: AgentRunContext, call: ToolCallRow, retry: boolean): Promise<Step> {
    const spec = call.taskSpec as TaskSpec;
    const found = retry ? await existingTask(run, spec) : undefined;
    let childTaskId = found;
    if (childTaskId === undefined) {
      const proposed = await deps.scheduler.propose(spec, requesterKey(call));
      if (proposed.outcome === 'rejected') {
        if (proposed.reason === 'investigation_inactive') return { kind: 'stop', outcome: 'stopping' };
        if (proposed.reason !== 'budget_exhausted') {
          throw new Error(`child task of call ${call.id} refused: ${proposed.reason}`);
        }
        return stepOf(
          await deps.calls.transition(ctx, { callId: call.id, from: ['starting'] }, async () =>
            refusal('task_limit', proposed.details),
          ),
        );
      }
      childTaskId = proposed.taskId;
    }
    const taskId = childTaskId;
    return stepOf(
      await deps.calls.transition(ctx, { callId: call.id, from: ['starting'] }, async () => ({ to: 'waiting', childTaskId: taskId })),
    );
  }

  /** `requested` → `starting`: the limits, the share and the child's specification, in one guarded write. */
  async function startChild(ctx: CallContext, run: AgentRunContext, call: ToolCallRow, args: CallAgentArgs): Promise<Step> {
    const started = await deps.calls.transition(ctx, { callId: call.id, from: ['requested'] }, async (tx) => {
      const decision = decideCallAgent(args, {
        config: run.config,
        definition: run.definition,
        depth: run.depth,
        childrenStarted: await deps.tree.childrenStarted(tx, run.runTaskId),
        shareTokens: run.shareTokens,
        occupiedTokens: await deps.tree.occupiedTokens(tx, run.runTaskId),
      });
      if (decision.decision === 'refused') return refusal(decision.code);
      const taskSpec = childTaskSpec({
        investigationId: run.investigationId,
        agentName: args.agent,
        assignment: args.assignment,
        parent: { taskId: run.runTaskId, callIndex: call.callIndex, notAfter: run.notAfter },
        depth: run.depth + 1,
        sources: childSources(run.sources, decision.callee.sources),
        definitionDeadlineMs: decision.callee.limits.deadlineMs,
        shareTokens: decision.shareTokens,
        now: deps.clock.now(),
        timings: deps.timings,
      });
      return { to: 'starting', shareTokens: decision.shareTokens, taskSpec };
    });
    if (started.outcome !== 'written' || started.call.state !== 'starting') return stepOf(started);
    return proposeChild(ctx, run, started.call, false);
  }

  async function runRequested(
    ctx: CallContext,
    run: AgentRunContext,
    call: ToolCallRow,
    checked: Extract<Precheck, { kind: 'run' }>,
  ): Promise<Step> {
    const tool = deps.tools.get(call.toolName);
    const sourceId = tool?.sourceOf?.(checked.args) ?? null;
    const access = await deps.accessPolicy.decide({ resourceId: run.resourceId, toolName: call.toolName, sourceId });
    if (access === 'access_denied') {
      return stepOf(await end(ctx, call, { to: 'rejected', outcome: 'access_denied', reason: 'access_denied', sourceId }));
    }
    if (checked.entry.effect === 'task' && call.toolName === CALL_AGENT) {
      return startChild(ctx, run, call, checked.args as CallAgentArgs);
    }
    if (tool === undefined) throw new Error(`tool ${call.toolName} of class ${checked.entry.effect} has no executor`);
    return stepOf(
      await deps.calls.transition(ctx, { callId: call.id, from: ['requested'] }, async (tx) => ({
        ...(await tool.run({ tx, run, call, args: checked.args })),
        ...(sourceId === null ? {} : { sourceId }),
      })),
    );
  }

  return {
    async executeTurn(ctx, run, calls) {
      let finish: { callId: string; result: unknown } | null = null;
      const waitFor: string[] = [];
      for (const [position, call] of calls.entries()) {
        let step: Step = { kind: 'next' };
        if (call.state === 'waiting' && call.childTaskId !== null) {
          step = { kind: 'wait', taskId: call.childTaskId };
        } else if (call.state === 'starting') {
          step = await proposeChild(ctx, run, call, true);
        } else if (call.state === 'requested') {
          const checked = precheck(call, { position, size: calls.length }, { run, registry: deps.registry });
          if (checked.kind === 'ending') step = stepOf(await end(ctx, call, checked.ending));
          else if (checked.kind === 'finish') finish = { callId: call.id, result: checked.result };
          else step = await runRequested(ctx, run, call, checked);
        }
        if (step.kind === 'stop') return { outcome: step.outcome };
        if (step.kind === 'wait') waitFor.push(step.taskId);
      }
      return { outcome: 'executed', finish, waitFor };
    },
  };
}
