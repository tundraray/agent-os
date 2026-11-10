import { CoverageSchema } from '@agent-os/contracts';
import type { RuntimeTx } from '@agent-os/runtime';
import { z } from 'zod';
import { agentFingerprint } from '../../agents/fingerprint.js';
import { firstMessageFits } from '../../agents/process-code.js';
import type {
  ClosureDecision,
  ClosureInput,
  FormBindings,
  FormDataReader,
  FormRunContext,
  ForcedEndCode,
  ForcedEndFunction,
  PrologueDecision,
  ResultForm,
} from '../../agents/result-forms.js';
import { agentToolsOf, BASE_TOOLS, createToolRegistry } from '../../agents/tool-registry.js';
import { findGroupTableByPair, type GroupTable, GroupTableSchema } from '../../calibration/group-table.js';
import { claimsRepository } from '../../claims/claims.repository.js';
import { type AgentDefinition, AgentProcessConfigSchema } from '../../config/agent-config.schema.js';
import { ClaimAssessmentSchema } from '../../verify/claim-assessment.js';
import { type AtomCheck, type CheckedAtom, checkAtoms } from '../../verify/check-atoms.js';
import { buildClaimCheck } from '../../verify/claim-check.js';
import { decideClaim, type DecidedStatus } from '../../verify/decide-claim.js';
import { type Pointer, PointerSchema, pointedRecords } from '../../verify/pointer.js';

/**
 * The checker's assessment of one claim (design-research-flow.md, Contract `claim_assessment`; ADR-0008, ADR-0010): the
 * process code around the `verifier` agent. The prologue builds the check packet from the claim's latest
 * revision, the closure decides the status with `decideClaim` and the group by the table of the fingerprint pair, and the
 * one write appends the check revision. The status comes only from the fields of the assessment; no step reads the claim
 * or the records as text.
 */

const FORM_IDENTITY = { name: 'claim_assessment', version: 1 } as const;
const FIRST_MESSAGE_MAX_BYTES = 24_000;
const GROUP_TABLES = 'groupTables';

/** The verifier has `finish` alone, so the tools of its fingerprint are those of the base registry. */
const TOOLS = createToolRegistry(BASE_TOOLS);

const StoredAtomsSchema = z.array(z.object({ kind: z.string(), value: z.string() }));
const StoredCoverageSchema = CoverageSchema.nullable();
const GroupTablesSchema = z.array(GroupTableSchema);

const LatestClaimsSchema = z.array(z.object({ claimId: z.string(), text: z.string(), atoms: StoredAtomsSchema, pointer: PointerSchema }));
const RecordPagesSchema = z.array(
  z.object({
    page: z.string(),
    provenance: z.object({
      sourceId: z.string(),
      toolName: z.string(),
      normalizedArgs: z.record(z.string(), z.unknown()),
      snapshot: z.string(),
    }),
    coverage: z.object({ completeness: z.string() }),
  }),
);

const FingerprintsShape = { agentFingerprint: z.string(), definitionMemoryFingerprint: z.string() };

const FullInputSchema = z.strictObject({
  kind: z.literal('claim'),
  claimId: z.string(),
  text: z.string(),
  atoms: StoredAtomsSchema,
  /** One entry per entry of the pointer, in its order, with only the records it names. */
  pages: z.array(
    z.strictObject({
      pageId: z.string(),
      source: z.string(),
      tool: z.string(),
      args: z.record(z.string(), z.unknown()),
      snapshot: z.string(),
      complete: z.boolean(),
      records: z.array(z.unknown()),
    }),
  ),
  ...FingerprintsShape,
});
const OversizeInputSchema = z.strictObject({ kind: z.literal('oversize'), claimId: z.string(), pointer: PointerSchema, ...FingerprintsShape });
const NotClaimInputSchema = z.strictObject({ kind: z.literal('not_a_claim') });
const PrologueInputSchema = z.discriminatedUnion('kind', [FullInputSchema, OversizeInputSchema, NotClaimInputSchema]);

/** The input the prologue checks a claim from: what `collect` reads, and what calibration builds from the records of a pair. */
export type ClaimAssessmentPrologueInput = z.infer<typeof FullInputSchema>;

const PrologueEndSchema = z.union([
  z.strictObject({ end: z.literal('needs_narrowing'), claimId: z.string() }),
  z.strictObject({ end: z.literal('not_a_claim') }),
]);

/** What the check revision takes from the decision; the rest `write` reads from the claim's latest revision. */
interface CheckRevision {
  /** Each atom with its verdict; null keeps the atoms as stored, when no check ran. */
  readonly atoms: readonly CheckedAtom[] | null;
  readonly evidenceIds: readonly string[];
  readonly status: DecidedStatus;
  readonly claimType: string | null;
  readonly assessment: unknown;
  readonly confidence: string | null;
}

/** An accepted decision with the row of its `write`, which the run's result does not carry. */
type AssessedDecision = Extract<ClosureDecision, { kind: 'accept' }> & { readonly claimId: string; readonly revision: CheckRevision };

const isAssessed = (decision: ClosureDecision): decision is AssessedDecision => decision.kind === 'accept' && 'revision' in decision;

/** A revision no answer decided: `insufficient`, with an empty basis. */
const undecidedRevision = (reason: 'needs_narrowing' | 'invalid_assessment'): CheckRevision => ({
  atoms: null,
  evidenceIds: [],
  status: 'insufficient',
  claimType: null,
  assessment: { answer: null, invalidForm: reason === 'invalid_assessment', reason },
  confidence: null,
});

const insufficientResult = (claimId: string) => ({ claimId, status: 'insufficient', group: null });

const atomCheckOf = (input: ClaimAssessmentPrologueInput): AtomCheck =>
  checkAtoms({ atoms: input.atoms, records: input.pages.flatMap((page) => page.records) });

/** The text of the check packet; the instructions are the agent's system block. */
function firstMessageOf(input: ClaimAssessmentPrologueInput): string {
  return buildClaimCheck({ claimText: input.text, atomCheck: atomCheckOf(input), pages: input.pages });
}

const packetFits = (input: ClaimAssessmentPrologueInput): boolean => firstMessageFits(firstMessageOf(input), FIRST_MESSAGE_MAX_BYTES);

/** The records of the pointer's pages, each entry of the pointer with the page it names as that page's stored row. */
async function pointedPages(pointer: Pointer, reader: FormDataReader): Promise<ClaimAssessmentPrologueInput['pages']> {
  const origins = new Map(RecordPagesSchema.parse(await reader.recordPages()).map((origin) => [origin.page, origin]));
  const items = new Map<string, readonly unknown[]>();
  for (const pageId of new Set(pointer.map((entry) => entry.pageId))) {
    items.set(pageId, z.array(z.unknown()).parse(await reader.records(pageId, 0)));
  }
  return pointer.map((entry) => {
    const origin = origins.get(entry.pageId);
    if (origin === undefined) throw new Error(`page ${entry.pageId} of a stored pointer is not of this investigation`);
    return {
      pageId: entry.pageId,
      source: origin.provenance.sourceId,
      tool: origin.provenance.toolName,
      args: origin.provenance.normalizedArgs,
      snapshot: origin.provenance.snapshot,
      complete: origin.coverage.completeness === 'complete',
      records: pointedRecords([entry], items).map(({ record }) => record),
    };
  });
}

/** The fingerprint of the definition this form closes: the one key a run looks its table up by and calibration writes (KD-4). */
const fingerprintOf = (definition: AgentDefinition): string =>
  agentFingerprint({
    definition,
    tools: agentToolsOf(definition.tools, { registry: TOOLS, resultSchema: ClaimAssessmentSchema }),
    form: FORM_IDENTITY,
  });

/** The checker agent of a configuration, as calibration needs it. */
export interface ClaimAssessmentAgent {
  readonly processId: string;
  readonly agentName: string;
  readonly model: string;
  readonly agentFingerprint: string;
}

/**
 * The definition of this form in a configuration given as data. Null when there is none, which includes data that is not
 * an agents-form configuration: `createEngine` is what refuses a bad one, with the path of its fault.
 */
export function claimAssessmentAgent(config: unknown): ClaimAssessmentAgent | null {
  const parsed = AgentProcessConfigSchema.safeParse(config);
  if (!parsed.success) return null;
  const found = Object.entries(parsed.data.agents).find(([, definition]) => definition.result === FORM_IDENTITY.name);
  if (found === undefined) return null;
  const [agentName, definition] = found;
  return { processId: parsed.data.processId, agentName, model: definition.model, agentFingerprint: fingerprintOf(definition) };
}

/** The prologue's input; a packet over the limit leaves only the numbers and the sign, so the run row stays small (DC-19). */
async function collectClaim(context: FormRunContext, reader: FormDataReader): Promise<z.infer<typeof PrologueInputSchema>> {
  const claim = LatestClaimsSchema.parse(await reader.claims()).find((candidate) => candidate.claimId === context.assignment);
  if (claim === undefined) return { kind: 'not_a_claim' };
  const fingerprints = {
    agentFingerprint: fingerprintOf(context.definition),
    definitionMemoryFingerprint: await reader.definitionMemoryFingerprint(),
  };
  const full: ClaimAssessmentPrologueInput = {
    kind: 'claim',
    claimId: claim.claimId,
    text: claim.text,
    atoms: claim.atoms,
    pages: await pointedPages(claim.pointer, reader),
    ...fingerprints,
  };
  return packetFits(full) ? full : { kind: 'oversize', claimId: claim.claimId, pointer: claim.pointer, ...fingerprints };
}

function buildPrologue(raw: unknown): PrologueDecision {
  const input = PrologueInputSchema.parse(raw);
  switch (input.kind) {
    case 'not_a_claim':
      return { kind: 'end', result: { end: 'not_a_claim' } };
    case 'oversize':
      return { kind: 'end', result: { end: 'needs_narrowing', claimId: input.claimId } };
    case 'claim':
      // Calibration passes the full input without `collect`, so the limit holds here too (Flow 4).
      return packetFits(input)
        ? { kind: 'start', firstMessage: firstMessageOf(input) }
        : { kind: 'end', result: { end: 'needs_narrowing', claimId: input.claimId } };
  }
}

/** The tables bound for a run; null under `Engine.assessAgent`, where the binding is replaced by the calibrating mark. */
function boundTables(bindings: FormBindings): readonly GroupTable[] | null {
  const binding = bindings[GROUP_TABLES];
  if (binding === undefined) throw new Error(`the form ${FORM_IDENTITY.name} has no ${GROUP_TABLES} binding`);
  return binding.kind === 'definition_pair_table' ? GroupTablesSchema.parse(binding.value) : null;
}

/**
 * The pointer and pages of the input for `decideClaim`: the pages hold only the pointed records, so numbers are renumbered
 * in pointer order, with a page named twice kept as one, whose id goes into the basis.
 */
function decisionPages(input: ClaimAssessmentPrologueInput): { readonly pointer: Pointer; readonly pages: ReadonlyMap<string, readonly unknown[]> } {
  const pages = new Map<string, unknown[]>();
  const pointer = input.pages.map(({ pageId, records }) => {
    const page = pages.get(pageId) ?? [];
    pages.set(pageId, page);
    const first = page.length;
    page.push(...records);
    return { pageId, records: records.map((_, offset) => first + offset) };
  });
  return { pointer, pages };
}

function closeAnswer(result: unknown, input: ClaimAssessmentPrologueInput, bindings: FormBindings): ClosureDecision {
  const tables = boundTables(bindings);
  const decision = decideClaim({
    assessment: result,
    ...decisionPages(input),
    atomCheck: atomCheckOf(input),
    groupTable: tables === null ? undefined : findGroupTableByPair(tables, input),
  });
  if (decision.reason === 'invalid_assessment') return { kind: 'refuse', reason: 'invalid_result' };
  const group = tables === null ? null : decision.confidence;
  const runResult = { claimId: input.claimId, status: decision.status, group };
  const accepted: AssessedDecision = {
    kind: 'accept',
    // Calibration needs the answer and the profile; a run's result stays the number, the status and the group.
    result: tables === null ? { ...runResult, profile: decision.profile, assessment: result } : runResult,
    claimId: input.claimId,
    revision: {
      atoms: decision.values.atoms,
      evidenceIds: decision.basis,
      status: decision.status,
      claimType: decision.claimType,
      assessment: { answer: result, invalidForm: false },
      confidence: group,
    },
  };
  return accepted;
}

function evaluateResult({ result, prologueInput }: ClosureInput, bindings: FormBindings): ClosureDecision {
  const ended = PrologueEndSchema.safeParse(result);
  if (!ended.success) return closeAnswer(result, FullInputSchema.parse(prologueInput), bindings);
  if (ended.data.end === 'not_a_claim') return { kind: 'refuse', reason: 'not_a_claim' };
  const accepted: AssessedDecision = {
    kind: 'accept',
    result: insufficientResult(ended.data.claimId),
    claimId: ended.data.claimId,
    revision: undecidedRevision('needs_narrowing'),
  };
  return accepted;
}

/** The check revision in the function's transaction, with what a short input does not hold from the latest revision (DC-25). */
async function appendCheckRevision(tx: RuntimeTx, context: FormRunContext, claimId: string, revision: CheckRevision): Promise<void> {
  const [latest] = await claimsRepository.latestRevisions(tx, context.investigationId, [claimId]);
  if (latest === undefined) throw new Error(`claim ${claimId} has no revision in investigation ${context.investigationId}`);
  await claimsRepository.appendRevisions(tx, {
    investigationId: context.investigationId,
    taskId: context.runTaskId,
    revisions: [
      {
        claimId,
        text: latest.text,
        atoms: revision.atoms ?? StoredAtomsSchema.parse(latest.atoms),
        evidenceIds: revision.evidenceIds,
        coverage: StoredCoverageSchema.parse(latest.coverage),
        status: revision.status,
        pointer: latest.pointer,
        claimType: revision.claimType,
        assessment: revision.assessment,
        confidence: revision.confidence,
      },
    ],
  });
}

/** The second answer off the form used up the turns: the claim is `insufficient` and the run succeeds (DC-8). */
const TURN_LIMIT_END: ForcedEndFunction = {
  collect: (context) => Promise.resolve(context.assignment),
  decide: (collected) => ({ kind: 'result', result: insufficientResult(z.string().parse(collected)) }),
  write: async (tx, context, decision) => {
    if (decision.kind === 'result') await appendCheckRevision(tx, context, context.assignment, undecidedRevision('invalid_assessment'));
  },
};

/** The claim stays `unverified`, and the run fails with its code (design-research-flow.md, Contract `claim_assessment`). */
const NO_RESULT_END: ForcedEndFunction = { decide: () => ({ kind: 'none' }), write: () => Promise.resolve() };

const FORCED_ENDS: Readonly<Record<ForcedEndCode, ForcedEndFunction>> = {
  turn_limit: TURN_LIMIT_END,
  run_tokens_exhausted: NO_RESULT_END,
  investigation_tokens_exhausted: NO_RESULT_END,
  not_after: NO_RESULT_END,
  model_unavailable: NO_RESULT_END,
  context_overflow: NO_RESULT_END,
};

/** The form's binding of the group tables a run's closure looks its fingerprint pair up in (KD-4). */
export const claimAssessmentBindings = (tables: readonly GroupTable[]): FormBindings => ({
  [GROUP_TABLES]: { kind: 'definition_pair_table', value: tables },
});

/** The checker's assessment of one claim, the output of the `verifier` agent. */
export const CLAIM_ASSESSMENT_FORM: ResultForm = {
  ...FORM_IDENTITY,
  resultSchema: ClaimAssessmentSchema,
  maxDefinitions: 1,
  toolsAllowed: ['finish'],
  userMemoryForbidden: true,
  bindings: claimAssessmentBindings([]),
  prologue: { collect: collectClaim, build: buildPrologue, firstMessageMaxBytes: FIRST_MESSAGE_MAX_BYTES },
  closure: {
    evaluate: evaluateResult,
    write: async (tx, context, decision) => {
      if (isAssessed(decision)) await appendCheckRevision(tx, context, decision.claimId, decision.revision);
    },
  },
  forcedEnd: FORCED_ENDS,
};
