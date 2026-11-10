import type { TaskSpec } from '@agent-os/contracts';
import type { RuntimeTx, UpstreamTask } from '@agent-os/runtime';
import type { z } from 'zod';
import type { AgentDefinition, AgentProcessConfig } from '../../config/agent-config.schema.js';
import type { CallEnding, ToolCallRow } from '../tool-calls.repository.js';

/** What the executor knows of the run whose calls it executes. */
export interface AgentRunContext {
  readonly runTaskId: string;
  readonly investigationId: string;
  /** The owner of the investigation: the rights port and the audit are by it. */
  readonly resourceId: string;
  /** The thread of the investigation: a retried `call_agent` looks its task up among the thread's tasks. */
  readonly threadId: string;
  readonly agentName: string;
  readonly definition: AgentDefinition;
  /** The frozen configuration the investigation runs on. */
  readonly config: AgentProcessConfig;
  /** The schema of `finish`: the definition's result form's. */
  readonly resultSchema: z.ZodType<unknown>;
  /** 0 for the root. */
  readonly depth: number;
  /** The run's share: the ceiling of what it occupies (KD-4). */
  readonly shareTokens: number;
  readonly sources: readonly string[];
  readonly notAfter: Date;
}

/** One call of a tool that ends in its own guarded write (classes `read` and `write`). */
export interface ToolRun<Args> {
  readonly tx: RuntimeTx;
  readonly run: AgentRunContext;
  readonly call: ToolCallRow;
  readonly args: Args;
}

/**
 * A tool the executor ends at once: it runs inside the call's guarded transaction, so a `write` effect commits together
 * with the outcome or not at all (KD-3, invariant 4). It calls neither the model nor an external system.
 */
export interface ImmediateTool {
  readonly name: string;
  /** The source the call reaches, for the rights port and the audit; none for the base tools. */
  sourceOf?(args: unknown): string | null;
  run(input: ToolRun<unknown>): Promise<CallEnding>;
}

/** What the step before a `task` call's guarded write ended with. */
export type TaskToolPreparation =
  /** The call ends here, with no task. */
  | { readonly kind: 'ending'; readonly ending: CallEnding }
  /** The call goes on to its task: `prepared` is what its specification is built from; `repeat` marks the call. */
  | { readonly kind: 'task'; readonly prepared: unknown; readonly repeat: boolean }
  /** The attempt was stopped during the step: the call stays as it is. */
  | { readonly kind: 'stopped' };

/**
 * A tool of class `task` other than `call_agent` (design-agent-core.md, Реестр инструментов: a `task` tool gives the
 * task's specification by its arguments and the session's result by the task's outcome). It takes no share of the run's
 * tokens. A process module implements it; the assembly point passes it to the executor.
 */
export interface TaskTool {
  readonly name: string;
  /** The source the call reaches, for the rights port and the audit. */
  sourceOf?(args: unknown): string | null;
  /** Outside any transaction, so it may do I/O: everything the specification needs and whether the call goes on at all. */
  prepare(input: {
    readonly run: AgentRunContext;
    readonly args: unknown;
    readonly signal: AbortSignal;
    /** The live task of the investigation with the key of `spec` (queued, running, waiting or succeeded). */
    readonly findLiveTask: (spec: TaskSpec) => Promise<string | undefined>;
  }): Promise<TaskToolPreparation>;
  /** The task's specification, inside the guarded write of `starting`, from what {@link TaskTool.prepare} returned. */
  taskSpec(input: { readonly run: AgentRunContext; readonly prepared: unknown }): TaskSpec;
  /** How the call ends once its task is final; `repeat` is the mark the call's row carries. */
  ending(input: {
    readonly tx: RuntimeTx;
    readonly call: ToolCallRow;
    readonly child: UpstreamTask;
    readonly repeat: boolean;
  }): Promise<CallEnding>;
}

/** Bytes of a value as JSON text. */
export const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');

/**
 * The longest prefix of `items` whose result fits `maxBytes`: the result of `wrap` with no items, plus each item's JSON
 * and a separator. At least nothing; never more than the limit (Реестр инструментов: a result is at most 16 KiB).
 */
export function fitItems<T>(items: readonly T[], maxBytes: number, wrap: (taken: readonly T[]) => unknown): T[] {
  let bytes = jsonBytes(wrap([]));
  const taken: T[] = [];
  for (const item of items) {
    const next = bytes + jsonBytes(item) + 1;
    if (next > maxBytes) break;
    bytes = next;
    taken.push(item);
  }
  return taken;
}

/**
 * `wrap` of the longest prefix of `text` whose result still fits `maxBytes` as JSON — for one value too large for a
 * result, such as a long plan or a child's result. Cuts at a character, never inside one.
 */
export function cutToFit(text: string, maxBytes: number, wrap: (cut: string) => unknown): unknown {
  let low = 0;
  let high = text.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonBytes(wrap(text.slice(0, middle))) <= maxBytes) low = middle;
    else high = middle - 1;
  }
  const cut = text.slice(0, low);
  // A lone high surrogate at the end is half a character: leave it out.
  return wrap(/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut);
}
