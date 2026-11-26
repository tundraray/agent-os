import type { Logger } from '@agent-os/common';
import {
  AgentMessageKindSchema,
  type DecisionResponse,
  SessionTaskStatusSchema,
  TaskStatusSchema,
  type TestRunClosedReason,
  testRunPhase,
  TRAINER_TASK_TYPE,
  WaitReasonSchema,
} from '@agent-os/contracts';
import {
  AgentsRepository,
  ConversationsRepository,
  ConversationTasksRepository,
  RuntimeModelCallsRepository,
  TrainingsRepository,
} from '@agent-os/db';
import { Inbox, type Task, TaskControl } from '@agent-os/runtime';
import { Inject, Injectable } from '@nestjs/common';
import type { z } from 'zod';

import { AGENTS_LOGGER } from '../agents.tokens';
import { AgentsError } from '../errors';
import { messagePayload } from '../resume';
import {
  agentTaskInputOf,
  type RootSession,
  toRootSession,
} from '../store/sessions';
import { ToolRegistry } from '../tools/tool-registry';
import type {
  AgentRef,
  ResolveConfirmationRequest,
  SendRequest,
} from './agent-sessions';
import {
  agentNotFound,
  agentTask,
  asAgent,
  type ConfirmationPayloadSchema,
  createLogged,
  parentOf,
  QuestionInputSchema,
} from './operation-support';
import { isQuestion } from '../task-tree';
import { FIX_TASK } from '../training/pool';
import { inTrainingTree } from '../training/training-tree';

const { waiting, stopped } = TaskStatusSchema.enum;
const { user_message: userMessage, interrupt } = AgentMessageKindSchema.enum;

/** A test run's trainer: a root `trainer` task with `testRun` in its input. */
function isTestRunRoot(task: Task): boolean {
  return (
    task.type === TRAINER_TASK_TYPE &&
    task.taskId === task.rootId &&
    agentTaskInputOf(task.input).testRun === true
  );
}

/**
 * The operations that change a live agent or its conversation: a message, an interrupt, a stop, the decision
 * of a confirmation, and the root session's place, title and deletion.
 */
@Injectable()
export class ControlOperations {
  private readonly logger: Logger;
  private readonly logged: ReturnType<typeof createLogged>;

  constructor(
    @Inject(ConversationsRepository)
    private readonly sessionRows: ConversationsRepository,
    @Inject(TaskControl)
    private readonly tasks: Pick<
      TaskControl,
      'get' | 'interrupt' | 'stop' | 'deleteTree' | 'answer'
    >,
    @Inject(Inbox) private readonly inbox: Pick<Inbox, 'enqueue'>,
    @Inject(ToolRegistry)
    private readonly registry: Pick<ToolRegistry, 'toolOf'>,
    @Inject(AGENTS_LOGGER) logger: Logger,
    /** A test run's root takes a message by its phase (design-trainer-dialog.md, KD-2). */
    @Inject(TrainingsRepository)
    private readonly trainingRows: Pick<
      TrainingsRepository,
      'find' | 'running'
    >,
    @Inject(AgentsRepository)
    private readonly agentRows: Pick<
      AgentsRepository,
      'trainingVersions' | 'findAny'
    >,
    @Inject(ConversationTasksRepository)
    private readonly sessionTaskRows: Pick<ConversationTasksRepository, 'list'>,
    @Inject(RuntimeModelCallsRepository)
    private readonly modelCalls: Pick<RuntimeModelCallsRepository, 'sumTree'>,
  ) {
    this.logger = logger.child({ service: 'agents.sessions' });
    this.logged = createLogged(this.logger);
  }

  /**
   * Puts the employee's message in the agent's queue; a schedule's message carries its mark (schedules KD-5).
   * Inside a transaction the caller opened the message joins it (the queue's `withTxRetry` catches nothing
   * there), so the caller's other writes and the message commit together (KD-2).
   */
  send({
    agentId,
    ownerId,
    text,
    record,
    schedule,
  }: SendRequest): Promise<{ messageId: string }> {
    return this.logged(
      'send',
      {
        agentId,
        ownerId,
        recordId: record?.id ?? null,
        scheduleId: schedule?.scheduleId ?? null,
      },
      async () => {
        const target = await agentTask(this.tasks, agentId, ownerId);
        // A training tree is not resumed (self-learning design-training.md KD-3, place 5), except a test
        // run's root in its dialog and result phases (design-trainer-dialog.md, KD-2).
        if (await inTrainingTree(this.tasks, target)) {
          if (!isTestRunRoot(target)) throw agentNotFound(agentId);
          const closedReason = await this.testRunClosed(target);
          if (closedReason !== null) {
            this.logger.info('test run message refused', {
              agentId,
              ownerId,
              closedReason,
            });
            throw new AgentsError(
              'TEST_RUN_NOT_ACCEPTING',
              `Test run ${agentId} takes no message now: ${closedReason}`,
              { closedReason },
            );
          }
        }
        // Notes 5: a message to a stopped agent carries the `resume` mark; the window between this
        // read and the write is a known low risk.
        const parent =
          target.status === stopped
            ? await parentOf(this.tasks, target, ownerId)
            : null;
        const { messageId } = await asAgent(
          this.inbox.enqueue({
            recipientId: agentId,
            ownerId,
            kind: userMessage,
            payload: {
              ...messagePayload(text, target, parent),
              ...(record === undefined ? {} : { record }),
              ...(schedule === undefined ? {} : { schedule }),
            },
            revive: true,
          }),
        );
        return { messageId };
      },
      ({ messageId }) => ({ messageId }),
    );
  }

  /**
   * Why a test run's root takes no message now, or `null` (design-trainer-dialog.md, «Фазы и передача хода»):
   * only the dialog and result phases below the cap take one, and the result only while the agent is not deleted
   * and no training of it runs.
   */
  private async testRunClosed(root: Task): Promise<TestRunClosedReason | null> {
    const row = await this.trainingRows.find(root.taskId);
    if (row === undefined)
      throw new Error(`Test run ${root.taskId} has no training row`);
    const [proposed, pool, spentUsd] = await Promise.all([
      this.agentRows.trainingVersions(row.id),
      this.sessionTaskRows.list(root.taskId),
      this.modelCalls.sumTree(root.taskId),
    ]);
    const state = testRunPhase({
      rootStatus: root.status,
      capped: row.cappedAt !== null,
      agentId: row.agentId,
      takenAgentId: row.takenAgentId,
      versions: (row.baseVersionId === null ? 0 : 1) + proposed.length,
      tests: row.tests,
      fixTaskInProgress: pool.some(
        (task) =>
          task.number === FIX_TASK &&
          task.status === SessionTaskStatusSchema.enum.in_progress,
      ),
    });
    if (state.phase === 'ended') return state.reason;
    if (state.phase === 'working' || state.phase === 'taken')
      return state.phase;
    if (Number(spentUsd) >= Number(row.capUsd)) return 'capped';
    if (state.phase === 'dialog' || row.agentId === null) return null;
    if ((await this.trainingRows.running(row.agentId))?.description === null)
      return 'training_running';
    if ((await this.agentRows.findAny(row.agentId))?.deletedAt != null)
      return 'agent_deleted';
    return null;
  }

  /** Marks the agent «прерван»: it closes its open calls and waits for a message (KD-3). */
  interrupt({
    agentId,
    ownerId,
  }: AgentRef): Promise<'interrupted' | 'not_active'> {
    return this.logged(
      'interrupt',
      { agentId, ownerId },
      async () => {
        const task = await agentTask(this.tasks, agentId, ownerId);
        // A free agent (waiting for messages) has no work to cut off: `not_active`, nothing changes (Flow 4).
        if (
          task.status === waiting &&
          task.waitReason === WaitReasonSchema.enum.messages
        )
          return 'not_active';
        // KD-3: the `interrupt` message makes the agent's next step close its calls and wait.
        return asAgent(
          this.tasks.interrupt(agentId, ownerId, {
            kind: interrupt,
            payload: {},
            revive: false,
          }),
        );
      },
      (outcome) => ({ outcome }),
    );
  }

  stop({ agentId, ownerId }: AgentRef): Promise<string[]> {
    return this.logged(
      'stop',
      { agentId, ownerId },
      async () => {
        await agentTask(this.tasks, agentId, ownerId);
        // Flow 7: `tasks.stop` and nothing else; `history` shows the stop records.
        return asAgent(this.tasks.stop(agentId, ownerId));
      },
      (stoppedIds) => ({ stoppedIds }),
    );
  }

  resolveConfirmation({
    decisionId,
    ownerId,
    approve,
    args,
  }: ResolveConfirmationRequest): Promise<DecisionResponse['outcome']> {
    return this.logged(
      'resolveConfirmation',
      { decisionId, ownerId, approve, withArgs: args !== undefined },
      async () => {
        // The decision is the answer to a question task (data-model/design-runtime.md, KD-3). The edit is
        // checked only against an open question of this owner. For any other task `tasks.answer` answers
        // `already_answered` (answered or stopped) or `TASK_NOT_FOUND` (missing, another owner's, deleted or
        // not a question) and writes nothing; `TASK_NOT_FOUND` passes through as the runtime's error.
        const question =
          args === undefined
            ? undefined
            : await this.tasks.get(decisionId, ownerId);
        const edited =
          question !== undefined &&
          isQuestion(question) &&
          question.status === waiting
            ? {
                args: this.editedArgs(
                  QuestionInputSchema.parse(question.input).payload,
                  args,
                ),
              }
            : {};
        // The tool step reads `{ approve, args? }` from the question's result and the call id from its input.
        const outcome = await this.tasks.answer(decisionId, ownerId, {
          approve,
          ...edited,
        });
        return outcome === 'answered' ? 'resolved' : 'already_resolved';
      },
      (outcome) => ({ outcome }),
    );
  }

  /** Moves the owner's root session to the top of the list. */
  touchRoot(rootId: string, ownerId: string): Promise<void> {
    return this.logged('touchRoot', { rootId, ownerId }, () =>
      this.sessionRows.touchRoot(rootId, ownerId),
    );
  }

  /** Sets the title and moves the root session up; `undefined` as in `root`. */
  renameRoot(
    rootId: string,
    ownerId: string,
    title: string,
  ): Promise<RootSession | undefined> {
    return this.logged(
      'renameRoot',
      { rootId, ownerId },
      async () => {
        if (!(await this.sessionRows.renameRoot(rootId, ownerId, title)))
          return undefined;
        const row = await this.sessionRows.root(rootId, ownerId);
        return row === undefined ? undefined : toRootSession(row);
      },
      (renamed) => ({ found: renamed !== undefined }),
    );
  }

  /** Writes a generated title only into an empty one; `true` when it was written. */
  titleRootIfEmpty(
    rootId: string,
    ownerId: string,
    title: string,
  ): Promise<boolean> {
    return this.logged(
      'titleRootIfEmpty',
      { rootId, ownerId },
      () => this.sessionRows.titleRootIfEmpty(rootId, ownerId, title),
      (written) => ({ written }),
    );
  }

  /**
   * Stops the conversation's tree and marks its runtime tasks deleted (`TaskControl.deleteTree`, in
   * its own transaction, which it repeats after a deadlock): the deletion mark lives on the tasks
   * only (KD-2), and from then on the conversation answers as a missing one everywhere. The rows
   * stay. `AGENT_NOT_FOUND` for a missing, another owner's or an already deleted root.
   */
  deleteRoot(rootId: string, ownerId: string): Promise<void> {
    return this.logged('deleteRoot', { rootId, ownerId }, () =>
      asAgent(this.tasks.deleteTree(rootId, ownerId).then(() => undefined)),
    );
  }

  /** The edited arguments parsed by the tool's schema; `INVALID_ARGUMENTS` unless the tool allows the edit. */
  private editedArgs(
    payload: z.infer<typeof ConfirmationPayloadSchema>,
    args: unknown,
  ): unknown {
    // An MCP tool never allows an edit; nor does any tool of this part.
    const tool =
      payload.server === null ? this.registry.toolOf(payload.tool) : undefined;
    if (tool?.confirmation?.editableArgs !== true) {
      throw new AgentsError(
        'INVALID_ARGUMENTS',
        `Tool ${payload.tool} does not allow editing its arguments`,
      );
    }
    const parsed = tool.argsSchema.safeParse(args);
    if (!parsed.success) {
      throw new AgentsError(
        'INVALID_ARGUMENTS',
        `Arguments of ${payload.tool} rejected by its schema`,
        {
          cause: parsed.error,
        },
      );
    }
    return parsed.data;
  }
}
