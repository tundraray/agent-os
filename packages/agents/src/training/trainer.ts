import {
  SessionTaskStatusSchema,
  TEST_RUN_PLAN_REVISIONS_MAX,
  TEST_RUN_TOOLS,
  TRAINER_TOOLS,
  TRY_SCRIPT_TOOL,
} from '@agent-os/contracts';
import type { StepContext, StepMessage, StepResult } from '@agent-os/runtime';

import type { AgentRun, SessionHistory } from '../agent/agent-state';
import { BaseAgent } from '../agent/base-agent';
import { chatTurns } from '../agent/deliver';
import type { TurnAnswer, TurnEnd } from '../agent/model-step';
import type { StepPrelude } from '../agent/step-common';
import type { Session } from '../store/sessions';
import {
  TASK_CREATE_TOOL,
  TASK_LIST_TOOLS,
} from '../tools/system/task-list-tools';
import { withInheritedTranscript } from './inherited-transcript';
import { CODE_TASKS, TEST_RUN_FIXED_TASKS, TEST_RUN_MODEL_TASKS } from './pool';
import { nextTestRunMove, runTestRunStep } from './test-run-step';
import {
  PROPOSAL_TASK,
  runTrainerStep,
  type TrainerDeps,
} from './trainer-step';

/** The reminder after a test run's final plan (design-trainer-dialog.md, KD-2). */
const FINAL_PLAN_NOTICE = `This plan is final (revision ${TEST_RUN_PLAN_REVISIONS_MAX}): create the agent now with create_agent, exactly by this plan.`;

/**
 * The trainer, the `trainer` task type: the root of a training (self-learning design-training.md, KD-1). It is
 * not a chat — no root tools — and not a deep agent — no notepad, no report rule. It works through the pool its
 * start wrote into its task list: it cannot add tasks, and the list rule keeps the pool's set and order and
 * leaves the code tasks to code. Once a version is proposed or the proposal task is closed its steps are code
 * (`trainer-step.ts`). With `testRun` in its task input it runs a test run instead (design-test-run.md, KD-1): its
 * own tools and pool, and the hand-over between the model and code of `test-run-step.ts`; until its agent exists it
 * talks with the employee as a chat does (design-trainer-dialog.md, KD-2), and the history a fork inherited reaches
 * its model as one transcript in the data envelope (KD-6).
 */
export class Trainer extends BaseAgent {
  private readonly trainerDeps: TrainerDeps;

  constructor(deps: TrainerDeps, run: AgentRun) {
    super(deps, run);
    this.trainerDeps = deps;
  }

  /** Its reads of the trained agent, the trial run and the proposal: no other kind declares them. */
  protected override get kindTools(): readonly string[] {
    if (this.input.testRun === true) {
      const [, , , , definition, propose] = TRAINER_TOOLS;
      return [...TEST_RUN_TOOLS, definition, propose, TRY_SCRIPT_TOOL];
    }
    return [...TRAINER_TOOLS, TRY_SCRIPT_TOOL];
  }

  protected override get taskListTools(): readonly string[] {
    return TASK_LIST_TOOLS.filter((tool) => tool !== TASK_CREATE_TOOL);
  }

  protected override get fixedTasks(): readonly number[] {
    return this.input.testRun === true ? TEST_RUN_FIXED_TASKS : CODE_TASKS;
  }

  /** The model's step until it proposes a version or closes its proposal task; after that the replays and the judge, by code. */
  override async modelStep(
    ctx: StepContext,
    session: Session,
    view: SessionHistory,
    prelude?: StepPrelude,
  ): Promise<StepResult> {
    if (this.input.testRun === true) {
      const next = await nextTestRunMove(this.trainerDeps, ctx);
      return next.move.kind === 'model'
        ? super.modelStep(ctx, session, withInheritedTranscript(view), prelude)
        : runTestRunStep(this.trainerDeps, this, ctx, next, view, prelude);
    }
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

  /** A test run's compaction summarizes the inherited history as its model sees it: the transcript. */
  override compactionStep(
    ctx: StepContext,
    session: Session,
    view: SessionHistory,
    prelude?: StepPrelude,
  ): Promise<StepResult> {
    return super.compactionStep(
      ctx,
      session,
      this.input.testRun === true ? withInheritedTranscript(view) : view,
      prelude,
    );
  }

  /** A test run's employee message starts a new turn, as a chat's does (KD-2). */
  override turnsAfterDelivery(
    turns: number,
    messages: readonly StepMessage[],
  ): number {
    return this.input.testRun === true ? chatTurns(turns, messages) : turns;
  }

  /**
   * In a test run's dialog — no agent yet — an answer without calls waits for the employee's message, as a chat's,
   * except after the final plan: then a notice reminds it to create the agent (KD-2). Otherwise only the model's
   * tasks of the pool keep its turn open: the code tasks are not its to close.
   */
  override async endOfTurn(
    ctx: StepContext,
    answer: TurnAnswer,
  ): Promise<TurnEnd> {
    const testRun = this.input.testRun === true;
    if (testRun) {
      const row = await this.trainerDeps.trainingRows.find(ctx.rootId);
      if (row === undefined)
        throw new Error(`Test run ${ctx.rootId} has no training row`);
      if (row.agentId === null)
        return {
          ending:
            row.plan?.revision === TEST_RUN_PLAN_REVISIONS_MAX
              ? { kind: 'notice', text: FINAL_PLAN_NOTICE }
              : { kind: 'wait' },
          inFlight: { unfinished: 0, pending: 0 },
        };
    }
    return super.endOfTurn(ctx, {
      ...answer,
      openTasks: answer.openTasks.filter((task) =>
        testRun
          ? TEST_RUN_MODEL_TASKS.includes(task.number)
          : !CODE_TASKS.includes(task.number),
      ),
    });
  }
}
