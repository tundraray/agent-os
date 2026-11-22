import { createSecretMasker, type Logger } from '@agent-os/common';
import type { LastExtractionReason, LastExtractionStatus } from '@agent-os/contracts';
import type { Database, Transaction } from '@agent-os/db';
import {
  type Runtime,
  RuntimeError,
  type StepContext,
  type StepResult,
  type TaskHandler,
} from '@agent-os/runtime';

import type { AgentsEmbeddings } from '../embeddings/embeddings';
import type { AgentToolCall, AgentToolDefinition, AgentTurnMessage } from '../model/mastra-turn';
import type { ModelCallRequest, ModelCallResult, ModelClient } from '../model/model-client';
import { envelope } from '../model/provider-messages';
import { tokensOfBytes, utf8Bytes } from '../model/token-estimate';
import { sessions } from '../store/sessions.repository';
import { type CheckedOperations, checkOperations, type RoundCall } from './check-operations';
import { type ExtractionInput, readExtractionInput } from './extraction-input';
import {
  advanceExtractedUpTo,
  findRunById,
  type KnowledgeRun,
  updateKnowledgeRun,
  writeRoundOutcome,
} from './knowledge-runs.repository';
import {
  confirmItem,
  insertEntity,
  insertRelations,
  lockGraph,
  markOutdated,
  type NewKnowledgeRelation,
  readGraph,
  readKnowledgeSettings,
} from './knowledge.repository';
import { graphItemsOf, registryToolAlive } from './knowledge-block';
import {
  isForeignKeyViolation,
  KNOWLEDGE_EXTRACT_TASK_TYPE,
  KnowledgeExtractInputSchema,
} from './knowledge-tasks';
import { knowledgeLineWithKey } from './knowledge-text';
import {
  CHOOSE_ENTITIES_TOOL,
  ChooseEntitiesArgsSchema,
  RECORD_KNOWLEDGE_TOOL,
  RecordKnowledgeAnswerSchema,
  RecordKnowledgeArgsSchema,
} from './operations';
import { type GraphItem, selectKnowledge } from './select-knowledge';
import {
  applyChoices,
  proposedEntities,
  SIMILAR_ENTITY_LIMIT,
  similarCandidates,
  similarEntitiesText,
} from './similar-entities';
import type { KnowledgeCloseness, KnowledgeVectorStore } from './vector-store';

/*
 * The handler of `knowledge.extract` (design-core.md, KD-3, KD-4, Flow 1): one extraction round per
 * step. The model judges, the code decides: the deep agent's model returns operations through
 * `record_knowledge`, `checkOperations` checks them against the graph re-read under the graph lock,
 * and the code applies them by id. Model and embedding calls run outside any transaction; every write
 * of the round — graph, outcome, mark, the run row's task fields — is one guarded transaction.
 */

/** The agent name of the extraction call: the id of the request agent Mastra builds. */
const EXTRACT_AGENT_NAME = 'knowledge-extract';

/** What the extraction model is told; `ModelClient.call` appends the data preamble and the code rule. */
const EXTRACTION_RULE = [
  'You keep the knowledge graph of a deep agent. Below are the knowledge graph learned by its earlier runs,',
  'each record with its id (e… for an entity, r… for a relation), and the tool calls of the last run, each',
  'with its number c…. Decide what this run learned that will help later runs of the same deep agent, and call',
  'record_knowledge exactly once with the operations; call no other tool and do not answer in text.',
  '- add_entity: a thing the deep agent works with (a system, a project, a team, a document), with a ref you',
  '  use in this answer to link it; add_relation kind fact: a fact between two entities (ids e… or refs);',
  '  kind lesson: how a tool should be called for a kind of question; kind searched_nothing: a tool that',
  '  found nothing for a kind of question.',
  '- confirm: a record of the graph this run showed again, by its id; mark_outdated: a record this run',
  '  showed to be wrong or stale. Look for an existing record by id before adding a new one.',
  '- Every add and confirm cites in evidence the numbers c… of the calls that show it; cite only calls above.',
  '- Never record personal data of people, secrets, tokens or passwords. Record nothing you are unsure of;',
  '  an empty list of operations is a valid answer.',
].join('\n');

/** What the `choose_entities` call is told; the rule itself is in its message. */
const CHOOSE_RULE =
  'You link new entities of a deep agent knowledge graph to existing ones. Call choose_entities once.';

const RECORD_KNOWLEDGE: AgentToolDefinition = {
  name: RECORD_KNOWLEDGE_TOOL,
  description: 'Records what this run learned: operations on the knowledge graph of the deep agent.',
  inputSchema: RecordKnowledgeArgsSchema,
};

const CHOOSE_ENTITIES: AgentToolDefinition = {
  name: CHOOSE_ENTITIES_TOOL,
  description: 'For each new entity, chooses the existing entity it is, or null to keep it new.',
  inputSchema: ChooseEntitiesArgsSchema,
};

export interface KnowledgeExtractHandlerDeps {
  /** Reads outside the commit: the run row, the session, the graph, the settings, the registry, the calls. */
  readonly database: Database;
  /** The deep agent's subtree for the round's input (`readExtractionInput`). */
  readonly tasks: Pick<Runtime['tasks'], 'get' | 'listTree'>;
  /** The only way to the model: access check, ledger row and monthly spend of an ordinary call. */
  readonly modelClient: Pick<ModelClient, 'call'>;
  /** Vectors of the answer's new entities, charged to the starter (KD-4, FR-20). */
  readonly embeddings: Pick<AgentsEmbeddings, 'embed'>;
  readonly store: KnowledgeVectorStore;
}

/** What a round came to before its commit. */
type RoundResult =
  /** No calls in the window: no model call, `done` with zeros (DC-5). */
  | { readonly kind: 'empty' }
  /** The model's operations, after the choice among similar entities when there was one. */
  | { readonly kind: 'answered'; readonly operations: readonly unknown[] }
  | { readonly kind: 'skipped'; readonly reason: LastExtractionReason }
  | { readonly kind: 'failed'; readonly reason: 'model_error' | 'invalid_answer' };

/** How the commit left the task. */
type Settled =
  | {
      readonly kind: 'continue' | 'complete';
      readonly counts: RoundCounts;
      readonly recordDeleted: boolean;
    }
  /** The run row is gone or no longer names this task: nothing was written. */
  | { readonly kind: 'not_current' };

interface RoundCounts {
  readonly added: number;
  readonly confirmed: number;
  readonly outdated: number;
}

const NO_COUNTS: RoundCounts = { added: 0, confirmed: 0, outdated: 0 };

/** The model's call of one tool, parsed, or why the answer is not good. */
type Parsed<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string };

// ---------- Parsing the answers ----------

function parseToolCall<T>(
  toolCalls: readonly AgentToolCall[],
  name: string,
  parse: (args: unknown) => Parsed<T>,
): Parsed<T> {
  const call = toolCalls.find((candidate) => candidate.toolName === name);
  if (call === undefined)
    return { ok: false, error: `You did not call ${name}. Call ${name} exactly once.` };
  return parse(call.args);
}

function parseOperations(args: unknown): Parsed<readonly unknown[]> {
  const parsed = RecordKnowledgeAnswerSchema.safeParse(args);
  if (parsed.success) return { ok: true, value: parsed.data.operations };
  return {
    ok: false,
    error: `The arguments of ${RECORD_KNOWLEDGE_TOOL} are not valid: ${parsed.error.message}. Call it again with a list of operations.`,
  };
}

/**
 * The messages of the second attempt: the first message, the model's answer and the error — as the
 * result of its tool calls when it made any, otherwise as a new user message.
 */
function retryMessages(
  first: AgentTurnMessage,
  answer: { readonly text: string; readonly toolCalls: readonly AgentToolCall[] },
  error: string,
): AgentTurnMessage[] {
  if (answer.toolCalls.length > 0) {
    return [
      first,
      { role: 'assistant', content: answer.text, toolCalls: answer.toolCalls },
      {
        role: 'tool',
        results: answer.toolCalls.map((call) => ({
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: error,
        })),
      },
    ];
  }
  const said: AgentTurnMessage[] =
    answer.text.trim() === '' ? [] : [{ role: 'assistant', content: answer.text, toolCalls: [] }];
  return [first, ...said, { role: 'user', content: error }];
}

// ---------- The commit ----------

/** Inserts the additions in the answer's order (a `ref` before what uses it), then confirms and marks. */
async function applyChecked(
  tx: Transaction,
  recordId: string,
  runId: string,
  roundAt: Date,
  checked: CheckedOperations,
): Promise<void> {
  const born = {
    recordId,
    sourceRunId: runId,
    confirmedByRunId: runId,
    createdAt: roundAt,
    confirmedAt: roundAt,
  };
  const refIds = new Map<string, number>();
  const endId = (end: { readonly id: number } | { readonly ref: string }): number => {
    if ('id' in end) return end.id;
    const id = refIds.get(end.ref);
    if (id === undefined) throw new Error('knowledge fact points at a ref that was not inserted');
    return id;
  };
  const relationRows: NewKnowledgeRelation[] = [];
  for (const addition of checked.apply) {
    if (addition.type === 'entity') {
      const row = await insertEntity(tx, {
        ...born,
        name: addition.name,
        description: addition.description,
      });
      refIds.set(addition.ref, row.id);
      continue;
    }
    switch (addition.kind) {
      case 'fact':
        relationRows.push({
          ...born,
          kind: 'fact',
          fromEntityId: endId(addition.from),
          toEntityId: endId(addition.to),
          label: addition.label,
        });
        break;
      case 'lesson':
        relationRows.push({
          ...born,
          kind: 'lesson',
          server: addition.server,
          tool: addition.tool,
          question: addition.question,
          hint: addition.hint,
          outcome: addition.outcome,
        });
        break;
      case 'searched_nothing':
        relationRows.push({
          ...born,
          kind: 'searched_nothing',
          server: addition.server,
          tool: addition.tool,
          question: addition.question,
        });
        break;
    }
  }
  await insertRelations(tx, relationRows);
  for (const confirmation of checked.confirm) {
    await confirmItem(tx, recordId, {
      item: { type: confirmation.type, id: confirmation.id },
      confirmations: confirmation.confirmations,
      at: confirmation.confirmedAt,
      runId: confirmation.confirmedByRunId,
    });
  }
  for (const item of checked.outdated) await markOutdated(tx, recordId, item);
}

function statusOf(result: RoundResult): {
  status: LastExtractionStatus;
  reason: LastExtractionReason | null;
} {
  switch (result.kind) {
    case 'empty':
    case 'answered':
      return { status: 'done', reason: null };
    case 'skipped':
      return { status: 'skipped', reason: result.reason };
    case 'failed':
      return { status: 'failed', reason: result.reason };
  }
}

/** Counts of the operations by kind for the log: never their texts. */
function operationCounts(operations: readonly unknown[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const operation of operations) {
    const op =
      typeof operation === 'object' && operation !== null
        ? (operation as { op?: unknown }).op
        : undefined;
    const key = typeof op === 'string' ? op : 'malformed';
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

function rejectionCounts(checked: CheckedOperations): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const { reason } of checked.rejected) counts[reason] = (counts[reason] ?? 0) + 1;
  return counts;
}

/**
 * Builds the handler of `knowledge.extract` (design-core.md, KD-3, KD-4, Flow 1, Invariants 1–5).
 *
 * A step is one round:
 * 1. Reads the run row, the deep agent's session (its model), the round's input (`readAt` — the read).
 *    No row, no session or no deep agent task (the conversation was deleted) — the round ends without a
 *    model call; a row that names another task (a lost step whose commit already ended the round) —
 *    `complete` without writes.
 * 2. No calls in the window — no model call, `done` with zeros (DC-5).
 * 3. The graph by `selectKnowledge` without closeness, then `ModelClient.call` with `record_knowledge` on
 *    the deep agent's model, the starter as owner; a refusal is `skipped`, any `model_error` is `failed`;
 *    an answer without a good call gets one more attempt, a second bad one is `invalid_answer` (DC-7).
 * 4. New entities: masked, embedded, the store's similar entities; only with candidates one more call
 *    with `choose_entities` (DC-17). So a round makes at most three model calls.
 * 5. The commit — one guarded transaction: `lockGraph`, the run row locked and re-read, the graph re-read,
 *    `checkOperations`, the graph writes in a savepoint (a deleted deep agent drops only them, DC-8), the
 *    outcome with `last_extract_task_id`, the mark moved forward to `readAt` on `done`, and under the run
 *    row's lock: «one more round» set → cleared and the task continues; else `extract_task_id` cleared and
 *    the task completes. The step never returns `fail`.
 *
 * The outcome of the step is decided in the guarded transaction, not before it, because the trigger can
 * set «one more round» at any time; the step's own commit then only moves the task's status. A step lost
 * after the guarded transaction is re-run: the row no longer names the task (it ended) and the re-run
 * completes without writes, or the row still names it with the mark moved (it continued) and the re-run is
 * the next round. A step lost before it re-runs from the start: its model calls are made and billed again,
 * nothing was applied. Nothing is applied twice — every write is inside the one transaction.
 */
export function createKnowledgeExtractHandler(deps: KnowledgeExtractHandlerDeps): TaskHandler {
  const { database, modelClient, embeddings, store } = deps;
  const mask = createSecretMasker([]);

  /** The round's model call through `ModelClient`: the starter as owner, the extraction task as task and root. */
  function callModel(
    ctx: StepContext,
    round: { readonly ownerId: string; readonly model: string; readonly logger: Logger },
    call: Pick<ModelCallRequest, 'instructions' | 'messages' | 'tools'>,
  ): Promise<ModelCallResult> {
    return modelClient.call({
      ...call,
      ownerId: round.ownerId,
      rootId: ctx.rootId,
      taskId: ctx.taskId,
      agentName: EXTRACT_AGENT_NAME,
      model: round.model,
      streamsText: false,
      signal: ctx.signal,
      logger: round.logger,
    });
  }

  /** The extraction call and its one retry on an answer that cannot be parsed. At most two model calls. */
  async function extract(
    ctx: StepContext,
    round: { readonly ownerId: string; readonly model: string; readonly logger: Logger },
    message: AgentTurnMessage,
  ): Promise<RoundResult> {
    let messages: AgentTurnMessage[] = [message];
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const result = await callModel(ctx, round, {
        instructions: EXTRACTION_RULE,
        messages,
        tools: [RECORD_KNOWLEDGE],
      });
      if (result.kind === 'not_started') {
        round.logger.warn('knowledge round skipped: model call refused', {
          attempt,
          reason: result.verdict.reason,
        });
        return { kind: 'skipped', reason: result.verdict.reason };
      }
      if (result.kind === 'model_error') {
        round.logger.warn('knowledge round failed: model error', {
          attempt,
          reason: result.reason,
          provider: result.provider,
          statusCode: result.statusCode,
        });
        return { kind: 'failed', reason: 'model_error' };
      }
      const parsed = parseToolCall(result.toolCalls, RECORD_KNOWLEDGE_TOOL, parseOperations);
      round.logger.info('knowledge extraction answered', {
        attempt,
        modelCallId: result.modelCallId,
        toolCalls: result.toolCalls.length,
        valid: parsed.ok,
        operations: parsed.ok ? operationCounts(parsed.value) : null,
      });
      if (parsed.ok) return { kind: 'answered', operations: parsed.value };
      messages = retryMessages(message, result, parsed.error);
    }
    round.logger.warn('knowledge round failed: invalid answer twice', { attempts: 2 });
    return { kind: 'failed', reason: 'invalid_answer' };
  }

  /**
   * Similar entities (KD-4, FR-20): the answer's new entities masked and embedded for the starter, the
   * store's closest entities of the graph, and — only with candidates — one `choose_entities` call. Any
   * failure here leaves the operations as they are, with the reason in the log (DC-17).
   */
  async function chooseSimilar(
    ctx: StepContext,
    round: {
      readonly ownerId: string;
      readonly model: string;
      readonly logger: Logger;
      readonly recordId: string;
    },
    operations: readonly unknown[],
    graphItems: readonly GraphItem[],
  ): Promise<readonly unknown[]> {
    const proposed = proposedEntities(operations).map((entity) => ({
      ref: entity.ref,
      name: mask(entity.name),
      description: mask(entity.description),
    }));
    if (proposed.length === 0 || !graphItems.some((item) => item.type === 'entity'))
      return operations;

    const texts = proposed.map((entity) => `${entity.name}: ${entity.description}`);
    const embedded = await embeddings.embed({
      texts,
      inputType: 'document',
      ownerId: round.ownerId,
      taskId: ctx.taskId,
      signal: ctx.signal,
      logger: round.logger,
    });
    if (embedded.kind === 'unavailable') {
      round.logger.warn('similar entities skipped: embeddings unavailable', {
        newEntities: proposed.length,
        reason: embedded.reason,
        embeddingModel: embedded.model,
      });
      return operations;
    }

    const pairsByRef = new Map<string, readonly KnowledgeCloseness[]>();
    try {
      for (const [index, entity] of proposed.entries()) {
        const vector = embedded.vectors[index];
        if (vector === undefined) throw new Error('embeddings gave fewer vectors than texts');
        pairsByRef.set(
          entity.ref,
          await store.query(round.recordId, vector, embedded.model, SIMILAR_ENTITY_LIMIT, 'entity'),
        );
      }
    } catch (error) {
      round.logger.warn('similar entities skipped: vector store query failed', {
        newEntities: proposed.length,
        error,
      });
      return operations;
    }

    const similar = similarCandidates(proposed, pairsByRef, graphItems);
    round.logger.info('similar entities found', {
      newEntities: proposed.length,
      textBytes: texts.reduce((sum, text) => sum + utf8Bytes(text), 0),
      embeddingModel: embedded.model,
      candidates: similar.map((entity) =>
        entity.candidates.map(({ id, closeness }) => ({ id, closeness })),
      ),
    });
    if (similar.length === 0) return operations;

    const result = await callModel(ctx, round, {
      instructions: CHOOSE_RULE,
      messages: [{ role: 'user', content: similarEntitiesText(similar) }],
      tools: [CHOOSE_ENTITIES],
    });
    if (result.kind !== 'answer') {
      round.logger.warn('similar entities choice skipped', {
        result: result.kind,
        reason: result.kind === 'not_started' ? result.verdict.reason : result.reason,
      });
      return operations;
    }
    const parsed = parseToolCall(result.toolCalls, CHOOSE_ENTITIES_TOOL, (args) => {
      const choice = ChooseEntitiesArgsSchema.safeParse(args);
      return choice.success
        ? { ok: true, value: choice.data.choices }
        : { ok: false, error: choice.error.message };
    });
    if (!parsed.ok) {
      round.logger.warn('similar entities choice dropped: invalid answer', {
        modelCallId: result.modelCallId,
      });
      return operations;
    }
    const applied = applyChoices(operations, similar, parsed.value);
    round.logger.info('similar entities chosen', {
      modelCallId: result.modelCallId,
      accepted: applied.accepted.map(({ id }) => id),
      rejected: applied.rejected.map(({ id }) => id),
    });
    return applied.operations;
  }

  /**
   * The round's single commit, in a guarded transaction so the step's outcome follows what it saw under
   * the run row's lock. `outcome` is `null` when the conversation is gone: only the task fields change.
   */
  async function commitRound(
    ctx: StepContext,
    round: {
      readonly runId: string;
      readonly recordId: string;
      readonly model: string | null;
      readonly logger: Logger;
    },
    result: RoundResult | null,
    window: { readonly calls: ReadonlyMap<string, RoundCall>; readonly readAt: Date } | null,
  ): Promise<Settled | 'fenced'> {
    const guarded = await ctx.guard(async (tx: Transaction): Promise<Settled> => {
      await lockGraph(tx, round.recordId);
      const run = await findRunById(tx, round.runId);
      if (run === undefined || run.extractTaskId !== ctx.taskId) return { kind: 'not_current' };

      let counts = NO_COUNTS;
      let recordDeleted = false;
      const roundAt = new Date();
      if (result?.kind === 'answered' && window !== null) {
        const graph = await readGraph(tx, round.recordId);
        const checked = checkOperations({
          graph,
          calls: window.calls,
          operations: result.operations,
          mask,
          roundAt,
          runId: round.runId,
        });
        round.logger.info('knowledge operations checked', {
          graphEntities: graph.entities.length,
          graphRelations: graph.relations.length,
          added: checked.apply.length,
          confirmed: checked.confirm.length,
          outdated: checked.outdated.length,
          rejected: rejectionCounts(checked),
        });
        try {
          await tx.transaction((savepoint) =>
            applyChecked(savepoint, round.recordId, round.runId, roundAt, checked),
          );
          counts = {
            added: checked.apply.length,
            confirmed: checked.confirm.length,
            outdated: checked.outdated.length,
          };
        } catch (error) {
          if (!isForeignKeyViolation(error)) throw error;
          recordDeleted = true;
          round.logger.warn('knowledge graph writes dropped: deep agent deleted', {
            reason: 'record_deleted',
          });
        }
      }

      if (result !== null) {
        await writeRoundOutcome(tx, round.runId, {
          ...statusOf(result),
          ...counts,
          model: round.model,
          at: roundAt,
          extractTaskId: ctx.taskId,
        });
        // Only a done round moves the mark, and only forward (Invariant 2, DC-3).
        if (window !== null && (result.kind === 'answered' || result.kind === 'empty')) {
          await advanceExtractedUpTo(tx, round.runId, window.readAt);
        }
      }

      if (run.needsRound && result !== null && !recordDeleted) {
        await updateKnowledgeRun(tx, round.runId, { needsRound: false });
        return { kind: 'continue', counts, recordDeleted };
      }
      await updateKnowledgeRun(tx, round.runId, { extractTaskId: null, needsRound: false });
      return { kind: 'complete', counts, recordDeleted };
    });
    return guarded.outcome === 'fenced' ? 'fenced' : guarded.value;
  }

  /** Commits the round and turns what the commit saw into the step's result; logs the outcome. */
  async function finish(
    ctx: StepContext,
    round: {
      readonly runId: string;
      readonly recordId: string;
      readonly model: string | null;
      readonly logger: Logger;
    },
    result: RoundResult | null,
    window: ExtractionInput | null,
    startedAt: number,
  ): Promise<StepResult> {
    const settled = await commitRound(ctx, round, result, window);
    const status = result === null ? null : statusOf(result);
    const fields = {
      status: status?.status ?? null,
      reason: status?.reason ?? null,
      readAt: window?.readAt.toISOString() ?? null,
      durationMs: Date.now() - startedAt,
    };
    if (settled === 'fenced') {
      round.logger.info('knowledge round abandoned without writes', {
        ...fields,
        outcome: 'fenced',
      });
      return { outcome: 'continue' };
    }
    if (settled.kind === 'not_current') {
      round.logger.info('knowledge round ended: not current', {
        ...fields,
        outcome: 'not_current',
      });
      return { outcome: 'complete', result: { outcome: 'not_current' } };
    }
    const moved = window !== null && status?.status === 'done';
    round.logger.info('knowledge round committed', {
      ...fields,
      ...settled.counts,
      recordDeleted: settled.recordDeleted,
      markMovedTo: moved ? fields.readAt : null,
      next: settled.kind,
    });
    if (settled.kind === 'continue') return { outcome: 'continue' };
    return { outcome: 'complete', result: { ...fields, ...settled.counts } };
  }

  /** The deep agent's task, read by `readExtractionInput`, is gone: the conversation was deleted. */
  async function inputOf(run: KnowledgeRun): Promise<ExtractionInput | undefined> {
    try {
      return await readExtractionInput({ database, tasks: deps.tasks }, run);
    } catch (error) {
      if (error instanceof RuntimeError && error.code === 'TASK_NOT_FOUND') return undefined;
      throw error;
    }
  }

  async function step(ctx: StepContext): Promise<StepResult> {
    const startedAt = Date.now();
    const { runId, rootId } = KnowledgeExtractInputSchema.parse(ctx.input);
    const baseLogger = ctx.logger.child({ runId, conversationRootId: rootId });

    const run = await findRunById(database, runId);
    if (run === undefined) {
      baseLogger.info('knowledge round ended: run row gone', {
        outcome: 'gone',
        durationMs: Date.now() - startedAt,
      });
      return { outcome: 'complete', result: { outcome: 'gone' } };
    }
    const { recordId, ownerId } = run;
    if (run.extractTaskId !== ctx.taskId) {
      baseLogger.info('knowledge round ended: not current', {
        recordId,
        outcome: 'not_current',
        durationMs: Date.now() - startedAt,
      });
      return { outcome: 'complete', result: { outcome: 'not_current' } };
    }

    const session = await sessions.get(database, runId);
    const input = session === undefined ? undefined : await inputOf(run);
    if (session === undefined || input === undefined) {
      const logger = baseLogger.child({ recordId, ownerId });
      logger.info('knowledge round without writes: conversation gone', {
        session: session !== undefined,
      });
      return finish(ctx, { runId, recordId, model: null, logger }, null, null, startedAt);
    }

    // The deep agent's model from its session: a later change of the deep agent does not touch it (AC-08.3).
    const model = session.model;
    const logger = baseLogger.child({ recordId, ownerId, model });
    const round = { runId, recordId, ownerId, model, logger };
    logger.info('knowledge round input read', {
      ...input.counts,
      readAt: input.readAt.toISOString(),
    });
    if (input.counts.calls === 0) return finish(ctx, round, { kind: 'empty' }, input, startedAt);

    const settings = await readKnowledgeSettings(database);
    const graphItems = graphItemsOf(await readGraph(database, recordId));
    const choice = selectKnowledge({
      items: graphItems,
      settings,
      toolAlive: await registryToolAlive(database, run.servers),
      closeness: [],
    });
    const graphText = choice.chosen.map(knowledgeLineWithKey).join('\n');
    logger.info('knowledge round graph selected', {
      graphRecords: graphItems.length,
      chosen: choice.chosen.length,
      left: choice.left,
      blockTokens: tokensOfBytes(utf8Bytes(graphText)),
    });

    const message: AgentTurnMessage = {
      role: 'user',
      content: [
        envelope(
          'knowledge graph',
          'earlier runs of this deep agent',
          graphText === '' ? '(empty)' : graphText,
        ),
        input.text,
      ].join('\n\n'),
    };
    const extracted = await extract(ctx, round, message);
    const result =
      extracted.kind === 'answered'
        ? {
            kind: 'answered' as const,
            operations: await chooseSimilar(ctx, round, extracted.operations, graphItems),
          }
        : extracted;
    return finish(ctx, round, result, input, startedAt);
  }

  return { type: KNOWLEDGE_EXTRACT_TASK_TYPE, inputSchema: KnowledgeExtractInputSchema, step };
}
