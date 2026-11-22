import type { Transaction } from '@agent-os/db';
import { ToolOutcomeSchema } from '@agent-os/contracts';
import type { StepContext } from '@agent-os/runtime';

import type { AgentDeps } from '../agent/agent-deps';
import type { AgentRun } from '../agent/agent-state';
import { BaseAgent } from '../agent/base-agent';
import type {
  CallClosing,
  Delegation,
  DelegationInput,
  FinalAnswer,
  FinalSubagentReport,
} from '../agent/delegation';
import type { CallState } from '../history/call-state';
import type { DeepAgentSnapshot, RunSnapshot } from '../start/snapshot';
import type { SessionTool } from '../tools/tool-registry';
import { learningRunOf, TASK_TOOL } from './deep-definition';
import type { TaskArgs } from './delegation-rules';
import { createDelegations, type Delegations, type DelegationsDeps, reportOf, type TaskCall } from './task-delegation';

const { refused } = ToolOutcomeSchema.enum;

function deepAgentOf(snapshot: RunSnapshot, agentId: string): DeepAgentSnapshot {
  if (snapshot.kind !== 'deep_agent') {
    throw new Error(`Agent ${agentId} runs as a deep agent without a deep agent's snapshot`);
  }
  return snapshot;
}

/** What a deep agent works with: an agent's, and what `task` needs. */
export type DeepAgentDeps = AgentDeps & DelegationsDeps;

/**
 * The deep agent, the `deep_agent` task type, over the shared step of `BaseAgent` (deep-agents KD-2; design-task.md KD-4, KD-6): it gives
 * work to its subagents with `task`, whose calls of one answer are checked together and wait for one tracker;
 * with a final subagent only that subagent's completed answer ends the run; a run that learns gets its knowledge
 * run with its session and embeds each question of the employee.
 */
export class DeepAgent extends BaseAgent {
  protected override readonly embedsEmployeeMessages = true;
  private readonly delegations: Delegations;
  /** The outcomes of the trackers' tasks: the final subagent's answer is read through them. */
  private readonly trackers: DelegationsDeps['trackers'];
  /** The subagent whose answer ends the run, from the snapshot; `null` — the deep agent's own answer does. */
  private readonly finalSubagent: string | null;

  constructor(deps: DeepAgentDeps, run: AgentRun) {
    super(deps, run);
    this.delegations = createDelegations(deps);
    this.trackers = deps.trackers;
    this.finalSubagent = deepAgentOf(run.input.snapshot, run.task.taskId).content.finalSubagent;
  }

  /** A run that learns gets its row with its deep agent session, in the same transaction (self-learning KD-2). */
  protected override async sessionCreated(tx: Transaction): Promise<void> {
    const learning = learningRunOf(this.input.snapshot);
    if (learning !== null) await this.deps.knowledgeRunRows.insertRun(tx, { runId: this.task.taskId, ...learning });
  }

  /**
   * Sent `task` calls wait for their tracker, and the step that delivers its `tasks_finished` closes them with
   * the outcomes of their tasks (KD-4), never as `unknown`.
   */
  override async closeDelegated(ctx: StepContext, calls: readonly CallState[]): Promise<CallClosing[]> {
    if (calls.length === 0) return [];
    const results = await this.delegations.closings(
      { taskId: ctx.taskId, ownerId: ctx.ownerId, logger: ctx.logger },
      calls,
    );
    return results.map((result): CallClosing => (tx) => this.delegations.close(tx, ctx.taskId, result));
  }

  override delegates(tool: Pick<SessionTool, 'kind' | 'name'>): boolean {
    return tool.kind === 'system' && tool.name === TASK_TOOL;
  }

  /**
   * The `task` calls of the answer, checked together once every other call is closed (KD-4): a refusal is
   * closed with its text; the accepted ones open one tracker in the commit, and the step waits for it.
   */
  override async delegate({ ctx, caller, calls, loggedArgs }: DelegationInput): Promise<Delegation> {
    // The schema checked the arguments against the session's `task`, as its declaration describes it.
    const taskCalls: TaskCall[] = calls.map(({ call, args }) => ({ call, args: args as TaskArgs }));
    const decision = await this.delegations.decide(caller, taskCalls);
    const refusals = decision.refused.map((refusal) => {
      const call = taskCalls.find((candidate) => candidate.call.callId === refusal.callId)?.call;
      if (call === undefined) throw new Error(`Refused task call ${refusal.callId} is not of this step`);
      ctx.logger.info('task delegation refused', {
        agentId: ctx.taskId,
        rootId: ctx.rootId,
        ownerId: ctx.ownerId,
        callId: call.callId,
        args: loggedArgs(call),
        reason: refusal.reason,
        rule: refusal.rule,
      });
      return { call, ending: { outcome: refused, refusalReason: refusal.reason, resultText: refusal.text } };
    });
    for (const accepted of decision.accepted) {
      ctx.logger.info('task delegation accepted', {
        agentId: ctx.taskId,
        rootId: ctx.rootId,
        ownerId: ctx.ownerId,
        callId: accepted.callId,
        subagent: accepted.subagent,
        form: accepted.form.kind,
        tasks: accepted.form.kind === 'single' ? 1 : accepted.form.items.length,
        answerFields: accepted.answerFields.length,
        listTask: accepted.listTask,
      });
    }
    return {
      refused: refusals,
      accepted: decision.accepted.length,
      open:
        decision.accepted.length === 0
          ? null
          : (tx, effects) =>
              this.delegations.open({ tx, effects, caller, accepted: decision.accepted, logger: ctx.logger }),
    };
  }

  /**
   * How the last finished single `task` of the final subagent ended, and its last message (DC-4; deep-agents
   * design-task.md KD-6): its call's result names the subagent's task, whose outcome the tracker keeps. Read by
   * kind, not from the step's entries: the result may stand before the last compaction. `null` — the snapshot
   * names no final subagent, and the deep agent's own answer ends the run.
   */
  protected override async finalAnswer(ctx: StepContext): Promise<FinalAnswer | null> {
    const subagent = this.finalSubagent;
    if (subagent === null) return null;
    return { subagent, report: await this.finalSubagentReport(ctx, subagent) };
  }

  private async finalSubagentReport(ctx: StepContext, subagent: string): Promise<FinalSubagentReport | null> {
    const { database, messageRows } = this.deps;
    const childTaskId = await messageRows.lastSingleTask(database, ctx.taskId, TASK_TOOL, subagent);
    if (childTaskId === undefined) return null;
    const trackers = await this.trackers.list(ctx.taskId, ctx.ownerId);
    const task = trackers.flatMap((tracker) => tracker.tasks).find((candidate) => candidate.taskId === childTaskId);
    if (task === undefined) throw new Error(`Subagent task ${childTaskId} of agent ${ctx.taskId} is in no tracker`);
    if (task.status === 'completed') return { status: 'completed', text: reportOf(task) };
    return { status: task.status === 'failed' ? 'failed' : 'stopped', text: null };
  }
}
