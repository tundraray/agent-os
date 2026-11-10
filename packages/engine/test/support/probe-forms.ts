import type { RuntimeTx } from '@agent-os/runtime';
import { z } from 'zod';
// The result forms and the memory repository are internal to the package: the probe forms are registered through the
// internal assembly `composeEngine` from the sources (ADR-0010), never through `createEngine`.
import { investigationMemoryRepository } from '../../src/agents/investigation-memory.repository.js';
import {
  type ClosureDecision,
  type ForcedEndCode,
  type ForcedEndFunction,
  type FormBindings,
  type FormDataReader,
  type FormRunContext,
  type ResultForm,
  TEXT_FORM,
} from '../../src/agents/result-forms.js';

/**
 * The probe result forms of the agent-core tests (design-agent-core.md, Test Strategy): `probe_record` with all three
 * functions of process code and a binding of kind `definition_pair_table`, and `probe_deadline` with only the forced end
 * of `not_after`. Their decisions read only the structure of the data they get — fields of the assignment JSON, a flag
 * of the result — never a text (rule 3 of the plan).
 *
 * The assignment of a `recorder` run is a JSON text {@link RecordAssignment}; the probe's `collect` finds it in the
 * `call_agent` row that started the run, since the run row keeps no assignment for a form with a prologue.
 */

/** The fields a `recorder` assignment may carry, as the JSON text the calling agent sends. */
export interface RecordAssignment {
  /** What to record: the first message is built from it. */
  readonly task: string;
  /** Asks `collect` for an input of about this many bytes more (UC-12 run 8). */
  readonly padBytes?: number;
  /** A ready result: the prologue ends the run with it, without a model turn (UC-12 runs 5, 6). */
  readonly ready?: RecordResult;
}

/** The result of `probe_record`: a note, and `refuse` — the field the closure refuses (UC-12 run 1). */
export interface RecordResult {
  readonly note: string;
  readonly refuse?: boolean;
}

/** The group the probe's binding table gives an accepted result (DC-25): absent under `Engine.assessAgent`. */
const PROBE_GROUP = 'probe-group-a';
/** The UTF-8 bytes of the first message beyond which a `recorder` run fails `prologue_oversize` (DC-19). */
const PROBE_FIRST_MESSAGE_MAX_BYTES = 2_048;
/** The kind of the notes the probe's closure and forced end write into the investigation's memory. */
const PROBE_NOTE_KIND = 'note';

/** The note texts the probe's process code writes: the test compares them as literals. */
const PROBE_NOTES = {
  accepted: 'probe closure: accepted',
  refused: 'probe closure: refused',
  forcedEnd: (code: ForcedEndCode) => `probe forced end: ${code}`,
} as const;

const RecordResultSchema = z.strictObject({ note: z.string().min(1).max(2_000), refuse: z.boolean().optional() });
const RecordAssignmentSchema = z.object({
  task: z.string(),
  padBytes: z.number().int().nonnegative().optional(),
  ready: z.unknown().optional(),
});

/** What the prologue's `collect` returns: the assignment, with the padding it asked for. */
interface PrologueInput {
  readonly assignment: z.infer<typeof RecordAssignmentSchema>;
  readonly pad?: string;
}

const CallRowSchema = z.object({
  toolName: z.string(),
  childTaskId: z.string().nullable(),
  arguments: z.object({ agent: z.string(), assignment: z.string() }).partial(),
});

/**
 * The assignment of the run: the `call_agent` row whose child is this run, or — while the parent has not recorded the
 * child's task id yet — the last call of this agent in the investigation (the probe calls `recorder` once per tree).
 */
async function assignmentOf(context: FormRunContext, reader: FormDataReader): Promise<string> {
  const calls = z.array(CallRowSchema.loose()).parse(await reader.toolCalls());
  const ofAgent = calls.filter((call) => call.toolName === 'call_agent' && call.arguments.agent === context.agentName);
  const call = ofAgent.find((candidate) => candidate.childTaskId === context.runTaskId) ?? ofAgent.at(-1);
  if (call?.arguments.assignment === undefined) throw new Error(`no call_agent row started run ${context.runTaskId}`);
  return call.arguments.assignment;
}

function note(tx: RuntimeTx, context: FormRunContext, text: string): Promise<number> {
  return investigationMemoryRepository.append(tx, {
    investigationId: context.investigationId,
    runTaskId: context.runTaskId,
    agentName: context.agentName,
    kind: PROBE_NOTE_KIND,
    text,
    refs: [],
  });
}

/** An accepted result gets the group of the bound table; the calibrating mark of `assessAgent` gives none (DC-25). */
function grouped(result: RecordResult, bindings: FormBindings): unknown {
  const table = bindings['groups'];
  if (table?.kind !== 'definition_pair_table') return result;
  return { ...result, group: (table.value as { group: string }).group };
}

/** The forced end of `code`: a result that names the code it replaced, and a note of it (DC-21). */
function forcedEndOf(code: ForcedEndCode): ForcedEndFunction {
  return {
    decide: () => ({ kind: 'result', result: { note: PROBE_NOTES.forcedEnd(code), forced: code } }),
    write: async (tx, context, decision) => {
      if (decision.kind === 'result') await note(tx, context, PROBE_NOTES.forcedEnd(code));
    },
  };
}

/**
 * `probe_record` (Test Strategy): the prologue builds the first message from the assignment, or ends the run with its
 * ready result; the closure writes a note into the investigation's memory, refuses a result with `refuse`, and adds the
 * bound table's group to an accepted one; forced ends for `turn_limit`, `run_tokens_exhausted` and `not_after`; the
 * definition memory of scope `user` is forbidden.
 */
const PROBE_RECORD_FORM: ResultForm = {
  name: 'probe_record',
  version: 1,
  resultSchema: RecordResultSchema,
  userMemoryForbidden: true,
  bindings: { groups: { kind: 'definition_pair_table', value: { group: PROBE_GROUP } } },
  prologue: {
    firstMessageMaxBytes: PROBE_FIRST_MESSAGE_MAX_BYTES,
    collect: async (context, reader): Promise<PrologueInput> => {
      const assignment = RecordAssignmentSchema.parse(JSON.parse(await assignmentOf(context, reader)));
      return assignment.padBytes === undefined ? { assignment } : { assignment, pad: 'x'.repeat(assignment.padBytes) };
    },
    build: (input) => {
      const { assignment } = input as PrologueInput;
      if (assignment.ready !== undefined) return { kind: 'end', result: assignment.ready };
      return { kind: 'start', firstMessage: `Record this: ${assignment.task}` };
    },
  },
  closure: {
    evaluate: ({ result }, bindings): ClosureDecision => {
      const parsed = RecordResultSchema.safeParse(result);
      if (!parsed.success) return { kind: 'refuse', reason: 'result_outside_form' };
      if (parsed.data.refuse === true) return { kind: 'refuse', reason: 'refused_by_probe' };
      return { kind: 'accept', result: grouped(parsed.data, bindings) };
    },
    write: async (tx, context, decision) => {
      await note(tx, context, decision.kind === 'accept' ? PROBE_NOTES.accepted : PROBE_NOTES.refused);
    },
  },
  forcedEnd: {
    turn_limit: forcedEndOf('turn_limit'),
    run_tokens_exhausted: forcedEndOf('run_tokens_exhausted'),
    not_after: forcedEndOf('not_after'),
  },
};

/** The result `probe_deadline`'s forced end writes: the text form with the mark of the deadline. */
export const PROBE_DEADLINE_RESULT = { summary: 'the deadline came first', refs: [], deadline: true } as const;

/** `probe_deadline` (Test Strategy, UC-E14): the text form with only a forced end for `not_after`. */
const PROBE_DEADLINE_FORM: ResultForm = {
  name: 'probe_deadline',
  version: 1,
  resultSchema: TEXT_FORM.resultSchema,
  forcedEnd: {
    not_after: {
      decide: () => ({ kind: 'result', result: PROBE_DEADLINE_RESULT }),
      write: async () => undefined,
    },
  },
};

/** The forms the agent-core harness adds to the shipped ones. */
export const PROBE_FORMS: readonly ResultForm[] = [PROBE_RECORD_FORM, PROBE_DEADLINE_FORM];

/** The structured `detail` of a refusal of the two variants below: the tests compare it as a literal (DC-20). */
const PROBE_REFUSAL_DETAIL = { missing: 'the probe field', attempt: 1 } as const;

const REFUSED_BY_PROBE = 'refused_by_probe';

/** The refusal of a result with the refusal field, with its `detail`; null for any other result. */
function refusalWithDetail(result: unknown): ClosureDecision | null {
  return RecordResultSchema.parse(result).refuse === true ? { kind: 'refuse', reason: REFUSED_BY_PROBE, detail: PROBE_REFUSAL_DETAIL } : null;
}

const RefusedFinishRowSchema = z.object({
  run: z.string(),
  toolName: z.string(),
  state: z.string(),
  outcome: z.object({ detail: z.object({ detail: z.unknown() }).optional() }).nullable(),
});

/** The `detail` of a refused `finish` of this run, read back from its call row; null when there is none. */
async function refusedDetailOf(context: FormRunContext, reader: FormDataReader): Promise<unknown> {
  const calls = z.array(RefusedFinishRowSchema).parse(await reader.toolCalls());
  const refused = calls.find((call) => call.run === context.runTaskId && call.toolName === 'finish' && call.state === 'rejected');
  return refused?.outcome?.detail?.detail ?? null;
}

/**
 * `probe_record` whose closure refuses with `detail`, writes that `detail` as a note of its own, and accepts a later result
 * only when `collect` found the `detail` in the row of the refused `finish` (UC-12 run 1).
 */
const PROBE_RECORD_READING_FORM: ResultForm = {
  ...PROBE_RECORD_FORM,
  closure: {
    collect: refusedDetailOf,
    evaluate: ({ result, collected }, bindings): ClosureDecision => {
      const refusal = refusalWithDetail(result);
      if (refusal !== null) return refusal;
      return collected === null ? { kind: 'refuse', reason: REFUSED_BY_PROBE } : { kind: 'accept', result: grouped(RecordResultSchema.parse(result), bindings) };
    },
    write: async (tx, context, decision) => {
      await note(tx, context, decision.kind === 'accept' ? PROBE_NOTES.accepted : PROBE_NOTES.refused);
      if (decision.kind === 'refuse') await note(tx, context, `probe closure detail: ${JSON.stringify(decision.detail)}`);
    },
  },
};

/** The forms of UC-12 run 1: the shipped list with the variant that reads the refused call. */
export const PROBE_FORMS_READING: readonly ResultForm[] = [PROBE_RECORD_READING_FORM, PROBE_DEADLINE_FORM];

/** `probe_record` whose closure refuses with `detail` and reads nothing, so `Engine.assessAgent` takes it (UC-14). */
export const PROBE_RECORD_DETAIL_FORM: ResultForm = {
  ...PROBE_RECORD_FORM,
  closure: {
    evaluate: ({ result }, bindings): ClosureDecision =>
      refusalWithDetail(result) ?? { kind: 'accept', result: grouped(RecordResultSchema.parse(result), bindings) },
    write: () => Promise.reject(new Error('write is never called outside an investigation')),
  },
};
