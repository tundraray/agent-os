import {
  AgentMessageKindSchema,
  ToolCallStateSchema,
} from '@agent-os/contracts';
import type {
  LiveTask,
  LiveTaskIdentity,
  StepContext,
  StepMessage,
  StepResult,
} from '@agent-os/runtime';

import { type CallState, isDelegated } from '../history/call-state';
import { embedQuestion } from '../knowledge/question-vector';
import {
  type RunDefinition,
  snapshotDefinition,
} from '../start/snapshot-definition';
import type { Session, SessionInput } from '../store/sessions';
import { TASK_LIST_TOOLS } from '../tools/system/task-list-tools';
import type { ToolCaller, ToolDeclaration } from '../tools/tool';
import type { SessionTool } from '../tools/tool-registry';
import type { AgentDeps } from './agent-deps';
import {
  absorbState,
  type AgentRun,
  type AgentState,
  loadState,
  type SessionHistory,
} from './agent-state';
import { compactionDue, runCompactionStep } from './compaction-step';
import { continuationOf } from './continuation';
import type {
  CallClosing,
  Delegation,
  DelegationInput,
  FinalAnswer,
} from './delegation';
import {
  childrenInFlight,
  runModelStep,
  type TurnAnswer,
  type TurnEnd,
} from './model-step';
import {
  abandoned,
  closesOpen,
  interruptWait,
  preludeOf,
  type StepPlan,
  withPrelude,
} from './prelude';
import type { StepPrelude } from './step-common';
import { runToolStep } from './tool-step';
import { endOfTurn } from './turn-rules';

const { interrupt } = AgentMessageKindSchema.enum;
const { done } = ToolCallStateSchema.enum;

/**
 * The agent of one task: the object the runtime keeps in memory between the task's steps (design-agents.md: C3
 * `AgentStepHandler`, «Как шаг выбирает работу», KD-3, Flow 6). `AgentFactory` makes it — ready, where the task
 * is created (`createIn`), or from the database (`restore`) — and the runtime calls `step` for each step; everything
 * a step does is a method here, with its stage in the file of the same name (`tool-step.ts`, `compaction-step.ts`,
 * `model-step.ts`).
 *
 * The object holds what is fixed for the task — its identity, its parsed input, the definition, the caller and
 * the declaration of its snapshot — and the state of its session (`AgentState`): the row, the history the model
 * sees and its calls. The database stays the source of truth: a step only reads the state, its writes go to the
 * commit, and the state changes in one place, `absorb`, after the commit succeeded. Any other end of a step
 * makes the runtime drop the object and restore a new one. What rights depend on is never kept and is read on
 * every step: the chat listing, the knowledge block, the task list, the session's tools (`registry.toolsFor`,
 * `checkTools`), `access.tools`, the children in flight, the trackers.
 *
 * The class is abstract and holds what every agent does. Its three subclasses, one task type each: `Agent`
 * (`agent.ts`) — an agent's record and a deep agent's subagent; `ChatAgent` (`chat-agent.ts`) — a conversation's
 * root; `DeepAgent` (`deep/deep-agent.ts`). The methods below the stages are the points they override; their
 * bodies here are the ordinary agent's: it declares the tools of its snapshot, delegates nothing, ends its turn
 * with its own answer and adds nothing to a new session. What a snapshot hands the model — prompt, tools, flags —
 * is data: `snapshotDefinition`. An agent never picks its tools: it declares them (`declaration`), and the tools
 * library answers with the session's set for the task's owner.
 */
export abstract class BaseAgent implements LiveTask {
  /**
   * A message of the employee delivered to the session is a new question to embed (self-learning KD-6).
   * Overridden by `DeepAgent`.
   */
  protected readonly embedsEmployeeMessages: boolean = false;

  /** The task the object is of. */
  readonly task: LiveTaskIdentity;
  /** The task's input, parsed once: the snapshot written at the start (ADR-0017) and the assignment. */
  readonly input: SessionInput;
  /** What the snapshot hands the model. */
  readonly definition: RunDefinition;
  /** The agent as its tools see it. */
  readonly caller: ToolCaller;
  /**
   * What the agent declares of its tools, as plain data of its snapshot's definition: its servers, the system
   * tools it names and the task-list tools when it keeps a task list — a root always does — and whom it may
   * start or call. A root lists the employee's records, which are read live (`offeredDeclaration`), not those of
   * its snapshot. The set a step's calls are checked against is built from this.
   */
  readonly declaration: ToolDeclaration;
  /** The session as of the last commit; `undefined` until the session exists. Assigned only in `absorb`. */
  private state: AgentState | undefined = undefined;

  constructor(
    protected readonly deps: AgentDeps,
    run: AgentRun,
  ) {
    const { task, input } = run;
    const definition = snapshotDefinition(input.snapshot);
    const taskList = this.root || definition.taskList;
    this.task = task;
    this.input = input;
    this.definition = definition;
    this.caller = {
      agentId: task.taskId,
      ownerId: task.ownerId,
      rootId: task.rootId,
      root: this.root,
      depth: task.depth,
      snapshot: input.snapshot,
      servers: definition.servers,
    };
    this.declaration = {
      servers: definition.servers,
      system: [...definition.tools, ...(taskList ? TASK_LIST_TOOLS : [])],
      root: this.root,
      startable: this.root ? null : definition.startable,
      deepAgents: null,
      taskList,
      listDelegation: definition.listDelegation,
    };
  }

  /** The agent is a conversation's root. A getter: the constructor reads it. Overridden by `ChatAgent`. */
  protected get root(): boolean {
    return false;
  }

  /**
   * One step of the agent.
   *
   * 1. The state is the object's. Only an agent without a session — its starter did not make it — makes it
   *    here from the task input (through `guard`) and reads it. A session that learns gets its question vector
   *    on a new question (self-learning KD-6).
   * 2. A finished agent continues (`continuationOf`): its stop entries and `continued` go first. An `interrupt`
   *    closes the open calls and writes `interrupted`; with no other message the agent is marked and waits,
   *    with one the step goes on to its work.
   * 3. The work: open calls → the tool step; input of the previous call at the threshold → compaction;
   *    else the model step (its turn limit check is d3).
   *
   * Nothing here assigns a field: a step that throws, is cut off or loses its commit leaves the object as it was.
   */
  async step(ctx: StepContext): Promise<StepResult> {
    const startedAt = Date.now();
    const state = this.state ?? (await this.startedState(ctx));
    if (state === undefined) return abandoned(ctx, 'session write fenced');
    const { session, calls } = state;
    if (!(await this.embedQuestion(ctx, session))) {
      return abandoned(ctx, 'question write fenced or cancelled');
    }

    const plan: StepPlan = {
      continuation: continuationOf({ session, messages: ctx.messages }),
      interrupted: ctx.messages.some((message) => message.kind === interrupt),
      otherMessages: ctx.messages.some((message) => message.kind !== interrupt),
      open: calls.filter((call) => call.state !== done),
    };
    const prelude = preludeOf(this.deps, ctx, session, plan);
    // `prelude` is set: an interrupt always writes its event.
    if (plan.interrupted && !plan.otherMessages && prelude !== undefined) {
      return interruptWait(this.deps, ctx, prelude, startedAt);
    }

    // A stop or an interrupt closes the open calls, but a sent `task` call only its tracker's outcomes close
    // (deep-agents/design-task.md KD-3): the tool step closes it with the `tasks_finished` this step delivers.
    const toRun = closesOpen(plan) ? plan.open.filter(isDelegated) : plan.open;
    if (toRun.length > 0) {
      // The tool step does not know the prelude: its commit is wrapped so the prelude goes first.
      return withPrelude(
        this.deps,
        ctx,
        await this.toolStep(ctx, session, toRun, calls),
        prelude,
      );
    }
    // A compaction is written only here, with no call left open: the state from the last compaction on relies on it.
    if (compactionDue(session, this.deps.compactAtTokens)) {
      return this.compactionStep(ctx, session, state, prelude);
    }
    return this.modelStep(ctx, session, state, prelude);
  }

  /** The step's commit succeeded: the object takes the committed state in. */
  async committed(ctx: StepContext): Promise<void> {
    const startedAt = Date.now();
    await this.absorb();
    ctx.logger.debug('agent state absorbed', {
      ...this.held(),
      durationMs: Date.now() - startedAt,
    });
  }

  /** What the object holds, for the log: ids and sizes, never content. */
  held(): Record<string, unknown> {
    const { taskId, rootId, ownerId, type } = this.task;
    return {
      agentId: taskId,
      rootId,
      ownerId,
      type,
      loaded: this.state !== undefined,
      lastSeq: this.state?.lastSeq ?? null,
      entries: this.state?.entries.length ?? 0,
      forkPrefixEntries: this.state?.forkPrefix?.entries.length ?? 0,
    };
  }

  /**
   * Brings the state up to the database — the one place the object changes: the session row and
   * the entries appended since (`absorbState`), or the whole state when the object has none yet (`loadState`).
   * The entries a step wrote through `guard` come with the same read. Called after a committed step, and by
   * `AgentFactory` on a new object, before anyone else holds it.
   */
  async absorb(): Promise<void> {
    this.state =
      this.state === undefined
        ? await loadState(this.deps, this.task.taskId)
        : await absorbState(this.deps, this.state);
  }

  /**
   * The one way a session is made: `sessions.ensureSession`, then `sessionCreated` in the same transaction when
   * this call created the row.
   */
  async createSession(): Promise<void> {
    const created = await this.deps.sessions.ensureSession(
      this.task,
      this.input,
    );
    if (created) await this.sessionCreated();
  }

  /**
   * Called in the transaction that created the agent's session, once per session. Overridden by `DeepAgent`.
   */
  protected async sessionCreated(): Promise<void> {}

  /**
   * The state of an agent whose task was created without its session: the session is made from the task input
   * and read; `undefined` when the attempt is fenced. The object keeps it only after the step's commit.
   */
  private async startedState(
    ctx: StepContext,
  ): Promise<AgentState | undefined> {
    const made = await ctx.guard(() => this.createSession());
    if (made.outcome === 'fenced') return undefined;
    const state = await loadState(this.deps, ctx.taskId);
    if (state === undefined)
      throw new Error(`Session of agent ${ctx.taskId} was not created`);
    return state;
  }

  /**
   * The question vector of a session that learns; `false` — the step was cancelled or its write fenced.
   * Overridden by `ChatAgent`.
   */
  protected embedQuestion(
    ctx: StepContext,
    session: Session,
  ): Promise<boolean> {
    return embedQuestion(
      this.deps,
      ctx,
      session,
      this.input.snapshot,
      this.embedsEmployeeMessages,
    );
  }

  /**
   * The tool step (KD-1): the access gate, then each open call of the model's last answer in answer order — its
   * check, the repeat rule, the employee's confirmation, its run — and the closings in the commit
   * (`tool-step.ts`). `calls` are all the calls of the state's entries.
   */
  toolStep(
    ctx: StepContext,
    session: Session,
    openCalls: readonly CallState[],
    calls: readonly CallState[],
  ): Promise<StepResult> {
    return runToolStep(this.deps, this, ctx, session, openCalls, calls);
  }

  /** The compaction step (KD-7): the model summarizes the history it sees (`compaction-step.ts`). */
  compactionStep(
    ctx: StepContext,
    session: Session,
    view: SessionHistory,
    prelude?: StepPrelude,
  ): Promise<StepResult> {
    return runCompactionStep(this.deps, this, ctx, session, view, prelude);
  }

  /**
   * The model step (KD-1): the definition from the snapshot, the turn limit, the prompt with its knowledge and
   * task blocks, the session's tools, one model call, the answer entry and the end of the turn (`model-step.ts`).
   */
  modelStep(
    ctx: StepContext,
    session: Session,
    view: SessionHistory,
    prelude?: StepPrelude,
  ): Promise<StepResult> {
    return runModelStep(this.deps, this, ctx, session, view, prelude);
  }

  /** The declaration the tools of a model call are built from: `declaration`. Overridden by `ChatAgent`. */
  async offeredDeclaration(_ctx: StepContext): Promise<ToolDeclaration> {
    return this.declaration;
  }

  /** The turn counter after the step's messages are delivered (DC-1): unchanged. Overridden by `ChatAgent`. */
  turnsAfterDelivery(turns: number, _messages: readonly StepMessage[]): number {
    return turns;
  }

  /**
   * How the turn ends on an answer without tool calls (`endOfTurn` in `turn-rules.ts`): the agent waits for its
   * unfinished children, is reminded of its open tasks, or completes with its report — its own answer, or what
   * `finalAnswer` names. Overridden by `ChatAgent`.
   */
  async endOfTurn(ctx: StepContext, answer: TurnAnswer): Promise<TurnEnd> {
    const inFlight = await childrenInFlight(this.deps, ctx);
    const finalAnswer = await this.finalAnswer(ctx);
    const ending = endOfTurn({
      unfinishedChildren: inFlight.unfinished,
      pendingChildNotices: inFlight.pending,
      finalSubagent: finalAnswer?.subagent ?? null,
      finalSubagentReport: finalAnswer?.report ?? null,
      answerFields: answer.answerFields,
      openTasks: answer.openTasks,
      text: answer.text,
      cutOff: answer.cutOff,
    });
    return { ending, inFlight };
  }

  /**
   * The closings of the sent delegated calls this step delivers the outcomes of, asked by the tool step first.
   * Overridden by `DeepAgent`.
   */
  async closeDelegated(
    _ctx: StepContext,
    _calls: readonly CallState[],
  ): Promise<CallClosing[]> {
    return [];
  }

  /**
   * Whether a call of this tool is delegated — kept until every other call of the answer is closed — and not
   * run. Overridden by `DeepAgent`.
   */
  delegates(_tool: Pick<SessionTool, 'kind' | 'name'>): boolean {
    return false;
  }

  /** Checks the delegated calls of one answer together, outside any transaction. Overridden by `DeepAgent`. */
  async delegate(input: DelegationInput): Promise<Delegation> {
    throw new Error(
      `Agent ${input.caller.agentId} has ${input.calls.length} delegated calls, but its kind delegates none`,
    );
  }

  /**
   * The final subagent rule of the end of a turn; `null` — the agent's own answer ends its run. Overridden by
   * `DeepAgent`.
   */
  protected async finalAnswer(_ctx: StepContext): Promise<FinalAnswer | null> {
    return null;
  }
}
