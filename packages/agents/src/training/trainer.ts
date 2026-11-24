import {
  SessionTaskStatusSchema,
  TRAINER_TOOLS,
  TRY_SCRIPT_TOOL,
} from '@agent-os/contracts';
import type { StepContext, StepResult } from '@agent-os/runtime';

import type { AgentRun, SessionHistory } from '../agent/agent-state';
import { BaseAgent } from '../agent/base-agent';
import type { TurnAnswer, TurnEnd } from '../agent/model-step';
import type { StepPrelude } from '../agent/step-common';
import type { Session } from '../store/sessions';
import {
  TASK_CREATE_TOOL,
  TASK_LIST_TOOLS,
} from '../tools/system/task-list-tools';
import { CODE_TASKS } from './pool';
import {
  PROPOSAL_TASK,
  runTrainerStep,
  type TrainerDeps,
} from './trainer-step';

/**
 * The trainer, the `trainer` task type: the root of a training (self-learning design-training.md, KD-1). It is
 * not a chat — no root tools — and not a deep agent — no notepad, no report rule. It works through the pool its
 * start wrote into its task list: it cannot add tasks, and the list rule keeps the pool's set and order and
 * leaves the code tasks to code. Once a version is proposed or the proposal task is closed its steps are code
 * (`trainer-step.ts`).
 */
export class Trainer extends BaseAgent {
  private readonly trainerDeps: TrainerDeps;

  constructor(deps: TrainerDeps, run: AgentRun) {
    super(deps, run);
    this.trainerDeps = deps;
  }

  /** Its reads of the trained agent, the trial run and the proposal: no other kind declares them. */
  protected override get kindTools(): readonly string[] {
    return [...TRAINER_TOOLS, TRY_SCRIPT_TOOL];
  }

  protected override get taskListTools(): readonly string[] {
    return TASK_LIST_TOOLS.filter((tool) => tool !== TASK_CREATE_TOOL);
  }

  protected override get fixedTasks(): readonly number[] {
    return CODE_TASKS;
  }

  /** The model's step until it proposes a version or closes its proposal task; after that the replays and the judge, by code. */
  override async modelStep(
    ctx: StepContext,
    session: Session,
    view: SessionHistory,
    prelude?: StepPrelude,
  ): Promise<StepResult> {
    const version = await this.trainerDeps.agentRows.findTrainingVersion(
      ctx.taskId,
    );
    if (version === undefined) {
      const tasks = await this.trainerDeps.sessionTaskRows.list(ctx.taskId);
      const proposal = tasks.find((task) => task.number === PROPOSAL_TASK);
      if (proposal?.status !== SessionTaskStatusSchema.enum.completed)
        return super.modelStep(ctx, session, view, prelude);
    }
    return runTrainerStep(this.trainerDeps, this, ctx, version, view, prelude);
  }

  /** Only the model's tasks of the pool keep its turn open: the code tasks are not its to close. */
  override endOfTurn(ctx: StepContext, answer: TurnAnswer): Promise<TurnEnd> {
    return super.endOfTurn(ctx, {
      ...answer,
      openTasks: answer.openTasks.filter(
        (task) => !CODE_TASKS.includes(task.number),
      ),
    });
  }
}
