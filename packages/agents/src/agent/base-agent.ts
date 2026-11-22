import { AgentMessageKindSchema, ToolCallStateSchema } from '@agent-os/contracts';
import type { Transaction } from '@agent-os/db';
import type { StepContext, StepMessage, StepResult, TaskHandler } from '@agent-os/runtime';

import { type CallState, foldCalls, isDelegated } from '../history/call-state';
import type { HistoryEntry } from '../history/history';
import { embedQuestion } from '../knowledge/question-vector';
import type { RunSnapshot } from '../start/snapshot';
import { snapshotDefinition } from '../start/snapshot-definition';
import { history } from '../store/history.repository';
import {
  AgentTaskInputSchema,
  type RunStart,
  type Session,
  type SessionInput,
  sessionInputOf,
  sessions,
  type SessionTask,
} from '../store/sessions.repository';
import { TASK_LIST_TOOLS } from '../tools/system/task-list-tools';
import type { ToolCaller, ToolDeclaration } from '../tools/tool';
import type { SessionTool } from '../tools/tool-registry';
import type { AgentDeps } from './agent-deps';
import { compactionDue, runCompactionStep } from './compaction-step';
import { continuationOf } from './continuation';
import type { CallClosing, Delegation, DelegationInput, FinalAnswer } from './delegation';
import { childrenInFlight, runModelStep, type TurnAnswer, type TurnEnd } from './model-step';
import { abandoned, closesOpen, interruptWait, preludeOf, type StepPlan, withPrelude } from './prelude';
import type { StepPrelude } from './step-common';
import { runToolStep } from './tool-step';
import { endOfTurn } from './turn-rules';

const { interrupt } = AgentMessageKindSchema.enum;
const { done } = ToolCallStateSchema.enum;

/**
 * The agent: a handler of the runtime's tasks (design-agents.md: C3 `AgentStepHandler`, «Как шаг выбирает
 * работу», KD-3, Flow 6). The runtime calls `step` for each step of a task of the agent's `type`; everything a
 * step does is a method here, with its stage in the file of the same name (`tool-step.ts`, `compaction-step.ts`,
 * `model-step.ts`). Between steps the agent keeps nothing in memory: each step reads the session.
 *
 * The class is abstract and holds what every agent does. The runtime launches its three subclasses, one task
 * type each: `Agent` (`agent.ts`) — an agent's record and a deep agent's subagent; `ChatAgent`
 * (`chat-agent.ts`) — a conversation's root; `DeepAgent` (`deep/deep-agent.ts`). The methods below the stages are
 * the points they override; their bodies here are the ordinary agent's: it declares the tools of its snapshot,
 * delegates nothing, ends its turn with its own answer and adds nothing to a new session. What a snapshot hands
 * the model — prompt, tools, flags — is data: `snapshotDefinition`. An agent never picks its tools: it declares
 * them (`toolDeclaration`), and the tools library answers with the session's set for the task's owner.
 */
export abstract class BaseAgent implements TaskHandler, RunStart {
  /** The runtime task type this agent handles: a task is created with it where its run starts (`RunStart`). */
  abstract readonly type: string;
  readonly inputSchema = AgentTaskInputSchema;

  /**
   * A message of the employee delivered to the session is a new question to embed (self-learning KD-6).
   * Overridden by `DeepAgent`.
   */
  protected readonly embedsEmployeeMessages: boolean = false;

  /** The agent is a conversation's root. Overridden by `ChatAgent`. */
  protected readonly root: boolean = false;

  constructor(protected readonly deps: AgentDeps) {}

  /**
   * One step of the agent.
   *
   * 1. The session is made from the task input — the snapshot written at the start (ADR-0017) — if the
   *    starter did not make it (through `guard`). A session that learns gets its question vector on a
   *    new question (self-learning KD-6).
   * 2. The visible history is read once and its calls folded.
   * 3. A finished agent continues (`continuationOf`): its stop entries and `continued` go first. An `interrupt`
   *    closes the open calls and writes `interrupted`; with no other message the agent is marked and waits,
   *    with one the step goes on to its work.
   * 4. The work: open calls → the tool step; input of the previous call at the threshold → compaction;
   *    else the model step (its turn limit check is d3).
   */
  async step(ctx: StepContext): Promise<StepResult> {
    const startedAt = Date.now();
    const session = await this.sessionOf(ctx);
    if (session === undefined) return abandoned(ctx, 'session write fenced');
    if (!(await this.embedQuestion(ctx, session))) {
      return abandoned(ctx, 'question write fenced or cancelled');
    }

    // One read of the history for the whole step: from the last compaction on, where every open call
    // and everything the model sees is. Nothing is cached between steps — any worker runs the next one.
    const own: HistoryEntry[] = await history.visible(this.deps.database, ctx.taskId);
    const calls = foldCalls(own);

    const plan: StepPlan = {
      continuation: continuationOf({ session, messages: ctx.messages }),
      interrupted: ctx.messages.some((message) => message.kind === interrupt),
      otherMessages: ctx.messages.some((message) => message.kind !== interrupt),
      open: calls.filter((call) => call.state !== done),
    };
    const prelude = preludeOf(ctx, session, plan);
    // `prelude` is set: an interrupt always writes its event.
    if (plan.interrupted && !plan.otherMessages && prelude !== undefined) {
      return interruptWait(ctx, prelude, startedAt);
    }

    // A stop or an interrupt closes the open calls, but a sent `task` call only its tracker's outcomes close
    // (deep-agents/design-task.md KD-3): the tool step closes it with the `tasks_finished` this step delivers.
    const toRun = closesOpen(plan) ? plan.open.filter(isDelegated) : plan.open;
    if (toRun.length > 0) {
      // The tool step does not know the prelude: its commit is wrapped so the prelude goes first.
      return withPrelude(ctx, await this.toolStep(ctx, session, toRun, calls), prelude);
    }
    // A compaction is written only here, with no call left open: `history.visible` relies on it.
    if (compactionDue(session, this.deps.compactAtTokens)) {
      return this.compactionStep(ctx, session, own, prelude);
    }
    return this.modelStep(ctx, session, own, prelude);
  }

  /**
   * The one way a session is made: `sessions.ensureSession`, then `sessionStarted` in the same transaction when
   * this call created the row — the starter and the agent's first step race, and only one of them creates it.
   */
  async startSession(tx: Transaction, task: SessionTask, input: SessionInput): Promise<void> {
    const created = await sessions.ensureSession(tx, task, input);
    if (created) await this.sessionStarted(tx, task.taskId, input.snapshot);
  }

  /**
   * Called in the transaction that created the agent's session, once per session. Overridden by `DeepAgent`.
   */
  protected async sessionStarted(_tx: Transaction, _taskId: string, _snapshot: RunSnapshot): Promise<void> {}

  /** The session of the agent, made from the snapshot in the task input when missing; `undefined` when the attempt is fenced. */
  private async sessionOf(ctx: StepContext): Promise<Session | undefined> {
    const { database } = this.deps;
    const existing = await sessions.get(database, ctx.taskId);
    if (existing !== undefined) return existing;
    const input = sessionInputOf(ctx.input);
    const made = await ctx.guard((tx: Transaction) => this.startSession(tx, ctx, input));
    if (made.outcome === 'fenced') return undefined;
    const session = await sessions.get(database, ctx.taskId);
    if (session === undefined) throw new Error(`Session of agent ${ctx.taskId} was not created`);
    return session;
  }

  /**
   * The question vector of a session that learns; `false` — the step was cancelled or its write fenced.
   * Overridden by `ChatAgent`.
   */
  protected embedQuestion(ctx: StepContext, session: Session): Promise<boolean> {
    return embedQuestion(this.deps, ctx, session, this.embedsEmployeeMessages);
  }

  /**
   * The tool step (KD-1): the access gate, then each open call of the model's last answer in answer order — its
   * check, the repeat rule, the employee's confirmation, its run — and the closings in the commit
   * (`tool-step.ts`). `calls` are all the calls of the visible history.
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
    own: readonly HistoryEntry[],
    prelude?: StepPrelude,
  ): Promise<StepResult> {
    return runCompactionStep(this.deps, this, ctx, session, own, prelude);
  }

  /**
   * The model step (KD-1): the definition from the snapshot, the turn limit, the prompt with its knowledge and
   * task blocks, the session's tools, one model call, the answer entry and the end of the turn (`model-step.ts`).
   */
  modelStep(
    ctx: StepContext,
    session: Session,
    own: readonly HistoryEntry[],
    prelude?: StepPrelude,
  ): Promise<StepResult> {
    return runModelStep(this.deps, this, ctx, session, own, prelude);
  }

  /** The calling agent of a step, as its tools see it. */
  callerOf(ctx: StepContext): ToolCaller {
    const { snapshot } = sessionInputOf(ctx.input);
    return {
      agentId: ctx.taskId,
      ownerId: ctx.ownerId,
      rootId: ctx.rootId,
      root: this.root,
      depth: ctx.depth,
      snapshot,
      servers: snapshotDefinition(snapshot).servers,
    };
  }

  /**
   * What the agent declares of its tools, as plain data of its snapshot's definition: its servers, the system
   * tools it names and the task-list tools when it keeps a task list — a root always does — and whom it may
   * start or call. A root lists the employee's records, which are read live (`offeredDeclaration`), not those of
   * its snapshot. The set a step's calls are checked against is built from this.
   */
  toolDeclaration(snapshot: RunSnapshot): ToolDeclaration {
    const definition = snapshotDefinition(snapshot);
    const taskList = this.root || definition.taskList;
    return {
      servers: definition.servers,
      system: [...definition.tools, ...(taskList ? TASK_LIST_TOOLS : [])],
      root: this.root,
      startable: this.root ? null : definition.startable,
      deepAgents: null,
      taskList,
      listDelegation: definition.listDelegation,
    };
  }

  /** The declaration the tools of a model call are built from: `toolDeclaration`. Overridden by `ChatAgent`. */
  async offeredDeclaration(_ctx: StepContext, snapshot: RunSnapshot): Promise<ToolDeclaration> {
    return this.toolDeclaration(snapshot);
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
    const finalAnswer = await this.finalAnswer(ctx, answer.snapshot);
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
  async closeDelegated(_ctx: StepContext, _calls: readonly CallState[]): Promise<CallClosing[]> {
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
    throw new Error(`Agent ${input.caller.agentId} has ${input.calls.length} delegated calls, but its kind delegates none`);
  }

  /**
   * The final subagent rule of the end of a turn; `null` — the agent's own answer ends its run. Overridden by
   * `DeepAgent`.
   */
  protected async finalAnswer(_ctx: StepContext, _snapshot: RunSnapshot): Promise<FinalAnswer | null> {
    return null;
  }
}
