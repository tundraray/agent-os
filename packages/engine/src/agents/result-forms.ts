import type { RuntimeTx } from '@agent-os/runtime';
import { z } from 'zod';
import type { AgentDefinition } from '../config/agent-config.schema.js';
import type { SourceMode } from '../config/source-check.js';
import type { InvestigationRef } from './investigation-refs.js';

/**
 * Result forms and their process code (design-agent-core.md, KD-8, «Формы результата и код процесса»; ADR-0010).
 * A form is an entry of a closed registry the engine's internal assembly `composeEngine` builds; a definition names it,
 * as it names a tool. Process code is three optional functions, each made of an optional read step `collect`, one pure
 * step that decides, and — for the closure and the forced end — a write step. No step calls the model, an external
 * system, `TaskScheduler.propose` or the attempt functions of `TaskContext`.
 */

/** What every step knows of the run it works for. */
export interface FormRunContext {
  readonly investigationId: string;
  readonly resourceId: string;
  readonly runTaskId: string;
  readonly agentName: string;
  readonly definition: AgentDefinition;
  /**
   * The caller's assignment, from the run's task input, also for a form with a prologue: its run row holds null and its
   * session has no assignment, and the parent's `call_agent` row gets the child's task only after `propose`.
   */
  readonly assignment: string;
  readonly sourceMode: SourceMode;
  /** The run's depth in the agent tree: 0 at the root. */
  readonly depth: number;
}

/**
 * What a `collect` step may read of its investigation, inside the guarded transaction of its function (design-agent-core.md,
 * «Шаг чтения collect»). The engine implements it with the run's process code (T6.2).
 */
export interface FormDataReader {
  plan(): Promise<unknown>;
  claims(): Promise<unknown>;
  recordPages(): Promise<unknown>;
  records(page: string, from: number): Promise<unknown>;
  runs(): Promise<unknown>;
  engineRun(): Promise<unknown>;
  /** `definitionMemoryFingerprint` of this run's definition by the investigation's snapshot. */
  definitionMemoryFingerprint(): Promise<string>;
  /** Rows of `research_agent_tool_calls`, refused `call_agent` calls with their reason, parent run and index included. */
  toolCalls(): Promise<unknown>;
  /** The `budgetExhausted` sign of the agent tree read. */
  budgetExhausted(): Promise<boolean>;
}

/**
 * The fixed data of the engine a form gets at registration (design-agent-core.md, «привязки»). `definition_pair_table`
 * — a table looked up by the pair `agentFingerprint` + `definitionMemoryFingerprint` — is the only kind
 * `Engine.assessAgent` replaces with the mark «calibrating» (DC-25).
 */
export type FormBinding =
  | { readonly kind: 'fixed'; readonly value: unknown }
  | { readonly kind: 'definition_pair_table'; readonly value: unknown };

export type FormBindings = Readonly<Record<string, FormBinding>>;

/** A read step: the input of the pure step that follows, from the run and its investigation's data. */
export type CollectStep = (context: FormRunContext, reader: FormDataReader) => Promise<unknown>;

/** A write step: the rows of the decision, through the function's guarded transaction (`requireActive`). */
export type WriteStep<Decision> = (tx: RuntimeTx, context: FormRunContext, decision: Decision) => Promise<void>;

/** What the prologue's `build` decides: the first session message, or a result without a model turn. */
export type PrologueDecision =
  | { readonly kind: 'start'; readonly firstMessage: string }
  | { readonly kind: 'end'; readonly result: unknown };

/** Runs once, while the session is empty; its input is what `collect` returned, or the assignment without one. */
export interface PrologueFunction {
  readonly collect?: CollectStep;
  readonly build: (input: unknown, bindings: FormBindings) => PrologueDecision;
  /** UTF-8 bytes of the first message beyond which the run fails `prologue_oversize` (DC-19). */
  readonly firstMessageMaxBytes: number;
}

/**
 * What `evaluate` decides of a result: accepted (the same or replaced), or refused with a reason and, optionally, a
 * structured `detail`: `write` gets it with the decision, the model reads it next turn, and a later `collect` finds it in
 * the row of the refused call (DC-20).
 */
export type ClosureDecision =
  | { readonly kind: 'accept'; readonly result: unknown }
  | { readonly kind: 'refuse'; readonly reason: string; readonly detail?: unknown };

export interface ClosureInput {
  /** The result of `finish` after the form's schema, or the `end` of the prologue. */
  readonly result: unknown;
  /** The prologue input from the run row; the assignment for a form without a prologue. */
  readonly prologueInput: unknown;
  /** What `collect` returned; null without one. */
  readonly collected: unknown;
}

/** Runs on a lone `finish` and on the prologue's `end`, in the guarded write of the run's result. */
export interface ClosureFunction {
  readonly collect?: CollectStep;
  readonly evaluate: (input: ClosureInput, bindings: FormBindings) => ClosureDecision;
  readonly write: WriteStep<ClosureDecision>;
}

/** The failure codes a forced end may replace with a result (DC-21). */
const FORCED_END_CODES = [
  'run_tokens_exhausted',
  'investigation_tokens_exhausted',
  'not_after',
  'turn_limit',
  'model_unavailable',
  'context_overflow',
] as const;
export type ForcedEndCode = (typeof FORCED_END_CODES)[number];

/** Whether a failure code is one a forced end may replace; `prologue_oversize` and `prologue_refused` are not (DC-21). */
export const isForcedEndCode = (code: string): code is ForcedEndCode => FORCED_END_CODES.some((known) => known === code);

export type ForcedEndDecision = { readonly kind: 'result'; readonly result: unknown } | { readonly kind: 'none' };

/** Runs between turns where the handler would fail the run with its code. */
export interface ForcedEndFunction {
  readonly collect?: CollectStep;
  readonly decide: (collected: unknown, bindings: FormBindings) => ForcedEndDecision;
  readonly write: WriteStep<ForcedEndDecision>;
}

/** One entry of the result-form registry. */
export interface ResultForm {
  readonly name: string;
  /** Goes into `agentFingerprint`; an edit of the form's code that changes its decisions raises it. */
  readonly version: number;
  /** The schema of `finish`'s arguments, which are the run's result. */
  readonly resultSchema: z.ZodType<unknown>;
  /**
   * The references of a result that must lead to data of the run's investigation (DC-4). The engine checks them in the
   * guarded write of `finish`, before the closure; a reference of another investigation or to nothing refuses the result
   * `invalid_result` with the reason `foreign_ref`, and the run goes on.
   */
  readonly refsOf?: (result: unknown) => readonly InvestigationRef[];
  readonly prologue?: PrologueFunction;
  readonly closure?: ClosureFunction;
  readonly forcedEnd?: Readonly<Partial<Record<ForcedEndCode, ForcedEndFunction>>>;
  /** The definition memory of scope `user` is refused for a definition with this form (DC-24). */
  readonly userMemoryForbidden?: boolean;
  /** Only the definition named by this key of the configuration may name the form (DC-28). */
  readonly onlyOn?: 'rootAgent' | 'modelKnowledgeRoot';
  /** How many definitions of one configuration may name the form (DC-28). */
  readonly maxDefinitions?: number;
  /** The tools a definition with this form may have; `finish` alone when it holds only `finish` (DC-28). */
  readonly toolsAllowed?: readonly string[];
  readonly bindings?: FormBindings;
}

/** The closed list of forms by name. */
export type ResultFormRegistry = ReadonlyMap<string, ResultForm>;

const TextResultSchema = z.strictObject({
  summary: z.string().min(1).max(8_000),
  refs: z.array(z.strictObject({ type: z.enum(['note', 'claim', 'record', 'run']), id: z.string().min(1) })).max(50),
});

/**
 * The base form `text`: a summary and references to notes, claims, records and runs of this investigation; no process
 * code and no placement constraints. Version 2: its references must belong to the investigation (DC-4).
 */
export const TEXT_FORM: ResultForm = {
  name: 'text',
  version: 2,
  resultSchema: TextResultSchema,
  refsOf: (result) => TextResultSchema.safeParse(result).data?.refs ?? [],
};

/** The base forms of the engine; `create-engine.ts` adds the forms of the research process to them. */
export const SHIPPED_RESULT_FORMS: readonly ResultForm[] = [TEXT_FORM];

/** The registry of `forms`; a repeated name or a version below 1 is a defect of the engine's code. */
export function createResultFormRegistry(forms: readonly ResultForm[]): ResultFormRegistry {
  const registry = new Map<string, ResultForm>();
  for (const form of forms) {
    if (registry.has(form.name)) {
      throw new Error(`result form ${form.name} is registered twice`);
    }
    if (!Number.isInteger(form.version) || form.version < 1) {
      throw new Error(`result form ${form.name} has version ${form.version}; a version is a positive integer`);
    }
    registry.set(form.name, form);
  }
  return registry;
}
