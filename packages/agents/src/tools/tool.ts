import type { Logger } from '@agent-os/common';
import type {
  DeepAgentContent,
  QuestionAnswer,
  ToolOutcome,
  ToolRefusalReason,
} from '@agent-os/contracts';
import type { StoredToolResult } from '@agent-os/db';
import type { StepContext, StepEffects } from '@agent-os/runtime';
import type { z } from 'zod';

import type { RunStart } from '../start/run-definition';
import type { SessionTool } from './tool-registry';

/**
 * What an agent declares of its tools — plain data its class makes from its definition. The library answers it
 * with the session's tools: the external ones the owner's rights give, narrowed by `servers`, then the system
 * ones named here.
 */
export interface ToolDeclaration {
  /** Registry server names, or `*` for every server: they narrow the external tools the owner may use. */
  readonly servers: readonly string[];
  /** The system tools the agent has, by name, in the order the model sees them. */
  readonly system: readonly string[];
  /** The agent is a conversation's root: it also gets the tools registered `rootOnly`. */
  readonly root: boolean;
  /**
   * Lines of whom the agent may start or call — the agents of `start_agent`, the subagents of `task` — for the
   * description of the tool that does it; `null` — not listed, the tool keeps its own description.
   */
  readonly startable: readonly string[] | null;
  /** Lines of the deep agents the agent may start, for the description of the tool that does it; `null` — not listed. */
  readonly deepAgents: readonly string[] | null;
  /**
   * Lines of the skills the agent may read (agent-guidance KD-6) — its version's list, or the chat's listing — for
   * the description of `read_skill`; filled for a model call by `offeredDeclaration`, empty otherwise.
   */
  readonly skills: readonly string[];
  /** The agent keeps a task list. */
  readonly taskList: boolean;
  /** The agent may give the same work for a list of items. */
  readonly listDelegation: boolean;
  /** The saved scripts the agent owns: the library makes a `script__<name>` tool of each (self-learning scripts KD-4). */
  readonly scripts: DeepAgentContent['scripts'];
}

/** How a tool reads for the agent that declares it. */
export interface ToolDescription<Args> {
  readonly description: string;
  /** The schema of the agent's calls; without it the tool's own `argsSchema`. */
  readonly argsSchema?: z.ZodType<Args>;
}

export { FORK_AGENT } from '@agent-os/contracts';

/** What the spawn helper takes (design-runtime.md, «Операции `agents`»); owner and parent are the caller's. */
export interface StartChildRequest {
  /** The child's version, name and model, resolved by `resolveStart` before the commit. */
  readonly run: RunStart;
  readonly prompt: string;
  readonly description: string;
  /** Set only by `start_agent` with `fork`: the caller's history up to `throughSeq` precedes the child's. */
  readonly forkedFrom?: {
    readonly throughSeq: number;
  };
}

/**
 * Starts a child of the calling agent inside the step's commit transaction and returns its id at once
 * (design-agents.md, `tools.register`). It is bound to the transaction, the effects and the caller.
 */
export type StartChild = (
  request: StartChildRequest,
) => Promise<{ agentId: string }>;

/** The agent whose model called the tool. */
export interface ToolCaller {
  readonly agentId: string;
  readonly ownerId: string;
  readonly rootId: string;
  /** The task that started the caller; `null` for a conversation's root. */
  readonly parentId: string | null;
  /** The caller is a conversation's chat (`ChatAgent`): it starts records of the employee's live listing. */
  readonly root: boolean;
  /** 0 for a root session. */
  readonly depth: number;
  /** The caller's start: its version, read once when its object was made, its name and model (KD-6). */
  readonly run: RunStart;
  /** The servers the caller declares (`ToolDeclaration.servers`): a `run_code` run checks its calls against their tools. */
  readonly servers: readonly string[];
  /** The caller's tree is a training (its root is a `trainer` task): nothing is asked, no changing call is sent (KD-3). */
  readonly training: boolean;
  /**
   * The caller's task list is fixed (the trainer's pool): no task is deleted or gets a new dependency, and the
   * tasks with these numbers are moved by code only; `null` — an ordinary list.
   */
  readonly fixedTasks: readonly number[] | null;
  /**
   * The schedule mark of the root's last message as the tool step read it (chat-scheduling KD-4): the call rule and
   * `manage_schedule` know a schedule's run by it. `null` — the employee wrote it, and in the agent's own caller,
   * which no step has read.
   */
  readonly scheduleId: string | null;
}

/** What a tool's execution ends with; a refusal does not reach any external system. */
export type ToolRunResult =
  | {
      readonly kind: 'done';
      readonly outcome: Extract<
        ToolOutcome,
        'success' | 'empty' | 'tool_error' | 'recorded'
      >;
      readonly text: string;
      /** Script output of a `run_code` run: text of a successful run, `null` of a failed one (DC-14). */
      readonly output?: string | null;
      /** The tools whose calls a code run of a training tree recorded and did not send, in call order. */
      readonly recorded?: readonly string[];
      /** The full result the step's commit stores under the call's id; the model got `text` (a wrapper when long). */
      readonly stored?: StoredToolResult;
      /** The child a `start_agent`-like call started. */
      readonly childAgentId?: string;
    }
  | {
      readonly kind: 'refused';
      readonly reason: ToolRefusalReason;
      /** The refused model of a refusal by model; absent or `null` otherwise. */
      readonly refusalDetail?: { readonly model: string } | null;
      /** What the model reads after `[refused: <reason>]` in the call's `tool_result` (deep-agents KD-4). */
      readonly text?: string;
    };

/** Input of a tool executed inside the commit transaction of the step: no external calls. */
export interface InCommitToolInput<Args, Prepared = unknown> {
  readonly callId: string;
  readonly args: Args;
  readonly caller: ToolCaller;
  readonly effects: StepEffects;
  readonly startChild: StartChild;
  /** What the tool's `prepare` answered before the commit; absent for a tool without one. */
  readonly prepared?: Prepared;
  /** `content` of the card the employee approved when the call runs on confirmation; absent otherwise (deep-agents KD-3). */
  readonly confirmed?: unknown;
}

/** Input of a tool executed outside a transaction: it may call an external system. */
export interface OutsideToolInput<Args> {
  readonly args: Args;
  readonly caller: ToolCaller;
  /** The call's id. */
  readonly callId: string;
  /** The step's signal: the call ends when it aborts. */
  readonly signal: AbortSignal;
  readonly logger: Logger;
  /** The step's `guard`: the tool writes its rows only from the current attempt (code-execution KD-6). */
  readonly guard: StepContext['guard'];
  /** `content` of the resolved request when the call runs on confirmation; absent otherwise (KD-10). */
  readonly confirmed?: unknown;
  /**
   * Set only when the call runs on the employee's decision (agent-guidance KD-1): his answers to an
   * `agents.question` card, `null` — a decision without answers, he skipped the card. Absent when the call runs
   * without a decision (`sendUnasked`): nobody was there to answer (KD-2).
   */
  readonly answers?: readonly QuestionAnswer[] | null;
}

/** What `review` answers: the call is refused with its reason and text, or the card shows `content`. */
export type ToolReview =
  | {
      readonly kind: 'refused';
      readonly reason: ToolRefusalReason;
      readonly text: string;
    }
  | { readonly kind: 'card'; readonly content: unknown };

/** A tool that waits for the employee's decision before it runs (KD-4). */
export interface ToolConfirmation<Args> {
  /** Decision kind of the request. */
  readonly kind: string;
  /** Whether this call needs the decision; without it every call does (code-execution KD-4). */
  required?(args: Args): boolean;
  /** What the employee is shown; JSON. `tools` is the session's tool set (code-execution KD-10). */
  content(args: Args, tools: readonly SessionTool[]): unknown;
  /**
   * The check before the card (deep-agents KD-3): reads what it needs outside any transaction, after the
   * argument schema and the repeat rule, and refuses the call or gives the card's content. A refusal closes
   * the call `refused` with its text and asks the employee nothing; without `review` the card is `content`.
   */
  review?(args: Args, caller: ToolCaller): Promise<ToolReview>;
  /** Whether the employee may edit the arguments when confirming. */
  readonly editableArgs: boolean;
}

/**
 * How a tool call reads for the employee: for an MCP tool the server's title of the tool and the labels of
 * its arguments by key; for a saved script its description and its code. Built when a view is read, never
 * stored; a tool or an argument without a title has none. Another built-in tool has none: the web takes its
 * labels from its catalogue by the tool's name.
 */
export interface ToolDisplay {
  readonly toolTitle?: string;
  readonly argLabels?: Readonly<Record<string, string>>;
  readonly scriptCode?: string;
}

interface AgentToolBase<Args> {
  /** The name the model sees. */
  readonly name: string;
  readonly description: string;
  readonly argsSchema: z.ZodType<Args>;
  readonly confirmation?: ToolConfirmation<Args>;
  /**
   * The description and the schema of a tool that depend on the agent — whom it may start, which fields its
   * flags allow — built from its declaration; without it the tool reads the same for every agent.
   */
  describe?(declaration: ToolDeclaration): ToolDescription<Args>;
  /** A conversation's root gets the tool without naming it, and nobody else does (KD-6, Invariant 4). */
  readonly rootOnly?: boolean;
  /**
   * Every session gets the tool, without a grant, and no declaration names it (tool-result-reading R-2):
   * it reaches only what the session itself owns.
   */
  readonly everySession?: boolean;
  /**
   * What of the call's arguments may go to the log, which reaches Sentry: a tool whose arguments carry
   * a prompt, a record's content or a brief names only the fields that identify the call
   * (design-runtime.md, «Логирование»). Without it the arguments are logged whole. It may get the
   * arguments as the model wrote them, before they were checked.
   */
  loggedArgs?(args: Args): Record<string, unknown>;
}

/** Runs in the commit transaction of the step, with its `effects` and the spawn helper. */
export interface InCommitAgentTool<
  Args,
  Prepared = unknown,
> extends AgentToolBase<Args> {
  readonly mode: 'in_commit';
  /**
   * Runs before the commit transaction opens and hands its answer to `execute`: what must not be asked
   * while the transaction holds a connection — the access gate (design-access.md KD-4).
   */
  prepare?(input: {
    readonly callId: string;
    readonly args: Args;
    readonly caller: ToolCaller;
  }): Promise<Prepared>;
  execute(input: InCommitToolInput<Args, Prepared>): Promise<ToolRunResult>;
}

/** Runs outside a transaction. */
export interface OutsideAgentTool<Args> extends AgentToolBase<Args> {
  readonly mode: 'outside';
  execute(input: OutsideToolInput<Args>): Promise<ToolRunResult>;
}

/**
 * A tool registered in the tools library by the package or an upper part (design-agents.md, «Инструменты
 * (`tools`)»): a system tool, or `run_code`. `execute`, `content` and `describe` are methods, so a tool with
 * concrete arguments is an `AgentTool` of the registry.
 */
export type AgentTool<Args = unknown> =
  InCommitAgentTool<Args> | OutsideAgentTool<Args>;
