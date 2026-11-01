import type { Coverage, Task } from '@agent-os/contracts';
import type { Database } from '@agent-os/db';
import type {
  Clock,
  EvidenceReader,
  HandlerResult,
  InvestigationService,
  TaskContext,
  TaskHandler,
  TaskScheduler,
} from '@agent-os/runtime';
import type { SourceRegistry } from '@agent-os/sources';
import { z } from 'zod';
import { answerSaver, checkpointedAnswer } from '../attempt/checkpoint.js';
import { abandon as abandonAttempt, failed, readTaskFrame, succeeded, type TaskFrame } from '../attempt/task-attempt.js';
import { createCapabilityRegistry } from '../capabilities/capability-registry.js';
import { type DecisionFrame, proposeGather } from '../capabilities/gather.js';
import { VERIFY_WORKFLOW, VerifyInputSchema } from '../capabilities/verify.js';
import { type ClaimRevisionRow, claimsRepository as claims, type VerifiedRevision } from '../claims/claims.repository.js';
import { renderPromptTemplate } from '../config/prompt-template.js';
import type { ContextBuilder } from '../context/context-builder.js';
import type { EvidenceItem } from '../context/role-packets.js';
import { promptValues } from '../controller/plan-role.js';
import { abandonEarlierAttempts } from '../model/ledger.js';
import { ModelArgsObjectSchema, parseModelArgs } from '../model/model-args.js';
import type { ModelGateway } from '../model/model-gateway.js';
import type { EngineLogger } from '../ports.js';
import { type Atom, type SourceRecord, verifyClaim } from './claim-verifier.js';

export interface VerifyDeps {
  readonly database: Database;
  /** The fetch tasks of the round, read as the controller reads its tasks. */
  readonly investigations: Pick<InvestigationService, 'listForThread'>;
  /** Content of the cited and the fetched evidence, for the investigation's owner. */
  readonly evidence: Pick<EvidenceReader, 'get'>;
  /** Proposes the round's `source.fetch` tasks (ADR-0001). */
  readonly scheduler: Pick<TaskScheduler, 'propose'>;
  readonly sourceRegistry: Pick<SourceRegistry, 'resolveTool' | 'currentSnapshot'>;
  readonly gateway: ModelGateway;
  readonly contextBuilder: ContextBuilder;
  readonly clock: Clock;
  readonly logger: EngineLogger;
}

/** The checkpoint name of the verifier's one model call. */
const VERIFY_CALL = 'verify';
const INVALID_MODEL_OUTPUT = 'invalid_model_output';
const FINAL_STATUSES: ReadonlySet<string> = new Set(['succeeded', 'failed', 'cancelled']);

/**
 * What the `verifier` role returns: the source records to fetch and the claims each request checks. It judges no
 * claim — code does (KD-6). No top-level `claims`: that is the worker's output.
 */
export const VerifierOutputSchema = z.object({
  requests: z.array(
    z.object({
      claimIds: z.array(z.string()),
      sourceId: z.string(),
      toolName: z.string(),
      args: ModelArgsObjectSchema,
    }),
  ),
});
type VerifierRequest = z.infer<typeof VerifierOutputSchema>['requests'][number];

/**
 * A collection of the round: the claims it checks and its fetch task, or no task with the reason — `source_unavailable`
 * when the snapshot could not be read (KD-10), the stop reason when the runtime refused the task.
 */
const CollectionSchema = z.object({
  claimIds: z.array(z.uuid()),
  taskId: z.uuid().nullable(),
  failureCode: z.string().nullable(),
});
type Collection = z.infer<typeof CollectionSchema>;

/** The checkpoint after the round's tasks are proposed: the verifier answer and the collections, read after the wake. */
const ProposedRoundSchema = z.object({ call: z.literal(VERIFY_CALL), output: z.unknown(), collections: z.array(CollectionSchema) });

const StoredAtomsSchema = z.array(z.object({ kind: z.string(), value: z.string() }));
/** A page of `source.fetch` evidence: its records are `items` (design-mcp-source.md, evidence of a page). */
const PageSchema = z.object({ items: z.array(z.unknown()) });

const abandon = (cause: 'cancelled' | 'fenced'): never => abandonAttempt(VERIFY_WORKFLOW, cause);

type Step<T> = { readonly next: 'go'; readonly value: T } | { readonly next: 'result'; readonly result: HandlerResult };

/**
 * `research.verify` v1 (design-engine.md, Flow 4). The `verifier` role chooses which source records would check the
 * claims; its answer is saved to the checkpoint, the task proposes their `source.fetch` tasks, registers the wait and
 * returns `wait`, as the controller does (KD-6). After the wake code compares each claim's atoms with the records
 * fetched for it and appends a revision per claim: `supported` with its basis (`evidenceIds`) and scope (`coverage`),
 * `refuted` only by a contradicting record, `insufficient` with its missing atoms — also when the collection failed or
 * its snapshot could not be read (DC-10, KD-10). An output still invalid after the gateway's retry ends the task
 * without revisions and with the warning `invalid_model_output`.
 */
export function createVerifyHandler(deps: VerifyDeps): TaskHandler {
  const { database: db } = deps;
  const decoder = new TextDecoder();
  const gatherDeps = { scheduler: deps.scheduler, sources: deps.sourceRegistry, clock: deps.clock, logger: deps.logger };
  const capabilities = createCapabilityRegistry(gatherDeps);

  async function tasksOf(frame: TaskFrame): Promise<readonly Task[]> {
    const thread = await deps.investigations.listForThread(frame.resourceId, frame.threadId);
    return thread.find((candidate) => candidate.investigationId === frame.investigationId)?.tasks ?? [];
  }

  const readEvidence = (frame: TaskFrame, evidenceId: string) =>
    deps.evidence.get(evidenceId, frame.resourceId).then((stored) => decoder.decode(stored.bytes));

  /** The verifier's call over the claims, their atoms and the evidence they cite (Flow 4). */
  async function callVerifier(
    ctx: TaskContext,
    frame: TaskFrame,
    revisions: readonly ClaimRevisionRow[],
  ): Promise<Step<readonly VerifierRequest[]>> {
    const roleConfig = frame.config.roles.verifier;
    const instructions = renderPromptTemplate(roleConfig.prompt, promptValues(frame));
    const tools = capabilities.fetchToolCatalog(frame.config);
    const cited = [...new Set(revisions.flatMap((revision) => revision.evidenceIds))];
    const evidence: EvidenceItem[] = await Promise.all(
      cited.map(async (evidenceId) => ({ evidenceId, text: await readEvidence(frame, evidenceId) })),
    );
    const assignment = JSON.stringify({
      claims: revisions.map((revision) => ({ claimId: revision.claimId, text: revision.text, atoms: revision.atoms })),
      tools,
    });
    const packet = await deps.contextBuilder.buildSlotPacket(
      { roleConfig, instructions, outputSchema: VerifierOutputSchema, signal: ctx.signal },
      { assignment, evidence },
    );
    if (packet.outcome === 'needs_narrowing') {
      const narrowing = { materialTokens: packet.materialTokens, limitTokens: packet.limitTokens };
      return { next: 'result', result: succeeded({ needsNarrowing: narrowing, verdicts: [] }) };
    }
    if (packet.outcome === 'count_failed') {
      return { next: 'result', result: failed(ctx, 'model_unavailable', 'the verifier packet could not be counted') };
    }
    const answered = await deps.gateway.call({
      ctx,
      role: 'verifier',
      roleConfig,
      instructions,
      messages: packet.messages,
      outputSchema: VerifierOutputSchema,
      notAfter: frame.notAfter,
      checkpointAnswer: answerSaver(ctx, VERIFY_CALL),
    });
    switch (answered.outcome) {
      case 'answered':
        return { next: 'go', value: answered.output.requests };
      case INVALID_MODEL_OUTPUT:
        return { next: 'result', result: succeeded({ verdicts: [] }, { warnings: [INVALID_MODEL_OUTPUT] }) };
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
   * Proposes a `source.fetch` task per request the investigation may fetch (the gate's check of the tool and its
   * arguments, parsed from the JSON text the model writes — an output whose text is not a JSON object never gets here,
   * the gateway refuses it as invalid); a request for another claim set or tool, or with arguments the tool's schema
   * refuses, is dropped, and its claims stay without records.
   */
  async function collect(
    ctx: TaskContext,
    frame: TaskFrame,
    revisions: readonly ClaimRevisionRow[],
    requests: readonly VerifierRequest[],
  ): Promise<Step<Collection[]>> {
    const known = new Set(revisions.map((revision) => revision.claimId));
    const fetchTool = capabilities.fetchTools(frame.config);
    const decision: DecisionFrame = {
      ctx,
      investigationId: frame.investigationId,
      config: frame.config,
      notAfter: frame.notAfter,
      requesterKey: `${VERIFY_WORKFLOW}:${ctx.taskId}`,
    };
    const collections: Collection[] = [];
    for (const request of requests) {
      const claimIds = request.claimIds.filter((claimId) => known.has(claimId));
      const tool = fetchTool(request);
      const args = parseModelArgs(request.args);
      if (claimIds.length === 0 || tool === null || args === null || !tool.argsSchema.safeParse(args).success) continue;
      const { sourceId, toolName } = request;
      const gathered = await proposeGather(gatherDeps, decision, {
        kind: 'requestEvidence',
        rationale: 'verification round',
        evidenceIds: [],
        await: true,
        sourceId,
        toolName,
        args,
        completeness: 'all',
      });
      if (gathered.outcome === 'abandon') return abandon(gathered.cause);
      if (gathered.outcome === 'stop') {
        if (gathered.reason === 'deadline') {
          return { next: 'result', result: failed(ctx, 'deadline', 'no time left for the verification collections') };
        }
        collections.push({ claimIds, taskId: null, failureCode: gathered.reason });
        continue;
      }
      const [unavailable] = gathered.unavailable;
      collections.push({
        claimIds,
        taskId: gathered.taskIds[0] ?? null,
        failureCode: unavailable === undefined ? null : unavailable.failureCode,
      });
    }
    return { next: 'go', value: collections };
  }

  async function recordsOf(frame: TaskFrame, task: Task | undefined): Promise<SourceRecord[]> {
    if (task?.status !== 'succeeded') return [];
    const pages = await Promise.all(
      task.outputRefs.map(async (evidenceId) => ({ evidenceId, page: PageSchema.parse(JSON.parse(await readEvidence(frame, evidenceId))) })),
    );
    return pages.flatMap(({ evidenceId, page }) => page.items.map((record) => ({ evidenceId, record })));
  }

  /** Code compares every claim's atoms with the records fetched for it (KD-6, DC-10). */
  async function judge(frame: TaskFrame, revisions: readonly ClaimRevisionRow[], collections: readonly Collection[], tasks: readonly Task[]) {
    const byId = new Map(tasks.map((task) => [task.taskId, task]));
    const fetched = new Map<Collection, { records: SourceRecord[]; coverage: Coverage | null }>();
    for (const collection of collections) {
      const task = collection.taskId === null ? undefined : byId.get(collection.taskId);
      fetched.set(collection, { records: await recordsOf(frame, task), coverage: task?.status === 'succeeded' ? task.coverage : null });
    }
    return revisions.map((revision): VerifiedRevision & { readonly missingAtoms: readonly Atom[] } => {
      const own = collections.filter((collection) => collection.claimIds.includes(revision.claimId)).map((collection) => fetched.get(collection)!);
      const records = own.flatMap((item) => item.records);
      const verdict = verifyClaim({ atoms: StoredAtomsSchema.parse(revision.atoms), records });
      const basis = new Set(verdict.basis);
      const scope = own.find((item) => item.records.some((record) => basis.has(record.evidenceId)))?.coverage ?? null;
      return {
        claimId: revision.claimId,
        text: revision.text,
        atoms: verdict.atoms,
        evidenceIds: verdict.basis,
        coverage: scope,
        status: verdict.status,
        missingAtoms: verdict.missingAtoms,
      };
    });
  }

  /** The verifier's requests and the round's collections, from the checkpoint or by calling and proposing now. */
  async function round(ctx: TaskContext, frame: TaskFrame, revisions: readonly ClaimRevisionRow[]): Promise<Step<Collection[]>> {
    const proposed = ProposedRoundSchema.safeParse(ctx.checkpoint);
    if (proposed.success) return { next: 'go', value: proposed.data.collections };
    const saved = checkpointedAnswer(ctx, VERIFY_CALL);
    const called: Step<readonly VerifierRequest[]> =
      saved === undefined ? await callVerifier(ctx, frame, revisions) : { next: 'go', value: VerifierOutputSchema.parse(saved.output).requests };
    if (called.next === 'result') return called;
    const collected = await collect(ctx, frame, revisions, called.value);
    if (collected.next === 'result') return collected;
    await ctx.saveCheckpoint({ call: VERIFY_CALL, output: { requests: called.value }, collections: collected.value });
    return collected;
  }

  async function run(ctx: TaskContext): Promise<HandlerResult> {
    const input = VerifyInputSchema.parse(ctx.input);
    if ((await abandonEarlierAttempts(ctx)) === 'fenced') return abandon('fenced');
    const notAfter = new Date(input.notAfter);
    // DC-3: a task claimed or woken at or after `notAfter` goes no further.
    if (deps.clock.now() >= notAfter) {
      return failed(ctx, 'deadline', 'the verification task ran at or after notAfter');
    }
    const frame = await readTaskFrame(db, ctx, notAfter);
    // In the order the decision named them: a revision's number in this task is its claim's place in the round.
    const order = (claimId: string) => input.claimIds.indexOf(claimId);
    const revisions = (await claims.latestRevisions(db, ctx.investigationId, input.claimIds)).sort(
      (left, right) => order(left.claimId) - order(right.claimId),
    );
    if (revisions.length === 0) return succeeded({ verdicts: [] });

    const collected = await round(ctx, frame, revisions);
    if (collected.next === 'result') return collected.result;
    const collections = collected.value;
    const tasks = await tasksOf(frame);
    const roundTaskIds = new Set(collections.flatMap((collection) => (collection.taskId === null ? [] : [collection.taskId])));
    const open = tasks.filter((task) => roundTaskIds.has(task.taskId) && !FINAL_STATUSES.has(task.status)).map((task) => task.taskId);
    if (open.length > 0) {
      const registered = await ctx.registerWait(open);
      if (registered.outcome !== 'ok') {
        throw new Error(`wait of verification task ${ctx.taskId} refused: ${registered.reason}`);
      }
      return { kind: 'wait', answerOrDelta: null, waitFor: open, evidenceRefs: [], coverage: null, missingEvidence: [], warnings: [], proposedTasks: [] };
    }

    const judged = await judge(frame, revisions, collections, tasks);
    const written = await ctx.withAttemptGuard((tx) =>
      claims.appendRevisions(tx, { investigationId: ctx.investigationId, taskId: ctx.taskId, revisions: judged }),
    );
    if (written.outcome === 'fenced') return abandon('fenced');
    return succeeded({
      verdicts: judged.map((item) => ({ claimId: item.claimId, status: item.status, missingAtoms: item.missingAtoms.map(({ kind, value }) => ({ kind, value })) })),
    });
  }

  return {
    workflowType: VERIFY_WORKFLOW,
    workflowVersion: 1,
    inputSchema: VerifyInputSchema,
    run,
  };
}
