import type { Logger } from '@agent-os/common';
import type { ToolOutcome, ToolRefusalReason } from '@agent-os/contracts';
import type { RuntimeTx, StepContext, StepEffects } from '@agent-os/runtime';
import { z } from 'zod';

import type { SessionTool } from './tool-registry.js';

/** Agent name of `start_agent` that starts a fork of the caller (KD-7). */
export const FORK_AGENT = 'fork';

/** Limits the caller sets at `start` (design-agents.md, SessionLimits). */
export const SessionLimitsSchema = z.object({
  /** Definitions the session may start and how many times each; replaces the definition's `agents`. */
  agents: z.record(z.string().min(1), z.number().int().min(1)),
  /** The definition whose `completed` report must be the session's last one (see «Конец хода»). */
  finalAgent: z.string().min(1).optional(),
});
export type SessionLimits = z.infer<typeof SessionLimitsSchema>;

/** What the spawn helper takes: the fields of the `start` operation; owner and parent are the caller's. */
export interface StartChildRequest {
  readonly definition: string;
  readonly prompt: string;
  readonly description: string;
  readonly model?: string;
  readonly limits?: SessionLimits;
  /** Set only by the built-in `start_agent` with `fork`: the caller's history up to `throughSeq` precedes the child's. */
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
  | { readonly kind: 'refused'; readonly reason: ToolRefusalReason };

/** Input of a tool executed inside the commit transaction of the step: no external calls. */
export interface InCommitToolInput<Args> {
  readonly callId: string;
  readonly args: Args;
  readonly caller: ToolCaller;
  readonly tx: RuntimeTx;
  readonly effects: StepEffects;
  readonly startChild: StartChild;
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
}

/** Runs in the commit transaction of the step, with its `tx`, `effects` and the spawn helper. */
export interface InCommitAgentTool<Args> extends AgentToolBase<Args> {
  readonly mode: 'in_commit';
  execute(input: InCommitToolInput<Args>): Promise<ToolRunResult>;
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
