// agent-runtime / research-flow — repository rules over the real Postgres (design-research-flow.md, Contract «Инструменты
// возможностей», DC-6, UC-E1). Each `describe` is one rule with its cases as rows. These are storage-level checks, not
// scenarios: they spend no INT or E2E budget. A plain `vitest run` has no database, so they live in this e2e file.
//
// Assembly: the real `createRuntime` over the test database with one test handler of a workflow type unique to this file;
// it runs the body a test hands it inside a real attempt, so the tool's write goes through the real
// `TaskContext.withAttemptGuard` and the real `ToolExecutor`. Nothing of Postgres, the runtime or the engine is mocked; the
// thread-ownership port is a double, as in every harness. Isolation: a unique `resourceId` per test, no truncate; the
// investigations the file created are cancelled after it.

import { randomUUID } from 'node:crypto';
import type { Coverage, EvidenceInput } from '@agent-os/contracts';
import { createDatabase, type Database, type DatabaseConnection, researchClaims, researchEngineRuns, researchPlanRevisions } from '@agent-os/db';
import { createRuntime, parseRuntimeConfig, type Runtime, systemClock, type TaskContext, type ThreadOwnership } from '@agent-os/runtime';
import type { SourceRegistry, SourceSchema } from '@agent-os/sources';
import { asc, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { agentRunsRepository } from '../src/agents/agent-runs.repository.js';
import { createFormDataReader } from '../src/agents/collect-reader.js';
import { definitionMemoryFingerprint } from '../src/agents/fingerprint.js';
import { closureStep, type FormRun, runForcedEnd, runPrologue } from '../src/agents/process-code.js';
import { TEXT_FORM } from '../src/agents/result-forms.js';
import type { ToolAccessPolicy } from '../src/agents/tool-access-policy.js';
import { toolCallsRepository } from '../src/agents/tool-calls.repository.js';
import { createToolExecutor, POSTGRES_AGENT_TREE } from '../src/agents/tool-executor.js';
import { BASE_TOOLS, createToolRegistry } from '../src/agents/tool-registry.js';
import type { AgentRunContext } from '../src/agents/tools/tool-context.js';
import { claimsRepository } from '../src/claims/claims.repository.js';
import { AgentProcessConfigSchema } from '../src/config/agent-config.schema.js';
import { createEngine } from '../src/create-engine.js';
import type { Engine } from '../src/engine.js';
import type { RoleModel } from '../src/ports.js';
import { deepResearchProcessV3 } from '../src/processes/shipped-processes.js';
import { CLAIM_ASSESSMENT_FORM, claimAssessmentAgent } from '../src/research-flow/forms/claim-assessment.js';
import { RESEARCH_CLOSE_FORM } from '../src/research-flow/forms/research-close.js';
import { RESEARCH_IMMEDIATE_TOOLS, RESEARCH_TOOLS } from '../src/research-flow/research-tools.js';
import { databaseUrl } from './support/database-url.js';
import { assertNoActiveInvestigations, cancelNotingLeftBehind, closeEngineDb, trackInvestigationOwner } from './support/engineDb.js';
import { newUser } from './support/new-user.js';

/** The rights port of these repository tests: every owner may call every tool and read every source. */
const ALLOW_ALL_ACCESS: ToolAccessPolicy = { decide: () => 'allowed' };

/** A workflow type only this file registers: no other assembly ever claims its tasks. */
const WORKFLOW = `test-research-repo-${randomUUID()}`;
/** How long a test waits for its body to run inside an attempt before it fails with a reason. */
const BODY_TIMEOUT_MS = 20_000;

interface Pending {
  readonly body: (ctx: TaskContext) => Promise<unknown>;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

const pending = new Map<string, Pending>();
const owners = new Map<string, string>();
const created: { readonly investigationId: string; readonly resourceId: string; readonly threadId: string }[] = [];
let connection: DatabaseConnection;
let runtime: Runtime;

const threads: ThreadOwnership = {
  async withOwnedThread(threadId, resourceId, fn) {
    if (owners.get(threadId) !== resourceId) throw new Error(`Thread ${threadId} of ${resourceId} not found`);
    return fn();
  },
};

const db = () => connection.db;

async function newInvestigation(resourceId: string) {
  const threadId = `thread-${randomUUID()}`;
  owners.set(threadId, resourceId);
  trackInvestigationOwner(resourceId);
  const { investigationId } = await runtime.investigations.create({
    resourceId,
    threadId,
    query: 'repository rules',
    budget: { maxTasks: 60, maxToolCalls: 60 },
  });
  const investigation = { investigationId, resourceId, threadId };
  created.push(investigation);
  return investigation;
}

/** Proposes a task of {@link WORKFLOW} and runs `body` inside its attempt; resolves with what `body` returned. */
async function inAttempt<T>(investigationId: string, body: (ctx: TaskContext) => Promise<T>): Promise<T> {
  const key = randomUUID();
  const done = new Promise<T>((resolve, reject) => {
    pending.set(key, { body, resolve: resolve as (value: unknown) => void, reject });
  });
  const proposed = await runtime.scheduler.propose(
    {
      investigationId,
      workflowType: WORKFLOW,
      workflowVersion: 1,
      input: { key },
      inputRefs: [],
      expectedOutput: { description: 'a repository rule', completeness: 'all' },
      dependsOn: [],
      budget: { maxToolCalls: 1, maxRetries: 0, deadlineMs: 120_000, maxTokens: 100_000 },
    },
    `repo-spec-${key}`,
  );
  if (proposed.outcome === 'rejected') throw new Error(`propose rejected: ${proposed.reason}`);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`body of task ${proposed.taskId} did not run`)), BODY_TIMEOUT_MS);
  });
  try {
    return await Promise.race([done, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Evidence of one page with `size` records, as a `source.fetch` page is stored. */
function pageEvidence(size: number): EvidenceInput {
  const items = Array.from({ length: size }, (_, line) => ({ line }));
  const evidenceKey = `page-${randomUUID()}`;
  return {
    evidenceKey,
    provenance: { sourceId: 'fixture', toolName: 'search_logs', normalizedArgs: { key: evidenceKey }, snapshot: 'snapshot-1' },
    coverage: { completeness: 'complete', totalMatched: size, totalRelation: 'eq', returned: size, truncated: false, continuation: null },
    content: { mediaType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify({ items })) },
  };
}

const PAGE_SIZE = 25;

const CONFIG = AgentProcessConfigSchema.parse({
  processId: 'probe-research-flow',
  version: 1,
  goal: 'Probe the research tools',
  sources: [],
  agents: {
    worker: {
      model: 'anthropic/claude-haiku-5-5',
      effort: 'low',
      prompt: 'Answer {{query}}.',
      tools: ['claims_write'],
      result: 'text',
      limits: {
        maxTurns: 4,
        maxCallsPerTurn: 2,
        maxChildren: 0,
        runTokens: 300_000,
        deadlineMs: 600_000,
        windowTokens: 200_000,
        marginTokens: 1_000,
        maxOutputTokens: 2_000,
      },
    },
  },
  rootAgent: 'worker',
  agentLimits: { maxDepth: 1 },
  limits: { investigationTokens: { default: 300_000, max: 600_000 }, maxTasks: 5, maxToolCalls: 5 },
  answer: { sections: ['summary'] },
});

function realExecutor() {
  return createToolExecutor({
    registry: createToolRegistry([...BASE_TOOLS, ...RESEARCH_TOOLS]),
    tools: RESEARCH_IMMEDIATE_TOOLS,
    accessPolicy: ALLOW_ALL_ACCESS,
    calls: toolCallsRepository,
    tree: POSTGRES_AGENT_TREE,
    scheduler: runtime.scheduler,
    investigations: runtime.investigations,
    clock: systemClock,
    timings: { deadlineMarginMs: 90_000, leaseMs: 30_000 },
  });
}

/** The attempt's task as a run of `worker`: the row every call hangs off and what the executor knows of it. */
async function workerRun(
  ctx: TaskContext,
  investigation: { readonly resourceId: string; readonly threadId: string },
): Promise<AgentRunContext> {
  const notAfter = new Date(Date.now() + 60_000);
  const written = await ctx.withAttemptGuard((tx) =>
    agentRunsRepository.insert(tx, {
      taskId: ctx.taskId,
      investigationId: ctx.investigationId,
      agentName: 'worker',
      parent: null,
      depth: 0,
      assignment: 'find the cause',
      shareTokens: 100_000,
      notAfter,
      sources: [],
    }),
  );
  if (written.outcome !== 'committed') throw new Error(`setup write ${written.outcome}`);
  return {
    runTaskId: ctx.taskId,
    investigationId: ctx.investigationId,
    resourceId: investigation.resourceId,
    threadId: investigation.threadId,
    agentName: 'worker',
    definition: CONFIG.agents.worker!,
    config: CONFIG,
    resultSchema: TEXT_FORM.resultSchema,
    depth: 0,
    shareTokens: 100_000,
    sources: [],
    notAfter,
  };
}

/** One `claims_write` call of the run, in a turn of its own, through the executor; returns its row. */
async function callClaimsWrite(ctx: TaskContext, run: AgentRunContext, callIndex: number, claims: readonly unknown[]) {
  const requested = await ctx.withAttemptGuard((tx) =>
    toolCallsRepository.insertRequested(tx, { investigationId: ctx.investigationId, runTaskId: ctx.taskId, turn: callIndex }, [
      { callIndex, toolName: 'claims_write', arguments: { claims } },
    ]),
  );
  if (requested.outcome !== 'committed') throw new Error(`setup write ${requested.outcome}`);
  const executed = await realExecutor().executeTurn(ctx, run, requested.value);
  if (executed.outcome !== 'executed') throw new Error(`turn ${executed.outcome}`);
  const calls = await toolCallsRepository.ofRun(db(), ctx.taskId);
  return calls[callIndex]!;
}

const claimOf = (text: string, pointer: unknown) => ({ text, atoms: [{ kind: 'number', value: '7' }], pointer });

function revisionsOf(investigationId: string) {
  return db().select().from(researchClaims).where(eq(researchClaims.investigationId, investigationId)).orderBy(asc(researchClaims.claimIndex));
}

beforeAll(() => {
  connection = createDatabase({ connectionString: databaseUrl(), poolMax: 4 });
  runtime = createRuntime({
    database: connection,
    config: { ...parseRuntimeConfig({}), workers: true, concurrency: 4, pollMs: 50, dbPoolMax: 4 },
    threads,
    logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    clock: systemClock,
  });
  runtime.handlers.register({
    workflowType: WORKFLOW,
    workflowVersion: 1,
    inputSchema: z.object({ key: z.string() }),
    async run(ctx) {
      const { key } = ctx.input as { key: string };
      const entry = pending.get(key);
      pending.delete(key);
      try {
        entry?.resolve(await entry.body(ctx));
      } catch (error) {
        entry?.reject(error);
      }
      return {
        kind: 'completed',
        answerOrDelta: null,
        evidenceRefs: [],
        coverage: null,
        missingEvidence: [],
        warnings: [],
        proposedTasks: [],
      };
    },
  });
  runtime.start();
});

// An investigation of this file only owns the rows of its test and no test runs one to its end, so each is stopped on purpose.
afterEach(async () => {
  for (const { investigationId, resourceId } of created) {
    await runtime.investigations.cancel(investigationId, resourceId);
  }
});

afterAll(async () => {
  for (const investigation of created) {
    if (runtime !== undefined) await cancelNotingLeftBehind(db(), runtime.investigations, investigation);
  }
  try {
    await assertNoActiveInvestigations();
  } finally {
    await closeEngineDb();
    await runtime?.stop();
    await connection?.close();
  }
});

// DC-6, UC-E1, FR-15. Defects caught: a pointer to a foreign page is accepted; a model's page id that is no uuid breaks the
// call instead of refusing it; a partial write when one pointer of a call is wrong; a second call of a run silently writes
// nothing (the `(taskId, claimIndex)` collision) or returns the numbers of the first one.
// DC-25, DC-7, DC-8, Contract `claim_assessment`. Defect caught: the revision of a short input or of a forced end has an
// empty text, because neither input holds the claim: `write` reads it inside its own transaction.
describe('write формы claim_assessment над настоящей базой: ревизия без текста во входе', () => {
  const VERIFIER = { ...CONFIG.agents.worker!, tools: [], result: 'claim_assessment' };
  const COVERAGE: Coverage = { completeness: 'complete', totalMatched: 2, totalRelation: 'eq', returned: 2, truncated: false, continuation: null };
  const ATOMS: { kind: 'number'; value: string }[] = [{ kind: 'number', value: '7' }];

  /** A run of `verifier` for `claimId` in this attempt: the row its steps write to and what the engine gives them. */
  async function verifierRun(ctx: TaskContext, investigation: { readonly resourceId: string }, claimId: string): Promise<FormRun> {
    const written = await ctx.withAttemptGuard((tx) =>
      agentRunsRepository.insert(tx, {
        taskId: ctx.taskId,
        investigationId: ctx.investigationId,
        agentName: 'verifier',
        parent: null,
        depth: 0,
        assignment: null,
        shareTokens: 70_000,
        notAfter: new Date(Date.now() + 60_000),
        sources: [],
      }),
    );
    if (written.outcome !== 'committed') throw new Error(`setup write ${written.outcome}`);
    return {
      ctx,
      form: CLAIM_ASSESSMENT_FORM,
      context: {
        investigationId: ctx.investigationId,
        resourceId: investigation.resourceId,
        runTaskId: ctx.taskId,
        agentName: 'verifier',
        definition: VERIFIER,
        assignment: claimId,
        sourceMode: 'sources',
        depth: 1,
      },
      assignment: claimId,
      snapshotEntries: [],
      guarded: async (work) => {
        const result = await ctx.withAttemptGuard(work, { requireActive: true });
        if (result.outcome !== 'committed') throw new Error(`guarded write ${result.outcome}`);
        return result.value;
      },
    };
  }

  /** An `unverified` claim over two records of `recordBytes` bytes, written by a task of its own. */
  async function storedClaim(investigationId: string, recordBytes: number) {
    return inAttempt(investigationId, async (ctx) => {
      const items = [0, 1].map((line) => ({ line, count: 7, note: 'x'.repeat(recordBytes) }));
      const evidence = pageEvidence(2);
      const page = await ctx.putEvidence({
        ...evidence,
        content: { mediaType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify({ items })) },
      });
      const claim = { text: 'seven failures', atoms: ATOMS, pointer: [{ pageId: page.evidenceId, records: [0, 1] }] };
      const written = await ctx.withAttemptGuard((tx) =>
        claimsRepository.writeTaskClaims(tx, { investigationId, taskId: ctx.taskId, coverage: COVERAGE, claims: [claim] }),
      );
      if (written.outcome !== 'committed') throw new Error(`setup write ${written.outcome}`);
      return { claimId: written.value[0]!, pointer: claim.pointer };
    });
  }

  async function revisionsOfClaim(investigationId: string, claimId: string) {
    return (await db().select().from(researchClaims).where(eq(researchClaims.investigationId, investigationId)).orderBy(asc(researchClaims.seq))).filter(
      (row) => row.claimId === claimId,
    );
  }

  it.each<[string, number, (run: FormRun) => Promise<unknown>, unknown, { answer: null; invalidForm: boolean; reason: string }]>([
    [
      'короткий вход: пролог end needs_narrowing',
      13_000,
      (run) => runPrologue(run),
      { kind: 'completed' },
      { answer: null, invalidForm: false, reason: 'needs_narrowing' },
    ],
    [
      'принудительный конец turn_limit',
      10,
      (run) => runForcedEnd(run, 'turn_limit', 2),
      { kind: 'result' },
      { answer: null, invalidForm: true, reason: 'invalid_assessment' },
    ],
  ])('%s: ревизия insufficient с текстом, атомами и coverage проверенной, основа пуста', async (_case, recordBytes, step, outcome, assessment) => {
    const investigation = await newInvestigation(newUser());
    const { claimId, pointer } = await storedClaim(investigation.investigationId, recordBytes);
    expect((await revisionsOfClaim(investigation.investigationId, claimId)).map((row) => [row.status, row.text])).toEqual([['unverified', 'seven failures']]);

    const { ended, runTaskId } = await inAttempt(investigation.investigationId, async (ctx) => ({
      ended: await step(await verifierRun(ctx, investigation, claimId)),
      runTaskId: ctx.taskId,
    }));

    expect(ended).toEqual({ ...(outcome as object), result: { claimId, status: 'insufficient', group: null } });
    const [, checked] = await revisionsOfClaim(investigation.investigationId, claimId);
    expect({ ...checked, atoms: z.array(z.object({ kind: z.string(), value: z.string() })).parse(checked!.atoms) }).toMatchObject({
      taskId: runTaskId,
      status: 'insufficient',
      text: 'seven failures',
      atoms: ATOMS,
      coverage: COVERAGE,
      pointer,
      evidenceIds: [],
      claimType: null,
      confidence: null,
      assessment,
    });
  });
});

// DC-9, DC-20; Contract `research_close`. Defects caught: the reason of the closure read from the column `reason` instead of
// `outcome.detail.reason`, so gates 3 and 4 never see the refusal; new claims written twice; a `detail` on a refusal without one.
describe('закрытие research_close над настоящей базой: строка отказа читается следующим закрытием', () => {
  const V3_CONFIG = AgentProcessConfigSchema.parse(deepResearchProcessV3);
  const ATOMS: { kind: 'number'; value: string }[] = [{ kind: 'number', value: '7' }];

  async function seedEngineRow(investigationId: string, resourceId: string): Promise<void> {
    await db().insert(researchEngineRuns).values({
      investigationId,
      resourceId,
      launchKey: `launch-${randomUUID()}`,
      processId: V3_CONFIG.processId,
      processVersion: V3_CONFIG.version,
      processConfig: deepResearchProcessV3,
      sourceMode: 'sources',
      tokenBudget: 300_000,
    });
  }

  /** The attempt's task as the root run, with what the engine gives the steps of its form. */
  async function rootRun(ctx: TaskContext, resourceId: string): Promise<FormRun> {
    const written = await ctx.withAttemptGuard((tx) =>
      agentRunsRepository.insert(tx, {
        taskId: ctx.taskId,
        investigationId: ctx.investigationId,
        agentName: 'controller',
        parent: null,
        depth: 0,
        assignment: 'find the cause',
        shareTokens: 100_000,
        notAfter: new Date(Date.now() + 60_000),
        sources: [],
      }),
    );
    if (written.outcome !== 'committed') throw new Error(`setup write ${written.outcome}`);
    return {
      ctx,
      form: RESEARCH_CLOSE_FORM,
      context: {
        investigationId: ctx.investigationId,
        resourceId,
        runTaskId: ctx.taskId,
        agentName: 'controller',
        definition: V3_CONFIG.agents.controller!,
        assignment: 'find the cause',
        sourceMode: 'sources',
        depth: 0,
      },
      assignment: 'find the cause',
      snapshotEntries: [],
      guarded: async (work) => {
        const result = await ctx.withAttemptGuard(work, { requireActive: true });
        if (result.outcome !== 'committed') throw new Error(`guarded write ${result.outcome}`);
        return result.value;
      },
    };
  }

  /** One `finish` of the root, the row and its closure through the real transition; returns the row as it ended. */
  async function closeRoot(run: FormRun, callIndex: number, result: unknown) {
    const ctx = run.ctx as TaskContext;
    const requested = await ctx.withAttemptGuard((tx) =>
      toolCallsRepository.insertRequested(tx, { investigationId: ctx.investigationId, runTaskId: ctx.taskId, turn: callIndex }, [
        { callIndex, toolName: 'finish', arguments: result },
      ]),
    );
    if (requested.outcome !== 'committed') throw new Error(`setup write ${requested.outcome}`);
    const moved = await toolCallsRepository.transition(ctx, { callId: requested.value[0]!.id, from: ['requested'] }, closureStep(run, { result }));
    if (moved.outcome !== 'written') throw new Error(`finish ${moved.outcome}`);
    return moved.call;
  }

  /** A call of the checker on `claimId` that the budget refused: an ended call with no check revision. */
  async function refusedCheckerCall(run: FormRun, callIndex: number, claimId: string): Promise<void> {
    const ctx = run.ctx as TaskContext;
    const requested = await ctx.withAttemptGuard((tx) =>
      toolCallsRepository.insertRequested(tx, { investigationId: ctx.investigationId, runTaskId: ctx.taskId, turn: callIndex }, [
        { callIndex, toolName: 'call_agent', arguments: { agent: 'verifier', assignment: claimId } },
      ]),
    );
    if (requested.outcome !== 'committed') throw new Error(`setup write ${requested.outcome}`);
    const moved = await toolCallsRepository.transition(ctx, { callId: requested.value[0]!.id, from: ['requested'] }, () =>
      Promise.resolve({ to: 'rejected', outcome: 'rejected', reason: 'budget_exhausted' }),
    );
    if (moved.outcome !== 'written') throw new Error(`call ${moved.outcome}`);
  }

  /** A finished child of the root under the call `callIndex`, of the answer agent; returns its run id. */
  function answerRun(root: FormRun, callIndex: number, draft: unknown): Promise<string> {
    return inAttempt(root.ctx.investigationId, async (ctx) => {
      const written = await ctx.withAttemptGuard(async (tx) => {
        await agentRunsRepository.insert(tx, {
          taskId: ctx.taskId,
          investigationId: ctx.investigationId,
          agentName: 'synthesis',
          parent: { taskId: root.ctx.taskId, callIndex },
          depth: 1,
          assignment: null,
          shareTokens: 10_000,
          notAfter: new Date(Date.now() + 60_000),
          sources: [],
        });
        await agentRunsRepository.writeEnding(tx, ctx.taskId, { result: draft });
      });
      if (written.outcome !== 'committed') throw new Error(`setup write ${written.outcome}`);
      return ctx.taskId;
    });
  }

  /** A claim already checked `supported`, with its pointer on a page of the investigation: a record new claims may rest on. */
  async function supportedClaim(investigationId: string) {
    const stored = await inAttempt(investigationId, async (ctx) => {
      const page = (await ctx.putEvidence(pageEvidence(PAGE_SIZE))).evidenceId;
      const claim = { text: 'seven failures', atoms: ATOMS, pointer: [{ pageId: page, records: [0, 1] }] };
      const written = await ctx.withAttemptGuard((tx) => claimsRepository.writeTaskClaims(tx, { investigationId, taskId: ctx.taskId, coverage: null, claims: [claim] }));
      if (written.outcome !== 'committed') throw new Error(`setup write ${written.outcome}`);
      return { claimId: written.value[0]!, page, pointer: claim.pointer };
    });
    await inAttempt(investigationId, async (ctx) => {
      const written = await ctx.withAttemptGuard((tx) =>
        claimsRepository.appendRevisions(tx, {
          investigationId,
          taskId: ctx.taskId,
          revisions: [
            {
              claimId: stored.claimId,
              text: 'seven failures',
              atoms: ATOMS,
              evidenceIds: [stored.page],
              coverage: null,
              status: 'supported',
              pointer: stored.pointer,
              claimType: 'count',
              assessment: { answer: null, invalidForm: false },
              confidence: 'high',
            },
          ],
        }),
      );
      if (written.outcome !== 'committed') throw new Error(`setup write ${written.outcome}`);
    });
    return stored;
  }

  /** The revisions of `research_claims` the root's task wrote. */
  async function revisionsOfTask(investigationId: string, taskId: string) {
    return (await revisionsOf(investigationId)).filter((row) => row.taskId === taskId);
  }

  const newClaim = (text: string, pointer: unknown) => ({ claimId: null, text, atoms: ATOMS, pointer });

  it('отказ needs_verification: строка несёт причину формы в исходе, следующее закрытие читает её номером вызова', async () => {
    const resourceId = newUser();
    const investigation = await newInvestigation(resourceId);
    const { investigationId } = investigation;
    await seedEngineRow(investigationId, resourceId);
    await db().insert(researchPlanRevisions).values({ investigationId, revision: 1, plan: { steps: ['one'] } });
    const { pointer } = await supportedClaim(investigationId);

    const outcome = await inAttempt(investigationId, async (ctx) => {
      const run = await rootRun(ctx, resourceId);
      expect(await toolCallsRepository.ofRun(db(), ctx.taskId)).toEqual([]);
      const draft = { outcome: 'answered', summaryClaimIds: [], claims: [newClaim('a new claim', pointer)] };
      const staleRun = await answerRun(run, 1, draft);

      // The first closure refuses and writes the new claim.
      const first = await closeRoot(run, 2, { answer: staleRun });
      const [written] = await revisionsOfTask(investigationId, ctx.taskId);
      expect([written?.text, written?.status, written?.claimIndex]).toEqual(['a new claim', 'unverified', 0]);
      const newClaimId = written!.claimId;

      // The checker's call on it ends with no revision; the draft that ended before the refusal is refused, nothing is written twice.
      await refusedCheckerCall(run, 3, newClaimId);
      const second = await closeRoot(run, 4, { answer: staleRun });
      expect(await revisionsOfTask(investigationId, ctx.taskId)).toHaveLength(1);

      const collected = await run.guarded((tx) => RESEARCH_CLOSE_FORM.closure!.collect!(run.context, createFormDataReader(tx, { investigationId, snapshotEntries: [] })));
      const refusedRow = (collected as { toolCalls: { callIndex: number; toolName: string; state: string; reason: string | null; outcome: unknown }[] }).toolCalls[0];

      // A new draft after the refusal is accepted: its new claim goes to the answer unverified, and no revision is written.
      const freshRun = await answerRun(run, 5, { outcome: 'answered', summaryClaimIds: [], claims: [{ ...newClaim('a new claim', pointer), claimId: newClaimId }, newClaim('another', pointer)] });
      const third = await closeRoot(run, 6, { answer: freshRun });

      return { first, second, third, refusedRow, newClaimId, runTaskId: ctx.taskId };
    });

    expect([outcome.first.state, outcome.first.reason]).toEqual(['rejected', 'invalid_result']);
    expect(outcome.first.outcome).toEqual({
      outcome: 'rejected',
      reason: 'invalid_result',
      detail: {
        reason: 'needs_verification',
        // DC-9: the model reads only the ids; the claims themselves are written, not shown.
        detail: { claimIds: [outcome.newClaimId] },
      },
    });
    expect(outcome.refusedRow).toMatchObject({ callIndex: 2, toolName: 'finish', state: 'rejected', reason: 'invalid_result' });
    expect(outcome.second.outcome).toEqual({ outcome: 'rejected', reason: 'invalid_result', detail: { reason: 'draft_invalid' } });
    expect(outcome.third.state).toBe('done');
    expect(await revisionsOfTask(investigationId, outcome.runTaskId)).toHaveLength(1);
    const [engine] = await db().select().from(researchEngineRuns).where(eq(researchEngineRuns.investigationId, investigationId));
    expect(engine?.answer).toMatchObject({
      outcome: 'inconclusive',
      established: [],
      assumed: [
        { claimId: outcome.newClaimId, text: 'a new claim', verified: false },
        { text: 'another', verified: false },
      ],
    });
  });

  it('отказ plan_missing без detail: исход строки ровно с причиной формы', async () => {
    const resourceId = newUser();
    const { investigationId } = await newInvestigation(resourceId);
    await seedEngineRow(investigationId, resourceId);

    const call = await inAttempt(investigationId, async (ctx) => closeRoot(await rootRun(ctx, resourceId), 0, { answer: randomUUID() }));

    expect(call.outcome).toEqual({ outcome: 'rejected', reason: 'invalid_result', detail: { reason: 'plan_missing' } });
  });
});

describe('claims_write: указатель только на записи своего расследования, всё или ничего', () => {
  it.each<[string, (pages: { readonly own: string; readonly foreign: string }) => unknown]>([
    ['страница другого расследования', ({ foreign }) => [{ pageId: foreign, records: [0] }]],
    ['неизвестная страница', () => [{ pageId: randomUUID(), records: [0] }]],
    ['id страницы — не uuid', () => [{ pageId: 'page-1', records: [0] }]],
    ['номер записи вне страницы', ({ own }) => [{ pageId: own, records: [PAGE_SIZE] }]],
    ['21 запись', ({ own }) => [{ pageId: own, records: Array.from({ length: 21 }, (_, number) => number) }]],
  ])('%s: pointer_invalid с номером утверждения, ревизий нет', async (_case, pointerOf) => {
    const foreignInvestigation = await newInvestigation(newUser());
    const foreign = (await inAttempt(foreignInvestigation.investigationId, (ctx) => ctx.putEvidence(pageEvidence(PAGE_SIZE)))).evidenceId;
    const investigation = await newInvestigation(newUser());

    const call = await inAttempt(investigation.investigationId, async (ctx) => {
      const own = (await ctx.putEvidence(pageEvidence(PAGE_SIZE))).evidenceId;
      const run = await workerRun(ctx, investigation);
      expect(await revisionsOf(ctx.investigationId)).toEqual([]);
      return callClaimsWrite(ctx, run, 0, [claimOf('the disk was full', pointerOf({ own, foreign }))]);
    });

    expect(call.state).toBe('rejected');
    expect(call.reason).toBe('pointer_invalid');
    expect(call.outcome).toEqual({ outcome: 'rejected', reason: 'pointer_invalid', detail: { invalidClaims: [0] } });
    expect(await revisionsOf(investigation.investigationId)).toEqual([]);
  });

  it('одно неверное из трёх: отказ с его порядковым номером и ни одной ревизии', async () => {
    const investigation = await newInvestigation(newUser());

    const call = await inAttempt(investigation.investigationId, async (ctx) => {
      const own = (await ctx.putEvidence(pageEvidence(PAGE_SIZE))).evidenceId;
      const run = await workerRun(ctx, investigation);
      return callClaimsWrite(ctx, run, 0, [
        claimOf('first', [{ pageId: own, records: [0] }]),
        claimOf('second', [{ pageId: own, records: [PAGE_SIZE] }]),
        claimOf('third', [{ pageId: own, records: [1] }]),
      ]);
    });

    expect(call.reason).toBe('pointer_invalid');
    expect(call.outcome).toEqual({ outcome: 'rejected', reason: 'pointer_invalid', detail: { invalidClaims: [1] } });
    expect(await revisionsOf(investigation.investigationId)).toEqual([]);
  });

  it('верный вызов: ревизии unverified задачи запуска, номера в порядке вызова', async () => {
    const investigation = await newInvestigation(newUser());

    const { call, page, runTaskId } = await inAttempt(investigation.investigationId, async (ctx) => {
      const own = (await ctx.putEvidence(pageEvidence(PAGE_SIZE))).evidenceId;
      const run = await workerRun(ctx, investigation);
      const written = await callClaimsWrite(ctx, run, 0, [
        claimOf('first', [{ pageId: own, records: [0, 24] }]),
        claimOf('second', [{ pageId: own, records: [3] }]),
      ]);
      return { call: written, page: own, runTaskId: ctx.taskId };
    });

    const revisions = await revisionsOf(investigation.investigationId);
    expect(revisions.map((row) => [row.claimIndex, row.text, row.status, row.taskId, row.evidenceIds, row.pointer])).toEqual([
      [0, 'first', 'unverified', runTaskId, [page], [{ pageId: page, records: [0, 24] }]],
      [1, 'second', 'unverified', runTaskId, [page], [{ pageId: page, records: [3] }]],
    ]);
    expect(revisions[0]!.atoms).toEqual([{ kind: 'number', value: '7' }]);
    expect(call.state).toBe('done');
    expect(call.outcome).toEqual({ outcome: 'success', result: { claimIds: revisions.map((row) => row.claimId) } });
  });

  it('второй вызов того же запуска продолжает индексы и возвращает только свои номера', async () => {
    const investigation = await newInvestigation(newUser());

    const { first, second } = await inAttempt(investigation.investigationId, async (ctx) => {
      const own = (await ctx.putEvidence(pageEvidence(PAGE_SIZE))).evidenceId;
      const run = await workerRun(ctx, investigation);
      return {
        first: await callClaimsWrite(ctx, run, 0, [
          claimOf('first', [{ pageId: own, records: [0] }]),
          claimOf('second', [{ pageId: own, records: [1] }]),
        ]),
        second: await callClaimsWrite(ctx, run, 1, [claimOf('third', [{ pageId: own, records: [2] }])]),
      };
    });

    const revisions = await revisionsOf(investigation.investigationId);
    expect(revisions.map((row) => [row.claimIndex, row.text])).toEqual([
      [0, 'first'],
      [1, 'second'],
      [2, 'third'],
    ]);
    expect(first.outcome).toEqual({ outcome: 'success', result: { claimIds: [revisions[0]!.claimId, revisions[1]!.claimId] } });
    expect(second.outcome).toEqual({ outcome: 'success', result: { claimIds: [revisions[2]!.claimId] } });
  });
});

// AC-16.1, DC-10 (the start side), KD-4, «Когда нужна новая калибровка». Defects caught: a server on v3 that starts with an
// old table or none; the key read from a lower loaded version; a memory record of another agent changing the checker's
// pair; a removed record still counted; a read failure that lets the start go on. The records live under a `processId`
// unique to the test, so no `AppModule` start on this database ever meets them.
describe('Engine.checkCalibration', () => {
  /** The fingerprint of no records, computed outside the engine: SHA-256 of `[]`, 12 hex digits. */
  const EMPTY_MEMORY = '4f53cda18c2b';
  const OTHER_PRINT = 'abcdefabcdef';
  const ADMIN = { userId: 'memory-admin', roles: ['agent-memory-admin'] };

  /** Fails any access: a check that has nothing to check must not reach the database. */
  const unreachableDatabase = new Proxy(
    {},
    {
      get(_, property) {
        throw new Error(`the database was touched (${String(property)})`);
      },
    },
  ) as Database;

  const notCalled = () => Promise.reject(new Error('not part of the calibration check'));
  const modelDouble = (modelId: string): RoleModel => ({
    specificationVersion: 'v2',
    provider: 'test',
    modelId,
    supportedUrls: {},
    doGenerate: notCalled,
    doStream: notCalled,
  });
  const anyTool: { argsSchema: SourceSchema } = { argsSchema: z.strictObject({ from: z.string(), to: z.string() }) };
  const SOURCES = {
    resolveTool: () => ({ adapter: {}, tool: anyTool }) as ReturnType<SourceRegistry['resolveTool']>,
    describeSource: () => 'not part of the calibration check',
    currentSnapshot: notCalled,
  };

  /** The shipped v3, and the same data as a lower version 2, of a `processId` no other test or server start uses. */
  function processes() {
    const processId = `check-calibration-${randomUUID()}`;
    return {
      processId,
      lowerVersion: { ...(deepResearchProcessV3 as object), processId, version: 2 },
      agentsForm: { ...(deepResearchProcessV3 as object), processId },
    };
  }

  function engineOver(database: Database, loaded: readonly unknown[], groupTables: readonly unknown[]): Engine {
    return createEngine({
      database,
      runtime: {
        scheduler: runtime.scheduler,
        investigations: runtime.investigations,
        handlers: { register: () => undefined },
        eventConsumers: { register: () => undefined },
      },
      sourceRegistry: SOURCES,
      connectedSources: ['fixture'],
      toolAccessPolicy: ALLOW_ALL_ACCESS,
      processes: loaded,
      groupTables,
      resolveModel: modelDouble,
      tokenCounter: { countTurnInputTokens: notCalled },
      clock: systemClock,
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined },
    });
  }

  const checkerPrint = (config: unknown): string => claimAssessmentAgent(config)!.agentFingerprint;

  const tableOf = (agentFingerprint: string, definitionMemoryFingerprint: string) => ({
    model: 'anthropic/claude-haiku-5-5',
    agentFingerprint,
    definitionMemoryFingerprint,
    scenarioSet: 'check-calibration',
    pairsFingerprint: 'ba9876543210',
    calibratedAt: '2026-11-09T00:00:00.000Z',
    groupCount: 3,
    profiles: [],
    groups: [],
    pairKinds: [],
  });

  const refusalOf = (engine: Engine): Promise<unknown> => engine.checkCalibration().then(() => undefined, (error: unknown) => error);

  it.each<[string, (agentPrint: string) => readonly unknown[]]>([
    ['no table', () => []],
    ['a table of the same agent with other memory', (agentPrint) => [tableOf(agentPrint, OTHER_PRINT)]],
    ['a table of the same memory with another agent', () => [tableOf(OTHER_PRINT, EMPTY_MEMORY)]],
  ])('%s for the pair of the highest loaded version → calibration_missing with the process, the version and both fingerprints', async (_, tables) => {
    const { processId, lowerVersion, agentsForm } = processes();
    const agentPrint = checkerPrint(agentsForm);

    const refusal = await refusalOf(engineOver(db(), [lowerVersion, agentsForm], tables(agentPrint)));

    expect(refusal).toMatchObject({
      code: 'calibration_missing',
      processId,
      version: 3,
      agentFingerprint: agentPrint,
      definitionMemoryFingerprint: EMPTY_MEMORY,
    });
    expect((refusal as Error).message).toBe(
      `no group table for process ${processId} version 3: agent fingerprint ${agentPrint}, ` +
        `definition memory fingerprint ${EMPTY_MEMORY}; build one with the calibrate command`,
    );
  });

  it('passes with the table of the pair', async () => {
    const { agentsForm } = processes();

    await expect(engineOver(db(), [agentsForm], [tableOf(checkerPrint(agentsForm), EMPTY_MEMORY)]).checkCalibration()).resolves.toBeUndefined();
  });

  it('a deployment record of the checker changes the pair, one of another agent does not, and removing it restores the pair', async () => {
    const { processId, agentsForm } = processes();
    const agentPrint = checkerPrint(agentsForm);
    const engine = engineOver(db(), [agentsForm], [tableOf(agentPrint, EMPTY_MEMORY)]);
    const write = async (agentName: string, text: string): Promise<string> => {
      const written = await engine.writeDefinitionMemory({ processId, agentName, scope: { kind: 'deployment' }, text, writer: ADMIN });
      if (written.outcome !== 'written') throw new Error(`setup write refused: ${written.reason}`);
      return written.id;
    };

    await write('worker', 'a note for the worker');
    await expect(engine.checkCalibration()).resolves.toBeUndefined();

    const text = 'a note for the checker';
    const id = await write('verifier', text);
    const changedMemory = definitionMemoryFingerprint([{ id, scope: 'deployment', text }]);
    expect(changedMemory).not.toBe(EMPTY_MEMORY);
    await expect(refusalOf(engine)).resolves.toMatchObject({
      code: 'calibration_missing',
      processId,
      version: 3,
      agentFingerprint: agentPrint,
      definitionMemoryFingerprint: changedMemory,
    });
    await expect(engineOver(db(), [agentsForm], [tableOf(agentPrint, changedMemory)]).checkCalibration()).resolves.toBeUndefined();

    await expect(engine.removeDefinitionMemory({ id, remover: ADMIN })).resolves.toEqual({ outcome: 'removed' });
    await expect(engine.checkCalibration()).resolves.toBeUndefined();
  });

  it('a failed read of the memory rejects, so the start stops', async () => {
    const { agentsForm } = processes();

    await expect(engineOver(unreachableDatabase, [agentsForm], []).checkCalibration()).rejects.toThrow('the database was touched');
  });
});
