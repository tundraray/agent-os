import type { Logger } from '@agent-os/common';
import type { ToolOutcome, ToolRefusalReason } from '@agent-os/contracts';
import type { RuntimeTx, StepContext, StepEffects } from '@agent-os/runtime';
import type { z } from 'zod';

import type { RunSnapshot } from '../start/snapshot.js';
import type { SessionTool } from './tool-registry.js';

/** `agent` of `start_agent` that starts a fork of the caller (KD-7). */
export const FORK_AGENT = 'fork';

/** What the spawn helper takes (design-runtime.md, «Операции `agents`»); owner and parent are the caller's. */
export interface StartChildRequest {
  /** The child's snapshot, resolved by `resolveStart` before the commit. */
  readonly snapshot: RunSnapshot;
  readonly prompt: string;
  readonly description: string;
  /** Set only by `start_agent` with `fork`: the caller's history up to `throughSeq` precedes the child's. */
  readonly forkedFrom?: { readonly agentId: string; readonly throughSeq: number };
}

/**
 * Starts a child of the calling agent inside the step's commit transaction and returns its id at once
 * (design-agents.md, `tools.register`). It is bound to the transaction, the effects and the caller.
 */
export type StartChild = (request: StartChildRequest) => Promise<{ agentId: string }>;

/** The agent whose model called the tool. */
export interface ToolCaller {
  readonly agentId: string;
  readonly ownerId: string;
  readonly rootId: string;
  /** `null` for a root session. */
  readonly parentId: string | null;
  /** 0 for a root session. */
  readonly depth: number;
  /** The caller's snapshot, from the input of its task (ADR-0017). */
  readonly snapshot: RunSnapshot;
}

/** What a tool's execution ends with; a refusal does not reach any external system. */
export type ToolRunResult =
  | {
      readonly kind: 'done';
      readonly outcome: Extract<ToolOutcome, 'success' | 'empty' | 'tool_error'>;
      readonly text: string;
      /** Script output of a `run_code` run: text of a successful run, `null` of a failed one (DC-14). */
      readonly output?: string | null;
      /** The child a `start_agent`-like call started. */
      readonly childAgentId?: string;
    }
  | {
      readonly kind: 'refused';
      readonly reason: ToolRefusalReason;
      /** The refused model of a refusal by model; absent or `null` otherwise. */
      readonly refusalDetail?: { readonly model: string } | null;
    };

/** Input of a tool executed inside the commit transaction of the step: no external calls. */
export interface InCommitToolInput<Args, Prepared = unknown> {
  readonly callId: string;
  readonly args: Args;
  readonly caller: ToolCaller;
  readonly tx: RuntimeTx;
  readonly effects: StepEffects;
  readonly startChild: StartChild;
  /** What the tool's `prepare` answered before the commit; absent for a tool without one. */
  readonly prepared?: Prepared;
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
}

/** A tool that waits for the employee's decision before it runs (KD-4). */
export interface ToolConfirmation<Args> {
  /** Decision kind of the request. */
  readonly kind: string;
  /** Whether this call needs the decision; without it every call does (code-execution KD-4). */
  required?(args: Args): boolean;
  /** What the employee is shown; JSON. `tools` is the session's tool set (code-execution KD-10). */
  content(args: Args, tools: readonly SessionTool[]): unknown;
  /** Whether the employee may edit the arguments when confirming. */
  readonly editableArgs: boolean;
}

/**
 * How a tool call reads for the employee: the tool's human title and the labels of its arguments by
 * key. Built when a view is read, never stored; a tool or an argument without a title has none.
 */
export interface ToolDisplay {
  readonly toolTitle?: string;
  readonly argLabels?: Readonly<Record<string, string>>;
}

interface AgentToolBase<Args> {
  /** The name the model sees. */
  readonly name: string;
  /** The name the employee sees. */
  readonly title?: string;
  /** Labels of the arguments the employee sees, by key. */
  readonly argLabels?: Readonly<Record<string, string>>;
  readonly description: string;
  readonly argsSchema: z.ZodType<Args>;
  readonly confirmation?: ToolConfirmation<Args>;
  /** Only a session without a parent gets the tool (KD-6, Invariant 4). */
  readonly rootOnly?: boolean;
  /**
   * Every session gets the tool, without a grant, and no definition names it (tool-result-reading R-2):
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

/** Runs in the commit transaction of the step, with its `tx`, `effects` and the spawn helper. */
export interface InCommitAgentTool<Args, Prepared = unknown> extends AgentToolBase<Args> {
  readonly mode: 'in_commit';
  /**
   * Runs before the commit transaction opens and hands its answer to `execute`: what must not be asked
   * while the transaction holds a connection — the access gate (design-access.md KD-4).
   */
  prepare?(input: { readonly args: Args; readonly caller: ToolCaller }): Promise<Prepared>;
  execute(input: InCommitToolInput<Args, Prepared>): Promise<ToolRunResult>;
}

/** Runs outside a transaction. */
export interface OutsideAgentTool<Args> extends AgentToolBase<Args> {
  readonly mode: 'outside';
  execute(input: OutsideToolInput<Args>): Promise<ToolRunResult>;
}

/**
 * A tool of the package or of an upper part (design-agents.md, «Инструменты (`tools`)»). `execute`
 * and `content` are methods, so a tool with concrete arguments is an `AgentTool` of the registry.
 */
export type AgentTool<Args = unknown> = InCommitAgentTool<Args> | OutsideAgentTool<Args>;
