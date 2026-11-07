import { CoverageSchema, type EvidenceRecord, type Task } from '@agent-os/contracts';
import type { Database } from '@agent-os/db';
import type { Clock, EvidenceReader, HandlerResult, InvestigationService, TaskContext, TaskHandler } from '@agent-os/runtime';
import { z } from 'zod';
import { answerSaver, checkpointedAnswer } from '../attempt/checkpoint.js';
import { abandon as abandonAttempt, failed, readTaskFrame, succeeded, type TaskFrame } from '../attempt/task-attempt.js';
import { findGroupTable, type GroupTable } from '../calibration/group-table.js';
import { VERIFY_WORKFLOW, VerifyInputSchema } from '../capabilities/verify.js';
import { type ClaimRevisionRow, claimsRepository as claims, type VerifiedRevision } from '../claims/claims.repository.js';
import type { ContextBuilder } from '../context/context-builder.js';
import { abandonEarlierAttempts } from '../model/ledger.js';
import type { ModelGateway } from '../model/model-gateway.js';
import { promptVersion } from '../model/prompt-version.js';
import { ClaimAssessmentSchema } from './claim-assessment.js';
import { buildClaimCheck, type ClaimCheck, type ClaimCheckPage } from './claim-check.js';
import { type ClaimDecision, decideClaim } from './decide-claim.js';
import { checkPointer, PageSchema, type Pointer } from './pointer.js';

export interface VerifyDeps {
  readonly database: Database;
  /** The tasks of the investigation: a page of the pointer must be the output of one of them. */
  readonly investigations: Pick<InvestigationService, 'listForThread'>;
  /** The pages of the pointer, for the investigation's owner only. */
  readonly evidence: Pick<EvidenceReader, 'get'>;
  readonly gateway: ModelGateway;
  readonly contextBuilder: ContextBuilder;
  /** The calibrated group tables; the investigation's is the one of its `verifier` model and prompt (KD-3). */
  readonly groupTables: readonly GroupTable[];
  readonly clock: Clock;
}

/**
 * The output schema of the `verifier` role: the closed assessment of one claim (Contract «Вывод `verifier` —
 * `ClaimAssessment`»), the schema `buildClaimCheck` gives the call.
 */
export const VerifierOutputSchema = ClaimAssessmentSchema;

/** Checkpoint names of the verifier call and of its one retry after an answer off the form (DC-7). */
const FIRST_CALL = 'verify';
const RETRY_CALL = 'verify-retry';
const INVALID_MODEL_OUTPUT = 'invalid_model_output';

/** Why a check revision is `insufficient` (Contract «`research.verify` версии 2»). */
type InsufficientReason = 'pointer_invalid' | 'needs_narrowing' | NonNullable<ClaimDecision['reason']>;

const StoredAtomsSchema = z.array(z.object({ kind: z.string(), value: z.string() }));
const ArgsSchema = z.record(z.string(), z.unknown());
const StoredCoverageSchema = CoverageSchema.nullable();

const abandon = (cause: 'cancelled' | 'fenced'): never => abandonAttempt(VERIFY_WORKFLOW, cause);

type Step<T> = { readonly next: 'go'; readonly value: T } | { readonly next: 'result'; readonly result: HandlerResult };

/** A page the pointer may name: of this investigation, readable for its owner, holding records. */
interface PointedPage {
  readonly items: readonly unknown[];
  readonly origin: Omit<ClaimCheckPage, 'records'>;
}

/** The claim as the task checks it: its latest revision with the pointer that passed the rule and its pages. */
interface CheckedClaim {
  readonly revision: ClaimRevisionRow;
  readonly pointer: Pointer;
  readonly pages: ReadonlyMap<string, PointedPage>;
}

const isEvidenceNotFound = (error: unknown): boolean =>
  error instanceof Error && (error as Error & { code?: unknown }).code === 'evidence_not_found';

/** The records of a page, or null when its content is not a page of records. */
function recordsOf(bytes: Uint8Array): readonly unknown[] | null {
  let content: unknown;
  try {
    content = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  const page = PageSchema.safeParse(content);
  return page.success ? page.data.items : null;
}

/** Where the records of a page came from, as the verifier input shows each page (DC-14). */
const originOf = (record: EvidenceRecord): PointedPage['origin'] => ({
  source: record.provenance.sourceId,
  tool: record.provenance.toolName,
  args: ArgsSchema.parse(record.provenance.normalizedArgs),
  snapshot: record.provenance.snapshot,
  complete: record.coverage.completeness === 'complete',
});

/**
 * `research.verify` v2 (design-engine.md, Flow 1; «Как утверждение получает статус»): the check of one claim. The task
 * reads the claim's latest revision and the pages of its pointer for the investigation's owner; a pointer that names a
 * page of another investigation or owner, an unknown page, a record outside its page, or no record at all ends
 * `insufficient` with `pointer_invalid`, with no model call and no reservation (DC-6). `buildClaimCheck` builds the
 * packet of the pointed records only; a packet over the role window ends `insufficient` with `needs_narrowing`, again
 * without a call. One `verifier` call answers the closed assessment; an answer the form rules of `decideClaim` refuse is
 * asked once more, and one still off the form ends `insufficient` with `invalid_assessment` (DC-7). `decideClaim`
 * with the investigation's group table gives the status, and one guarded write appends the revision: status, pointer,
 * type, the assessment with its broken-form flag (with no answer and the reason when no call decided), the group of a `supported` claim and the basis in `evidenceIds`. The
 * task proposes no collection and never waits. A refused reservation, a stop or a cancel, a passed `notAfter` and an
 * unavailable provider end the task without a revision (DC-8).
 */
export function createVerifyHandler(deps: VerifyDeps): TaskHandler {
  const { database: db } = deps;

  async function ownTaskIds(frame: TaskFrame): Promise<ReadonlySet<string>> {
    const thread = await deps.investigations.listForThread(frame.resourceId, frame.threadId);
    const tasks: readonly Task[] = thread.find((candidate) => candidate.investigationId === frame.investigationId)?.tasks ?? [];
    return new Set(tasks.map((task) => task.taskId));
  }

  /** The page for the owner, or undefined when it is no page of this investigation's tasks readable for them. */
  async function pointedPage(frame: TaskFrame, own: ReadonlySet<string>, pageId: string): Promise<PointedPage | undefined> {
    if (!z.uuid().safeParse(pageId).success) return undefined;
    let stored: Awaited<ReturnType<VerifyDeps['evidence']['get']>>;
    try {
      stored = await deps.evidence.get(pageId, frame.resourceId);
    } catch (error) {
      if (isEvidenceNotFound(error)) return undefined;
      throw error;
    }
    if (!own.has(stored.record.taskId)) return undefined;
    const items = recordsOf(stored.bytes);
    return items === null ? undefined : { items, origin: originOf(stored.record) };
  }

  /** The pointer rule over the pages the pointer names (DC-6); null when it fails. */
  async function checkClaimPointer(frame: TaskFrame, revision: ClaimRevisionRow): Promise<CheckedClaim | null> {
    const named = z.array(z.object({ pageId: z.string() })).safeParse(revision.pointer);
    const pages = new Map<string, PointedPage>();
    if (named.success) {
      const own = await ownTaskIds(frame);
      for (const pageId of new Set(named.data.map((entry) => entry.pageId))) {
        const page = await pointedPage(frame, own, pageId);
        if (page !== undefined) pages.set(pageId, page);
      }
    }
    const sizes = new Map([...pages].map(([pageId, page]) => [pageId, page.items.length]));
    const checked = checkPointer(revision.pointer, sizes);
    return checked.valid ? { revision, pointer: checked.pointer, pages } : null;
  }

  /** The verifier input: the claim text and, page by page in pointer order, only the records the pointer names. */
  function claimCheckOf(frame: TaskFrame, claim: CheckedClaim): ClaimCheck {
    const pages = claim.pointer.map(({ pageId, records }): ClaimCheckPage => {
      const page = claim.pages.get(pageId)!;
      return { ...page.origin, records: records.map((number) => page.items[number]) };
    });
    return buildClaimCheck({ roleConfig: frame.config.roles.verifier, claimText: claim.revision.text, pages });
  }

  /** One verifier call: its answer, null when the gateway found it off the schema twice, or the task's result. */
  async function callVerifier(ctx: TaskContext, frame: TaskFrame, check: ClaimCheck, call: string): Promise<Step<unknown>> {
    const roleConfig = frame.config.roles.verifier;
    const answered = await deps.gateway.call({
      ctx,
      role: 'verifier',
      roleConfig,
      instructions: check.instructions,
      promptVersion: promptVersion(roleConfig.prompt),
      messages: check.messages,
      outputSchema: check.outputSchema,
      notAfter: frame.notAfter,
      checkpointAnswer: answerSaver(ctx, call),
    });
    switch (answered.outcome) {
      case 'answered':
        return { next: 'go', value: answered.output };
      case INVALID_MODEL_OUTPUT:
        return { next: 'go', value: null };
      case 'no_answer':
        if (answered.reason === 'cancelled') return abandon('cancelled');
        return { next: 'result', result: failed(ctx, 'deadline', 'the verifier call reached notAfter') };
      case 'fenced':
        return abandon('fenced');
      case 'failed':
        return { next: 'result', result: failed(ctx, answered.code, `the verifier call failed: ${answered.code}`) };
    }
  }

  /**
   * The answer the status is decided from: the retry's when the checkpoint holds it; otherwise the first call's (saved
   * or asked now), asked once more when `decideClaim` finds it off the form. A schema failure was already retried by
   * the gateway, so a null answer is final.
   */
  async function assess(
    ctx: TaskContext,
    frame: TaskFrame,
    check: ClaimCheck,
    offForm: (answer: unknown) => boolean,
  ): Promise<Step<unknown>> {
    const retried = checkpointedAnswer(ctx, RETRY_CALL);
    if (retried !== undefined) return { next: 'go', value: retried.output };
    const saved = checkpointedAnswer(ctx, FIRST_CALL);
    const first = saved === undefined ? await callVerifier(ctx, frame, check, FIRST_CALL) : { next: 'go' as const, value: saved.output };
    if (first.next === 'result' || first.value === null || !offForm(first.value)) return first;
    return callVerifier(ctx, frame, check, RETRY_CALL);
  }

  async function append(ctx: TaskContext, revision: VerifiedRevision, reason: InsufficientReason | null, extra: object = {}): Promise<HandlerResult> {
    const written = await ctx.withAttemptGuard((tx) =>
      claims.appendRevisions(tx, { investigationId: ctx.investigationId, taskId: ctx.taskId, revisions: [revision] }),
    );
    if (written.outcome === 'fenced') return abandon('fenced');
    return succeeded({ claimId: revision.claimId, status: revision.status, reason, ...extra });
  }

  /**
   * A revision decided before any call: `insufficient`, with the pointer as stored. Its assessment holds no answer and
   * the reason, the way an answer off the form is stored with its flag, so the stored revision says why it was not checked.
   */
  const uncheckedRevision = (revision: ClaimRevisionRow, reason: 'pointer_invalid' | 'needs_narrowing'): VerifiedRevision => ({
    claimId: revision.claimId,
    text: revision.text,
    atoms: StoredAtomsSchema.parse(revision.atoms),
    evidenceIds: [],
    coverage: StoredCoverageSchema.parse(revision.coverage),
    status: 'insufficient',
    pointer: revision.pointer,
    claimType: null,
    assessment: { answer: null, invalidForm: false, reason },
    confidence: null,
  });

  async function run(ctx: TaskContext): Promise<HandlerResult> {
    const input = VerifyInputSchema.parse(ctx.input);
    if ((await abandonEarlierAttempts(ctx)) === 'fenced') return abandon('fenced');
    const notAfter = new Date(input.notAfter);
    // DC-3: a task claimed or woken at or after `notAfter` goes no further.
    if (deps.clock.now() >= notAfter) {
      return failed(ctx, 'deadline', 'the verification task ran at or after notAfter');
    }
    const frame = await readTaskFrame(db, ctx, notAfter);
    const [revision] = await claims.latestRevisions(db, ctx.investigationId, [input.claimId]);
    if (revision === undefined) return succeeded({ claimId: input.claimId, status: null, reason: null });

    const claim = await checkClaimPointer(frame, revision);
    if (claim === null) return append(ctx, uncheckedRevision(revision, 'pointer_invalid'), 'pointer_invalid');

    const check = claimCheckOf(frame, claim);
    const roleConfig = frame.config.roles.verifier;
    const packet = await deps.contextBuilder.fitMessages(
      { roleConfig, instructions: check.instructions, outputSchema: check.outputSchema, signal: ctx.signal },
      check.messages,
    );
    if (packet.outcome === 'needs_narrowing') {
      const needsNarrowing = { materialTokens: packet.materialTokens, limitTokens: packet.limitTokens };
      return append(ctx, uncheckedRevision(revision, 'needs_narrowing'), 'needs_narrowing', { needsNarrowing });
    }
    if (packet.outcome === 'count_failed') {
      return failed(ctx, 'model_unavailable', 'the verifier packet could not be counted');
    }

    const atoms = StoredAtomsSchema.parse(revision.atoms);
    const groupTable = findGroupTable(deps.groupTables, roleConfig);
    const items = new Map([...claim.pages].map(([pageId, page]) => [pageId, page.items]));
    const decide = (answer: unknown): ClaimDecision => decideClaim({ assessment: answer, pointer: claim.pointer, atoms, pages: items, groupTable });
    const assessed = await assess(ctx, frame, check, (answer) => decide(answer).reason === 'invalid_assessment');
    if (assessed.next === 'result') return assessed.result;

    const decision = decide(assessed.value);
    return append(
      ctx,
      {
        claimId: revision.claimId,
        text: revision.text,
        atoms: decision.values?.atoms ?? atoms,
        evidenceIds: decision.basis,
        coverage: StoredCoverageSchema.parse(revision.coverage),
        status: decision.status,
        pointer: revision.pointer,
        claimType: decision.claimType,
        assessment: { answer: assessed.value, invalidForm: decision.reason === 'invalid_assessment' },
        confidence: decision.confidence,
      },
      decision.reason,
    );
  }

  return {
    workflowType: VERIFY_WORKFLOW,
    workflowVersion: 2,
    inputSchema: VerifyInputSchema,
    run,
  };
}
