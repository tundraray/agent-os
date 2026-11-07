// agent-quality / engine Integration Tests (engine package) - Design Doc: docs/features/agent-quality/design-engine.md (v1.3, approved 2026-11-07)
// PRD: docs/features/agent-quality/prd.md (FR-06, FR-08, FR-09, FR-10, FR-11, FR-12, FR-13, FR-14, FR-15, FR-16, FR-17, FR-18). UXRD: docs/features/agent-quality/uxrd.md (MC-1, MC-2, MC-3, KD-7). ADRs: ADR-0003 (Drizzle data layer), ADR-0005 (ProcessConfig stays data),
// ADR-0006 (reserve answers `stopping` in a closed or stopped investigation), ADR-0007 (status from a closed assessment, group from a calibrated table).
// Generated: 2026-11-07 | Part: engine | Test type: Integration (in-process runtime + engine + real Postgres, scripted model), CI job `e2e-engine`
// State: INT-1 (V1-V3), INT-2 (A1, A3-A5), INT-3 (B1-B3) and INT-4 (K1, K2) are implemented; no todo is left.
// Implementation timing: created alongside the slice each test names (INT-1 `research.verify` v2 + `decideClaim` + claim revision write; INT-2 `screenDraft` / `composeAnswer` / `buildResearchAnswer` / `readAnswerMessage`;
// INT-3 `CallLedger.reserve` `busy` + the gateway wait; INT-4 the controller input and the cache mark).
//
// File name and placement. Same package, harness and config as `deep-research-engine.int.e2e-spec.ts` and `agent-quality-lifecycle.int.e2e-spec.ts` (`test/**/*.e2e-spec.ts` of `vitest.config.e2e.ts`; run with
// `pnpm --filter @agent-os/engine test:e2e`, never in the default `vitest run`). Every behaviour below lives in this package (the handlers, the ledger, the answer functions); the api side of the part is
// apps/api/test/agent-quality-engine.e2e-spec.ts, the migration is packages/db/test/agent-quality-engine.int.e2e-spec.ts.
//
// Generated as `it.todo` skeletons so the file loads under lint, typecheck and `vitest run`; each was implemented following its Given/When/Then comments when its slice landed.
// Do not convert a todo into a passing stub.
//
// Environment (Design Doc "Test Strategy"):
// - Postgres 16 from infra/docker-compose.yml. Real `createRuntime` and `createEngine` with their handlers, the real `ModelGateway` over the real `postgresCallLedger`, real `EvidenceReader`, `readInvestigation`,
//   `readAnswerMessage`. Model boundary only: the scripted language-model double of test/support/scriptedModel.ts keyed by role; the counting source over the fixture is the only source. No real Anthropic call, no key.
// - "Model evaluates, algorithm decides": the verifier stub returns only the closed JSON assessment (`support`, `claimType`, `records[]`), the synthesis stub only `outcome`, `summaryClaimIds`, `claims`. No test asserts
//   on a keyword or a substring of model text; texts the code itself builds (section captions, group words MC-1, summary caption MC-2, causal label MC-3) are compared as literals from the UXRD.
// - Isolation (project convention, no truncate): a unique `resourceId` and `launchKey` per test (test/support/new-user.ts); the file runs with `fileParallelism: false`; `cancelStarted()` in afterEach.
// - Time: the clock and lease are the injected ones (`expireLease`, `engineClock`); the 2-second wait of INT-3 runs on the injected clock, held by `engineClock.holdTimers` and fired by the test, never on a sleep. No latency is asserted.
// - Support (in place): test/support/scriptedModel.ts recognises the verifier form by `records` and synthesis by `summaryClaimIds` and has the verifier helper
//   `assessment({ support, claimType, records })`; test/support/engineHarness.ts has the `groupTables` option, `seedClaims` (first `unverified` revisions),
//   `seedRevisions` (checked revisions with status, group and basis, INT-2) and `evidenceReads` (every `EvidenceReader.get` of the engine, INT-2 A5);
//   test/support/test-configs.ts serves the shipped configuration and `two-steps` (INT-2 A3).
//
// Budget (whole part, four files): Integration 5 (limit 3; up to 5 under the integration-e2e-testing rule only when each extra test names the defect no other test catches), E2E 2 (limit 2).
//   Core: INT-1 (claim check), INT-2 (answer), INT-3 (budget wait), all in this file.
//   Extras: INT-4 (this file, the controller step) - unique defect: the rejected attempts of a step are read from the stored decisions, so only a restart of the controller task against the real database shows a list that survives it,
//   and the cache mark is visible only in the stored transcript input and the journal row of a real gateway call (a unit test with a fake client sees the mark, not the tokens the journal charges);
//   INT-5 (packages/db file) - unique defect: a migration that fails or rewrites claim revisions that already exist; nothing but a migrated Postgres with seeded old rows shows it.
//   E2E-1 and E2E-2 are in apps/api/test/agent-quality-engine.e2e-spec.ts. Rows of one rule or one flow are table rows of one INT, not tests.
//
// AC -> proving test (the plan reads this to avoid a second test for an AC already proven):
// - AC-11.1 (pointer to a foreign or missing record, DC-6): INT-1 V2 (the owner check and the "no call" half need the real reader and ledger); the validation rule itself is unit
// - AC-12.1 (values found, verifier says no, DC-9 meaning half): unit, `decide-claim.spec.ts` (test audit: INT-1 V4 removed, the status rule needs no database)
// - AC-12.2 (off-form answer, DC-7): INT-1 V3 (the retry count and the stored result); the form rules are unit
// - AC-12.3 (an established finding has a verifier transcript that confirmed it), DC-11 (group taken from the table, wired): INT-1 V1
// - AC-13.1 (a number that differs from the record, DC-9): unit, `decide-claim.spec.ts` rows (the value check runs on the records `pointedRecords` gives, so the pointer's records only); the wiring is INT-1 V1
// - AC-14.1 (causal never established, DC-10): unit, `decide-claim.spec.ts` (status) and INT-2 A1 (placement and label)
// - AC-09.1 (references are the basis of the check only, DC-4): INT-2 A1
// - AC-16.1, AC-16.2, DC-12 (summary from accepted claims): INT-2 A1; AC-16.3: unit, `reference-gateway.spec.ts` summary rows and the builder row without items (test audit: INT-2 A2 removed); AC-16.4 (forced stop, no summary): INT-2 A3; DC-13 (no-source mode): INT-2 A4
// - KD-8 and Invariant 9 (text and metadata from one function, one write, delivery read), UC-E5 (answers and messages written before this part): INT-2 A1 (parity, delivery read), A5 (old answer)
// - AC-10.1 (parallel workers fit the budget, DC-5): INT-3 B1; AC-10.2 (no new call once the budget is exhausted), DC-8 (unverified without a revision): INT-3 B2; the `stopping` / `notAfter` exits of the wait: INT-3 B3
// - AC-08.1 (a retry sees the rejected attempts, also after a restart), DC-3: INT-4 K1; AC-18.1 (stable block, cache mark, cheaper steps), DC-15: INT-4 K2
// - AC-06.1, AC-06.2, AC-15.2, DC-1, DC-2 (calibration and the start check): the calibration rule is unit; the developer journey is E2E-2 in the api file; `calibration_missing` of `createEngine` is unit (create-engine.spec.ts)
// - AC-17.1, DC-14 (records as a numbered data section, the influence measure): unit (see the end of the file); the wiring of `run` to the real `Engine.assess` is one row for the self-check file, see "Unplaced"
// - Migration of the claim fields and the `causal` status: INT-5 in the db file; the CHECK domain of `research_claims.status` is the existing AC-RT-8 row of packages/db/test/migrations.e2e-spec.ts, whose literal list
//   gets `causal` (a change of an existing test that the plan makes with the migration, not a new test).
//
// Proven at unit level (named for the plan; generated as specs next to the code, not here). One table-driven spec per rule, cases as rows:
// - `decideClaim` (packages/engine/src/verify): the table of the Design Doc's status diagram (form violations, type causal over any support, support no / insufficient, the three value outcomes, no atoms), the profile (type, values, one or two-plus
//   independent records by `traceId` with a record without `traceId` counted separate, contradicts) and the group lookup with the lowest group for an unknown profile and for a missing table (DC-11, UC-E7). Plus a property test:
//   FOR ALL assessments and record sets, `supported` implies `support` yes, a type other than `causal`, every record relation given exactly once, at least one `supports`, and values neither contradicting nor missing (Invariant 1).
// - `buildClaimCheck`: the instructions are the role template unchanged, the claim text and the records only in messages, each record a JSON object with its number, each page with source, tool, normalised arguments, slice and completeness (DC-14).
// - Pointer validation of `research.verify`: own page, integer number inside the page, 1 to 20 records, duplicates (DC-6 rule half).
// - Reserve arithmetic: `refused` only when spent plus this reserve exceeds the budget, `busy` when only other open reserves make it exceed, `reserved` otherwise; the order after the lifecycle checks (`fenced`, `stopping`) (Invariant 6).
// - Gateway wait: `busy` repeats every 2 seconds on a fake clock with the same counted input and no recount, ends on `stopping`, abort and `notAfter` with `no_answer` (DC-5 rule half).
// - `screenDraft` and `composeAnswer`: references from the stored basis, sections by status, `summaryClaimIds` filtered to the established claims of this answer, de-duplicated, at most three (DC-4, DC-12); code-built answer has no summary and no causal in `established` (AC-16.4).
// - `buildResearchAnswer`: sections, footnote numbers by first appearance, group words, summary caption only with items, causal label, "not verified", no-source warning and "from model knowledge", the text and the metadata carrying the same items and groups (Invariant 9); the pre-part
//   form without summary, group words and label (UXRD KD-7); a page without details is an error of the step, not a missing footnote.
// - Closed schemas of the worker, verifier and synthesis outputs (every object closes its property set) in role-output-schemas.spec.ts.
// - Controller input (decision-input.spec.ts, role-packets): the stable block is byte-identical for equal tools and plan revision and changes with the revision; the changing block carries the rejected attempts as kind-or-null plus a code from the closed list;
//   the cache mark is placed on the last part of the stable block of a controller call and on no other role's request (role-agent client).
// - `ResearchAnswerMetadataSchema` and the stored answer schema parse the pre-part shapes with `summaryItems` empty, `confidence` null, `causal` false, `summary` kept (UC-E5 parse half) in packages/contracts and packages/engine.
// - Calibration (apps/api/src/self-check, over a fake `assess`): per kind the three fractions of the report, the profile ranking by the lower bound of the 90 percent interval, the split into three or four groups with a profile never divided, fewer profiles than groups,
//   `calibration_empty`, `calibration_prompt_has_fields`, an off-form or failed pair counted as a wrong decision and listed apart, the table rewritten for the same model and prompt version (UC-10 rule half, Flow 5).
// - `injectionInfluence` (apps/api/src/self-check/metrics.spec.ts, over a fake `assess`): each `injected` pair checked as is and without the records of `injectionTraceIds` with the rest renumbered; a scenario counts when any such pair differs in `support` or `claimType`;
//   a pair left with no records is skipped; a scenario with no pair in the measure is out of the denominator; 1 of 2 gives 0.5 and, with `injectionInfluenceMax` 0.25, the report line "за пределом допустимого" (UC-11, AC-17.1).
//
// Unplaced (no skeleton here, for the plan): the wiring of `run` to the real `Engine.assess` with the verifier model in `assessModels` (the injection measure through the real engine assembly) is one more row for the existing INT-3 of
// apps/api/test/agent-quality-self-check.int.e2e-spec.ts, which already holds the `run` assembly; it is not a new test and spends no budget of this part.

import { randomUUID } from 'node:crypto';
import { researchEngineRuns } from '@agent-os/db';
import { deepResearchProcessV2, type GroupTable, promptVersion, readRunRecord, type TokenCountRequest } from '@agent-os/engine';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { COUNTING_SOURCE_ID } from './support/countingSource.js';
import { closeEngineDb, engineRowsOf, llmTranscriptsOf, tasksOf } from './support/engineDb.js';
import { createEngineHarness, type EngineHarness, type HeldTimer, type SeededClaim, type SeededRevision } from './support/engineHarness.js';
import { newLaunchKey, newUser } from './support/new-user.js';
import { assessment, type RecordedModelCall, type ScriptedStep, verifierPacketOf } from './support/scriptedModel.js';
import { TEST_PROCESSES } from './support/test-configs.js';

/** A gate a test opens once; waiting on an open gate goes on at once. */
function latch() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open: () => open() };
}

describe('agent-quality / engine - integration (in-process runtime + engine + real Postgres, scripted model)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-1  One claim, one verifier call over the records the claim points at: the status, type, group and basis stored in a new revision
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-11.1: "Given указатель утверждения ведёт на запись другого расследования или на место, которого в записи нет, Then утверждение не установлено."
  // AC-12.1: "Given значения утверждения нашлись в записях, а проверяющий вызов ответил «не подтверждают», Then утверждение не стоит в «Установлено»."
  // AC-12.2: "Given проверяющий вызов вернул ответ не по форме или не ответил, Then утверждение не установлено."
  // AC-12.3: "Given вывод стоит в «Установлено», Then в его ходе есть транскрипт проверяющего вызова, который его подтвердил."
  // AC-13.1: "Given проверяющий вызов ответил «подтверждают», а число в утверждении расходится с числом в записи, Then утверждение не установлено."
  // AC-14.1: "Given проверяющий вызов отнёс утверждение к причинным, Then оно стоит в «Предположениях» и никогда — в «Установлено»." (the status half; the placement is INT-2 A1)
  // DC-6 (FR-11): "Утверждение без указателя, с номером вне страницы или со страницей не своего расследования получает статус `insufficient`, и проверяющий вызов для него не делается."
  // DC-7 (FR-12): "Оценка не по форме - значение вне списка, отношение не для каждой данной записи, номер записи, которой не было во входе, или «подтверждают» без единой подтверждающей записи - после одной повторной попытки даёт статус `insufficient`."
  // DC-9 (FR-13): "Если оценка «подтверждают», а атом-число или атом-интервал противоречит записи указателя, статус - `refuted`; если атома нет среди записей указателя - `insufficient`; утверждение без атомов проходит сверку как «неприменимо»."
  // DC-10 (FR-14): "Утверждение, которое оценка отнесла к причинным, получает статус `causal` при любом ответе «подтверждают ли»..."
  // DC-11 (FR-15): "Каждое установленное утверждение хранит группу из таблицы групп по своему профилю..." (the wired half: the group is read from the table the engine was given and stored in the revision)
  // Use cases: UC-1, UC-2, UC-3, UC-E1, UC-E2. KD-1, KD-2, KD-3. Flow 1. Invariants 1, 2, 5.
  //
  // Primary failure mode (turns red when): the verifier is given records the claim does not point at (a whole page, or records re-fetched from the source) so the basis and the links are not the checked records; a status is written without a verifier call
  // having answered (a `supported` revision with no transcript of its task); a pointer to a foreign, missing or empty place still reaches the model or is stored as `unverified`; an off-form assessment, once or twice, ends as `supported` or as
  // `unverified` instead of `insufficient`; the new revision loses the pointer, type, assessment (with the reason of an `insufficient` decided without a call), group or basis.
  // (The value check over the pointed records only and `causal` over `supported` are `decide-claim.spec.ts` rows since the test audit.)
  // Behavior: `research.verify` reads the latest revision and the pages of its pointer through `EvidenceReader` for the owner -> validates the pointer -> `buildClaimCheck` -> one `verifier` call through reserve and transcript -> `decideClaim` with the group table ->
  //   a new revision (status, type, assessment, group, basis in `evidenceIds`) -> the task ends `succeeded` with the status
  // @category: core-functionality
  // @dependency: research.verify, buildClaimCheck, decideClaim, verifyClaim, EvidenceReader, ModelGateway, claimsRepository, group table, research_llm_calls, research_llm_transcripts, scripted model, Postgres
  // @complexity: high
  //
  // Verification items (table; each row asserts on `research_claims`, `research_tasks`, `research_llm_calls`, `research_llm_transcripts` and the model double's calls, with literal expected values; the verifier answers only with the closed assessment form):
  // - V1 established with group and a transcript (UC-1, AC-12.3, DC-11): Given a worker claim "412 timeout errors from 19:40 to 20:15" with atoms (service, count, interval) and a pointer to a count page plus three log rows of three `traceId`s, a verifier stub
  //   `support: yes`, `claimType: quantitative`, all four records `supports`, a group table that puts the profile (quantitative, values matched, two or more independent, no contradiction) in `high` -> the latest revision is `supported` with group `high`, type
  //   `quantitative`, the stored assessment, `evidenceIds` = the pages whose records were marked `supports`; `research_llm_transcripts` has one answered `verifier` row of the check task whose input carries exactly the four pointed records numbered from 0 and
  //   no record outside the pointer; the counting source got no new call (no re-fetch)
  // - V2 pointer to nothing (UC-E1, AC-11.1, DC-6): four claims - a record number past the page, a page of another investigation of the same owner, a page of another owner's investigation, an empty pointer -> each ends `insufficient` with reason
  //   `pointer_invalid`, the model double got no `verifier` call, `research_llm_calls` has no row and there is no transcript for these tasks
  // - V3 off-form assessment (UC-E2, AC-12.2, DC-7): three claims whose stub answers (a) a `support` value outside the list, (b) `yes` with no record marked `supports`, (c) a relation for a record number that was not in the input, each in both attempts -> each ends
  //   `insufficient` with reason `invalid_assessment`, none `supported`, exactly two verifier calls per task and no third; a fourth claim whose first answer is off-form and second valid gets its status from the second answer
  // - V4, V5 (values against meaning, causal): removed by the test audit; the status rule is owned by `decide-claim.spec.ts` rows, the stored revision fields by V1 and V3
  describe('INT-1', () => {
    const VERIFIER = (deepResearchProcessV2 as { roles: { verifier: { model: string; prompt: string } } }).roles.verifier;
    /** The table of the investigations' verifier: the profile of V1 is `high`; any other profile gets the lowest group. */
    const GROUP_TABLE: GroupTable = {
      model: VERIFIER.model,
      promptVersion: promptVersion(VERIFIER.prompt),
      scenarioSet: 'int-1',
      pairsFingerprint: '0123456789ab',
      calibratedAt: '2026-11-07T00:00:00.000Z',
      groupCount: 3,
      profiles: [
        { profile: { claimType: 'quantitative', valueCheck: 'matched', independentRecords: 'two_or_more', contradictions: false }, group: 'high' },
      ],
      groups: [{ group: 'high', establishedPairs: 4, correctShare: 1 }],
      pairKinds: [],
    };
    const INTERVAL = '2026-10-01T19:40:00.000Z/2026-10-01T20:15:00.000Z';
    const logRow = (traceId: string, ts: string) => ({ ts, service: 'payment-api', level: 'error', event: 'timeout', traceId });
    /** The log page: three rows the claims point at and a fourth no pointer names. */
    const LOG_PAGE = [
      logRow('a'.repeat(32), '2026-10-01T19:45:00.000Z'),
      logRow('b'.repeat(32), '2026-10-01T19:50:00.000Z'),
      logRow('c'.repeat(32), '2026-10-01T20:10:00.000Z'),
      logRow('d'.repeat(32), '2026-10-01T20:12:00.000Z'),
    ];
    /** The count page: payment-api's count and a `ledger` bucket no pointer names. */
    const countPage = (count: number) => [
      { key: 'payment-api', count },
      { key: 'ledger', count: 7 },
    ];

    let harness: EngineHarness;

    beforeAll(async () => {
      harness = await createEngineHarness({ groupTables: [GROUP_TABLE] });
    });

    afterAll(async () => {
      await harness?.close();
      await closeEngineDb();
    });

    beforeEach(() => {
      harness.model.reset();
      harness.countingSource.calls.length = 0;
    });

    afterEach(async () => {
      try {
        expect(harness.model.pending()).toEqual({ plan: 0, controller: 0, worker: 0, verifier: 0, synthesis: 0 });
      } finally {
        await harness.cancelStarted();
      }
    });

    type Page = 'log' | 'count';
    const TOOL_OF: Record<Page, string> = { log: 'search_logs', count: 'aggregate_logs' };
    const evidenceOf = (page: Page) => ({
      output: { kind: 'requestEvidence', rationale: `collect the ${page} page`, sourceId: 'fixture', toolName: TOOL_OF[page], args: { service: 'payment-api' }, completeness: 'all' },
    });
    const conclude = { output: { kind: 'concludeInconclusive', rationale: 'scripted conclusion' } };

    function waitFor<T>(what: string, read: () => Promise<T | undefined>): Promise<T> {
      return vi.waitFor(
        async () => {
          const value = await read();
          if (value === undefined) throw new Error(`waiting for ${what}`);
          return value;
        },
        { timeout: 30_000, interval: 50 },
      );
    }

    async function startInvestigation(resourceId: string, query: string): Promise<string> {
      const threadId = await harness.createThread(resourceId);
      const started = await harness.engine.startInvestigation({ resourceId, threadId, query, processId: 'deep-research', launchKey: newLaunchKey() });
      if (started.outcome === 'rejected') throw new Error(`start refused: ${started.code}`);
      return started.investigationId;
    }

    const finished = (investigationId: string, resourceId: string) =>
      waitFor('the end of the investigation', async () => {
        const read = await harness.engine.readInvestigation({ investigationId, resourceId });
        return read.outcome === 'found' && read.view.status !== 'running' ? read.view : undefined;
      });

    /** A finished investigation of `resourceId` that gathered one page: the page id (V2's foreign pages). */
    async function pageOfAnotherInvestigation(resourceId: string): Promise<string> {
      harness.countingSource.answerWith(() => LOG_PAGE);
      harness.model.script('controller', evidenceOf('log'), conclude);
      const investigationId = await startInvestigation(resourceId, 'INT-1: a page of another investigation');
      await finished(investigationId, resourceId);
      const [fetch] = (await tasksOf(investigationId)).filter((task) => task.workflowType === 'source.fetch');
      return fetch!.outputRefs[0]!;
    }

    /**
     * One investigation that gathers the pages, then verifies the claims the test seeds over them (a pointer may span
     * pages, which no single worker sees), then concludes. The verifier answers from `answers`: a queue per claim text,
     * recognised by exact equality — the check tasks run in parallel, so their order is not the script's.
     */
    async function checkClaims(options: {
      /** The investigation's owner; a new user by default. */
      readonly owner?: string;
      readonly pages: Partial<Record<Page, readonly unknown[]>>;
      readonly claims: (pageIds: Partial<Record<Page, string>>) => readonly SeededClaim[];
      readonly answers?: ReadonlyMap<string, readonly unknown[]>;
    }) {
      const pages = Object.keys(options.pages) as Page[];
      harness.countingSource.answerWith((call) => options.pages[pages.find((page) => TOOL_OF[page] === call.toolName)!] ?? []);
      const queues = new Map([...(options.answers ?? [])].map(([text, outputs]) => [text, [...outputs]]));
      const steps = [...queues.values()].flatMap((outputs) =>
        outputs.map(() => ({ output: (call: RecordedModelCall) => queues.get(verifierPacketOf(call).claimText)!.shift() })),
      );
      if (steps.length > 0) harness.model.script('verifier', ...steps);
      let claimIds: string[] = [];
      const seeded = latch();
      harness.model.script(
        'controller',
        ...pages.map(evidenceOf),
        { output: () => ({ kind: 'requestVerification', rationale: 'check the claims', claimIds }), holdUntil: seeded.wait },
        conclude,
      );
      try {
        const resourceId = options.owner ?? newUser();
        const investigationId = await startInvestigation(resourceId, 'INT-1: why do the payments time out?');
        const fetches = await waitFor('the pages', async () => {
          const found = (await tasksOf(investigationId)).filter((task) => task.workflowType === 'source.fetch' && task.status === 'succeeded');
          return found.length === pages.length ? found : undefined;
        });
        const pageIds = Object.fromEntries(
          pages.map((page) => [page, fetches.find((task) => (task.input as { toolName: string }).toolName === TOOL_OF[page])!.outputRefs[0]!]),
        ) as Partial<Record<Page, string>>;
        const [controller] = await tasksOf(investigationId);
        claimIds = await harness.seedClaims({ investigationId, taskId: controller!.taskId, claims: options.claims(pageIds) });
        const sourceCallsBeforeCheck = harness.countingSource.calls.length;
        seeded.open();
        expect(await finished(investigationId, resourceId)).toMatchObject({ status: 'completed' });

        const tasks = await tasksOf(investigationId);
        const checks = tasks.filter((task) => task.workflowType === 'research.verify');
        const { claims, llmCalls } = await engineRowsOf(investigationId);
        const transcripts = await llmTranscriptsOf(investigationId);
        /** The check of one claim: its task, the revision it appended, its ledger rows and transcripts. */
        const checkOf = (claimId: string) => {
          const task = checks.find((candidate) => (candidate.input as { claimId: string }).claimId === claimId)!;
          return {
            task,
            revision: claims.find((row) => row.claimId === claimId && row.taskId === task.taskId)!,
            calls: llmCalls.filter((row) => row.taskId === task.taskId),
            transcripts: transcripts.filter((row) => row.taskId === task.taskId),
          };
        };
        return { resourceId, investigationId, pageIds, claimIds, checks, checkOf, sourceCallsBeforeCheck };
      } finally {
        seeded.open();
      }
    }

    type ClaimCheckRun = Awaited<ReturnType<typeof checkClaims>>;

    /** The stored fields of a check revision, with the outcome its task reported. */
    const storedCheck = ({ task, revision }: ReturnType<ClaimCheckRun['checkOf']>) => ({
      status: revision.status,
      claimType: revision.claimType,
      confidence: revision.confidence,
      evidenceIds: revision.evidenceIds,
      assessment: revision.assessment,
      pointer: revision.pointer,
      outcome: (task.outcome as { answerOrDelta: unknown }).answerOrDelta,
    });

    it('INT-1 V1: a confirmed claim is stored supported with the group of its profile from the table and the basis of its checked records, after one verifier call that saw only the pointed records and no re-fetch', async () => {
      const text = '412 timeout errors from 19:40 to 20:15';
      const answer = assessment({
        support: 'yes',
        claimType: 'quantitative',
        records: [0, 1, 2, 3].map((record) => ({ record, relation: 'supports' })),
      });
      const run = await checkClaims({
        pages: { count: countPage(412), log: LOG_PAGE },
        claims: (page) => [
          {
            text,
            atoms: [
              { kind: 'service', value: 'payment-api' },
              { kind: 'number', value: '412' },
              { kind: 'interval', value: INTERVAL },
            ],
            pointer: [
              { pageId: page.count!, records: [0] },
              { pageId: page.log!, records: [0, 1, 2] },
            ],
          },
        ],
        answers: new Map([[text, [answer]]]),
      });
      const [claimId] = run.claimIds;
      const check = run.checkOf(claimId!);

      expect(run.checks.map((task) => [task.workflowVersion, task.status])).toEqual([[2, 'succeeded']]);
      expect(storedCheck(check)).toEqual({
        status: 'supported',
        claimType: 'quantitative',
        confidence: 'high',
        evidenceIds: [run.pageIds.count, run.pageIds.log],
        assessment: { answer, invalidForm: false },
        pointer: [
          { pageId: run.pageIds.count, records: [0] },
          { pageId: run.pageIds.log, records: [0, 1, 2] },
        ],
        outcome: { claimId, status: 'supported', reason: null },
      });
      expect(check.revision.atoms).toEqual([
        { kind: 'service', value: 'payment-api', verdict: 'found' },
        { kind: 'number', value: '412', verdict: 'found' },
        { kind: 'interval', value: INTERVAL, verdict: 'found' },
      ]);
      // One verifier call that saw exactly the four pointed records, numbered from 0, and nothing else of the two pages.
      const [call, ...moreCalls] = harness.model.callsOf('verifier');
      expect(moreCalls).toEqual([]);
      expect(verifierPacketOf(call!)).toEqual({
        claimText: text,
        records: [
          { number: 0, record: { key: 'payment-api', count: 412 } },
          { number: 1, record: LOG_PAGE[0] },
          { number: 2, record: LOG_PAGE[1] },
          { number: 3, record: LOG_PAGE[2] },
        ],
      });
      // AC-12.3: the check task holds the answered verifier transcript behind the status; the call was reserved and settled.
      expect(check.calls.map((row) => [row.role, row.status])).toEqual([['verifier', 'settled']]);
      expect(check.transcripts.map((row) => [row.role, row.outcome, row.llmCallId])).toEqual([['verifier', 'answered', check.calls[0]!.callId]]);
      // No re-fetch: the check made no source call.
      expect(harness.countingSource.calls).toHaveLength(run.sourceCallsBeforeCheck);
      // The run record carries the new claim fields and the check task.
      const record = await readRunRecord(harness.db, { investigationId: run.investigationId, ownerId: run.resourceId });
      expect(record.outcome === 'found' ? record.record.claims : record).toEqual([
        expect.objectContaining({
          claimId,
          status: 'supported',
          pointer: check.revision.pointer,
          claimType: 'quantitative',
          confidence: 'high',
          assessment: { answer, invalidForm: false },
          checkTaskId: check.task.taskId,
        }),
      ]);
    }, 60_000);

    it('INT-1 V2: a pointer past the page, to another investigation, to another owner and an empty pointer each end insufficient pointer_invalid with no verifier call and no ledger row', async () => {
      const owner = newUser();
      const ownersOtherPage = await pageOfAnotherInvestigation(owner);
      const strangersPage = await pageOfAnotherInvestigation(newUser());
      harness.model.reset();
      const pointers = (page: Partial<Record<Page, string>>) => [
        [{ pageId: page.log!, records: [LOG_PAGE.length] }],
        [{ pageId: ownersOtherPage, records: [0] }],
        [{ pageId: strangersPage, records: [0] }],
        [],
      ];
      const run = await checkClaims({
        owner,
        pages: { log: LOG_PAGE },
        claims: (page) => pointers(page).map((pointer, index) => ({ text: `V2 claim ${index}`, atoms: [{ kind: 'service', value: 'payment-api' }], pointer })),
      });

      expect(run.checks.map((task) => task.status)).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded']);
      expect(run.claimIds.map((claimId) => storedCheck(run.checkOf(claimId)))).toEqual(
        pointers(run.pageIds).map((pointer, index) => ({
          status: 'insufficient',
          claimType: null,
          confidence: null,
          evidenceIds: [],
          // No call decided it: no answer, and the reason is kept in the stored assessment.
          assessment: { answer: null, invalidForm: false, reason: 'pointer_invalid' },
          pointer,
          outcome: { claimId: run.claimIds[index], status: 'insufficient', reason: 'pointer_invalid' },
        })),
      );
      expect(harness.model.callsOf('verifier')).toEqual([]);
      expect(run.claimIds.flatMap((claimId) => [...run.checkOf(claimId).calls, ...run.checkOf(claimId).transcripts])).toEqual([]);
    }, 90_000);

    it('INT-1 V3: an off-form assessment (a value outside the list, yes without a supporting record, a record number never given) is retried once and then ends insufficient invalid_assessment, never supported', async () => {
      const outsideList = assessment({ support: 'maybe', claimType: 'observation', records: [{ record: 0, relation: 'supports' }] });
      const yesWithoutSupport = assessment({ support: 'yes', claimType: 'observation', records: [{ record: 0, relation: 'unrelated' }] });
      const numberNeverGiven = assessment({ support: 'yes', claimType: 'observation', records: [{ record: 5, relation: 'supports' }] });
      const inForm = assessment({ support: 'yes', claimType: 'observation', records: [{ record: 0, relation: 'supports' }] });
      const texts = ['V3 a value outside the list', 'V3 yes without a supporting record', 'V3 a record number never given', 'V3 off the form once'];
      const run = await checkClaims({
        pages: { log: LOG_PAGE },
        claims: (page) => texts.map((text) => ({ text, atoms: [{ kind: 'service', value: 'payment-api' }], pointer: [{ pageId: page.log!, records: [0] }] })),
        answers: new Map<string, unknown[]>([
          [texts[0]!, [outsideList, outsideList]],
          [texts[1]!, [yesWithoutSupport, yesWithoutSupport]],
          [texts[2]!, [numberNeverGiven, numberNeverGiven]],
          [texts[3]!, [yesWithoutSupport, inForm]],
        ]),
      });
      const checks = run.claimIds.map((claimId) => run.checkOf(claimId));

      const offForm = (answer: unknown) => ({ answer, invalidForm: true });
      expect(checks.map((check) => [check.revision.status, check.revision.assessment, (check.task.outcome as { answerOrDelta: unknown }).answerOrDelta])).toEqual([
        // The schema refused it twice at the gateway: no answer in form is left to store.
        ['insufficient', offForm(null), { claimId: run.claimIds[0], status: 'insufficient', reason: 'invalid_assessment' }],
        ['insufficient', offForm(yesWithoutSupport), { claimId: run.claimIds[1], status: 'insufficient', reason: 'invalid_assessment' }],
        ['insufficient', offForm(numberNeverGiven), { claimId: run.claimIds[2], status: 'insufficient', reason: 'invalid_assessment' }],
        ['supported', { answer: inForm, invalidForm: false }, { claimId: run.claimIds[3], status: 'supported', reason: null }],
      ]);
      // Exactly two verifier calls per check, each reserved and transcribed, and no third.
      expect(checks.map((check) => check.transcripts.map((row) => [row.role, row.outcome]))).toEqual([
        [['verifier', 'invalid_output'], ['verifier', 'invalid_output']],
        [['verifier', 'answered'], ['verifier', 'answered']],
        [['verifier', 'answered'], ['verifier', 'answered']],
        [['verifier', 'answered'], ['verifier', 'answered']],
      ]);
      expect(checks.map((check) => check.calls.map((row) => row.status))).toEqual(texts.map(() => ['settled', 'settled']));
      expect(harness.model.callsOf('verifier')).toHaveLength(8);
    }, 60_000);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2  The answer is assembled from stored facts, written once with its message, and the message is read back for delivery
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-09.1: "Given synthesis приписал установленному выводу запись, которая не участвовала в его проверке, Then в ответе этой ссылки нет."
  // AC-14.1 (placement half): "...оно стоит в «Предположениях» и никогда - в «Установлено»."
  // AC-16.1: "Given ответ со сводкой выдан, Then каждый пункт сводки дословно совпадает с текстом принятого утверждения этого ответа."
  // AC-16.2: "Given synthesis выбрал для сводки непринятое утверждение, например из «Предположений», Then этого утверждения в сводке нет."
  // AC-16.3: "Given в ответе нет принятых утверждений, Then сводки в ответе нет."
  // AC-16.4: "Given расследование остановлено принудительно, например кончился бюджет, и ответ собрал код без synthesis, Then сводки в ответе нет: утверждения для неё synthesis не выбирал."
  // DC-4 (FR-09): "Ссылки установленного вывода - ровно основа его проверки из последней ревизии; ссылки, которые synthesis написала у этого вывода в черновике, в ответ не попадают."
  // DC-12 (FR-16): "Сводка - не больше трёх пунктов, в порядке выбора synthesis, без повторов; идентификаторы, которых нет среди принятых утверждений ответа, отбрасываются молча."
  // DC-13 (FR-16): "В режиме без источников сводки нет."
  // Use cases: UC-4, UC-5, UC-6, UC-12, UC-E4, UC-E5, UC-E6. KD-4, KD-8. Flow 2. Invariants 2, 3, 4, 9.
  //
  // Primary failure mode (turns red when): a link written by synthesis in the draft reaches the answer; a `causal` claim is placed in `established` or chosen for the summary; a summary item is a model-written text, a repeated item, a fourth item, an unknown id's text or a
  // not-accepted claim; the summary appears in a code-built answer or when no claim is accepted; the group of a claim is recomputed instead of read from its revision (a code-built answer after a forced stop shows another group); the text and the metadata of the message
  // differ (a group word in one and not the other); the answer is written twice or without its message; `readAnswerMessage` returns a message that carries a summary, group words or the causal label for an answer written before this part, or `readInvestigation` reads
  // records; the no-source answer shows a summary or a group.
  // Behavior: `research.synthesize` reads claims with status, group and pointer -> the stub returns the closed draft -> `screenDraft` takes references from the stored basis, `composeAnswer` builds summary items from stored texts and groups -> `buildResearchAnswer` builds text and
  //   metadata from the one answer and the page details -> `answerRepository` writes both once -> the investigation closes -> `readAnswerMessage` returns the stored message
  // @category: core-functionality
  // @dependency: research.synthesize, screenDraft, composeAnswer, buildResearchAnswer, answerRepository, readInvestigation, readAnswerMessage, EvidenceReader, InvestigationService.closeInTx, scripted model, Postgres
  // @complexity: high
  //
  // Verification items (table; investigations are prepared with `seedClaim` revisions and, in A1, with real INT-1-style verification of one claim; every row asserts on `research_engine_runs.answer`, `InvestigationView.answer`, the `readAnswerMessage` result and, where
  // named, the count of evidence-content reads):
  // - A1 mixed answer (UC-4, UC-5, UC-6, AC-09.1, AC-14.1, AC-16.1, AC-16.2, DC-4, DC-10, DC-12, Invariants 2, 3, 4, 9): Given claims s1 (high, basis page P1), s2 (medium, basis P2), s3 (low), c1 (causal) and i1 (insufficient); a synthesis draft that puts c1, s1, s2 and s3 in the
  //   answer, attaches to s1 a pointer that also names page P3 of the same investigation, and chooses `summaryClaimIds` = [c1, s2, s1, s2, an id that exists nowhere] -> `established` holds s1, s2, s3 with `confidence` high, medium, low and `evidenceIds` [P1], [P2], [P4] (P4 is the basis of s3);
  //   s1 has no P3; `assumed` holds c1 with `causal` true and `verified` true; `unknown` holds i1; `summaryItems` = [s2, s1] with the stored texts verbatim equal to those in `established` and the groups medium, high; `summary` is null; `readAnswerMessage` returns text and metadata where the
  //   metadata items and groups equal the view's, the text carries, as literals from the UXRD, the caption «Главное из установленного», the words «уверенность средняя» and «уверенность высокая» next to s2 and s1 and the label «причинная связь не доказана» next to c1, and no `launch`; the answer row was written once
  //   with the message in the same row
  // - A2 nothing accepted (UC-12, AC-16.3): removed by the test audit; owned by the summary rows of `reference-gateway.spec.ts` (only ids that are not accepted: no summary) and the builder row without items
  // - A3 forced stop (UC-E4, AC-16.4): two `supported` claims with groups and one `causal`, the controller stops with `step_limit` -> the code-built answer has the two in `established` with their stored groups, the causal one in `assumed`, `summaryItems` empty, no synthesis call, a stored message without the caption
  // - A4 no sources (UC-E6, DC-13): an engine without sources, a draft with two claims and one chosen for the summary -> both in `assumed` with no group and no causal flag, `summaryItems` empty, the message starts with the warning that sources are not connected
  // - A5 answer written before this part (UC-E5, KD-8): an `answer` row in the old shape (a `summary` string, no groups, no message) and a stored old claim in `established` -> `readInvestigation` parses it with `summaryItems` empty and `confidence` null and reads no evidence content; `readAnswerMessage` returns a
  //   message built now with no summary caption, no group words and no causal label, with its sections, footnotes and source list, and metadata `summary` null; the stored row is unchanged; a foreign owner gets `investigation_not_found`, an unfinished investigation gets `no_answer`
  describe('INT-2', () => {
    let harness: EngineHarness;

    beforeAll(async () => {
      harness = await createEngineHarness({ processes: TEST_PROCESSES });
    });

    afterAll(async () => {
      await harness?.close();
      await closeEngineDb();
    });

    beforeEach(() => {
      harness.model.reset();
      harness.countingSource.calls.length = 0;
    });

    afterEach(async () => {
      try {
        expect(harness.model.pending()).toEqual({ plan: 0, controller: 0, worker: 0, verifier: 0, synthesis: 0 });
      } finally {
        await harness.cancelStarted();
      }
    });

    /** Texts the code builds, as literals of the UXRDs (deep-research MC-23–MC-33, agent-quality MC-1, MC-2, MC-3). */
    const SOURCE_LINE = 'fixture · search_logs · counting-v1';
    const CAPTION = '### Главное из установленного';
    const evidenceOf = (page: number) => ({
      output: {
        kind: 'requestEvidence',
        rationale: `collect page ${page}`,
        sourceId: 'fixture',
        toolName: 'search_logs',
        args: { service: 'payment-api', page },
        completeness: 'all',
      },
    });

    function waitFor<T>(what: string, read: () => Promise<T | undefined>): Promise<T> {
      return vi.waitFor(
        async () => {
          const value = await read();
          if (value === undefined) throw new Error(`waiting for ${what}`);
          return value;
        },
        { timeout: 30_000, interval: 50 },
      );
    }

    const finished = (investigationId: string, resourceId: string) =>
      waitFor('the end of the investigation', async () => {
        const read = await harness.engine.readInvestigation({ investigationId, resourceId });
        return read.outcome === 'found' && read.view.status !== 'running' ? read.view : undefined;
      });

    /** Starts an investigation of `resourceId` under a new launch key; returns its id and that key. */
    async function start(resourceId: string, query: string, processId = 'deep-research') {
      const threadId = await harness.createThread(resourceId);
      const launchKey = newLaunchKey();
      const started = await harness.engine.startInvestigation({ resourceId, threadId, query, processId, launchKey });
      if (started.outcome === 'rejected') throw new Error(`start refused: ${started.code}`);
      return { investigationId: started.investigationId, launchKey };
    }

    /** A claim the test seeds with its checked revision: the status, group and basis a check would have stored. */
    interface CheckedClaim {
      readonly text: string;
      readonly status: SeededRevision['status'];
      readonly confidence: SeededRevision['confidence'];
      /** Indexes of the gathered pages its revision rests on. */
      readonly basis: readonly number[];
    }

    interface Ids {
      claimIds: string[];
      pageIds: string[];
    }

    /**
     * An investigation that gathers `pages` pages and then, while its next controller step is held, gets the test's
     * checked claims; the held step then answers `next`. `synthesis`, when given, is the draft of the synthesis `next`
     * starts. Returns once the investigation has ended.
     */
    async function answered(options: {
      readonly query: string;
      readonly processId?: string;
      readonly pages: number;
      readonly claims: readonly CheckedClaim[];
      readonly next: unknown;
      readonly synthesis?: (ids: Ids) => unknown;
    }) {
      harness.countingSource.answerWith((call) => [{ key: 'payment-api', count: 412, page: call.args['page'] }]);
      const ids: Ids = { claimIds: [], pageIds: [] };
      const seeded = latch();
      const pageSteps = Array.from({ length: options.pages }, (_, page) => evidenceOf(page));
      harness.model.script('controller', ...pageSteps, { output: options.next, holdUntil: seeded.wait });
      const { synthesis } = options;
      if (synthesis !== undefined) harness.model.script('synthesis', { output: () => synthesis(ids) });
      const resourceId = newUser();
      try {
        const { investigationId, launchKey } = await start(resourceId, options.query, options.processId);
        const fetches = await waitFor('the pages', async () => {
          const found = (await tasksOf(investigationId)).filter((task) => task.workflowType === 'source.fetch' && task.status === 'succeeded');
          return found.length === options.pages ? found : undefined;
        });
        const fetchOf = (page: number) => fetches.find((task) => (task.input as { args: { page: number } }).args.page === page)!;
        ids.pageIds = Array.from({ length: options.pages }, (_, page) => fetchOf(page).outputRefs[0]!);
        const pagesOf = (basis: readonly number[]) => basis.map((page) => ids.pageIds[page]!);
        const [controller] = await tasksOf(investigationId);
        ids.claimIds = await harness.seedClaims({
          investigationId,
          taskId: controller!.taskId,
          claims: options.claims.map(({ text, basis }) => ({ text, atoms: [], pointer: pagesOf(basis).map((pageId) => ({ pageId, records: [0] })) })),
        });
        await harness.seedRevisions({
          investigationId,
          taskId: fetchOf(0).taskId,
          revisions: options.claims.map(({ text, status, confidence, basis }, index) => ({
            claimId: ids.claimIds[index]!,
            text,
            status,
            confidence,
            evidenceIds: pagesOf(basis),
          })),
        });
        seeded.open();
        const view = await finished(investigationId, resourceId);
        return { resourceId, investigationId, launchKey, view, ...ids };
      } finally {
        seeded.open();
      }
    }

    /** A synthesis draft claim that states the seeded claim `claimId` in its own words, its pointer naming `pageIds`. */
    const stated = (claimId: string, text: string, pageIds: readonly string[]) => ({
      claimId,
      text: `${text}, as the draft words it`,
      atoms: [],
      pointer: pageIds.map((pageId) => ({ pageId, records: [0] })),
    });

    /** The `answer` column of the investigation's engine row, as stored. */
    const storedAnswerOf = async (investigationId: string): Promise<Record<string, unknown>> => {
      const { run } = await engineRowsOf(investigationId);
      return run!.answer as Record<string, unknown>;
    };

    async function messageOf(investigationId: string, resourceId: string) {
      const read = await harness.engine.readAnswerMessage({ investigationId, resourceId });
      if (read.outcome !== 'found') throw new Error(`readAnswerMessage refused: ${read.code}`);
      return read.message;
    }

    it('INT-2 A1: the answer takes references from the stored basis, keeps a causal claim out of established and summary, builds the summary from stored texts and groups, and its message text and metadata say the same', async () => {
      const query = 'INT-2 A1: why did the payments time out?';
      const S1 = 'payment-api logged 412 timeouts from 19:40 to 20:15';
      const S2 = 'the timeouts hit only the calls to PayGate';
      const S3 = 'PayGate answered within 5 s before 19:40';
      const C1 = 'release 4.2 caused the timeouts';
      const I1 = 'whether the mobile clients were affected';
      const run = await answered({
        query,
        // Pages 0 to 4: P1, P2, P3, P4 and the basis of c1.
        pages: 5,
        claims: [
          { text: S1, status: 'supported', confidence: 'high', basis: [0] },
          { text: S2, status: 'supported', confidence: 'medium', basis: [1] },
          { text: S3, status: 'supported', confidence: 'low', basis: [3] },
          { text: C1, status: 'causal', confidence: null, basis: [4] },
          { text: I1, status: 'insufficient', confidence: null, basis: [] },
        ],
        next: { kind: 'proposeAnswer', rationale: 'the claims are checked' },
        synthesis: ({ claimIds: [s1, s2, s3, c1, i1], pageIds: [p1, p2, p3, p4, p5] }) => ({
          outcome: 'answered',
          // c1 is causal, the second s2 repeats, the last id names nothing: the summary items are s2 and s1.
          summaryClaimIds: [c1, s2, s1, s2, randomUUID()],
          claims: [
            stated(c1!, C1, [p5!]),
            // DC-4: the draft attaches page P3 to s1, whose basis is P1 only.
            stated(s1!, S1, [p1!, p3!]),
            stated(s2!, S2, [p2!]),
            stated(s3!, S3, [p4!]),
            stated(i1!, I1, [p1!]),
          ],
        }),
      });
      const [s1, s2, s3, c1, i1] = run.claimIds;
      const [p1, p2, , p4, p5] = run.pageIds;

      expect(run.view.status).toBe('completed');
      expect(run.view.answer).toEqual({
        answerId: expect.any(String),
        outcome: 'answered',
        stopReason: null,
        summary: null,
        summaryItems: [
          { claimId: s2, text: S2, confidence: 'medium' },
          { claimId: s1, text: S1, confidence: 'high' },
        ],
        established: [
          { claimId: s1, text: S1, evidenceIds: [p1], verified: true, confidence: 'high' },
          { claimId: s2, text: S2, evidenceIds: [p2], verified: true, confidence: 'medium' },
          { claimId: s3, text: S3, evidenceIds: [p4], verified: true, confidence: 'low' },
        ],
        assumed: [{ claimId: c1, text: C1, evidenceIds: [p5], verified: true, causal: true }],
        unknown: [{ claimId: i1, text: I1, evidenceIds: [], verified: false }],
        removed: [],
      });

      // The delivery read returns the message stored with the answer: it reads no page, it builds nothing now.
      harness.evidenceReads.length = 0;
      const message = await messageOf(run.investigationId, run.resourceId);
      expect(harness.evidenceReads).toEqual([]);
      expect(message.text).toBe(
        [
          '**Ответ ресерча** · Есть ответ',
          `Цель: ${query}`,
          '',
          CAPTION,
          `- ${S2} (уверенность средняя)`,
          `- ${S1} (уверенность высокая)`,
          '',
          '### Установлено',
          `- ${S1} [1] (уверенность высокая)`,
          `- ${S2} [2] (уверенность средняя)`,
          `- ${S3} [3] (уверенность низкая)`,
          '',
          '### Предположения',
          `- ${C1} [4] (причинная связь не доказана)`,
          '',
          '### Не выяснено',
          `- ${I1} (не проверено)`,
          '',
          '### Источники (4)',
          `1. ${SOURCE_LINE}`,
          `2. ${SOURCE_LINE}`,
          `3. ${SOURCE_LINE}`,
          `4. ${SOURCE_LINE}`,
        ].join('\n'),
      );
      // Invariant 9: the metadata carries the items, groups and causal flag the text shows, and no `launch`.
      const source = { sourceId: 'fixture', toolName: 'search_logs', snapshot: 'counting-v1', truncated: false };
      expect(message.metadata).toEqual({
        launchKey: run.launchKey,
        goal: query,
        summary: null,
        summaryItems: [
          { claimId: s2, text: S2, confidence: 'medium' },
          { claimId: s1, text: S1, confidence: 'high' },
        ],
        outcome: 'answered',
        stopReason: null,
        established: [
          { text: S1, footnotes: [1], verified: true, confidence: 'high', causal: false },
          { text: S2, footnotes: [2], verified: true, confidence: 'medium', causal: false },
          { text: S3, footnotes: [3], verified: true, confidence: 'low', causal: false },
        ],
        assumed: [{ text: C1, footnotes: [4], verified: true, confidence: null, causal: true }],
        unknown: [{ text: I1, footnotes: [], verified: false, confidence: null, causal: false }],
        sources: [1, 2, 3, 4].map((number) => ({ number, ...source })),
        sourceMode: 'sources',
      });
      // One row holds the answer and that message; one synthesis wrote it.
      const stored = await storedAnswerOf(run.investigationId);
      expect(stored['answerId']).toBe(run.view.answer!.answerId);
      expect(stored['message']).toEqual(message);
      expect((await tasksOf(run.investigationId)).filter((task) => task.workflowType === 'research.synthesize')).toHaveLength(1);
    }, 60_000);

    it('INT-2 A3: an answer built by code after a forced stop keeps the stored groups, puts no causal claim in established and has no summary', async () => {
      const query = 'INT-2 A3: why did the payments time out?';
      const S1 = 'payment-api logged 412 timeouts from 19:40 to 20:15';
      const S2 = 'the timeouts hit only the calls to PayGate';
      const C1 = 'release 4.2 caused the timeouts';
      // `two-steps`: the page is step 1, a replan step 2, and step 3 is not taken — code answers with `step_limit`.
      const run = await answered({
        query,
        processId: 'two-steps',
        pages: 1,
        claims: [
          { text: S1, status: 'supported', confidence: 'high', basis: [0] },
          { text: S2, status: 'supported', confidence: 'medium', basis: [0] },
          { text: C1, status: 'causal', confidence: null, basis: [0] },
        ],
        next: { kind: 'replan', rationale: 'one more branch', reason: 'the claims are checked' },
      });
      const [s1, s2] = run.claimIds;
      const [p1] = run.pageIds;

      expect(harness.model.callsOf('synthesis')).toEqual([]);
      const answer = run.view.answer!;
      expect(answer).toMatchObject({ outcome: 'partial', stopReason: 'step_limit', summary: null, summaryItems: [], assumed: [], unknown: [] });
      // The code answer lists the supported claims in the order it reads them, with their stored groups.
      expect([...answer.established!].sort((left, right) => left.text.localeCompare(right.text))).toEqual([
        { claimId: s1, text: S1, evidenceIds: [p1], verified: true, confidence: 'high' },
        { claimId: s2, text: S2, evidenceIds: [p1], verified: true, confidence: 'medium' },
      ]);
      const message = await messageOf(run.investigationId, run.resourceId);
      const lineOf = new Map([
        [S1, `- ${S1} [1] (уверенность высокая)`],
        [S2, `- ${S2} [1] (уверенность средняя)`],
      ]);
      expect(message.text).toBe(
        [
          '**Ответ ресерча** · Частичный ответ',
          `Цель: ${query}`,
          'Остановлен: достигнут лимит шагов',
          '',
          '### Установлено',
          ...answer.established!.map((claim) => lineOf.get(claim.text)),
          '',
          '### Источники (1)',
          `1. ${SOURCE_LINE}`,
        ].join('\n'),
      );
      expect(message.metadata).toMatchObject({ summary: null, summaryItems: [], assumed: [] });
      expect(message.metadata.established.map((claim) => [claim.text, claim.confidence])).toEqual(
        answer.established!.map((claim) => [claim.text, claim.confidence]),
      );
      // The message is the one written with the code answer.
      expect((await storedAnswerOf(run.investigationId))['message']).toEqual(message);
    }, 60_000);

    it('INT-2 A4: the no-source answer has no group, no causal flag and no summary', async () => {
      await harness.rebuildEngine({ connectedSources: [] });
      try {
        const query = 'INT-2 A4: why did the payments time out?';
        const draftClaim = (text: string) => ({ claimId: null, text, atoms: [], pointer: [] });
        harness.model.script('synthesis', {
          output: {
            outcome: 'answered',
            // A new claim has no id the draft could choose; the chosen id names nothing.
            summaryClaimIds: [randomUUID()],
            claims: [draftClaim('A4 retries need backoff'), draftClaim('A4 the provider limits the rate')],
          },
        });
        const resourceId = newUser();
        const { investigationId } = await start(resourceId, query);
        const view = await finished(investigationId, resourceId);

        expect(view).toMatchObject({ status: 'completed', sourceMode: 'model_knowledge' });
        expect(view.answer).toMatchObject({
          outcome: 'answered',
          summary: null,
          summaryItems: [],
          established: [],
          assumed: [
            { text: 'A4 retries need backoff', evidenceIds: [], verified: false, causal: false },
            { text: 'A4 the provider limits the rate', evidenceIds: [], verified: false, causal: false },
          ],
        });
        const message = await messageOf(investigationId, resourceId);
        expect(message.text).toBe(
          [
            'Источники данных не подключены — ответ опирается только на знания модели и не проверен по данным.',
            '',
            '**Ответ ресерча** · Есть ответ',
            `Цель: ${query}`,
            '',
            '### Предположения',
            '- A4 retries need backoff (из знаний модели, без источника)',
            '- A4 the provider limits the rate (из знаний модели, без источника)',
          ].join('\n'),
        );
        expect(message.metadata).toMatchObject({
          summary: null,
          summaryItems: [],
          sourceMode: 'model_knowledge',
          sources: [],
          assumed: [
            { text: 'A4 retries need backoff', footnotes: [], verified: false, confidence: null, causal: false },
            { text: 'A4 the provider limits the rate', footnotes: [], verified: false, confidence: null, causal: false },
          ],
        });
      } finally {
        await harness.rebuildEngine({ connectedSources: [COUNTING_SOURCE_ID] });
      }
    }, 60_000);

    it('INT-2 A5: an answer written before this part is read without errors and delivered with no summary, no group words and no causal label, with no evidence read by the status read', async () => {
      const query = 'INT-2 A5: why did the payments time out?';
      const run = await answered({
        query,
        pages: 1,
        claims: [],
        next: { kind: 'concludeInconclusive', rationale: 'scripted conclusion' },
      });
      const [p1] = run.pageIds;
      // The answer as the engine wrote it before agent-quality: a summary string; no items, groups, causal flags or message.
      // Its established claim is causal in meaning, as the earlier check could leave it (UXRD KD-7).
      const old = {
        answerId: run.view.answer!.answerId,
        outcome: 'answered',
        stopReason: null,
        summary: 'The old synthesis retold the answer.',
        established: [{ claimId: randomUUID(), text: 'A5 release 4.2 caused the timeouts', evidenceIds: [p1], verified: true }],
        assumed: [{ claimId: randomUUID(), text: 'A5 the cache was cold', evidenceIds: [p1], verified: false }],
        unknown: [],
        removed: [],
      };
      await harness.db.update(researchEngineRuns).set({ answer: old }).where(eq(researchEngineRuns.investigationId, run.investigationId));

      // The status read parses the old answer with the new fields empty, and reads no page.
      harness.evidenceReads.length = 0;
      const status = await harness.engine.readInvestigation({ investigationId: run.investigationId, resourceId: run.resourceId });
      expect(status.outcome === 'found' ? status.view.answer : status).toMatchObject({
        summary: 'The old synthesis retold the answer.',
        summaryItems: [],
        established: [{ text: 'A5 release 4.2 caused the timeouts', confidence: null }],
        assumed: [{ text: 'A5 the cache was cold', causal: false }],
      });
      expect(harness.evidenceReads).toEqual([]);

      // The delivery read builds the message now (UXRD KD-7), from the page details it reads.
      const message = await messageOf(run.investigationId, run.resourceId);
      expect(harness.evidenceReads).toEqual([p1]);
      expect(message.text).toBe(
        [
          '**Ответ ресерча** · Есть ответ',
          `Цель: ${query}`,
          '',
          '### Установлено',
          '- A5 release 4.2 caused the timeouts [1]',
          '',
          '### Предположения',
          '- A5 the cache was cold [1] (не проверено)',
          '',
          '### Источники (1)',
          `1. ${SOURCE_LINE}`,
        ].join('\n'),
      );
      expect(message.metadata).toMatchObject({
        summary: null,
        summaryItems: [],
        established: [{ text: 'A5 release 4.2 caused the timeouts', footnotes: [1], verified: true, confidence: null, causal: false }],
        assumed: [{ text: 'A5 the cache was cold', footnotes: [1], verified: false, confidence: null, causal: false }],
      });
      // The stored row is left as it was: the message is built for this read only.
      expect(await storedAnswerOf(run.investigationId)).toEqual(old);

      // Refusals: another owner, and an investigation not completed with an answer yet.
      expect(await harness.engine.readAnswerMessage({ investigationId: run.investigationId, resourceId: newUser() })).toEqual({
        outcome: 'rejected',
        code: 'investigation_not_found',
      });
      const held = latch();
      harness.model.script('controller', { output: { kind: 'concludeInconclusive', rationale: 'scripted conclusion' }, holdUntil: held.wait });
      const owner = newUser();
      const { investigationId: running } = await start(owner, 'INT-2 A5: an investigation still running');
      try {
        expect(await harness.engine.readAnswerMessage({ investigationId: running, resourceId: owner })).toEqual({
          outcome: 'rejected',
          code: 'no_answer',
        });
      } finally {
        held.open();
      }
      await finished(running, owner);
    }, 60_000);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-3  A call that does not fit only because of other open reserves waits; one that does not fit its own spending is refused
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-10.1: "Given сценарий, фактический расход которого укладывается в бюджет, When worker работают параллельно, Then расследование не останавливается с причиной «бюджет исчерпан» до анализа записей."
  // AC-10.2: "Given бюджет исчерпан, Then новые вызовы модели, включая проверяющие, не начинаются."
  // DC-5 (FR-10): "Вызов, который не помещается только из-за открытых резервов других вызовов, ждёт и повторяет резерв раз в 2 секунды, пока не поместится, не придёт отказ `stopping` или не наступит `notAfter`; пока он ждёт, строки в журнале у него нет."
  // DC-8 (FR-12): "Утверждение, которое не удалось проверить из-за отказа резерва, отмены или `notAfter`, остаётся `unverified` и стоит в «Предположениях» с пометкой «не проверено»."
  // Use cases: UC-9, UC-E3. KD-5. Flow 4. Invariant 6.
  //
  // Primary failure mode (turns red when): the fourth of four parallel workers is refused `investigation_tokens_exhausted` because of the reserves of the other three, so its analysis task fails and the sub-question stays unanalysed; a waiting call leaves a ledger row; the spent
  // total exceeds the budget; a call whose own spending does not fit waits instead of being refused; a waiting call goes on after the stop or past `notAfter` and starts the model; a refused or cancelled verifier call leaves a revision instead of an `unverified` claim.
  // Behavior: the gateway asks `CallLedger.reserve` for the counted input plus margin plus the output ceiling -> `reserved` / `busy` / `refused` / `stopping` -> on `busy` it waits 2 seconds and asks again with the same counted input -> the model runs only after `reserved`
  // @category: core-functionality
  // @dependency: createModelGateway, postgresCallLedger.reserve, research.analyze, research.verify, InvestigationService.cancel, injected clock, scripted model, Postgres
  // @complexity: high
  //
  // Verification items (table; every row asserts on `research_llm_calls`, the run's `tokensSpent` and `tokensReserved`, `research_tasks` and the model double's calls, with literal expected values):
  // - B1 four workers, one budget (UC-9, AC-10.1, DC-5): Given budget 200 000, 20 000 already spent, four worker inputs of 40 000 with the role's margin and ceiling, replies that report 41 000 and a hold on the first three -> the fourth reserve is `busy` and writes no row while it waits; after the three close
  //   it is `reserved`; all four analysis tasks end `succeeded`, the investigation is not stopped with `budget_exhausted`, spent equals the sum of the actual figures and is not above the budget
  // - B2 own spending does not fit (UC-E3, AC-10.2, DC-8): spent plus the verifier's reserve is above the budget -> the reserve answers `refused` at once with no wait, no new row, no model call; the claim stays `unverified` with no new revision and the answer shows it in `assumed` with `verified` false
  // - B3 the wait ends (DC-5, DC-8): a call held as `busy` by an open reserve of another call (a) when the investigation is cancelled on the injected clock -> no call, no row, the task cancelled with no revision; (b) when `notAfter` of its decision passes -> no call, no row, the task ends with `deadline`
  describe('INT-3', () => {
    let harness: EngineHarness;

    beforeAll(async () => {
      // Four analysis tasks and the controller run at once: more slots and connections than the default two.
      harness = await createEngineHarness({ runtime: { concurrency: 6, dbPoolMax: 10 } });
    });

    afterAll(async () => {
      await harness?.close();
      await closeEngineDb();
    });

    beforeEach(() => {
      harness.model.reset();
      harness.countingSource.calls.length = 0;
      // The reserve wait (2 seconds, design-engine.md Runtime settings) is fired by the test, never slept.
      harness.engineClock.holdTimers = (ms) => ms === 2_000;
    });

    afterEach(async () => {
      harness.engineClock.offsetMs = 0;
      harness.tokenCounter.intercept = undefined;
      try {
        expect(harness.model.pending()).toEqual({ plan: 0, controller: 0, worker: 0, verifier: 0, synthesis: 0 });
      } finally {
        await harness.cancelStarted();
        harness.engineClock.holdTimers = undefined;
        for (const timer of harness.engineClock.heldTimers.splice(0)) timer.fire();
      }
    });

    const LOG_ROW = { ts: '2026-10-01T19:45:00.000Z', service: 'payment-api', level: 'error', event: 'timeout', traceId: 'a'.repeat(32) };
    /** The usage of a model call the ledger charges `tokens` for: input plus output, as the provider reports them. */
    const charged = (tokens: number) => ({ inputTokens: tokens - 1_000, outputTokens: 1_000 });
    const PLAN = { output: { readinessCriteria: ['the question is answered'], branches: [] }, usage: charged(10_000) };
    /** The role of a counted request by its output schema, as the model double tells the roles apart. */
    const hasOutput = (request: TokenCountRequest, property: string) =>
      property in ((request.outputSchema as { properties?: Record<string, unknown> }).properties ?? {});
    const isWorkerRequest = (request: TokenCountRequest) => hasOutput(request, 'claims');
    const isVerifierRequest = (request: TokenCountRequest) => hasOutput(request, 'records');
    /** Every count is 1 000 tokens but the given role's: a reserve is counted input + margin + output ceiling of the role. */
    const countAs = (role: (request: TokenCountRequest) => boolean, tokens: number) => {
      harness.tokenCounter.intercept = (request) => (role(request) ? tokens : 1_000);
    };

    function waitFor<T>(what: string, read: () => Promise<T | undefined> | T | undefined): Promise<T> {
      return vi.waitFor(
        async () => {
          const value = await read();
          if (value === undefined) throw new Error(`waiting for ${what}`);
          return value;
        },
        { timeout: 30_000, interval: 50 },
      );
    }

    async function start(query: string, tokenBudget: number) {
      const resourceId = newUser();
      const threadId = await harness.createThread(resourceId);
      const started = await harness.engine.startInvestigation({ resourceId, threadId, query, processId: 'deep-research', launchKey: newLaunchKey(), tokenBudget });
      if (started.outcome === 'rejected') throw new Error(`start refused: ${started.code}`);
      return { resourceId, investigationId: started.investigationId };
    }

    const finished = (investigationId: string, resourceId: string) =>
      waitFor('the end of the investigation', async () => {
        const read = await harness.engine.readInvestigation({ investigationId, resourceId });
        return read.outcome === 'found' && read.view.status !== 'running' ? read.view : undefined;
      });

    /** The one reserve wait the engine holds now, other than `fired` (a wait the test already fired). */
    const heldWait = (fired?: HeldTimer) =>
      waitFor('a reserve wait', () => {
        const [timer, ...more] = harness.engineClock.heldTimers;
        if (more.length > 0) throw new Error(`${more.length + 1} waits held at once`);
        return timer !== undefined && timer !== fired ? timer : undefined;
      });

    const ledgerOf = async (investigationId: string) => (await engineRowsOf(investigationId)).llmCalls;

    it('INT-3 B1: four parallel workers whose actual spending fits the budget all run, the fourth waiting on the open reserves without a ledger row and the spent total staying within the budget', async () => {
      // Budget 200 000; the plan and the first controller step charge 10 000 each. A worker reserves 40 000 counted +
      // 3 200 margin + 8 000 ceiling = 51 200: three fit (20 000 + 153 600), the fourth does not beside them, though
      // each worker charges only 41 000 (Flow 4).
      countAs(isWorkerRequest, 40_000);
      harness.countingSource.answerWith(() => [LOG_ROW]);
      const release = latch();
      const workerAnswer = { output: { claims: [] }, usage: charged(41_000) };
      harness.model.script('plan', PLAN);
      harness.model.script(
        'controller',
        {
          output: {
            kind: 'requestAnalysis',
            rationale: 'four services at once',
            subquestions: [1, 2, 3, 4].map((n) => ({
              text: `what did service-${n} log?`,
              sourceId: 'fixture',
              toolName: 'search_logs',
              args: { service: `service-${n}` },
              completeness: 'all',
            })),
          },
          usage: charged(10_000),
        },
        { output: { kind: 'concludeInconclusive', rationale: 'scripted conclusion' } },
      );
      harness.model.script('worker', ...[1, 2, 3].map(() => ({ ...workerAnswer, holdUntil: release.wait })), workerAnswer);
      try {
        const { resourceId, investigationId } = await start('INT-3 B1: why did four services slow down?', 200_000);

        // The first three hold their reserves in their model calls; the fourth waits on them.
        const firstWait = await heldWait();
        expect(firstWait.ms).toBe(2_000);
        const analyses = (await tasksOf(investigationId)).filter((task) => task.workflowType === 'research.analyze');
        expect(analyses).toHaveLength(4);
        const whileWaiting = await engineRowsOf(investigationId);
        const workerRows = whileWaiting.llmCalls.filter((row) => row.role === 'worker');
        expect(workerRows.map((row) => [row.status, row.reservedTokens])).toEqual([1, 2, 3].map(() => ['reserved', 51_200]));
        const [waiting, ...others] = analyses.filter((task) => !workerRows.some((row) => row.taskId === task.taskId));
        expect(others).toEqual([]);
        expect(whileWaiting.run).toMatchObject({ tokenBudget: 200_000, tokensSpent: 20_000, tokensReserved: 153_600 });
        expect(harness.model.callsOf('worker')).toHaveLength(3);
        expect((await llmTranscriptsOf(investigationId)).filter((row) => row.taskId === waiting!.taskId)).toEqual([]);

        // Two seconds on: the reserve is asked again with the same counted input — no new count — and is still busy.
        const workerCounts = harness.tokenCounter.requests.filter(isWorkerRequest).length;
        firstWait.fire();
        const secondWait = await heldWait(firstWait);
        expect(secondWait.ms).toBe(2_000);
        expect(harness.tokenCounter.requests.filter(isWorkerRequest)).toHaveLength(workerCounts);
        expect((await ledgerOf(investigationId)).filter((row) => row.taskId === waiting!.taskId)).toEqual([]);

        // The three answer and close their reserves; the next try fits.
        release.open();
        await waitFor('the three closed', async () => {
          const { run } = await engineRowsOf(investigationId);
          return run!.tokensReserved === 0 ? run : undefined;
        });
        secondWait.fire();
        const done = await finished(investigationId, resourceId);

        expect(done).toMatchObject({ status: 'completed', answer: { outcome: 'inconclusive', stopReason: null } });
        const analysed = (await tasksOf(investigationId)).filter((task) => task.workflowType === 'research.analyze');
        expect(analysed.map((task) => task.status)).toEqual(['succeeded', 'succeeded', 'succeeded', 'succeeded']);
        const { run, llmCalls } = await engineRowsOf(investigationId);
        expect(llmCalls.map((row) => [row.role, row.status, row.chargedTokens])).toEqual([
          ['plan', 'settled', 10_000],
          ['controller', 'settled', 10_000],
          ['worker', 'settled', 41_000],
          ['worker', 'settled', 41_000],
          ['worker', 'settled', 41_000],
          ['worker', 'settled', 41_000],
          ['controller', 'settled', 120],
        ]);
        // The waiting worker has the one row written once it fitted, with the input counted once.
        expect(llmCalls.filter((row) => row.taskId === waiting!.taskId).map((row) => row.countedInputTokens)).toEqual([40_000]);
        expect(harness.tokenCounter.requests.filter(isWorkerRequest)).toHaveLength(workerCounts);
        // Spent is the sum of the actual charges, within the budget.
        expect(run).toMatchObject({ tokensSpent: 184_120, tokensReserved: 0 });
        expect(harness.engineClock.heldTimers).toEqual([]);
      } finally {
        release.open();
      }
    }, 90_000);

    /**
     * An investigation that gathers one page, gets the test's claims over it while its second controller step is held,
     * and verifies them with that step; `next` are the controller's steps after it. The plan and the first two
     * controller steps charge 10 000 each.
     */
    async function verifying(options: {
      readonly query: string;
      readonly tokenBudget: number;
      readonly claims: readonly string[];
      readonly next?: readonly ScriptedStep[];
    }) {
      harness.countingSource.answerWith(() => [LOG_ROW]);
      let claimIds: string[] = [];
      const seeded = latch();
      harness.model.script('plan', PLAN);
      harness.model.script(
        'controller',
        {
          output: {
            kind: 'requestEvidence',
            rationale: 'collect the log page',
            sourceId: 'fixture',
            toolName: 'search_logs',
            args: { service: 'payment-api' },
            completeness: 'all',
          },
          usage: charged(10_000),
        },
        { output: () => ({ kind: 'requestVerification', rationale: 'check the claims', claimIds }), holdUntil: seeded.wait, usage: charged(10_000) },
        ...(options.next ?? []),
      );
      try {
        const { resourceId, investigationId } = await start(options.query, options.tokenBudget);
        const [fetch] = await waitFor('the page', async () => {
          const found = (await tasksOf(investigationId)).filter((task) => task.workflowType === 'source.fetch' && task.status === 'succeeded');
          return found.length === 1 ? found : undefined;
        });
        const [controller] = await tasksOf(investigationId);
        claimIds = await harness.seedClaims({
          investigationId,
          taskId: controller!.taskId,
          claims: options.claims.map((text) => ({ text, atoms: [{ kind: 'service', value: 'payment-api' }], pointer: [{ pageId: fetch!.outputRefs[0]!, records: [0] }] })),
        });
        seeded.open();
        return { resourceId, investigationId, claimIds };
      } finally {
        seeded.open();
      }
    }

    /** The check task of a claim and the statuses of the claim's revisions. */
    async function checkOf(investigationId: string, claimId: string) {
      const task = (await tasksOf(investigationId)).find(
        (candidate) => candidate.workflowType === 'research.verify' && (candidate.input as { claimId: string }).claimId === claimId,
      );
      const { claims } = await engineRowsOf(investigationId);
      return { task, revisions: claims.filter((row) => row.claimId === claimId).map((row) => row.status) };
    }

    it('INT-3 B2: a reserve that does not fit the spending alone is refused without waiting, leaves no call, and the claim stays unverified', async () => {
      // Budget 50 000, 30 000 spent when the check starts: the verifier reserves 20 000 counted + 1 600 + 4 000 = 25 600,
      // which does not fit beside the spending alone, while the controller step (1 000 + 1 600 + 8 000) and the synthesis
      // (1 000 + 2 400 + 8 000) that follow it do fit.
      countAs(isVerifierRequest, 20_000);
      const text = 'B2 payment-api logged the timeouts';
      let pointer: unknown = null;
      harness.model.script('synthesis', {
        output: () => ({ outcome: 'answered', summaryClaimIds: [], claims: [{ claimId: claimIds[0], text, atoms: [], pointer }] }),
      });
      const { resourceId, investigationId, claimIds } = await verifying({
        query: 'INT-3 B2: why did the payments time out?',
        tokenBudget: 50_000,
        claims: [text],
        next: [{ output: { kind: 'proposeAnswer', rationale: 'answer with what is checked' } }],
      });
      const check = await waitFor('the end of the check', async () => {
        const found = await checkOf(investigationId, claimIds[0]!);
        return found.task?.status === 'failed' ? found : undefined;
      });
      pointer = (await engineRowsOf(investigationId)).claims[0]!.pointer;
      const done = await finished(investigationId, resourceId);

      expect(check.task).toMatchObject({ failureReason: { class: 'budget_exhausted', code: 'investigation_tokens_exhausted' } });
      // No wait, no verifier call, no row and no transcript of the check; the claim keeps its one unverified revision.
      expect(harness.engineClock.heldTimers).toEqual([]);
      expect(harness.model.calls.map((call) => call.role)).toEqual(['plan', 'controller', 'controller', 'controller', 'synthesis']);
      const { run, llmCalls } = await engineRowsOf(investigationId);
      expect(llmCalls.map((row) => [row.role, row.status])).toEqual([
        ['plan', 'settled'],
        ['controller', 'settled'],
        ['controller', 'settled'],
        ['controller', 'settled'],
        ['synthesis', 'settled'],
      ]);
      expect((await llmTranscriptsOf(investigationId)).filter((row) => row.taskId === check.task!.taskId)).toEqual([]);
      expect((await checkOf(investigationId, claimIds[0]!)).revisions).toEqual(['unverified']);
      expect(run).toMatchObject({ tokensSpent: 30_240, tokensReserved: 0 });
      // DC-8: the answer shows the claim as not verified.
      expect(done).toMatchObject({ status: 'completed', answer: { stopReason: null, established: [], assumed: [{ claimId: claimIds[0], text, verified: false }] } });
    }, 60_000);

    it.each([
      ['the investigation is cancelled', 'cancel'],
      ['notAfter of its decision passes', 'deadline'],
    ] as const)('INT-3 B3: a call waiting on other reserves ends with no call and no row when %s', async (_case, end) => {
      // Budget 60 000, 30 000 spent: one verifier reserve of 25 600 fits, the second only once the first is closed.
      countAs(isVerifierRequest, 20_000);
      harness.model.script('verifier', { hangUntilAborted: true });
      const { resourceId, investigationId, claimIds } = await verifying({
        query: `INT-3 B3 ${end}: why did the payments time out?`,
        tokenBudget: 60_000,
        claims: ['B3 payment-api logged the timeouts', 'B3 payment-api retried the calls'],
      });
      const wait = await heldWait();
      const rows = await ledgerOf(investigationId);
      expect(rows.filter((row) => row.role === 'verifier').map((row) => row.status)).toEqual(['reserved']);
      const checks = await Promise.all(claimIds.map((claimId) => checkOf(investigationId, claimId)));
      const waitingIndex = checks.findIndex((check) => !rows.some((row) => row.taskId === check.task!.taskId));
      const { taskId } = checks[waitingIndex]!.task!;

      if (end === 'cancel') {
        await harness.runtime.investigations.cancel(investigationId, resourceId);
      } else {
        // Past the controller's deadline, so past notAfter of the verification decision and its tasks.
        harness.engineClock.offsetMs = 3_600_000;
        wait.fire();
      }
      await waitFor('the end of the waiting check', () => harness.endedRuns.find((ended) => ended.taskId === taskId));

      const after = await checkOf(investigationId, claimIds[waitingIndex]!);
      expect(after.task).toMatchObject(
        end === 'cancel' ? { status: 'cancelled' } : { status: 'failed', failureReason: { class: 'deadline', code: 'deadline' } },
      );
      // The wait ended without a call: the one verifier call is the other check's, and the waiting one has no row, no
      // transcript and no new revision.
      expect(harness.engineClock.heldTimers).toEqual([]);
      expect(harness.model.callsOf('verifier')).toHaveLength(1);
      expect((await ledgerOf(investigationId)).filter((row) => row.taskId === taskId)).toEqual([]);
      expect((await llmTranscriptsOf(investigationId)).filter((row) => row.taskId === taskId)).toEqual([]);
      expect(after.revisions).toEqual(['unverified']);
    }, 60_000);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-4  (extra) A retried controller step sees why its attempts were rejected, and the stable start of the controller input is cached
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-08.1: "Given код отклонил решение controller, Then транскрипт следующей попытки содержит причину отказа."
  // AC-18.1: "Given расследование прошло больше одного шага controller, Then в журнале вызовов шаги после первого стоят меньше, чем стоил бы тот же вход без повтора начала."
  // DC-3 (FR-08): "Вход повторной попытки шага содержит каждую отклонённую попытку этого шага - вид решения, если он был, и код причины, - в том числе попытки, записанные до перезапуска задачи."
  // DC-15 (FR-18): "Неизменный блок входа controller побайтно одинаков на всех шагах расследования, пока не сменилась ревизия плана, и запрос к провайдеру несёт метку кэша на его конце."
  // Use cases: UC-7, UC-8. KD-6. Flow 3. Invariant 7.
  //
  // Primary failure mode (turns red when): the retry's transcript has no rejection code, or only the attempts of the current process (a task restarted between the attempts loses the first rejection); the full rejected output enters the input; the stable block differs between steps
  // (a changing value placed before the mark), so nothing is cached; the mark sits on the whole request or on another role instead of the end of the stable block; the cache-read tokens of the second and third step are absent from the journal or are charged at the full price.
  // Behavior: the controller step is rejected by the code (`nothing_to_wait_for`, `kind_unknown`) -> the rejection is stored as a decision row of the step -> the retry builds its input from the stored rejections -> the stable block carries the cache mark at its end -> the provider reports cache-read
  //   tokens -> the journal charges them at the catalog price of a cache read
  // @category: core-functionality
  // @dependency: controller.handler, judgeControllerOutput, decisionsRepository, role-agent client, ModelGateway, cost catalog, research_decisions, research_llm_calls, research_llm_transcripts, scripted model, Postgres
  // @complexity: medium
  //
  // Verification items (table):
  // - K1 rejection is visible (UC-7, AC-08.1, DC-3): one step of three calls: the stub picks `wait` with nothing open (rejected `nothing_to_wait_for`), the controller task is restarted while its next call is held (`expireLease`),
  //   the new attempt's stub picks an unknown kind (rejected `kind_unknown`, kind null), then `concludeInconclusive`; the step has the three rows with their codes and the held call wrote none; the transcript input of the new attempt's first call carries the rejection recorded before the restart and of its second call both, as kind or null and code, never the rejected output
  // - K2 stable block and cache (UC-8, AC-18.1, DC-15, Invariant 7): three controller steps with no replan, the stub reporting cache-read tokens on the second and third call -> the stable block of the three transcript inputs is byte-identical, the stored input of each shows the mark on the end of that block and
  //   not on the whole request, the plan request carries no mark (the other roles: role-agent.spec.ts), and the journal rows of the second and third steps have the cache-read tokens with a charge below the charge of the same input at the full price
  describe('INT-4', () => {
    // A lease is lost only when a test moves it back (K1): no heartbeat beats within a test and the sweeper runs every
    // 50 ms. Two slots: the restarted controller attempt runs while the held one still sits in its model call.
    let harness: EngineHarness;

    beforeAll(async () => {
      harness = await createEngineHarness({
        runtime: { concurrency: 2, dbPoolMax: 8, leaseMs: 60_000, heartbeatMs: 60_000, reaperMs: 50 },
      });
    });

    afterAll(async () => {
      await harness?.close();
      await closeEngineDb();
    });

    beforeEach(() => {
      harness.model.reset();
      harness.countingSource.calls.length = 0;
    });

    afterEach(async () => {
      try {
        expect(harness.model.pending()).toEqual({ plan: 0, controller: 0, worker: 0, verifier: 0, synthesis: 0 });
      } finally {
        await harness.cancelStarted();
      }
    });

    const CONTROLLER_MODEL = (deepResearchProcessV2 as { roles: { controller: { model: string } } }).roles.controller.model;
    const MARK = { anthropic: { cacheControl: { type: 'ephemeral' } } };
    const conclude = { output: { kind: 'concludeInconclusive', rationale: 'scripted conclusion' } };

    /** A controller input as the transcript stores it: the instructions and the messages with their provider options. */
    interface StoredInput {
      readonly instructions: string;
      readonly messages: readonly { readonly role: string; readonly content: string; readonly providerOptions?: unknown }[];
    }
    const inputOf = (transcript: { input: unknown }) => transcript.input as StoredInput;
    /** The JSON of the `<decision_input>` section the engine writes into the changing block. */
    function decisionInputOf(input: StoredInput): { rejectedAttempts: unknown } {
      const changing = input.messages[1]!.content;
      const open = '<decision_input>\n';
      const start = changing.indexOf(open);
      const end = changing.indexOf('\n</decision_input>', start);
      if (start < 0 || end < 0) throw new Error('the changing block has no <decision_input> section');
      return JSON.parse(changing.slice(start + open.length, end)) as { rejectedAttempts: unknown };
    }

    function waitFor<T>(what: string, read: () => Promise<T | undefined> | T | undefined): Promise<T> {
      return vi.waitFor(
        async () => {
          const value = await read();
          if (value === undefined) throw new Error(`waiting for ${what}`);
          return value;
        },
        { timeout: 30_000, interval: 50 },
      );
    }

    async function start(query: string) {
      const resourceId = newUser();
      const threadId = await harness.createThread(resourceId);
      const started = await harness.engine.startInvestigation({ resourceId, threadId, query, processId: 'deep-research', launchKey: newLaunchKey() });
      if (started.outcome === 'rejected') throw new Error(`start refused: ${started.code}`);
      return { resourceId, investigationId: started.investigationId };
    }

    const finished = (investigationId: string, resourceId: string) =>
      waitFor('the end of the investigation', async () => {
        const read = await harness.engine.readInvestigation({ investigationId, resourceId });
        return read.outcome === 'found' && read.view.status !== 'running' ? read.view : undefined;
      });

    it('INT-4 K1: a retried controller step is told the code of each rejected attempt of the step, also when its task was restarted between the attempts', async () => {
      // Step 1 of the controller, three calls (`maxDecisionRetries` 2): attempt 1 makes call 0, rejected by the code, and
      // is restarted while its call 1 is held; attempt 2 makes call 1, rejected again, and call 2, accepted.
      const held = latch();
      harness.model.script(
        'controller',
        { output: { kind: 'wait', rationale: 'K1-REJECTED-OUTPUT-WAIT' } },
        { ...conclude, holdUntil: held.wait },
        { output: { kind: 'guessTheCause', rationale: 'K1-REJECTED-OUTPUT-UNKNOWN' } },
        conclude,
      );
      try {
        const { resourceId, investigationId } = await start('K1: why did the payments time out?');
        await vi.waitFor(() => expect(harness.model.callsOf('controller')).toHaveLength(2), { timeout: 20_000, interval: 50 });
        const controller = (await tasksOf(investigationId)).find((task) => task.workflowType === 'research.controller')!;
        await harness.expireLease(controller.taskId, 1);

        expect(await finished(investigationId, resourceId)).toMatchObject({ status: 'completed', answer: { outcome: 'inconclusive' } });
        expect(harness.model.callsOf('controller')).toHaveLength(4);

        // The rejections are rows of the step with their codes; the held call of attempt 1 wrote no row.
        const { decisions } = await engineRowsOf(investigationId);
        expect(decisions.map((row) => [row.step, row.callIndex, row.status, row.kind, row.rejectionReason])).toEqual([
          [1, 0, 'rejected', 'wait', 'nothing_to_wait_for'],
          [1, 1, 'rejected', null, 'kind_unknown'],
          [1, 2, 'accepted', 'concludeInconclusive', null],
        ]);
        // The calls of attempt 2: call 1 is told the rejection recorded before the restart, call 2 both rejections, as
        // kind or null and code only; no rejected output reaches an input.
        const afterRestart = (await llmTranscriptsOf(investigationId)).filter((row) => row.role === 'controller' && row.attempt === 2).map(inputOf);
        expect(afterRestart.map((input) => decisionInputOf(input).rejectedAttempts)).toEqual([
          [{ kind: 'wait', reason: 'nothing_to_wait_for' }],
          [
            { kind: 'wait', reason: 'nothing_to_wait_for' },
            { kind: null, reason: 'kind_unknown' },
          ],
        ]);
        for (const input of afterRestart) {
          expect(JSON.stringify(input.messages)).not.toContain('K1-REJECTED-OUTPUT');
        }
      } finally {
        held.open();
      }
    }, 60_000);

    it('INT-4 K2: the stable block of the controller input is byte-identical across steps with the cache mark at its end, and later steps are charged less for the cached part', async () => {
      harness.countingSource.answerWith((call) => [{ service: call.args.service, level: 'error', event: 'timeout' }]);
      const evidenceOf = (service: string) => ({
        kind: 'requestEvidence',
        rationale: `collect the errors of ${service}`,
        sourceId: 'fixture',
        toolName: 'search_logs',
        args: { service },
        completeness: 'all',
      });
      // The same input on every step; the provider reads 3 000 of its 4 000 tokens from the cache after the first.
      const full = { inputTokens: 4_000, outputTokens: 100 };
      const cached = { ...full, cacheReadTokens: 3_000 };
      harness.model.script(
        'controller',
        { output: evidenceOf('payment-api'), usage: full },
        { output: evidenceOf('ledger'), usage: cached },
        { ...conclude, usage: cached },
      );
      const { resourceId, investigationId } = await start('K2: why did the payments time out?');

      expect(await finished(investigationId, resourceId)).toMatchObject({ status: 'completed', answer: { outcome: 'inconclusive' } });
      const { planRevisions, decisions, llmCalls } = await engineRowsOf(investigationId);
      expect(planRevisions).toHaveLength(1);
      expect(decisions.map((row) => [row.step, row.status, row.kind])).toEqual([
        [1, 'accepted', 'requestEvidence'],
        [2, 'accepted', 'requestEvidence'],
        [3, 'accepted', 'concludeInconclusive'],
      ]);

      // Invariant 7: the stable block is the same bytes on the three steps; the mark ends it and no other message.
      const inputs = (await llmTranscriptsOf(investigationId)).filter((row) => row.role === 'controller').map(inputOf);
      expect(inputs).toHaveLength(3);
      const [stable] = inputs[0]!.messages;
      expect(stable!.content.startsWith('<tools>\n')).toBe(true);
      for (const input of inputs) {
        expect(Object.keys(input).sort()).toEqual(['instructions', 'messages']);
        expect(input.messages.map((message) => message.providerOptions)).toEqual([MARK, undefined]);
        expect(input.messages[0]!.content).toBe(stable!.content);
      }
      expect(inputs[1]!.messages[1]!.content).not.toBe(inputs[0]!.messages[1]!.content);
      // The provider got the mark on the stable block only and none on the request; the plan call got no mark.
      for (const call of harness.model.callsOf('controller')) {
        expect(call.messageOptions.map((message) => message.providerOptions)).toEqual([undefined, MARK, undefined]);
        expect(call.providerOptions).toEqual({ anthropic: { effort: 'low' } });
      }
      expect(harness.model.callsOf('plan').flatMap((call) => call.messageOptions.map((message) => message.providerOptions))).toEqual([
        undefined,
        undefined,
      ]);

      // AC-18.1: the journal keeps the cache reads, and the steps after the first cost less than the same input at the
      // full price — by the catalog of the controller model: input 2, cache read 0.1, output 10 USD per million tokens.
      expect(CONTROLLER_MODEL).toBe('anthropic/claude-sonnet-5-5');
      const controllerRows = llmCalls.filter((row) => row.role === 'controller');
      expect(controllerRows.map((row) => [row.inputTokens, row.cacheReadTokens, row.costUsd])).toEqual([
        [4_000, 0, '0.00900000'],
        [4_000, 3_000, '0.00330000'],
        [4_000, 3_000, '0.00330000'],
      ]);
    }, 60_000);
  });
});
