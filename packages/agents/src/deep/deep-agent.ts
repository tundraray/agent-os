import {
  CHILD_FINISHED_KIND,
  type ChildFinishedPayload,
  ChildFinishedPayloadSchema,
  ToolOutcomeSchema,
} from '@agent-os/contracts';
import {
  isFinished,
  type StepContext,
  type TaskControl,
} from '@agent-os/runtime';

import type { AgentDeps } from '../agent/agent-deps';
import type { AgentRun } from '../agent/agent-state';
import { BaseAgent } from '../agent/base-agent';
import { reportOf } from '../agent/deliver';
import type {
  CallClosing,
  Delegation,
  DelegationInput,
  FinalAnswer,
  FinalSubagentReport,
} from '../agent/delegation';
import type { CallState } from '../history/call-state';
import type { SessionTool } from '../tools/tool-registry';
import { TASK_TOOL } from './deep-definition';
import type { TaskArgs } from './delegation-rules';
import {
  createDelegations,
  type Delegations,
  type DelegationsDeps,
  type TaskCall,
} from './task-delegation';
import { agentOwner } from '../agent/agent-owner';

const { refused } = ToolOutcomeSchema.enum;

/**
 * What a deep agent works with: an agent's, what `task` needs, and the runtime's tasks — the final subagent's
 * answer is read from its task.
 */
export type DeepAgentDeps = AgentDeps &
  DelegationsDeps & { readonly tasks: Pick<TaskControl, 'get'> };

/** The `child_finished` of the step's messages, by child task id. */
function finishedChildren(ctx: StepContext): Map<string, ChildFinishedPayload> {
  const finished = new Map<string, ChildFinishedPayload>();
  for (const message of ctx.messages) {
    if (message.kind !== CHILD_FINISHED_KIND) continue;
    const payload = ChildFinishedPayloadSchema.parse(message.payload);
    finished.set(payload.taskId, payload);
  }
  return finished;
}

/**
 * The deep agent, the `deep_agent` task type, over the shared step of `BaseAgent` (deep-agents KD-2; design-task.md KD-4, KD-6): it gives
 * work to its subagents with `task`, whose calls of one answer are checked together and wait for their subagents;
 * with a final subagent only that subagent's completed answer ends the run; a run that learns gets its knowledge
 * run with its session and embeds each question of the employee.
 */
export class DeepAgent extends BaseAgent {
  protected override readonly embedsEmployeeMessages = true;
  private readonly delegations: Delegations;
  /** The final subagent's answer is read from its task. */
  private readonly tasks: Pick<TaskControl, 'get'>;
  /** The subagent whose answer ends the run, from the version; `null` — the deep agent's own answer does. */
  private readonly finalSubagent: string | null;

  constructor(deps: DeepAgentDeps, run: AgentRun) {
    super(deps, run);
    this.delegations = createDelegations(deps);
    this.tasks = deps.tasks;
    const { version, subagent } = run.run;
    if (version.kind !== 'deep_agent' || subagent !== null) {
      throw new Error(
        `Agent ${run.task.taskId} runs as a deep agent on ${version.kind} version ${version.id}`,
      );
    }
    this.finalSubagent = version.content.finalSubagent;
  }

  /** A run that learns gets its row with its deep agent session, in the same transaction (self-learning KD-2). */
  protected override async sessionCreated(): Promise<void> {
    const { learning } = this.definition;
    if (learning !== null)
      await this.deps.knowledgeRunRows.insertRun({
        runId: this.task.taskId,
        ...learning,
      });
  }

  /**
   * The step after their start closes the sent `task` calls, never as `unknown`: each subagent by its
   * `child_finished` this step delivers, one without it as still running (data-model/design-runtime.md, KD-2,
   * Contract «Инструмент `task`»).
   */
  override async closeDelegated(
    ctx: StepContext,
    calls: readonly CallState[],
  ): Promise<CallClosing[]> {
    if (calls.length === 0) return [];
    const results = await this.delegations.closings(
      { taskId: ctx.taskId, ownerId: agentOwner(ctx), logger: ctx.logger },
      calls,
      finishedChildren(ctx),
    );
    return results.map(
      (result): CallClosing =>
        () =>
          this.delegations.close(ctx.taskId, result),
    );
  }

  override delegates(tool: Pick<SessionTool, 'kind' | 'name'>): boolean {
    return tool.kind === 'system' && tool.name === TASK_TOOL;
  }

  /**
   * The `task` calls of the answer, checked together once every other call is closed (KD-4): a refusal is
   * closed with its text; the accepted ones start their subagents in the commit, and the step waits for them.
   */
  override async delegate({
    ctx,
    caller,
    calls,
    loggedArgs,
  }: DelegationInput): Promise<Delegation> {
    // The schema checked the arguments against the session's `task`, as its declaration describes it.
    const taskCalls: TaskCall[] = calls.map(({ call, args }) => ({
      call,
      args: args as TaskArgs,
    }));
    const decision = await this.delegations.decide(caller, taskCalls);
    const refusals = decision.refused.map((refusal) => {
      const call = taskCalls.find(
        (candidate) => candidate.call.callId === refusal.callId,
      )?.call;
      if (call === undefined)
        throw new Error(
          `Refused task call ${refusal.callId} is not of this step`,
        );
      ctx.logger.info('task delegation refused', {
        agentId: ctx.taskId,
        rootId: ctx.rootId,
        ownerId: ctx.ownerId,
        callId: call.callId,
        args: loggedArgs(call),
        reason: refusal.reason,
        rule: refusal.rule,
      });
      return {
        call,
        ending: {
          outcome: refused,
          refusalReason: refusal.reason,
          resultText: refusal.text,
        },
      };
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
          : (effects) =>
              this.delegations.open({
                effects,
                caller,
                accepted: decision.accepted,
                logger: ctx.logger,
              }),
    };
  }

  /**
   * How the last finished single `task` of the final subagent ended, and its last message (DC-4; deep-agents
   * design-task.md KD-6): its call's result names the subagent's task, whose outcome its task keeps
   * (`TaskControl.get`). Read by kind, not from the step's entries: the result may stand before the last
   * compaction. `null` — the version names no final subagent, and the deep agent's own answer ends the run.
   */
  protected override async finalAnswer(
    ctx: StepContext,
  ): Promise<FinalAnswer | null> {
    const subagent = this.finalSubagent;
    if (subagent === null) return null;
    return { subagent, report: await this.finalSubagentReport(ctx, subagent) };
  }

  private async finalSubagentReport(
    ctx: StepContext,
    subagent: string,
  ): Promise<FinalSubagentReport | null> {
    const { messageRows } = this.deps;
    const childTaskId = await messageRows.lastSingleTask(
      ctx.taskId,
      TASK_TOOL,
      subagent,
    );
    if (childTaskId === undefined) return null;
    const task = await this.tasks.get(childTaskId, agentOwner(ctx));
    // A call closed while its subagent still ran: that subagent has not answered yet.
    if (!isFinished(task.status)) return null;
    if (task.status === 'completed')
      return { status: 'completed', text: reportOf(task.result) };
    return {
      status: task.status === 'failed' ? 'failed' : 'stopped',
      text: null,
    };
  }
}
