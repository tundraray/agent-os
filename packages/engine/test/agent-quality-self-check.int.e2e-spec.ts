// agent-quality / self-check Integration Test Skeletons (engine side) - Design Doc: docs/features/agent-quality/design-self-check.md (approved 2026-11-06)
// PRD: docs/features/agent-quality/prd.md (FR-01; NFR-01). ADRs: ADR-0003 (Drizzle data layer: the transcript table lives in the `app` schema model), ADR-0005 (ProcessConfig stays data). UXRD: none (part without UI).
// Generated: 2026-11-06 | Part: self-check | Test type: Integration (in-process runtime + engine + real Postgres, scripted model), CI job `e2e-engine`
// Implementation timing: created alongside the slice each test names (the transcript write in ModelGateway, the read/purge functions and the cascade).
//
// File name and placement. This follows the sibling `deep-research-engine.int.e2e-spec.ts` in this package: `test/**/*.e2e-spec.ts`, picked up by `vitest.config.e2e.ts` (fileParallelism false, migrations applied once by
// `test/support/migrate.global-setup.ts`), run with `pnpm --filter @agent-os/engine test:e2e`. Every transcript write is part of the guarded transaction of `research_llm_calls` (KD-1), so there is no in-memory form of these tests.
// The other half of the part (the self-check program in apps/api) is in apps/api/test/agent-quality-self-check.int.e2e-spec.ts and agent-quality-self-check.e2e-spec.ts.
//
// A case whose slice has not landed yet is `it.todo`, so the file loads under lint, typecheck and `vitest run` and reports the todo count. Implement each todo following its Given/When/Then comments when its slice lands.
// Do not convert a todo into a passing stub.
//
// Environment (Design Doc "Test Strategy"):
// - Postgres 16 from infra/docker-compose.yml. Real `createRuntime` and `createEngine` with their handlers, real `ModelGateway`, real `readTranscripts` / `readRunRecord` / `purgeExpiredTranscripts`. No mock of Postgres or of an engine component.
// - Model boundary only: the scripted language-model double of test/support/scriptedModel.ts behind `resolveModel`, keyed by role; it can answer off-schema once and throw a provider error once. No real Anthropic call, no key.
// - Isolation (project convention, no truncate): a unique `resourceId` and `launchKey` per test (test/support/new-user.ts); the file runs with `fileParallelism: false`.
// - Time: no sleeps. The age of a transcript is set by the harness moving `created_at` back (the way the lease is moved in INT-4 Z1 of the engine file); the retention term is a parameter of the read and purge functions.
// - Support to add with the slice (not created here): extend test/support/engineHarness.ts with `readTranscriptsOf(investigationId, ownerId)` and an `ageTranscripts(investigationId, days)` helper; extend test/support/engineDb.ts with a read-only snapshot of
//   `research_llm_transcripts` next to the `research_llm_calls` snapshot.
//
// Budget (whole part, both files): Integration 5 (limit 3; up to 5 under the integration-e2e-testing rule only when each extra test names the defect no other test catches) and E2E 1 of 2.
//   INT-1 and INT-2 (this file) and INT-3 (api file) are the core budget. INT-4 and INT-5 (api file) are the two extras; their unique defects are stated at their headers. Table-driven rows keep the ACs of one rule or one flow in one test.
//
// AC -> proving test (the plan reads this to avoid a second test for an AC already proven):
// - AC-01.1 (a transcript per attempt, retries included), DC-1: INT-1 T1
// - AC-01.6 (prompt version stable per role and configuration, changes with any template edit), DC-2: INT-1 T2 (wiring); the fingerprint rule is unit
// - AC-01.2 (reads filter by owner), NFR-01: INT-2 T1
// - AC-01.3 (a transcript does not outlive its investigation): INT-2 T2 (and INT-5 R3 for copies in the self-check database)
// - AC-01.4 (30 days by default, not read after the term, purged within the hour), DC-4: INT-2 T3 (read filter and purge); the 30-day default and the hourly timer are unit
// - AC-01.5 (scenario runs kept without a term): INT-2 T4
// - DC-3 (a judge call leaves a transcript with role `judge`): INT-3 R1 in the api file (it runs through the real `Engine.assess`)

import { createHash } from 'node:crypto';
import { researchLlmTranscripts } from '@agent-os/db';
import {
  deepResearchProcessV2,
  type InvestigationView,
  purgeExpiredTranscripts,
  readRunRecord,
  readTranscripts,
  type TokenCountRequest,
  type TranscriptRetention,
} from '@agent-os/engine';
import { inArray } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { closeEngineDb, engineRowsOf, llmTranscriptsOf, tasksOf } from './support/engineDb.js';
import { createEngineHarness, type EngineHarness, type HarnessTranscript } from './support/engineHarness.js';
import { newLaunchKey, newUser } from './support/new-user.js';
import { assessment, type RecordedModelCall, type ScriptedRole, workerPagesOf } from './support/scriptedModel.js';

type RolePrompts = Readonly<Record<ScriptedRole, { readonly prompt: string }>>;

/** The shipped deep-research configuration, read for its role prompt templates. */
const shipped = deepResearchProcessV2 as { readonly roles: RolePrompts };

/** T2: the shipped configuration with one word of the worker prompt template changed, nothing else. */
const WORKER_EDIT_PROCESS = 'worker-prompt-edit';
const editedWorkerPrompt = shipped.roles.worker.prompt.replace('You analyse log records', 'You examine log records');
const workerEditConfig = {
  ...(deepResearchProcessV2 as Readonly<Record<string, unknown>>),
  processId: WORKER_EDIT_PROCESS,
  roles: { ...shipped.roles, worker: { ...shipped.roles.worker, prompt: editedWorkerPrompt } },
};

const ROLES: readonly ScriptedRole[] = ['plan', 'controller', 'worker', 'verifier', 'synthesis'];

/** KD-2 restated independently of the engine: the first 12 hexadecimal characters of SHA-256 of the template. */
function fingerprint(template: string): string {
  return createHash('sha256').update(template, 'utf8').digest('hex').slice(0, 12);
}

/** A worker count: the output schema of the `worker` role is the one with `claims`. */
function isWorkerRequest(request: TokenCountRequest): boolean {
  const properties = (request.outputSchema as { properties?: Record<string, unknown> }).properties ?? {};
  return 'claims' in properties;
}

/** A gate a test opens once; waiting on an open gate goes on at once. */
function latch() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open: () => open() };
}

/** The input of a transcript as the gateway wrote it: the instructions and the user text of its messages. */
function sentInput(transcript: HarnessTranscript): [instructions: string, user: string] {
  const input = transcript.input as { instructions: string; messages: { role: string; content: string }[] };
  const user = input.messages.filter((message) => message.role === 'user').map((message) => message.content);
  return [input.instructions, user.join('\n')];
}

describe('agent-quality / self-check - engine integration (in-process runtime + engine + real Postgres, scripted model)', () => {
  describe('INT-1', () => {
    const ANALYZE = 'research.analyze';
    let harness: EngineHarness;

    beforeAll(async () => {
      // A lease is lost only when the test moves it back: no heartbeat beats within a test, the sweeper runs every 50 ms.
      harness = await createEngineHarness({
        processes: [deepResearchProcessV2, workerEditConfig],
        runtime: { concurrency: 4, dbPoolMax: 10, leaseMs: 60_000, heartbeatMs: 60_000, reaperMs: 50 },
      });
    });

    afterAll(async () => {
      await harness?.close();
      await closeEngineDb();
    });

    beforeEach(() => {
      harness.model.reset();
      harness.countingSource.calls.length = 0;
      harness.countingSource.answerWith((call) => [{ service: call.args.service, level: 'error', message: 'lock wait timeout' }]);
    });

    afterEach(async () => {
      try {
        // A step left in the script means the test scripted a call that never happened.
        expect(harness.model.pending()).toEqual({ plan: 0, controller: 0, worker: 0, verifier: 0, synthesis: 0 });
      } finally {
        harness.tokenCounter.intercept = undefined;
        await harness.cancelStarted();
      }
    });

    /** A claim about `service` pointing at the one record of `pageId`. */
    const claimOf = (service: string, pageId: string) => ({
      text: `${service} timed out waiting for a lock`,
      atoms: [{ kind: 'service', value: service }],
      pointer: [{ pageId, records: [0] }],
    });
    /** The worker's claim about `service`, pointing at the one record of the first page of its packet. */
    const workerClaimOf = (service: string) => (call: RecordedModelCall) => ({ claims: [claimOf(service, workerPagesOf(call)[0]!.pageId)] });
    /** The verifier confirms a claim on its one record. */
    const confirmed = { output: assessment({ support: 'yes', claimType: 'observation', records: [{ record: 0, relation: 'supports' }] }) };
    const analysisOf = (...services: string[]) => ({
      output: {
        kind: 'requestAnalysis',
        rationale: 'look at the failing services',
        subquestions: services.map((service) => ({
          text: `what failed in ${service}?`,
          sourceId: 'fixture',
          toolName: 'search_logs',
          args: { service },
          completeness: 'all',
        })),
      },
    });
    /** The verification decision, answered once `claimsWritten` settles, with the claim ids the test read by then. */
    const verificationOf = (claimIds: () => string[], claimsWritten: Promise<void>) => ({
      output: () => ({ kind: 'requestVerification', rationale: 'check the claims', claimIds: claimIds() }),
      holdUntil: claimsWritten,
    });

    async function startDeepResearch(query: string, processId = 'deep-research') {
      const resourceId = newUser();
      const threadId = await harness.createThread(resourceId);
      const result = await harness.engine.startInvestigation({ resourceId, threadId, query, processId, launchKey: newLaunchKey() });
      if (result.outcome === 'rejected') throw new Error(`start refused: ${result.code}`);
      return { resourceId, investigationId: result.investigationId };
    }

    /** Waits for the terminal status of the investigation (each test waits for its own). */
    function finished(investigationId: string, resourceId: string): Promise<InvestigationView> {
      return vi.waitFor(
        async () => {
          const read = await harness.engine.readInvestigation({ investigationId, resourceId });
          if (read.outcome !== 'found') throw new Error(`investigation ${investigationId} not found`);
          if (read.view.status === 'running') throw new Error(`investigation ${investigationId} is still running`);
          return read.view;
        },
        { timeout: 30_000, interval: 50 },
      );
    }

    /** The claim ids of the investigation once `count` claims are written, in the worker's output order. */
    function claimIdsOnceWritten(investigationId: string, count: number): Promise<string[]> {
      return vi.waitFor(
        async () => {
          const { claims } = await engineRowsOf(investigationId);
          if (claims.length < count) throw new Error('the worker claims are not written yet');
          return claims.sort((left, right) => left.claimIndex - right.claimIndex).map((claim) => claim.claimId);
        },
        { timeout: 20_000, interval: 50 },
      );
    }

    /** The handler of the task's `attempt` has returned or thrown. */
    function attemptEnded(taskId: string, attempt: number): Promise<void> {
      return vi.waitFor(() => expect(harness.endedRuns).toContainEqual({ taskId, attempt }), { timeout: 10_000, interval: 20 });
    }

    // UC-1, UC-1a. Table-driven: one investigation per row group on the scripted model, the real gateway, the real roles.
    //
    // Rows:
    //  T1 attempts. Given an investigation where a worker call answers off-schema once and is retried, a verifier call is cut by a provider error and retried, and a worker attempt loses its lease before the answer.
    //     Then: the count of transcripts equals the count of `research_llm_calls` rows (retries and the abandoned reservation included); each transcript has `callId` equal to its journal row, role, model, a 12-hex prompt version,
    //     the full input as sent to the provider; the provider-error attempt has no response and outcome `provider_error`; the off-schema attempt has its response and outcome `invalid_output`; the lost-lease attempt has outcome
    //     `abandoned` and the journal row `abandoned`; a late write from the fenced attempt adds neither a journal row nor a transcript.
    //  T2 prompt version. Given two investigations on two configurations that differ by one word in the worker prompt template.
    //     Then: all worker transcripts of one investigation share one version; the worker version of the second investigation differs from the first; the versions of the other four roles are equal across the two.
    //
    // AC: "Каждая попытка вызова — и повтор после ошибки провайдера, и повтор после ответа не по форме — имеет свой транскрипт ... исход `provider_error` ... исход `abandoned`" (AC-01.1, DC-1);
    //     "Версия промпта в транскрипте одинакова у вызовов одной роли на одной конфигурации и меняется при любой правке шаблона промпта этой роли" (AC-01.6, DC-2)
    // Behavior: role calls the model -> gateway reserves tokens and writes the input in one guarded record, closes the reservation and writes the response in another -> a reader finds exactly one transcript per journal row
    // Catches: a gateway attempt (a retry, a provider error, an abandoned reservation) that leaves no transcript, a second one, or one detached from its journal row; a role that does not pass the prompt fingerprint to the gateway, so the version is
    //          empty or does not change when only a prompt template is edited. No unit test sees either: both live in the shared guarded transaction and in the role-to-gateway call.
    // @category: core-functionality
    // @dependency: ModelGateway, research_llm_calls, research_llm_transcripts, role handlers, scripted model, Postgres
    // @complexity: high
    it('INT-1 T1: every model call attempt (an off-schema answer and its retry, a provider error and its retry, a reservation abandoned by a lost-lease takeover) leaves its own transcript tied to its journal row with the same usage, and a fenced attempt writes none', async () => {
      const workerAnswer = {
        output: workerClaimOf('service-0'),
        usage: { inputTokens: 1_200, outputTokens: 80, cacheReadTokens: 300, cacheWriteTokens: 100 },
      };
      let claimIds: string[] = [];
      const claimsWritten = latch();
      const lateAnswer = latch();
      harness.model.script('controller', analysisOf('service-0'), verificationOf(() => claimIds, claimsWritten.wait), {
        output: { kind: 'concludeInconclusive', rationale: 'scripted conclusion' },
      });
      // Attempt 1 gets the off-schema answer; attempt 2 comes back too late, off-schema again, so the gateway goes straight to
      // the close of its reservation (an answer would first meet the checkpoint, which is fenced before any close); attempt 3
      // gets the answer it keeps.
      const offSchema = { output: { claims: 'not a list of claims' } };
      harness.model.script('worker', offSchema, { ...offSchema, holdUntil: lateAnswer.wait }, workerAnswer);
      harness.model.script('verifier', { providerError: { statusCode: 503 } }, confirmed);
      // Attempt 1 is held at the count of its retry, before it reserves: it loses the task there.
      const retryCount = latch();
      let retryCountHeld = false;
      harness.tokenCounter.intercept = async (request) => {
        if (retryCountHeld || !isWorkerRequest(request) || harness.model.callsOf('worker').length !== 1) return undefined;
        retryCountHeld = true;
        await retryCount.wait;
        return undefined;
      };
      try {
        const { resourceId, investigationId } = await startDeepResearch('T1: why do the lock waits time out?');
        await vi.waitFor(() => expect(retryCountHeld).toBe(true), { timeout: 20_000, interval: 20 });
        const analyze = (await tasksOf(investigationId)).find((task) => task.workflowType === ANALYZE)!;
        const workerRows = async () => {
          const { llmCalls } = await engineRowsOf(investigationId);
          return {
            calls: llmCalls.filter((row) => row.taskId === analyze.taskId),
            transcripts: (await llmTranscriptsOf(investigationId)).filter((row) => row.taskId === analyze.taskId),
          };
        };

        // Attempt 2 takes the task over and reserves; its answer is held.
        await harness.expireLease(analyze.taskId, 1);
        await vi.waitFor(() => expect(harness.model.callsOf('worker')).toHaveLength(2), { timeout: 10_000, interval: 20 });
        const beforeFencedReserve = await workerRows();
        expect(beforeFencedReserve.calls.map((row) => [row.attempt, row.status])).toEqual([
          [1, 'settled'],
          [2, 'reserved'],
        ]);
        expect(beforeFencedReserve.transcripts.map((row) => [row.attempt, row.outcome])).toEqual([
          [1, 'invalid_output'],
          [2, null],
        ]);
        // The superseded attempt 1 goes on to reserve: the guard refuses it, so neither a journal row nor a transcript is added.
        retryCount.open();
        await attemptEnded(analyze.taskId, 1);
        expect(harness.logs.runtime.warn.map(([message]) => message)).toContainEqual(
          expect.stringMatching(new RegExp(`^fenced withAttemptGuard .*taskId=${analyze.taskId} attempt=1$`)),
        );
        expect(await workerRows()).toEqual(beforeFencedReserve);

        // Attempt 3 takes the task over while attempt 2 waits for its answer: attempt 2's reservation is closed `abandoned`.
        await harness.expireLease(analyze.taskId, 2);
        await vi.waitFor(
          async () =>
            expect((await tasksOf(investigationId)).find((task) => task.taskId === analyze.taskId)).toMatchObject({
              status: 'succeeded',
              attempt: 3,
            }),
          { timeout: 10_000, interval: 50 },
        );
        // The late close of attempt 2 meets the guard: it changes neither its journal row nor its transcript.
        const beforeLateClose = await workerRows();
        lateAnswer.open();
        await attemptEnded(analyze.taskId, 2);
        expect(harness.logs.runtime.warn.map(([message]) => message)).toContainEqual(
          expect.stringMatching(new RegExp(`^fenced withAttemptGuard .*taskId=${analyze.taskId} attempt=2$`)),
        );
        expect(await workerRows()).toEqual(beforeLateClose);

        claimIds = await claimIdsOnceWritten(investigationId, 1);
        claimsWritten.open();
        expect(await finished(investigationId, resourceId)).toMatchObject({ status: 'completed', answer: { outcome: 'inconclusive' } });

        const { llmCalls } = await engineRowsOf(investigationId);
        const transcripts = await harness.readTranscriptsOf(investigationId, resourceId);
        // One transcript per journal row, the retries and the abandoned reservation included, in call order.
        expect(transcripts.map((transcript) => transcript.callId)).toEqual(llmCalls.map((row) => row.callId));
        expect(llmCalls.map((row) => [row.role, row.status])).toEqual([
          ['plan', 'settled'],
          ['controller', 'settled'],
          ['worker', 'settled'],
          ['worker', 'abandoned'],
          ['worker', 'settled'],
          ['controller', 'settled'],
          ['verifier', 'failed'],
          ['verifier', 'settled'],
          ['controller', 'settled'],
        ]);
        expect(transcripts.map((transcript) => [transcript.role, transcript.outcome])).toEqual([
          ['plan', 'answered'],
          ['controller', 'answered'],
          ['worker', 'invalid_output'],
          ['worker', 'abandoned'],
          ['worker', 'answered'],
          ['controller', 'answered'],
          ['verifier', 'provider_error'],
          ['verifier', 'answered'],
          ['controller', 'answered'],
        ]);

        const ledgerRow = new Map(llmCalls.map((row) => [row.callId, row]));
        for (const transcript of transcripts) {
          const row = ledgerRow.get(transcript.callId)!;
          expect(transcript).toMatchObject({
            llmCallId: row.callId,
            investigationId,
            taskId: row.taskId,
            attempt: row.attempt,
            role: row.role,
            model: row.model,
            promptVersion: fingerprint(shipped.roles[transcript.role as ScriptedRole].prompt),
          });
          // A closed call keeps the usage and the cost of its journal row; an abandoned one has neither an answer nor usage.
          const usage = [transcript.inputTokens, transcript.cacheReadTokens, transcript.cacheWriteTokens, transcript.outputTokens, transcript.costUsd];
          if (transcript.outcome === 'abandoned') {
            expect([...usage, transcript.response, transcript.closedAt]).toEqual([null, null, null, null, null, null, null]);
          } else {
            expect(usage).toEqual([row.inputTokens, row.cacheReadTokens, row.cacheWriteTokens, row.outputTokens, row.costUsd]);
          }
        }
        // The input is what the provider received, call by call of each role.
        for (const role of ['plan', 'controller', 'worker', 'verifier'] as const) {
          const written = transcripts.filter((transcript) => transcript.role === role).map(sentInput);
          expect(written).toEqual(harness.model.callsOf(role).map((call) => [call.system, call.user]));
        }

        const [offSchemaCall, abandonedCall, answeredCall] = transcripts.filter((transcript) => transcript.role === 'worker');
        expect([offSchemaCall!.attempt, abandonedCall!.attempt, answeredCall!.attempt]).toEqual([1, 2, 3]);
        // The raw text of the answer is kept, also when the schema refused it.
        expect(offSchemaCall!.response).toMatchObject({ finishReason: 'stop', text: '{"claims":"not a list of claims"}' });
        const page = (await tasksOf(investigationId)).find((task) => task.taskId === (analyze.input as { gatherTaskId: string }).gatherTaskId)!.outputRefs[0]!;
        expect(answeredCall).toMatchObject({
          response: {
            object: { claims: [claimOf('service-0', page)] },
            finishReason: 'stop',
            text: JSON.stringify({ claims: [claimOf('service-0', page)] }),
          },
          inputTokens: 1_200,
          cacheReadTokens: 300,
          cacheWriteTokens: 100,
          outputTokens: 80,
        });
        expect(Number(answeredCall!.costUsd)).toBeGreaterThan(0);
        const [providerErrorCall] = transcripts.filter((transcript) => transcript.role === 'verifier');
        expect(providerErrorCall).toMatchObject({ outcome: 'provider_error', response: null, outputTokens: null });
      } finally {
        retryCount.open();
        lateAnswer.open();
        claimsWritten.open();
      }
    }, 60_000);

    it('INT-1 T2: on two configurations that differ by one word of the worker prompt template, each role passes the fingerprint of its template: the worker version follows the edit and the other four stay', async () => {
      /** An investigation that calls all five roles, the controller and the worker more than once; returns its transcripts. */
      async function runEveryRole(processId: string, query: string): Promise<HarnessTranscript[]> {
        let claimIds: string[] = [];
        const claimsWritten = latch();
        harness.model.script('controller', analysisOf('service-0', 'service-1'), verificationOf(() => claimIds, claimsWritten.wait), {
          output: { kind: 'proposeAnswer', rationale: 'enough to answer' },
        });
        harness.model.script('worker', { output: workerClaimOf('service-0') }, { output: workerClaimOf('service-0') });
        // One check task per claim.
        harness.model.script('verifier', confirmed, confirmed);
        harness.model.script('synthesis', { output: { outcome: 'answered', summaryClaimIds: [], claims: [] } });
        try {
          const { resourceId, investigationId } = await startDeepResearch(query, processId);
          claimIds = await claimIdsOnceWritten(investigationId, 2);
          claimsWritten.open();
          expect(await finished(investigationId, resourceId)).toMatchObject({ status: 'completed' });
          return await harness.readTranscriptsOf(investigationId, resourceId);
        } finally {
          claimsWritten.open();
        }
      }
      /** The distinct prompt versions of each role. */
      const versionsByRole = (transcripts: HarnessTranscript[]) =>
        Object.fromEntries(
          ROLES.map((role) => [role, [...new Set(transcripts.filter((transcript) => transcript.role === role).map((transcript) => transcript.promptVersion))]]),
        );
      const rolesCalled = ['controller', 'controller', 'controller', 'plan', 'synthesis', 'verifier', 'verifier', 'worker', 'worker'];

      const shippedRun = await runEveryRole('deep-research', 'T2 A: why do the lock waits time out?');
      const editedRun = await runEveryRole(WORKER_EDIT_PROCESS, 'T2 B: why are the refunds declined?');

      expect(shippedRun.map((transcript) => transcript.role).sort()).toEqual(rolesCalled);
      expect(editedRun.map((transcript) => transcript.role).sort()).toEqual(rolesCalled);
      const shippedVersions = {
        plan: [fingerprint(shipped.roles.plan.prompt)],
        controller: [fingerprint(shipped.roles.controller.prompt)],
        worker: [fingerprint(shipped.roles.worker.prompt)],
        verifier: [fingerprint(shipped.roles.verifier.prompt)],
        synthesis: [fingerprint(shipped.roles.synthesis.prompt)],
      };
      // One version per role and configuration, the template's: the questions of the two runs differ, the versions do not.
      expect(versionsByRole(shippedRun)).toEqual(shippedVersions);
      // The one-word edit of the worker template changes the worker version only.
      expect(fingerprint(editedWorkerPrompt)).not.toBe(fingerprint(shipped.roles.worker.prompt));
      expect(versionsByRole(editedRun)).toEqual({ ...shippedVersions, worker: [fingerprint(editedWorkerPrompt)] });
    }, 60_000);
  });

  describe('INT-2', () => {
    // UC-E1, UC-E2, UC-3, UC-4. Table-driven over the lifetime of a transcript. All rows read through the real `readTranscripts`; the investigation comes from the harness (real engine run on the scripted model).
    //
    // Rows:
    //  T1 owner. Given the investigation of user A. When transcripts and the run record of that investigation are read with user B as owner.
    //     Then: both answer `investigation_not_found`; with user A both answer. (A deleted investigation answers the same.)
    //  T2 cascade. Given an investigation with transcripts, one of them a judge call bound to it (written through `Engine.assess`). When the conversation is deleted (the real deletion of the runtime, as in INT-3 V1 of the engine file).
    //     Then: no row of `research_llm_transcripts` remains for that investigation, the judge-bound one included.
    //  T3 retention. Given no `TRANSCRIPT_RETENTION_DAYS` set (the default term passed by the caller), a transcript written at T. When it is read at T+29 days, at T+31 days before any purge, and then `purgeExpiredTranscripts` runs.
    //     Then: present, then not returned by the read although the row still exists, then the purge returns 1 and removes only that row; the `research_llm_calls` row and every transcript younger than the term stay.
    //  T4 no term. Given a scenario-run investigation whose transcripts are 400 days old. When they are read and the purge runs with "no term".
    //     Then: all transcripts are returned and the purge returns 0.
    //
    // AC: "Чтение транскриптов и хода расследования фильтрует по владельцу" (AC-01.2, NFR-01); "Транскрипт удаляется вместе с расследованием" (AC-01.3);
    //     "Транскрипт старше срока хранения не отдаётся чтением сразу после конца срока, ещё до очистки; очистка удаляет его не позже чем через час" (AC-01.4, DC-4);
    //     "Транскрипты прогонов на придуманных сценариях хранятся бессрочно" (AC-01.5)
    // Behavior: reader / purge / delete -> filtered by owner, by foreign key and by age in SQL -> what a developer or another user can still see
    // Catches: another user reading transcripts that hold log content (NFR-01); transcripts orphaned after the conversation is deleted (log content outliving the investigation); an expired transcript still returned before the purge runs;
    //          a purge that removes the journal row or a young transcript; a "no term" mode that deletes. Only the real database shows the filter, the cascade and the purge scope.
    // @category: core-functionality
    // @dependency: readTranscripts, readRunRecord, purgeExpiredTranscripts, runtime deletion, Postgres
    // @complexity: medium
    //
    // T1 is extended by the read by task (plan T2.3; the skeleton does not name it):
    //  T1 by task. Given the investigation of user A with transcripts of several tasks. When the transcripts of its analysis task are read with user A, then with user B as owner.
    //     Then: user A gets only the transcripts of that task; user B gets `investigation_not_found`.
    // AC: "По расследованию, владельцу и задаче отдаёт только транскрипты этой задачи" (design-self-check.md, Contract `readTranscripts`)
    // Catches: a read by task that returns the transcripts of other tasks or skips the owner filter.
    const ANALYZE = 'research.analyze';
    const HAIKU = 'anthropic/claude-haiku-5-5';
    /** The term the caller passes when `TRANSCRIPT_RETENTION_DAYS` is not set (its 30-day default is unit-proven in api). */
    const DEFAULT_TERM = { days: 30 } as const;
    const NOT_FOUND = { outcome: 'rejected', code: 'investigation_not_found' } as const;
    /** Every model call of one run on the script of `finishedRun`, in call order. */
    const RUN_ROLES = ['plan', 'controller', 'worker', 'controller'];
    let harness: EngineHarness;

    beforeAll(async () => {
      harness = await createEngineHarness({ assessModels: [HAIKU] });
    });

    afterAll(async () => {
      await harness?.close();
      await closeEngineDb();
    });

    beforeEach(() => {
      harness.model.reset();
      harness.countingSource.answerWith((call) => [{ service: call.args.service, level: 'error', message: 'lock wait timeout' }]);
    });

    afterEach(async () => {
      try {
        expect(harness.model.pending()).toEqual({ plan: 0, controller: 0, worker: 0, verifier: 0, synthesis: 0 });
      } finally {
        await harness.cancelStarted();
      }
    });

    /** A finished investigation of a new user: the plan, one analysis task, an inconclusive conclusion. */
    async function finishedRun(query: string) {
      harness.model.script(
        'controller',
        {
          output: {
            kind: 'requestAnalysis',
            rationale: 'look at the failing service',
            subquestions: [
              { text: 'what failed in service-0?', sourceId: 'fixture', toolName: 'search_logs', args: { service: 'service-0' }, completeness: 'all' },
            ],
          },
        },
        { output: { kind: 'concludeInconclusive', rationale: 'scripted conclusion' } },
      );
      harness.model.script('worker', {
        output: { claims: [{ text: 'service-0 timed out waiting for a lock', atoms: [{ kind: 'service', value: 'service-0' }], pointer: [] }] },
      });
      const resourceId = newUser();
      const threadId = await harness.createThread(resourceId);
      const started = await harness.engine.startInvestigation({ resourceId, threadId, query, processId: 'deep-research', launchKey: newLaunchKey() });
      if (started.outcome === 'rejected') throw new Error(`start refused: ${started.code}`);
      const { investigationId } = started;
      await vi.waitFor(
        async () => {
          const read = await harness.engine.readInvestigation({ investigationId, resourceId });
          if (read.outcome !== 'found' || read.view.status === 'running') throw new Error(`investigation ${investigationId} is not finished`);
          expect(read.view.status).toBe('completed');
        },
        { timeout: 30_000, interval: 50 },
      );
      return { resourceId, threadId, investigationId };
    }

    const readOf = (investigationId: string, ownerId: string, retention: TranscriptRetention = DEFAULT_TERM, taskId?: string) =>
      readTranscripts(harness.db, { investigationId, ownerId, retention, ...(taskId === undefined ? {} : { taskId }) });

    /** The read transcripts as `[role, callId]` in the order read, or the refusal. */
    async function readCalls(investigationId: string, ownerId: string, retention?: TranscriptRetention, taskId?: string) {
      const read = await readOf(investigationId, ownerId, retention, taskId);
      return read.outcome === 'found' ? read.transcripts.map((transcript) => [transcript.role, transcript.callId]) : read;
    }

    /** The stored transcript rows of the investigation as `[role, callId]`, in call order. */
    const storedCalls = async (investigationId: string) => (await llmTranscriptsOf(investigationId)).map((row) => [row.role, row.callId]);

    it("INT-2 T1: the transcripts and the run record of an investigation are read by its owner only, a read by task returns only that task's transcripts, and a deleted investigation answers investigation_not_found", async () => {
      const { resourceId, threadId, investigationId } = await finishedRun('INT-2 T1: why do the lock waits time out?');
      const otherUser = newUser();
      const stored = await storedCalls(investigationId);
      expect(stored.map(([role]) => role)).toEqual(RUN_ROLES);
      const analyze = (await tasksOf(investigationId)).find((task) => task.workflowType === ANALYZE)!;
      const analyzeCalls = (await llmTranscriptsOf(investigationId)).filter((row) => row.taskId === analyze.taskId).map((row) => [row.role, row.callId]);

      // The owner reads every transcript in call order, and the run record.
      expect(await readCalls(investigationId, resourceId)).toEqual(stored);
      expect(await readRunRecord(harness.db, { investigationId, ownerId: resourceId })).toMatchObject({
        outcome: 'found',
        record: { investigationId, ownerId: resourceId, status: 'completed' },
      });
      // By task: only the one worker call of the analysis task, not the plan or controller calls.
      expect(analyzeCalls.map(([role]) => role)).toEqual(['worker']);
      expect(await readCalls(investigationId, resourceId, DEFAULT_TERM, analyze.taskId)).toEqual(analyzeCalls);

      // Another user reads nothing: neither the transcripts, nor those of one task, nor the run record.
      expect(await readOf(investigationId, otherUser)).toEqual(NOT_FOUND);
      expect(await readOf(investigationId, otherUser, DEFAULT_TERM, analyze.taskId)).toEqual(NOT_FOUND);
      expect(await readRunRecord(harness.db, { investigationId, ownerId: otherUser })).toEqual(NOT_FOUND);

      // Once the conversation is deleted, the owner gets the same answer.
      await harness.purgeThread(resourceId, threadId);
      expect(await readOf(investigationId, resourceId)).toEqual(NOT_FOUND);
      expect(await readRunRecord(harness.db, { investigationId, ownerId: resourceId })).toEqual(NOT_FOUND);
    }, 60_000);

    it('INT-2 T2: deleting the conversation removes every transcript of its investigation, the judge call bound to it through Engine.assess included', async () => {
      const { resourceId, threadId, investigationId } = await finishedRun('INT-2 T2: why do the lock waits time out?');
      // The double picks a call's script by a property of its output schema: this judge form carries the verifier's `records`.
      harness.model.script('verifier', { output: { records: [] } });
      const judged = await harness.engine.assess({
        role: 'judge',
        model: HAIKU,
        effort: 'low',
        maxOutputTokens: 500,
        instructions: 'You judge the answer of an investigation.',
        messages: [{ role: 'user', content: 'INT-2 T2: the answer to judge' }],
        outputSchema: z.object({ records: z.array(z.unknown()) }),
        binding: { investigationId },
        notAfter: new Date(Date.now() + 60_000),
      });
      expect(judged.outcome).toBe('answered');

      // The owner's read includes the judge call bound to the investigation, outside any task.
      const read = await readOf(investigationId, resourceId);
      if (read.outcome !== 'found') throw new Error('the owner reads no transcripts');
      expect(read.transcripts.map((transcript) => [transcript.role, transcript.taskId === null])).toEqual([
        ...RUN_ROLES.map((role) => [role, false]),
        ['judge', true],
      ]);
      const callIds = read.transcripts.map((transcript) => transcript.callId);

      await harness.purgeThread(resourceId, threadId);
      // Looked up by call id, not by investigation: a transcript left with its link cleared would still show here.
      expect(await harness.db.select().from(researchLlmTranscripts).where(inArray(researchLlmTranscripts.callId, callIds))).toEqual([]);
    }, 60_000);

    it('INT-2 T3: under the default term a transcript is read at 29 days, is no longer read at 31 days although its row is still there, and the purge then removes only that row, leaving its journal row and the younger transcripts', async () => {
      // Clears what earlier runs may have left past the term: the purge below counts over the whole database.
      await purgeExpiredTranscripts(harness.db, DEFAULT_TERM);
      const { resourceId, investigationId } = await finishedRun('INT-2 T3: why do the lock waits time out?');
      const stored = await storedCalls(investigationId);
      const writtenAtT = stored[0]![1]!;
      const younger = stored.slice(1);

      await harness.ageTranscripts(investigationId, 29, { callId: writtenAtT });
      expect(await readCalls(investigationId, resourceId)).toEqual(stored);

      await harness.ageTranscripts(investigationId, 2, { callId: writtenAtT });
      expect(await readCalls(investigationId, resourceId)).toEqual(younger);
      expect(await storedCalls(investigationId)).toEqual(stored);

      expect(await purgeExpiredTranscripts(harness.db, DEFAULT_TERM)).toBe(1);
      expect(await storedCalls(investigationId)).toEqual(younger);
      // The journal keeps every call with its spend, the purged one's included.
      const { llmCalls } = await engineRowsOf(investigationId);
      expect(llmCalls.map((row) => [row.role, row.callId])).toEqual(stored);
    }, 60_000);

    it('INT-2 T4: without a term the 400-day-old transcripts of a scenario run are all read and the purge deletes none', async () => {
      const { resourceId, threadId, investigationId } = await finishedRun('INT-2 T4: why do the lock waits time out?');
      try {
        const stored = await storedCalls(investigationId);
        await harness.ageTranscripts(investigationId, 400);
        // Past any term: the default term reads none of them.
        expect(await readCalls(investigationId, resourceId)).toEqual([]);

        expect(await readCalls(investigationId, resourceId, 'no_term')).toEqual(stored);
        expect(await purgeExpiredTranscripts(harness.db, 'no_term')).toBe(0);
        expect(await storedCalls(investigationId)).toEqual(stored);
      } finally {
        // The aged rows would count in the purge of a later run.
        await harness.purgeThread(resourceId, threadId);
      }
    }, 60_000);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Proven at unit level (named for the plan; generated as specs next to the code, not here). One table-driven spec per rule, cases as rows.
// ---------------------------------------------------------------------------------------------------------------
// - Prompt fingerprint (table + fast-check property, packages/engine/src): 12 hexadecimal characters; the same template always gives the same value; any one-character edit of the template gives another; the value is taken from the template before the question
//   is substituted; `Engine.assess` takes it from the instruction text. AC-01.6 (rule half), KD-2, DC-2.
// - Retention settings (table): `TRANSCRIPT_RETENTION_DAYS` absent gives 30; a value below 1 or a non-integer is rejected at start. AC-01.4 (default half), UC-3.
// - Purge scheduler (fake timers): the hourly timer calls the purge function with the configured term and stops on shutdown. AC-01.4 (hourly half). Residual risk: the registration of this timer in the Nest module is not exercised by an integration test;
//   the plan may add one boot assertion to apps/api/test/research-runtime-wiring.e2e-spec.ts.
// - `Engine.assess` guards (fake model): a model outside `assessModels` answers `model_unavailable` without a provider call; retries follow the gateway rules already proven in `retry-policy.spec.ts` (two on provider error, one on off-schema output). DC-3 (rule half).
// - Run-row source snapshot on a failed read (fake source): a source whose snapshot cannot be read records an empty snapshot and the start does not refuse. KD-7 (start half); the happy path is proven through INT-4 R1 in the api file.
