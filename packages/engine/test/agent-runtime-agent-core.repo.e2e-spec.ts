// agent-runtime / agent-core — repository rules over the real Postgres (design-agent-core.md, KD-2, KD-3, Data Model).
// Each `describe` is one rule with its cases as rows. These are storage-level checks, not scenarios: they spend no INT or
// E2E budget (plan, Common Processing Points). A plain `vitest run` has no database, so they live in this e2e file.
//
// Assembly: the real `createRuntime` over the test database with one test handler of a workflow type unique to this
// file. The handler runs the body a test hands it inside a real attempt, so every guarded write goes through the real
// `TaskContext.withAttemptGuard`. Nothing of Postgres, the runtime or the engine is mocked; the thread-ownership port is
// a double, as in every harness. Isolation: a unique `resourceId` per test, no truncate.

import { randomUUID } from 'node:crypto';
import type { EvidenceInput } from '@agent-os/contracts';
import {
  agentDefinitionMemory,
  agentToolAudit,
  createDatabase,
  type DatabaseConnection,
  researchAgentMemory,
  researchAgentMessages,
  researchAgentRuns,
  researchAgentToolCalls,
  researchClaims,
  researchEngineRuns,
  researchLlmCalls,
  researchLlmTranscripts,
  researchPlanRevisions,
  researchTasks,
} from '@agent-os/db';
import {
  createRuntime,
  parseRuntimeConfig,
  type Runtime,
  type RuntimeTx,
  systemClock,
  type TaskContext,
  type ThreadOwnership,
} from '@agent-os/runtime';
import { asc, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { readAgentTree } from '../src/agents/agent-tree.js';
import { agentRunsRepository } from '../src/agents/agent-runs.repository.js';
import { CHILD_RESULT_CUT_MARK, childCallEnding } from '../src/agents/child-failure.js';
import {
  createDefinitionMemory,
  DEFAULT_MEMORY_ADMIN_ROLE,
  type DefinitionMemoryScope,
  type MemoryActor,
  takeDefinitionMemorySnapshot,
  type WriteDefinitionMemoryInput,
} from '../src/agents/definition-memory.js';
import { investigationMemoryRepository } from '../src/agents/investigation-memory.repository.js';
import { closureStep } from '../src/agents/process-code.js';
import { createResultFormRegistry, type ResultForm, TEXT_FORM } from '../src/agents/result-forms.js';
import { sessionRepository } from '../src/agents/session.repository.js';
import { CONFIGURATION_ACCESS_POLICY } from '../src/agents/tool-access-policy.js';
import { type CallStep, toolCallsRepository, type TransitionResult } from '../src/agents/tool-calls.repository.js';
import { baseImmediateTools, createToolExecutor, POSTGRES_AGENT_TREE } from '../src/agents/tool-executor.js';
import { BASE_TOOLS, createToolRegistry } from '../src/agents/tool-registry.js';
import { type AgentProcessConfig, AgentProcessConfigSchema } from '../src/config/agent-config.schema.js';
import { createProcessSet } from '../src/config/process-set.js';
import { runOccupiedTokens } from '../src/model/ledger.js';
import { purgeExpiredTranscripts } from '../src/transcripts/purge-transcripts.js';
import { readTranscripts } from '../src/transcripts/read-transcripts.js';
import { databaseUrl } from './support/database-url.js';
import { newUser } from './support/new-user.js';

/** A workflow type only this file registers: no other assembly ever claims its tasks. */
const WORKFLOW = `test-agent-repo-${randomUUID()}`;
/** How long a test waits for its body to run inside an attempt before it fails with a reason. */
const BODY_TIMEOUT_MS = 20_000;

type Body = (ctx: TaskContext) => Promise<unknown>;

interface Pending {
  readonly body: Body;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

const pending = new Map<string, Pending>();
const owners = new Map<string, string>();
/** The thread of each investigation the file created. */
const threadOf = new Map<string, string>();
let connection: DatabaseConnection;
let runtime: Runtime;

const threads: ThreadOwnership = {
  async withOwnedThread(threadId, resourceId, fn) {
    if (owners.get(threadId) !== resourceId) throw new Error(`Thread ${threadId} of ${resourceId} not found`);
    return fn();
  },
};

const db = () => connection.db;

/** An `active` investigation of `resourceId` in a thread of its own. */
async function newInvestigation(resourceId: string): Promise<string> {
  const threadId = `thread-${randomUUID()}`;
  owners.set(threadId, resourceId);
  const investigation = await runtime.investigations.create({
    resourceId,
    threadId,
    query: 'repository rules',
    budget: { maxTasks: 60, maxToolCalls: 60 },
  });
  threadOf.set(investigation.investigationId, threadId);
  return investigation.investigationId;
}

/**
 * Proposes a task of {@link WORKFLOW} in the investigation and runs `body` inside its attempt; resolves with what `body`
 * returned. The task completes after the body, whatever it returned.
 */
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

/** The run row every agent table hangs off: the attempt's own task as a root run. */
function rootRun(ctx: TaskContext, agentName = 'lead') {
  return {
    taskId: ctx.taskId,
    investigationId: ctx.investigationId,
    agentName,
    parent: null,
    depth: 0,
    assignment: 'find the cause',
    shareTokens: 100_000,
    notAfter: new Date(Date.now() + 60_000),
    sources: [],
  };
}

/** A root run of the attempt with one `requested` call of `toolName`; returns the call's id. */
async function requestedCall(ctx: TaskContext, toolName: string, args: unknown): Promise<string> {
  const written = await ctx.withAttemptGuard(async (tx) => {
    await agentRunsRepository.insert(tx, rootRun(ctx));
    const [call] = await toolCallsRepository.insertRequested(
      tx,
      { investigationId: ctx.investigationId, runTaskId: ctx.taskId, turn: 0 },
      [{ callIndex: 0, toolName, arguments: args }],
    );
    return call!.id;
  });
  if (written.outcome !== 'committed') throw new Error(`setup write ${written.outcome}`);
  return written.value;
}

async function auditRowsOf(resourceId: string) {
  return db().select().from(agentToolAudit).where(eq(agentToolAudit.resourceId, resourceId));
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

afterAll(async () => {
  await runtime?.stop();
  await connection?.close();
});

// KD-3, invariants 1, 3, 4, 12, AC-10.2 (the audit row), ADR-0006 (no write after a stop): the outcome of a call, its
// result message and exactly one audit row — without the arguments — commit in one guarded transaction, or none of
// them does. Defects caught: an audit row without an outcome or an outcome without one; a write after the
// investigation was stopped or by a lost attempt; a second audit row for a repeated transition; the arguments in the
// audit row; a `write` effect that outlives its failed outcome.
describe('вызов инструмента с исходом пишет ровно одну строку аудита без аргументов той же транзакцией', () => {
  const SUCCESS: CallStep = { to: 'done', outcome: 'success', result: { noteSeq: 7 } };

  it.each<[string, (ctx: TaskContext) => Promise<void>, TransitionResult['outcome']]>([
    ['an active attempt writes the outcome, the message and one audit row', async () => undefined, 'written'],
    [
      // The closure of ADR-0006 asks the running attempt to stop without aborting it, so its next guarded write meets
      // the closed investigation; a cancel would also abort the attempt and fence it.
      'a closed investigation (stopping) writes none of them',
      async (ctx) => db().transaction((tx) => runtime.investigations.closeInTx(tx, ctx.investigationId, 'completed')),
      'stopping',
    ],
    [
      'a lost attempt (fenced) writes none of them',
      async (ctx) => {
        await db()
          .update(researchTasks)
          .set({ attempt: sql`${researchTasks.attempt} + 1` })
          .where(eq(researchTasks.taskId, ctx.taskId));
      },
      'fenced',
    ],
  ])('%s', async (_case, before, expected) => {
    const resourceId = newUser();
    const investigationId = await newInvestigation(resourceId);

    const { outcome, callId } = await inAttempt(investigationId, async (ctx) => {
      const id = await requestedCall(ctx, 'memory_write', { kind: 'note', text: 'secret argument', refs: [] });
      await before(ctx);
      const result = await toolCallsRepository.transition(ctx, { callId: id, from: ['requested'] }, async () => SUCCESS);
      // Give the attempt back its number, so the runtime can end the task this test took over.
      if (expected === 'fenced') {
        await db()
          .update(researchTasks)
          .set({ attempt: sql`${researchTasks.attempt} - 1` })
          .where(eq(researchTasks.taskId, ctx.taskId));
      }
      return { outcome: result.outcome, callId: id };
    });

    expect(outcome).toBe(expected);
    const [call] = await db().select().from(researchAgentToolCalls).where(eq(researchAgentToolCalls.id, callId));
    const audit = await auditRowsOf(resourceId);
    const messages = await db()
      .select()
      .from(researchAgentMessages)
      .where(eq(researchAgentMessages.toolCallId, callId));
    if (expected === 'written') {
      expect(call).toMatchObject({ state: 'done', outcome: { outcome: 'success', result: { noteSeq: 7 } } });
      // Fix cycle 1 (D2): a call that starts and ends in one write has its start time too.
      expect(call!.startedAt).not.toBeNull();
      expect(audit).toHaveLength(1);
      expect(call!.auditId).toBe(audit[0]!.id);
      expect(Object.keys(audit[0]!).sort()).toEqual(['id', 'outcome', 'recordedAt', 'resourceId', 'sourceId', 'toolName']);
      expect(audit[0]).toMatchObject({ resourceId, toolName: 'memory_write', sourceId: null, outcome: 'success' });
      expect(JSON.stringify(audit[0])).not.toContain('secret argument');
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ kind: 'tool_result', seq: 0 });
    } else {
      expect(call).toMatchObject({ state: 'requested', outcome: null, auditId: null });
      expect(audit).toHaveLength(0);
      expect(messages).toHaveLength(0);
    }
  });

  it('a repeated transition of a call with an outcome writes nothing; a failing effect leaves no outcome and no audit', async () => {
    const resourceId = newUser();
    const investigationId = await newInvestigation(resourceId);

    const observed = await inAttempt(investigationId, async (ctx) => {
      const first = await requestedCall(ctx, 'memory_write', { kind: 'note', text: 'n', refs: [] });
      await toolCallsRepository.transition(ctx, { callId: first, from: ['requested'] }, async () => SUCCESS);
      const repeated = await toolCallsRepository.transition(ctx, { callId: first, from: ['requested'] }, async () => SUCCESS);

      const second = await ctx.withAttemptGuard(async (tx) => {
        const [call] = await toolCallsRepository.insertRequested(
          tx,
          { investigationId: ctx.investigationId, runTaskId: ctx.taskId, turn: 1 },
          [{ callIndex: 1, toolName: 'memory_write', arguments: { kind: 'note', text: 'm', refs: [] } }],
        );
        return call!.id;
      });
      if (second.outcome !== 'committed') throw new Error('setup');
      const failing = await toolCallsRepository
        .transition(ctx, { callId: second.value, from: ['requested'] }, async (tx: RuntimeTx) => {
          await tx.insert(researchAgentMemory).values({
            investigationId: ctx.investigationId,
            kind: 'note',
            text: 'written by the effect',
            runTaskId: ctx.taskId,
            agentName: 'lead',
          });
          throw new Error('effect failed after its write');
        })
        .then(
          () => 'resolved',
          () => 'thrown',
        );
      return { repeated: repeated.outcome, failing, secondId: second.value, firstId: first };
    });

    expect(observed).toMatchObject({ repeated: 'not_in_state', failing: 'thrown' });
    expect(await auditRowsOf(resourceId)).toHaveLength(1);
    const [second] = await db()
      .select()
      .from(researchAgentToolCalls)
      .where(eq(researchAgentToolCalls.id, observed.secondId));
    expect(second).toMatchObject({ state: 'requested', auditId: null });
    expect(
      await db().select().from(researchAgentMemory).where(eq(researchAgentMemory.investigationId, investigationId)),
    ).toHaveLength(0);
    const session = await sessionRepository.read(db(), (await agentRunsRepository.ofInvestigation(db(), investigationId))[0]!.taskId);
    expect(session.map((message) => [message.seq, message.toolCallId])).toEqual([[0, observed.firstId]]);
  });
});

// AC-03.3, FR-03: notes are only added and numbered by the database sequence. Defect caught: «the largest number plus
// one» — two notes written at the same moment get one number, or one of them is lost. Twenty rounds of two attempts
// writing at once; a scenario cannot force the collision (plan, Risks), so the rule is proven here and INT-2 only wires it.
describe('две одновременные записи заметки сохраняются обе с разными номерами', () => {
  it('twenty rounds of two concurrent notes keep both, with distinct numbers', async () => {
    const investigationId = await newInvestigation(newUser());
    for (let round = 0; round < 20; round += 1) {
      let arrived = 0;
      let release: () => void = () => undefined;
      const together = new Promise<void>((resolve) => {
        release = resolve;
      });
      const writeNote = (agentName: string) =>
        inAttempt(investigationId, async (ctx) => {
          await ctx.withAttemptGuard((tx) => agentRunsRepository.insert(tx, rootRun(ctx, agentName)));
          arrived += 1;
          if (arrived === 2) release();
          await together;
          const written = await ctx.withAttemptGuard((tx) =>
            investigationMemoryRepository.append(tx, {
              investigationId: ctx.investigationId,
              runTaskId: ctx.taskId,
              agentName,
              kind: 'finding',
              text: `round ${round} by ${agentName}`,
              refs: [],
            }),
          );
          if (written.outcome !== 'committed') throw new Error(`note write ${written.outcome}`);
          return written.value;
        });

      const numbers = await Promise.all([writeNote('lead'), writeNote('helper')]);

      expect(new Set(numbers).size).toBe(2);
    }
    const notes = await investigationMemoryRepository.read(db(), investigationId, {}, 100);
    expect(notes).toHaveLength(40);
    expect(new Set(notes.map((note) => note.seq)).size).toBe(40);
  });
});

/** A definition memory module over one agents-form configuration of a process unique to the test. */
function definitionMemoryFixture() {
  const processId = `probe-${randomUUID()}`;
  const limits = {
    maxTurns: 4,
    maxCallsPerTurn: 2,
    maxChildren: 0,
    runTokens: 300_000,
    deadlineMs: 600_000,
    windowTokens: 200_000,
    marginTokens: 1_000,
    maxOutputTokens: 2_000,
  };
  const definition = { model: 'anthropic/claude-haiku-5-5', effort: 'low', prompt: 'Answer {{query}}.', tools: [], limits };
  const config: AgentProcessConfig = AgentProcessConfigSchema.parse({
    processId,
    version: 1,
    goal: 'Probe the definition memory',
    sources: [],
    agents: { lead: { ...definition, result: 'text' }, checker: { ...definition, result: 'probe_check' } },
    rootAgent: 'lead',
    agentLimits: { maxDepth: 1 },
    limits: { investigationTokens: { default: 300_000, max: 600_000 }, maxTasks: 5, maxToolCalls: 5 },
    answer: { sections: ['summary'] },
  });
  /** A form that forbids the `user` scope, as the verifier's form does (DC-24). */
  const checkForm: ResultForm = {
    name: 'probe_check',
    version: 1,
    resultSchema: z.strictObject({ ok: z.boolean() }),
    userMemoryForbidden: true,
  };
  const forms = createResultFormRegistry([TEXT_FORM, checkForm]);
  const processes = createProcessSet([config]);
  if (!processes.ok) throw new Error('process set');
  const memory = createDefinitionMemory({
    database: db(),
    processes: processes.set,
    forms,
    adminRole: DEFAULT_MEMORY_ADMIN_ROLE,
  });
  return { processId, config, forms, memory };
}

/** Every row of the process's definition memory, removed ones included. */
function definitionRowsOf(processId: string) {
  return db()
    .select()
    .from(agentDefinitionMemory)
    .where(eq(agentDefinitionMemory.processId, processId))
    .orderBy(asc(agentDefinitionMemory.writtenAt), asc(agentDefinitionMemory.id));
}

const ADMIN = (userId: string): MemoryActor => ({ userId, roles: [DEFAULT_MEMORY_ADMIN_ROLE] });
const PLAIN = (userId: string): MemoryActor => ({ userId, roles: [] });

type WriteRow = (users: { readonly owner: string; readonly other: string }) => Omit<WriteDefinitionMemoryInput, 'processId'>;

// FR-22, AC-22.1–AC-22.3, DC-15, DC-24 (the write), UC-10, UC-E12: the scope `deployment` is written by the admin role
// only, a `user` scope by its user only; the active texts of one scope stay within 8 KiB; a `user` record of a definition
// whose form forbids it is refused; a refusal changes nothing. Defects caught: a write without the right accepted; the
// 8 KiB limit counted per record, over all scopes, with removed records or off by one; `user` memory let into the
// verifier-like form; an unknown definition written.
describe('запись памяти определения по правам и пределам', () => {
  it.each<[string, string, WriteRow]>([
    [
      'deployment without the admin role',
      'no_write_right',
      ({ owner }) => ({ agentName: 'lead', scope: { kind: 'deployment' }, text: 'rule', writer: PLAIN(owner) }),
    ],
    [
      'the user scope of another user',
      'no_write_right',
      ({ owner, other }) => ({ agentName: 'lead', scope: { kind: 'user', userId: other }, text: 'note', writer: ADMIN(owner) }),
    ],
    // Fix cycle 1 (security): an actor or a `user` scope without a user id gets no right, the admin role included.
    [
      'deployment by an admin without a user id',
      'no_write_right',
      () => ({ agentName: 'lead', scope: { kind: 'deployment' }, text: 'rule', writer: ADMIN('') }),
    ],
    [
      'a user scope without a user id, by a writer without one',
      'no_write_right',
      () => ({ agentName: 'lead', scope: { kind: 'user', userId: '' }, text: 'note', writer: PLAIN('') }),
    ],
    [
      'the user scope of a definition whose form forbids it',
      'scope_not_allowed',
      ({ owner }) => ({ agentName: 'checker', scope: { kind: 'user', userId: owner }, text: 'note', writer: PLAIN(owner) }),
    ],
    [
      'an agent the process does not define',
      'unknown_definition',
      ({ owner }) => ({ agentName: 'ghost', scope: { kind: 'deployment' }, text: 'rule', writer: ADMIN(owner) }),
    ],
    [
      'a deployment record that takes the scope one byte past 8 KiB',
      'limit_reached',
      ({ owner }) => ({ agentName: 'lead', scope: { kind: 'deployment' }, text: 'x'.repeat(193), writer: ADMIN(owner) }),
    ],
    [
      'a deployment record that fills the scope to exactly 8 KiB',
      'written',
      ({ owner }) => ({ agentName: 'lead', scope: { kind: 'deployment' }, text: 'x'.repeat(192), writer: ADMIN(owner) }),
    ],
    [
      'an own user record next to a full deployment scope',
      'written',
      ({ owner }) => ({ agentName: 'lead', scope: { kind: 'user', userId: owner }, text: 'x'.repeat(2_000), writer: PLAIN(owner) }),
    ],
  ])('%s → %s', async (_case, expected, row) => {
    const { processId, memory } = definitionMemoryFixture();
    const owner = newUser();
    const other = newUser();
    // 8000 bytes of active deployment rules, and a removed record that no longer counts.
    for (let index = 0; index < 4; index += 1) {
      const written = await memory.write({
        processId,
        agentName: 'lead',
        scope: { kind: 'deployment' },
        text: String(index).repeat(2_000),
        writer: ADMIN(owner),
      });
      if (written.outcome !== 'written') throw new Error('setup');
    }
    const removable = await memory.write({
      processId,
      agentName: 'lead',
      scope: { kind: 'deployment' },
      text: 'y'.repeat(150),
      writer: ADMIN(owner),
    });
    if (removable.outcome === 'written') await memory.remove({ id: removable.id, remover: ADMIN(owner) });
    const before = await definitionRowsOf(processId);

    const result = await memory.write({ processId, ...row({ owner, other }) });

    const after = await definitionRowsOf(processId);
    if (expected === 'written') {
      expect(result.outcome).toBe('written');
      expect(after).toHaveLength(before.length + 1);
    } else {
      expect(result).toEqual({ outcome: 'refused', reason: expected });
      expect(after).toEqual(before);
    }
  });

  it('removal by the right holder only, once; the list shows each reader the scopes it may read', async () => {
    const { processId, memory } = definitionMemoryFixture();
    const owner = newUser();
    const other = newUser();
    const rule = await memory.write({ processId, agentName: 'lead', scope: { kind: 'deployment' }, text: 'rule', writer: ADMIN(owner) });
    const own = await memory.write({
      processId,
      agentName: 'lead',
      scope: { kind: 'user', userId: owner },
      text: 'mine',
      writer: PLAIN(owner),
    });
    if (rule.outcome !== 'written' || own.outcome !== 'written') throw new Error('setup');
    const texts = (records: readonly { readonly text: string }[]) => records.map((record) => record.text);

    const outcomes = [
      await memory.remove({ id: rule.id, remover: ADMIN('') }),
      texts(await memory.list({ processId, agentName: 'lead', reader: ADMIN('') })),
      await memory.remove({ id: rule.id, remover: PLAIN(owner) }),
      await memory.remove({ id: own.id, remover: ADMIN(other) }),
      texts(await memory.list({ processId, agentName: 'lead', reader: PLAIN(owner) })),
      texts(await memory.list({ processId, agentName: 'lead', reader: ADMIN(other) })),
      await memory.remove({ id: own.id, remover: PLAIN(owner) }),
      await memory.remove({ id: own.id, remover: PLAIN(owner) }),
      await memory.remove({ id: randomUUID(), remover: ADMIN(owner) }),
    ];

    expect(outcomes).toEqual([
      { outcome: 'refused', reason: 'no_write_right' },
      [],
      { outcome: 'refused', reason: 'no_write_right' },
      { outcome: 'refused', reason: 'no_write_right' },
      ['mine'],
      ['rule'],
      { outcome: 'removed' },
      { outcome: 'refused', reason: 'not_found' },
      { outcome: 'refused', reason: 'not_found' },
    ]);
  });
});

// UC-9, UC-E12 (the snapshot), AC-22.4–AC-22.6, DC-24, invariant 11: the start copies, for each definition, the active
// `deployment` records and the owner's `user` records — no other user's, and none of the `user` scope for a definition
// whose form forbids it, even one written while it had another form. A record removed after the start stays in the
// snapshot; deleting the investigation leaves the definition memory as it was. Defects caught: another user's record in
// the snapshot; a forbidden-form `user` record let in; the snapshot read live instead of copied; the definition memory
// deleted with the investigation.
describe('снимок при старте', () => {
  it('copies the deployment and owner records, keeps a record removed later, and outlives the investigation', async () => {
    const { processId, config, forms, memory } = definitionMemoryFixture();
    const owner = newUser();
    const other = newUser();
    const write = async (agentName: string, scope: DefinitionMemoryScope, text: string) => {
      const writer = scope.kind === 'deployment' ? ADMIN(owner) : PLAIN(scope.userId);
      const written = await memory.write({ processId, agentName, scope, text, writer });
      if (written.outcome !== 'written') throw new Error(`setup ${text}`);
      return written.id;
    };
    const leadRule = await write('lead', { kind: 'deployment' }, 'lead rule');
    const ownerNote = await write('lead', { kind: 'user', userId: owner }, 'owner note');
    await write('lead', { kind: 'user', userId: other }, 'other note');
    const checkerRule = await write('checker', { kind: 'deployment' }, 'checker rule');
    // A `user` record of the checker written while its form allowed it: stored, but never in a snapshot (DC-24).
    await db().insert(agentDefinitionMemory).values({
      id: randomUUID(),
      processId,
      agentName: 'checker',
      scope: 'user',
      userId: owner,
      text: 'checker owner note',
      writtenBy: owner,
    });
    const investigationId = await newInvestigation(owner);

    const snapshot = await takeDefinitionMemorySnapshot(db(), { config, forms, resourceId: owner });
    await db().insert(researchEngineRuns).values({
      investigationId,
      resourceId: owner,
      launchKey: `launch-${randomUUID()}`,
      processId,
      processVersion: 1,
      processConfig: config,
      sourceMode: 'model_knowledge',
      tokenBudget: 300_000,
      definitionMemorySnapshot: snapshot,
    });
    await memory.remove({ id: ownerNote, remover: PLAIN(owner) });
    const [stored] = await db()
      .select({ snapshot: researchEngineRuns.definitionMemorySnapshot })
      .from(researchEngineRuns)
      .where(eq(researchEngineRuns.investigationId, investigationId));
    const memoryBeforeDelete = await definitionRowsOf(processId);
    await runtime.investigations.purgeThread({ threadId: threadOf.get(investigationId)!, resourceId: owner });

    expect(stored?.snapshot).toEqual({
      lead: [
        { id: leadRule, scope: 'deployment', text: 'lead rule' },
        { id: ownerNote, scope: 'user', text: 'owner note' },
      ],
      checker: [{ id: checkerRule, scope: 'deployment', text: 'checker rule' }],
    });
    expect(
      await db().select().from(researchEngineRuns).where(eq(researchEngineRuns.investigationId, investigationId)),
    ).toHaveLength(0);
    expect(memoryBeforeDelete).toHaveLength(5);
    expect(await definitionRowsOf(processId)).toEqual(memoryBeforeDelete);
  });
});

/** Evidence of one page with `items`, as a `source.fetch` page is stored. */
function pageEvidence(evidenceKey: string, items: readonly unknown[]): EvidenceInput {
  return {
    evidenceKey,
    provenance: { sourceId: 'fixture', toolName: 'search_logs', normalizedArgs: { key: evidenceKey }, snapshot: 'snapshot-1' },
    coverage: { completeness: 'complete', totalMatched: items.length, totalRelation: 'eq', returned: items.length, truncated: false, continuation: null },
    content: { mediaType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify({ items })) },
  };
}

/** One page and one claim of the attempt's investigation; the claim's latest revision is `supported`. */
async function seedData(ctx: TaskContext): Promise<{ readonly page: string; readonly claimId: string }> {
  const { evidenceId } = await ctx.putEvidence(pageEvidence(`page-${randomUUID()}`, [{ line: 'disk full' }, { line: 'restart' }]));
  const claimId = randomUUID();
  const written = await ctx.withAttemptGuard(async (tx) => {
    await tx.insert(researchClaims).values(
      (['unverified', 'supported'] as const).map((status, claimIndex) => ({
        claimRevisionId: randomUUID(),
        investigationId: ctx.investigationId,
        claimId,
        taskId: ctx.taskId,
        claimIndex,
        text: 'the disk was full',
        atoms: [],
        status,
        confidence: status === 'supported' ? 'high' : null,
      })),
    );
  });
  if (written.outcome !== 'committed') throw new Error('seed');
  return { page: evidenceId, claimId };
}

// AC-04.1, AC-04.2, AC-03.2, DC-4, UC-3, UC-E9: the tools read and reference only the data of their own investigation —
// `investigation_read` shows this investigation's claim with its latest status and none of another's; a page of another
// investigation is `not_found` with no record; a note referencing another investigation's claim is `foreign_ref` and is
// not written, while one referencing its own claim and page is. Defects caught: a data leak across investigations; a
// note with a foreign reference written.
describe('данные и память читаются только своего расследования', () => {
  it('own claim with its latest status; a foreign page not_found; a foreign reference foreign_ref, no note', async () => {
    const foreignInvestigation = await newInvestigation(newUser());
    const foreign = await inAttempt(foreignInvestigation, seedData);
    const owner = newUser();
    const investigationId = await newInvestigation(owner);
    const registry = createToolRegistry(BASE_TOOLS);
    const executor = createToolExecutor({
      registry,
      tools: baseImmediateTools(registry),
      accessPolicy: CONFIGURATION_ACCESS_POLICY,
      calls: toolCallsRepository,
      tree: POSTGRES_AGENT_TREE,
      scheduler: runtime.scheduler,
      investigations: runtime.investigations,
      clock: systemClock,
      timings: { deadlineMarginMs: 90_000, leaseMs: 30_000 },
    });
    const { config } = definitionMemoryFixture();
    const definition = { ...config.agents.lead!, tools: ['memory_write', 'investigation_read'], limits: { ...config.agents.lead!.limits, maxCallsPerTurn: 5 } };

    const observed = await inAttempt(investigationId, async (ctx) => {
      const own = await seedData(ctx);
      const turn = [
        { toolName: 'investigation_read', arguments: { view: 'claims' } },
        { toolName: 'investigation_read', arguments: { view: 'records', page: foreign.page } },
        { toolName: 'memory_write', arguments: { kind: 'finding', text: 'leak', refs: [{ type: 'claim', id: foreign.claimId }] } },
        { toolName: 'memory_write', arguments: { kind: 'finding', text: 'own', refs: [{ type: 'claim', id: own.claimId }, { type: 'record', id: own.page }] } },
        { toolName: 'investigation_read', arguments: { view: 'records', page: own.page, from: 1 } },
      ];
      const requested = await ctx.withAttemptGuard(async (tx) => {
        await agentRunsRepository.insert(tx, rootRun(ctx));
        return toolCallsRepository.insertRequested(
          tx,
          { investigationId: ctx.investigationId, runTaskId: ctx.taskId, turn: 0 },
          turn.map((call, callIndex) => ({ callIndex, ...call })),
        );
      });
      if (requested.outcome !== 'committed') throw new Error('setup');
      const executed = await executor.executeTurn(
        ctx,
        {
          runTaskId: ctx.taskId,
          investigationId: ctx.investigationId,
          resourceId: owner,
          threadId: threadOf.get(investigationId)!,
          agentName: 'lead',
          definition,
          config,
          resultSchema: TEXT_FORM.resultSchema,
          depth: 0,
          shareTokens: 100_000,
          sources: [],
          notAfter: new Date(Date.now() + 60_000),
        },
        requested.value,
      );
      return { executed, own };
    });

    expect(observed.executed).toEqual({ outcome: 'executed', finish: null, waitFor: [] });
    const calls = await toolCallsRepository.ofRun(db(), (await agentRunsRepository.ofInvestigation(db(), investigationId))[0]!.taskId);
    expect(calls.map((call) => [call.state, call.reason])).toEqual([
      ['done', null],
      ['rejected', 'not_found'],
      ['rejected', 'foreign_ref'],
      ['done', null],
      ['done', null],
    ]);
    expect(calls[0]!.outcome).toEqual({
      outcome: 'success',
      result: {
        view: 'claims',
        items: [{ claimId: observed.own.claimId, text: 'the disk was full', status: 'supported', confidence: 'high' }],
        next: null,
      },
    });
    expect(calls[1]!.outcome).toEqual({ outcome: 'rejected', reason: 'not_found' });
    expect(calls[4]!.outcome).toEqual({
      outcome: 'success',
      result: { view: 'records', page: observed.own.page, items: [{ number: 1, record: { line: 'restart' } }], next: null },
    });
    const notes = await investigationMemoryRepository.read(db(), investigationId, {}, 10);
    expect(notes.map((note) => note.text)).toEqual(['own']);
    expect(await auditRowsOf(owner)).toHaveLength(5);
  });
});

/** A tool executor over the real tables, as the handler builds it. */
function realExecutor() {
  const registry = createToolRegistry(BASE_TOOLS);
  return createToolExecutor({
    registry,
    tools: baseImmediateTools(registry),
    accessPolicy: CONFIGURATION_ACCESS_POLICY,
    calls: toolCallsRepository,
    tree: POSTGRES_AGENT_TREE,
    scheduler: runtime.scheduler,
    investigations: runtime.investigations,
    clock: systemClock,
    timings: { deadlineMarginMs: 90_000, leaseMs: 30_000 },
  });
}

/** The data a reference may point to, in one investigation: a page, a claim, a note and the attempt's own run. */
interface RefTargets {
  readonly page: string;
  readonly claimId: string;
  readonly noteSeq: number;
  readonly runTaskId: string;
}

/** Seeds a page, a claim, the attempt's root run and one note of it; returns their ids. */
async function seedRefTargets(ctx: TaskContext): Promise<RefTargets> {
  const data = await seedData(ctx);
  const written = await ctx.withAttemptGuard(async (tx) => {
    await agentRunsRepository.insert(tx, rootRun(ctx));
    return investigationMemoryRepository.append(tx, {
      investigationId: ctx.investigationId,
      runTaskId: ctx.taskId,
      agentName: 'lead',
      kind: 'note',
      text: 'a lead',
      refs: [],
    });
  });
  if (written.outcome !== 'committed') throw new Error('seed');
  return { ...data, noteSeq: written.value, runTaskId: ctx.taskId };
}

type TextRef = { readonly type: 'note' | 'claim' | 'record' | 'run'; readonly id: string };

// Fix cycle 1 (D1, security), DC-4, design-agent-core.md «Базовые инструменты» (`finish`, form `text`): the references
// of a `text` result lead only to notes, claims, records and runs of the run's own investigation; one of another
// investigation, or one that leads nowhere, refuses the result `invalid_result` with the reason `foreign_ref` in the
// guarded write of `finish`, and the run's result stays unwritten. Defect caught: a result that points the reader of
// the answer at another investigation's data accepted.
describe('результат finish ссылается только на своё расследование', () => {
  let foreign: RefTargets;

  beforeAll(async () => {
    foreign = await inAttempt(await newInvestigation(newUser()), seedRefTargets);
  }, BODY_TIMEOUT_MS);

  it.each<[string, (own: RefTargets, other: RefTargets) => readonly TextRef[], 'accepted' | 'foreign_ref']>([
    [
      'own note, claim, record and run: accepted',
      (own) => [
        { type: 'note', id: String(own.noteSeq) },
        { type: 'claim', id: own.claimId },
        { type: 'record', id: own.page },
        { type: 'run', id: own.runTaskId },
      ],
      'accepted',
    ],
    ['a claim of another investigation: foreign_ref', (own, other) => [{ type: 'claim', id: own.claimId }, { type: 'claim', id: other.claimId }], 'foreign_ref'],
    ['a record of another investigation: foreign_ref', (_own, other) => [{ type: 'record', id: other.page }], 'foreign_ref'],
    ['a note of another investigation: foreign_ref', (_own, other) => [{ type: 'note', id: String(other.noteSeq) }], 'foreign_ref'],
    ['a run of another investigation: foreign_ref', (_own, other) => [{ type: 'run', id: other.runTaskId }], 'foreign_ref'],
    ['a note number that leads nowhere: foreign_ref', () => [{ type: 'note', id: '999999999999' }], 'foreign_ref'],
    ['a note id that is not a number: foreign_ref', () => [{ type: 'note', id: 'first' }], 'foreign_ref'],
  ])('%s', async (_case, refsOf, expected) => {
    const owner = newUser();
    const investigationId = await newInvestigation(owner);
    const { config } = definitionMemoryFixture();

    const { callId, runTaskId, result } = await inAttempt(investigationId, async (ctx) => {
      const own = await seedRefTargets(ctx);
      const finishResult = { summary: 'the disk was full', refs: refsOf(own, foreign) };
      const requested = await ctx.withAttemptGuard((tx) =>
        toolCallsRepository.insertRequested(tx, { investigationId, runTaskId: ctx.taskId, turn: 1 }, [
          { callIndex: 0, toolName: 'finish', arguments: finishResult },
        ]),
      );
      if (requested.outcome !== 'committed') throw new Error('setup');
      const call = requested.value[0]!;
      const run = {
        ctx,
        form: TEXT_FORM,
        context: {
          investigationId,
          resourceId: owner,
          runTaskId: ctx.taskId,
          agentName: 'lead',
          definition: config.agents.lead!,
          assignment: 'find the cause',
          sourceMode: 'model_knowledge' as const,
        },
        assignment: 'find the cause',
        snapshotEntries: [],
        guarded: async <T,>(work: (tx: RuntimeTx) => Promise<T>): Promise<T> => {
          const guarded = await ctx.withAttemptGuard(work, { requireActive: true });
          if (guarded.outcome !== 'committed') throw new Error(`guarded ${guarded.outcome}`);
          return guarded.value;
        },
      };
      await toolCallsRepository.transition(ctx, { callId: call.id, from: ['requested'] }, closureStep(run, { result: finishResult }));
      return { callId: call.id, runTaskId: ctx.taskId, result: finishResult };
    });

    const [call] = await db().select().from(researchAgentToolCalls).where(eq(researchAgentToolCalls.id, callId));
    const run = await agentRunsRepository.read(db(), runTaskId);
    if (expected === 'accepted') {
      expect(call).toMatchObject({ state: 'done', outcome: { outcome: 'success', result } });
      expect(run?.result).toEqual(result);
    } else {
      expect(call).toMatchObject({
        state: 'rejected',
        reason: 'invalid_result',
        outcome: { outcome: 'rejected', reason: 'invalid_result', detail: { reason: 'foreign_ref' } },
      });
      expect(run?.result).toBeNull();
    }
  });
});

// Fix cycle 1 (D5), FR-04, design-agent-core.md «Реестр инструментов» (a result is at most 16 KiB): `investigation_read`
// never ends over its limit and never stands still — an item over half the limit is listed by its position and size,
// so the cursor moves on, and a plan over the limit comes cut with a mark. Defects caught: the `runs` view returning
// an empty page with the same cursor forever behind one long result; a plan written whole over the limit.
describe('investigation_read не застревает на большом элементе', () => {
  it('lists an oversize run result by its index and size and goes on; cuts an oversize plan with a mark', async () => {
    const owner = newUser();
    const investigationId = await newInvestigation(owner);
    const { config } = definitionMemoryFixture();
    const definition = { ...config.agents.lead!, tools: ['investigation_read'] };
    const longResult = { summary: 'x'.repeat(20_000), refs: [] };
    const shortResult = { summary: 'short', refs: [] };
    const longPlan = { steps: [...Array(400).keys()].map((step) => ({ step, goal: `check the log of node ${step}` })) };
    const LIMIT = 16 * 1_024;

    const observed = await inAttempt(investigationId, async (ctx) => {
      const helperTaskId = await idleRunTask(investigationId, { agentName: 'helper', parent: { taskId: ctx.taskId, callIndex: 0 } });
      const requested = await ctx.withAttemptGuard(async (tx) => {
        await agentRunsRepository.insert(tx, rootRun(ctx));
        await agentRunsRepository.writeEnding(tx, ctx.taskId, { result: longResult });
        await agentRunsRepository.insert(tx, {
          ...rootRun(ctx, 'helper'),
          taskId: helperTaskId,
          parent: { taskId: ctx.taskId, callIndex: 0 },
          depth: 1,
        });
        await agentRunsRepository.writeEnding(tx, helperTaskId, { result: shortResult });
        await tx.insert(researchPlanRevisions).values({ investigationId, revision: 1, plan: longPlan });
        return toolCallsRepository.insertRequested(tx, { investigationId, runTaskId: ctx.taskId, turn: 1 }, [
          { callIndex: 0, toolName: 'investigation_read', arguments: { view: 'runs' } },
          { callIndex: 1, toolName: 'investigation_read', arguments: { view: 'plan' } },
        ]);
      });
      if (requested.outcome !== 'committed') throw new Error('setup');
      await realExecutor().executeTurn(
        ctx,
        {
          runTaskId: ctx.taskId,
          investigationId,
          resourceId: owner,
          threadId: threadOf.get(investigationId)!,
          agentName: 'lead',
          definition,
          config,
          resultSchema: TEXT_FORM.resultSchema,
          depth: 0,
          shareTokens: 100_000,
          sources: [],
          notAfter: new Date(Date.now() + 60_000),
        },
        requested.value,
      );
      const [runsCall, planCall] = await toolCallsRepository.ofRun(db(), ctx.taskId);
      return { runs: runsCall!.outcome, plan: planCall!.outcome, rootTaskId: ctx.taskId, helperTaskId };
    });

    const bytesOf = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
    // Both runs are written in one transaction, so they share `created_at` and the page orders them by task id.
    const rootFirst = observed.rootTaskId < observed.helperTaskId;
    const omittedRoot = { index: rootFirst ? 0 : 1, omitted: true, bytes: bytesOf({ run: observed.rootTaskId, agent: 'lead', result: longResult }) };
    const helper = { run: observed.helperTaskId, agent: 'helper', result: shortResult };
    expect(observed.runs).toEqual({
      outcome: 'success',
      result: { view: 'runs', items: rootFirst ? [omittedRoot, helper] : [helper, omittedRoot], next: null },
    });
    const planResult = (observed.plan as { result: Record<string, unknown> }).result;
    expect(planResult).toMatchObject({ view: 'plan', revision: 1, truncated: true, bytes: bytesOf(longPlan) });
    // The plan as stored (jsonb orders its keys): the mark carries a prefix of its JSON text.
    const [stored] = await db().select({ plan: researchPlanRevisions.plan }).from(researchPlanRevisions).where(eq(researchPlanRevisions.investigationId, investigationId));
    expect(JSON.stringify(stored!.plan).startsWith(planResult['planText'] as string)).toBe(true);
    expect((planResult['planText'] as string).length).toBeGreaterThan(0);
    expect(bytesOf(planResult)).toBeLessThanOrEqual(LIMIT);
  });

  // Fix cycle 2 (M1): a run's result over the limit — listed by the `runs` page as omitted, cut in the parent's session —
  // is read whole in pieces: `run` names it, `from` is the byte offset in its JSON text and each piece gives the next.
  // Defect caught: a child result larger than the page limit that no call can read in full.
  it('reads one run result of any size in pieces by run and byte offset', async () => {
    const owner = newUser();
    const investigationId = await newInvestigation(owner);
    const { config } = definitionMemoryFixture();
    const definition = { ...config.agents.lead!, tools: ['investigation_read'] };
    // 20 000 two-byte characters: some 40 KB of JSON text, three pieces at the 16 KiB limit.
    const longResult = { summary: 'ж'.repeat(20_000), refs: [] };
    const LIMIT = 16 * 1_024;

    const observed = await inAttempt(investigationId, async (ctx) => {
      const written = await ctx.withAttemptGuard(async (tx) => {
        await agentRunsRepository.insert(tx, rootRun(ctx));
        await agentRunsRepository.writeEnding(tx, ctx.taskId, { result: longResult });
      });
      if (written.outcome !== 'committed') throw new Error('setup');
      const pieces: Record<string, unknown>[] = [];
      let from: number | null = 0;
      for (let turn = 1; from !== null && turn <= 10; turn += 1) {
        const requested = await ctx.withAttemptGuard((tx) =>
          toolCallsRepository.insertRequested(tx, { investigationId, runTaskId: ctx.taskId, turn }, [
            { callIndex: turn - 1, toolName: 'investigation_read', arguments: { view: 'runs', run: ctx.taskId, from } },
          ]),
        );
        if (requested.outcome !== 'committed') throw new Error('setup');
        await realExecutor().executeTurn(
          ctx,
          {
            runTaskId: ctx.taskId,
            investigationId,
            resourceId: owner,
            threadId: threadOf.get(investigationId)!,
            agentName: 'lead',
            definition,
            config,
            resultSchema: TEXT_FORM.resultSchema,
            depth: 0,
            shareTokens: 100_000,
            sources: [],
            notAfter: new Date(Date.now() + 60_000),
          },
          requested.value,
        );
        const call = (await toolCallsRepository.ofRun(db(), ctx.taskId)).find((row) => row.turn === turn);
        const piece = (call!.outcome as { outcome: string; result: Record<string, unknown> }).result;
        pieces.push(piece);
        from = piece['next'] as number | null;
      }
      return { pieces, rootTaskId: ctx.taskId };
    });

    // The result as stored (jsonb orders its keys): the pieces joined are its JSON text, byte for byte.
    const [stored] = await db().select({ result: researchAgentRuns.result }).from(researchAgentRuns).where(eq(researchAgentRuns.taskId, observed.rootTaskId));
    const text = JSON.stringify(stored!.result);
    const bytes = Buffer.byteLength(text, 'utf8');
    expect(observed.pieces.length).toBeGreaterThanOrEqual(3);
    expect(observed.pieces.at(-1)!['next']).toBeNull();
    let offset = 0;
    for (const piece of observed.pieces) {
      expect(piece).toMatchObject({ view: 'runs', run: observed.rootTaskId, from: offset, bytes });
      expect(Buffer.byteLength(JSON.stringify(piece), 'utf8')).toBeLessThanOrEqual(LIMIT);
      offset += Buffer.byteLength(piece['chunk'] as string, 'utf8');
    }
    const joined = observed.pieces.map((piece) => piece['chunk'] as string).join('');
    expect(joined).toBe(text);
    expect(JSON.parse(joined)).toEqual(longResult);
  });
});

/** What the seed of an agent investigation wrote: its run, the ledger row and transcript of its turn. */
interface SeededTurn {
  readonly runTaskId: string;
  readonly callIds: readonly string[];
}

/**
 * An agents-form investigation of `owner` with its engine row and one root run of `lead`: its assignment, `turns`
 * answered turns — each with its ledger row and the transcript that references the view — one requested call and one
 * note of the investigation's memory.
 */
async function seedAgentInvestigation(owner: string, turns = 1): Promise<{ readonly investigationId: string } & SeededTurn> {
  const { config } = definitionMemoryFixture();
  const investigationId = await newInvestigation(owner);
  await db()
    .insert(researchEngineRuns)
    .values({
      investigationId,
      resourceId: owner,
      launchKey: `launch-${randomUUID()}`,
      processId: config.processId,
      processVersion: 1,
      processConfig: config,
      sourceMode: 'model_knowledge',
      tokenBudget: 300_000,
      definitionMemorySnapshot: { lead: [], checker: [] },
    });
  const seeded = await inAttempt(investigationId, async (ctx): Promise<SeededTurn> => {
    const written = await ctx.withAttemptGuard(async (tx) => {
      await agentRunsRepository.insert(tx, rootRun(ctx));
      const owned = { runTaskId: ctx.taskId, investigationId };
      await sessionRepository.append(tx, owned, [{ kind: 'assignment', content: { text: 'find the cause' } }]);
      const callIds: string[] = [];
      for (let turn = 1; turn <= turns; turn += 1) {
        const callId = randomUUID();
        callIds.push(callId);
        await tx.insert(researchLlmCalls).values({
          callId,
          investigationId,
          taskId: ctx.taskId,
          attempt: ctx.attempt,
          role: 'agent',
          model: 'anthropic/claude-haiku-5-5',
          reservedTokens: 3_000,
          countedInputTokens: 1_000,
        });
        await tx.insert(researchLlmTranscripts).values({
          callId,
          llmCallId: callId,
          investigationId,
          taskId: ctx.taskId,
          attempt: ctx.attempt,
          role: 'agent',
          model: 'anthropic/claude-haiku-5-5',
          promptVersion: '0123456789ab',
          input: { instructions: 'You look for the cause.', view: { throughSeq: 0, stubbedCalls: [], collapsedTurns: [], stage: 0 } },
        });
        const args = { kind: 'note', text: `turn ${turn}`, refs: [] };
        await sessionRepository.append(tx, owned, [
          {
            kind: 'model_answer',
            content: { turn, text: '', toolCalls: [{ toolCallId: `tc-${turn}`, toolName: 'memory_write', args, callIndex: turn - 1 }] },
            llmCallId: callId,
          },
        ]);
        await toolCallsRepository.insertRequested(tx, { investigationId, runTaskId: ctx.taskId, turn }, [
          { callIndex: turn - 1, toolName: 'memory_write', arguments: args },
        ]);
      }
      await tx.insert(researchAgentMemory).values({ investigationId, kind: 'note', text: 'a lead', runTaskId: ctx.taskId, agentName: 'lead' });
      return { runTaskId: ctx.taskId, callIds };
    });
    if (written.outcome !== 'committed') throw new Error(`seed ${written.outcome}`);
    return written.value;
  });
  return { investigationId, ...seeded };
}

/** Rows of the agent tables of an investigation: sessions, calls and notes. */
async function agentRowsOf(investigationId: string) {
  const count = async (table: typeof researchAgentMessages | typeof researchAgentToolCalls | typeof researchAgentMemory) =>
    (await db().select({ investigationId: table.investigationId }).from(table).where(eq(table.investigationId, investigationId))).length;
  return {
    messages: await count(researchAgentMessages),
    calls: await count(researchAgentToolCalls),
    notes: await count(researchAgentMemory),
  };
}

// UC-N1, DC-11, NFR-01, AC-03.4: an investigation's agent tree, transcripts and memory are read by its owner only —
// another owner gets `investigation_not_found`, and the definition memory list gives no one another user's scope; once
// the conversation is deleted, its sessions, calls and notes are gone for everyone.
// Defects caught: a tree or transcript read across owners; another user's `user` records listed; agent rows that
// outlive the deletion of their conversation.
describe('чужое расследование не читается', () => {
  it('the tree, the transcripts and the memory of A are not read as B, and after the deletion not at all', async () => {
    const owner = newUser();
    const stranger = newUser();
    const seeded = await seedAgentInvestigation(owner);
    const { investigationId } = seeded;
    const { processId, memory } = definitionMemoryFixture();
    const written = await memory.write({ processId, agentName: 'lead', scope: { kind: 'user', userId: owner }, text: 'mine', writer: PLAIN(owner) });
    if (written.outcome !== 'written') throw new Error('setup memory');

    const ownTree = await readAgentTree(db(), { investigationId, resourceId: owner });
    const ownTranscripts = await readTranscripts(db(), { investigationId, ownerId: owner, retention: 'no_term' });
    const asStranger = [
      await readAgentTree(db(), { investigationId, resourceId: stranger }),
      await readTranscripts(db(), { investigationId, ownerId: stranger, retention: 'no_term' }),
    ];
    const strangerList = await memory.list({ processId, agentName: 'lead', reader: PLAIN(stranger) });
    const ownerList = await memory.list({ processId, agentName: 'lead', reader: PLAIN(owner) });
    await runtime.investigations.purgeThread({ threadId: threadOf.get(investigationId)!, resourceId: owner });

    expect(ownTree.outcome === 'found' ? ownTree.tree.runs.map((run) => [run.agentName, run.turns.length, run.toolCalls.length]) : ownTree).toEqual([
      ['lead', 1, 1],
    ]);
    expect(ownTranscripts.outcome === 'found' ? ownTranscripts.transcripts.map((t) => [t.agentName, t.input]) : ownTranscripts).toEqual([
      ['lead', { instructions: 'You look for the cause.', messages: [{ role: 'user', content: 'find the cause' }] }],
    ]);
    expect(asStranger).toEqual([
      { outcome: 'rejected', code: 'investigation_not_found' },
      { outcome: 'rejected', code: 'investigation_not_found' },
    ]);
    expect(strangerList).toEqual([]);
    expect(ownerList.map((record) => record.text)).toEqual(['mine']);
    expect(await readAgentTree(db(), { investigationId, resourceId: owner })).toEqual({ outcome: 'rejected', code: 'investigation_not_found' });
    expect(await agentRowsOf(investigationId)).toEqual({ messages: 0, calls: 0, notes: 0 });
  });

  // KD-2, «Чистка сессий»: the session of a run of a closed investigation goes only once the newest transcript of its
  // turns is past the term. Defect caught: a session purged with its oldest transcript, so a transcript still read has
  // no session to rebuild its input from.
  it('сессия чистится не раньше своего самого нового транскрипта', async () => {
    const seeded = await seedAgentInvestigation(newUser(), 2);
    const [older, newer] = seeded.callIds;
    await db().transaction((tx) => runtime.investigations.closeInTx(tx, seeded.investigationId, 'completed'));
    const age = (callId: string | undefined, days: number) =>
      db()
        .update(researchLlmTranscripts)
        .set({ createdAt: sql`now() - make_interval(days => ${days})` })
        .where(eq(researchLlmTranscripts.callId, callId!));
    const keptOwner = newUser();

    await age(older, 10);
    await age(newer, 1);
    await purgeExpiredTranscripts(db(), { days: 3 }, keptOwner);
    const whileNewerKept = await agentRowsOf(seeded.investigationId);
    await age(newer, 5);
    await purgeExpiredTranscripts(db(), { days: 3 }, keptOwner);

    expect(whileNewerKept.messages).toBe(3);
    expect((await agentRowsOf(seeded.investigationId)).messages).toBe(0);
    expect(
      await db().select().from(researchLlmTranscripts).where(eq(researchLlmTranscripts.investigationId, seeded.investigationId)),
    ).toEqual([]);
  });
});

/**
 * Writes a `queued` task of a workflow no assembly registers, so it stays as written until the test moves its status;
 * returns its id. Its input is an agent run's (`agentName`, `parent`), which is all the share rule reads of it.
 */
async function idleRunTask(investigationId: string, input: { agentName: string; parent: { taskId: string; callIndex: number } }) {
  const taskId = randomUUID();
  await db()
    .insert(researchTasks)
    .values({
      taskId,
      investigationId,
      workflowType: `${WORKFLOW}-idle`,
      workflowVersion: 1,
      input,
      inputRefs: [],
      expectedOutput: { description: `the result of agent ${input.agentName}`, completeness: 'all' },
      dedupKey: `v1:${taskId}`,
      maxToolCalls: 1,
      maxRetries: 0,
      deadlineMs: 120_000,
      maxTokens: 100_000,
    });
  return taskId;
}

// KD-4, DC-9, invariant 6 (INT-4 B3 at the storage level): a run holds a child's whole share while any task of the
// child's subtree works, and the subtree's actual spend once none does — also when a descendant's `call_agent` has its
// task proposed but its id not yet written (`starting`): that task is found by its input's parent (run and call number).
// Defect caught: a grandchild whose id was never written left out of the subtree, so the share returns to the parent
// while the grandchild works and the grandchild's spend is not counted.
describe('доля дочернего держится, пока работает его поддерево', () => {
  it('a grandchild proposed by a call still starting keeps the share held, and its spend counts once it ends', async () => {
    const investigationId = await newInvestigation(newUser());
    const setTaskStatus = (taskId: string, status: 'failed' | 'succeeded') =>
      db().update(researchTasks).set({ status, finishedAt: sql`now()` }).where(eq(researchTasks.taskId, taskId));
    const settled = (taskId: string, chargedTokens: number) => ({
      callId: randomUUID(),
      investigationId,
      taskId,
      attempt: 1,
      role: 'agent',
      model: 'anthropic/claude-haiku-5-5',
      status: 'settled',
      reservedTokens: 33_000,
      countedInputTokens: 1_000,
      chargedTokens,
      closedAt: new Date(),
    });

    const occupied = await inAttempt(investigationId, async (ctx) => {
      // Given: lead's call 0 waits for helper with a share of 150 000; helper's call 0 proposed leaf and was lost before
      // writing leaf's id; helper spent 2 000 and has ended `failed`, leaf spent 4 000 and is still queued
      const helperTaskId = await idleRunTask(investigationId, { agentName: 'helper', parent: { taskId: ctx.taskId, callIndex: 0 } });
      const leafTaskId = await idleRunTask(investigationId, { agentName: 'leaf', parent: { taskId: helperTaskId, callIndex: 0 } });
      const callAgent = (runTaskId: string, agent: string) => ({
        id: randomUUID(),
        investigationId,
        runTaskId,
        turn: 1,
        callIndex: 0,
        toolName: 'call_agent',
        arguments: { agent, assignment: `call ${agent}` },
      });
      const written = await ctx.withAttemptGuard(async (tx) => {
        await agentRunsRepository.insert(tx, rootRun(ctx));
        await agentRunsRepository.insert(tx, {
          ...rootRun(ctx, 'helper'),
          taskId: helperTaskId,
          parent: { taskId: ctx.taskId, callIndex: 0 },
          depth: 1,
          shareTokens: 150_000,
        });
        await tx.insert(researchAgentToolCalls).values([
          { ...callAgent(ctx.taskId, 'helper'), state: 'waiting', childTaskId: helperTaskId, shareTokens: 150_000 },
          { ...callAgent(helperTaskId, 'leaf'), state: 'starting', shareTokens: 60_000 },
        ]);
        await tx.insert(researchLlmCalls).values([settled(helperTaskId, 2_000), settled(leafTaskId, 4_000)]);
      });
      if (written.outcome !== 'committed') throw new Error(`setup write ${written.outcome}`);
      await setTaskStatus(helperTaskId, 'failed');
      const read = async () => {
        const guarded = await ctx.withAttemptGuard((tx) => runOccupiedTokens(tx, ctx.taskId));
        if (guarded.outcome !== 'committed') throw new Error(`read ${guarded.outcome}`);
        return guarded.value;
      };

      // When: lead's occupied tokens are read while leaf works, and again once leaf has ended
      const whileLeafWorks = await read();
      await setTaskStatus(leafTaskId, 'succeeded');
      return [whileLeafWorks, await read()];
    });

    // Then: the whole share while leaf works; the spend of helper and leaf after
    expect(occupied).toEqual([150_000, 6_000]);
  });

  // Fix cycle 1 (D4, D6), KD-4, «Реестр инструментов»: the call that waited for a child records, when it ends, the
  // spend of the child's subtree by the same ledger walk as the share, and gets the child's long result cut to the
  // `call_agent` limit with the mark naming `investigation_read`. Defects caught: `spent_tokens` left empty on
  // `waiting` → `done`; a child's long result written whole into the parent's session.
  it('a waiting call ends with its subtree spend and the child result cut to the limit', async () => {
    const investigationId = await newInvestigation(newUser());
    const longResult = { summary: 'y'.repeat(20_000), refs: [] };
    const LIMIT = 16 * 1_024;
    const settled = (taskId: string, chargedTokens: number) => ({
      callId: randomUUID(),
      investigationId,
      taskId,
      attempt: 1,
      role: 'agent',
      model: 'anthropic/claude-haiku-5-5',
      status: 'settled',
      reservedTokens: 33_000,
      countedInputTokens: 1_000,
      chargedTokens,
      closedAt: new Date(),
    });
    const callAgent = (runTaskId: string, agent: string, childTaskId: string, shareTokens: number) => ({
      id: randomUUID(),
      investigationId,
      runTaskId,
      turn: 1,
      callIndex: 0,
      toolName: 'call_agent',
      arguments: { agent, assignment: `call ${agent}` },
      state: 'waiting',
      childTaskId,
      shareTokens,
    });

    const { callId, helperTaskId } = await inAttempt(investigationId, async (ctx) => {
      // Given: lead's call waits for helper (share 150 000), helper's call for leaf; helper spent 2 000 and leaf
      // 4 000, both have ended, and helper's result is over the `call_agent` limit
      const helperTaskId = await idleRunTask(investigationId, { agentName: 'helper', parent: { taskId: ctx.taskId, callIndex: 0 } });
      const leafTaskId = await idleRunTask(investigationId, { agentName: 'leaf', parent: { taskId: helperTaskId, callIndex: 0 } });
      const leadCall = callAgent(ctx.taskId, 'helper', helperTaskId, 150_000);
      const written = await ctx.withAttemptGuard(async (tx) => {
        await agentRunsRepository.insert(tx, rootRun(ctx));
        await agentRunsRepository.insert(tx, {
          ...rootRun(ctx, 'helper'),
          taskId: helperTaskId,
          parent: { taskId: ctx.taskId, callIndex: 0 },
          depth: 1,
          shareTokens: 150_000,
        });
        await agentRunsRepository.writeEnding(tx, helperTaskId, { result: longResult });
        await tx.insert(researchAgentToolCalls).values([leadCall, callAgent(helperTaskId, 'leaf', leafTaskId, 60_000)]);
        await tx.insert(researchLlmCalls).values([settled(helperTaskId, 2_000), settled(leafTaskId, 4_000)]);
      });
      if (written.outcome !== 'committed') throw new Error(`setup write ${written.outcome}`);
      for (const taskId of [leafTaskId, helperTaskId]) {
        await db().update(researchTasks).set({ status: 'succeeded', finishedAt: sql`now()` }).where(eq(researchTasks.taskId, taskId));
      }

      // When: lead's call ends with helper's result
      const ended = await toolCallsRepository.transition(ctx, { callId: leadCall.id, from: ['waiting'] }, (tx, call) =>
        childCallEnding(tx, call, { taskId: helperTaskId, status: 'succeeded', failure: null }, LIMIT),
      );
      if (ended.outcome !== 'written') throw new Error(`transition ${ended.outcome}`);
      return { callId: leadCall.id, helperTaskId };
    });

    // Then: the subtree's spend on the call, and the result cut to the limit with the mark
    const [call] = await db().select().from(researchAgentToolCalls).where(eq(researchAgentToolCalls.id, callId));
    expect(call).toMatchObject({ state: 'done', spentTokens: 6_000 });
    expect(call!.outcome).toMatchObject({ outcome: 'success', result: { cut: true, run: helperTaskId, mark: CHILD_RESULT_CUT_MARK } });
    expect(Buffer.byteLength(JSON.stringify((call!.outcome as { result: unknown }).result), 'utf8')).toBeLessThanOrEqual(LIMIT);
  });
});
