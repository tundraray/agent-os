// agent-harness / core - agents-package integration skeletons (in-process `RuntimeModule` + `createAgents` over real Postgres, real MCP fixture process, scripted model)
// Design Doc: docs/features/agent-harness/design-core.md (v1.0, Draft), Test Strategy UC-2, UC-4, UC-6, UC-8, UC-9, UC-10 (+ the journal half of UC-2) (KD-1, KD-3, KD-4, KD-5, KD-6, KD-7)
// PRD: docs/features/agent-harness/prd.md FR-01..FR-07 (AC-01.1, AC-01.2, AC-02.1, AC-03.1, AC-04.1, AC-04.2, AC-05.1, AC-06.1, AC-06.2, AC-07.1, AC-07.2) and NFR-01
// Generated: 2026-11-21 | Part: core | Test type: Integration (no E2E file: see "Budget")
// Implementation timing: written alongside the slice each test names and run once, at the end of the part (project rule "Tests only at the end"):
//   INT-1 with the argument check, the repeat rule, the `tool_call_refused` audit entry and the journal fields of the model step;
//   INT-2 with `toOutcome` / `unknown` and the text of a failed call;
//   INT-3 with `cutOff` of `ModelClient` and the `endOfTurn` input;
//   INT-4 with the empty-summary branch of the compaction step.
//
// File name follows the repo convention of the `agents` package (`<feature>-<part>.int.e2e-spec.ts` under packages/agents/test, picked up by `vitest.config.e2e.ts`, run with
// `pnpm --filter @agent-os/agents test:e2e`, never in the default `vitest run`). Every test is `it.todo`: the comments above it are its specification; the implementing task
// replaces `it.todo` by `it` and fills the body (a skeleton that passes on day one proves nothing).
//
// Harness: `createAgentsHarness` of support/agentsHarness.ts (real Postgres, real runtime and agents, scripted `ModelClient` of `@agent-os/agents/testing` as the only model double,
// the real MCP fixture process registered under the run's names). Isolation: a unique owner `newUser()` per test, its own `createFixtureFiles(...)`, a root record
// `testRecord(...)`; no sleeps, `script.called(n)` and `waitForTaskStatus` order the steps.
//
// Support the implementation tasks add (not skeletons, no test of their own):
//   - `createAgentsHarness`: an `audit` capture. Today the harness passes `audit: async () => {}`; INT-1 reads the entries `createAgents` was given (`harness.auditEntries`).
//     The real hook in `apps/api` (`accessAudit` in agents.module.ts) hands the entry to `AuditLog.record` unchanged and `audit_events.kind` is a free string, so a capture at the
//     port is the whole of what a test can see; no apps/api test is written for the new kind.
//   - `src/testing.ts`: a scripted answer may be marked `cutOff: true`; the double then answers with `finishReason: 'length'` (today it is `tool-calls` or `stop`). That is the same
//     value the real turn client reads from the provider, so the mapping of `ModelClient.call` to its `cutOff` flag is exercised by INT-3 as well.
//
// Budget: Integration 4 of 3, E2E 0 of 1-2.
//   The fourth integration test (INT-4) uses the "up to 5" allowance of integration-e2e-testing: its defect is named in its own block and no other test catches it (it is the only
//   test where a compaction step commits without a `compaction` entry over the real database). INT-1 and INT-2 each merge several ACs into one scripted run (table rows).
//   E2E: none. The only user-visible journey of this part is the owner's rerun of the deep-research tasks on Haiku (PRD, Success Criteria): a paid manual check, not a CI test;
//   INT-1..INT-4 already prove the platform side of it (what the model is told about its mistakes) against the real database and the real MCP server.
//
// Proven elsewhere (not in this file; the plan reads this to avoid a second test for an AC already proven). The unit tests are written by the implementation phases,
// one table-driven test per rule, none of them skeletoned here:
// - unit, packages/agents/src/agent/turn-rules.spec.ts (extend the existing `endOfTurn` table): cut-off x {no final subagent, unfinished children, deep agent with a final subagent} - UC-1, AC-01.1 (rule), DC-1
// - unit, packages/agents/src/model/model-client.spec.ts (extend): `finishReason: 'length'` -> `cutOff: true`, any other reason -> false, for the model step and the compaction call alike - KD-3
// - unit, ToolRunner.check (next to tool-runner/tool-gate specs): MCP schema missing arg / wrong type -> `invalid_arguments` with the argument name and what was expected; built-in tool
//   with a number for a string -> the same; a schema of unknown dialect -> allowed with the "not checked" reason; `pattern` and `format` are left to the server; the error text is cut at the code constant;
//   a call from `run_code` gets the same text - UC-3, AC-02.2, AC-02.3 (the log line itself: INT-1 row C asserts it is without values), DC-2
// - unit, packages/agents/src/mcp/mcp-outcome.spec.ts (extend the existing table): read-only x {timeout, connection_lost, protocol_error, unauthorized, client_error} -> `transport_failure`
//   with the reason text; mutating x the same -> `unknown` for the first three and `transport_failure` for the last two, always with `failureReason`; a call from a script of class `write` goes
//   through the same function - UC-5, AC-03.1, AC-03.2, AC-04.2 (rule), DC-3, DC-4, DC-5
// - unit, the repeat-rule function (pure-decision, own file): no earlier call -> run; one -> run with the mark naming its id; two -> refuse; one with another key order -> mark; two refused by
//   the check -> run; one in the same answer -> mark; `list_agents` twice -> run; a call before the last compaction is not counted - UC-7, AC-06.1 (rule), AC-06.2 (rule), AC-06.3, DC-7, DC-8, DC-9
// - unit, the log-field builder of the model step (if the task extracts it; else the arithmetic is covered by INT-1 row C only): `directCalls` / `runCodeCalls` / `toolsChosen` for an answer with
//   zero, one and several `run_code` calls - AC-07.1 (arithmetic), DC-10
// - existing, packages/agents/test/agent-platform-agents.int.e2e-spec.ts INT-3 F: a read call whose connection drops ends `transport_failure` with reason `connection_lost` and the agent goes
//   on; the new text for that reason is a row of the `toOutcome` table, not another integration test
// - existing, packages/agents/test/agent-platform-agents.int.e2e-spec.ts INT-3 B/C/E: a mutating call is held for confirmation, approved once, and a lost step closes it `unknown` - the
//   confirmation path is reused by INT-2 and not re-proven
// - not automated: the web showing the new refusal reason and the English transport text (Out of scope of the part); the first-time check that Google and OpenAI-compatible providers
//   report `length` on an output-limit stop (design Risks; the plan checks it by hand against the real providers, the `cutOff` field of `agent step finished` shows it afterwards)
// - not automated: the CHECK of `code_calls.refusal_reason` gets `repeated_call` through the generated migration; the existing `packages/db/test/migrations.e2e-spec.ts` applies every migration to a
//   scratch database, so a CHECK that does not match the schema set fails there
//
// acProof (the same mapping as the JSON of the generation report):
// - AC-01.1, AC-01.2: INT-3 (wiring, journal `cutOff`); rule: unit
// - AC-02.1: INT-1 row A; AC-02.2, AC-02.3: unit
// - AC-03.1, AC-03.2: unit (`toOutcome` text); INT-2 row A shows the text reaches the model for `timeout`
// - AC-04.1: INT-2 row A; AC-04.2: unit
// - AC-05.1: INT-4
// - AC-06.1, AC-06.2: INT-1 row B; AC-06.3: unit
// - AC-07.1: INT-1 row C (+ INT-3 for the `cutOff` field); AC-07.2: INT-1 row C
// - NFR-01 (no values in the new records): INT-1 row C

import {
  createLibraryDouble,
  createScriptedModel,
  inputLines,
} from '@agent-os/agents/testing';
import { conversations, toolResults } from '@agent-os/db';
import { createFixtureFiles, fixtureCallsOf } from '@agent-os/mcp-fixture';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  childNoticesOf,
  createAgentsHarness,
  historyLines,
  historyOf,
  ledgerRowsOf,
  TEST_MODEL_DEFAULT,
  testRecord,
  toolCallRowsOf,
  toolOutputOf,
  waitForTaskStatus,
} from './support/agentsHarness';
import { BACKOFFICE_SERVER, LOGS_SERVER } from './support/mcp-servers';
import { newUser, waitFor } from '@agent-os/db/testing';

/** Bound of one in-process test; the rows settle far sooner. */
const TEST_TIMEOUT_MS = 120_000;

/** `AGENT_COMPACT_AT_TOKENS` of INT-4: far above the default usage of a scripted answer. */
const COMPACT_AT_TOKENS = 5_000;

/** The request that follows the history in a compaction call (`compaction-step.ts`, FR-27). */
const COMPACTION_REQUEST =
  'The conversation above is getting too long. Write a summary of it that replaces it for you from now on. ' +
  'Keep the task, what the employee and other agents asked, every decision made, the facts found with ' +
  'their sources, the agents you started and their results, and what is left to do. ' +
  'Answer with the summary text only; do not call tools.';

/**
 * `MCP_CALL_TIMEOUT_MS` of INT-2: the hung calls end after it; long enough for the fixture's handshake and the
 * registry's tool list at harness start.
 */
const MCP_CALL_TIMEOUT_MS = 1_000;

/** The fixture's tools of INT-1 and INT-2 as the model names them, and their arguments (valid under the fixture's schemas). */
const GET_TRACE = `mcp__${LOGS_SERVER}__get_trace`;
const TRACE_A = { traceId: 'a'.repeat(32) };
const CREATE_INCIDENT_NOTE = `mcp__${BACKOFFICE_SERVER}__create_incident_note`;
const INCIDENT_NOTE = { orderId: 'ORD-1001', text: 'Customer charged twice' };

/** INT-1: a secret-looking value sent as an object where `traceId` must be a string; no journal record may carry it. */
const SECRET_MARK = 'sk-int1-secret-7f3c9e';

/** The notice after an answer cut off at the length limit (`turn-rules.ts`, KD-3). */
const CUT_OFF_NOTICE =
  'Your answer was cut off at the output length limit and is not accepted as your report. ' +
  'Write the report again, shorter, so that it fits in one answer.';

describe('agent-harness / core - the loop tells the model what went wrong and stops the loops it cannot stop itself', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-1: refused MCP calls (arguments, repeat) - the server is never reached, one audit entry per refusal, the model reads the reason, the journal holds no values
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-02.1 "Given MCP-инструмент требует аргумент `query`, when модель вызывает его без `query`, then сервер не вызывается, аудит записывает ровно одну запись с отказом, а модель видит, что не хватает `query`."
  //   AC-06.1 "Given исполнитель уже вызвал `logs.search` с аргументами A, when он вызывает `logs.search` с A второй раз, then вызов выполняется, а модель видит в результате пометку о повторе и id первого вызова."
  //   AC-06.2 "Given исполнитель вызвал `logs.search` с аргументами A дважды, when он вызывает его с A третий раз, then сервер не вызывается, аудит записывает ровно одну запись с отказом `repeated_call`, а модель видит подсказку."
  //   AC-07.1 "Given агенту доступны 12 инструментов, when модель выбирает два из них, then запись журнала о шаге содержит число 12, имена показанных инструментов, имена двух выбранных и сколько вызовов прямых, а сколько через `run_code`."
  //   AC-07.2 "Given результат прямого вызова не обёрнут, then журнал записывает его размер."
  //   NFR-01 "Записи журнала этой фичи не содержат значений аргументов, текстов утверждений и цитат, секретов и токенов - только имена, числа, исходы и id."
  //   Design: UC-4, UC-8, UC-10; KD-1, KD-5, KD-6; Flow 2, Flow 4.
  // Behavior: one agent with access to the `logs` server, one scripted run on `get_trace` (its `traceId` is required, 32 lowercase hex; the fixture lists that schema in `tools/list`, which the
  //   registry stored when the harness registered the server) ->
  //   step 1: one answer with two calls: `get_trace {}` (no `traceId`) and `get_trace { traceId: { token: <SECRET_MARK> } }` (wrong type, holding a value that looks like a secret) -> both refused
  //   `invalid_arguments` before any request;
  //   step 2: `get_trace TRACE_A` -> success (first call of A);
  //   step 3: `get_trace TRACE_A` again -> runs, success, the text the model reads ends with the repeat mark that names the id of step 2's call;
  //   step 4: `get_trace TRACE_A` a third time -> refused `repeated_call` with the hint to change the arguments or finish;
  //   step 5: a text report (the agent finishes).
  // Rows (one scripted run, literal expected values; read the exact wording from the first implementation run and write it as a literal, do not build it from the implementation's constants):
  //   A. the two invalid calls (AC-02.1): the fixture's call log holds no entry for either; the history has `tool_result: get_trace refused invalid_arguments` twice; the audit capture holds exactly two
  //      entries `{ kind: 'tool_call_refused', actor: <owner>, objectType: 'tool', objectId: '<LOGS_SERVER>/get_trace', outcome: 'rejected', reason: 'invalid_arguments' }`; the next model input
  //      (`toolOutputOf` of each call id) names `traceId` in both texts and says what was expected (required / a string).
  //   B. the loop (AC-06.1, AC-06.2): the fixture's call log holds exactly two `get_trace` entries for TRACE_A (the third never arrived); the second call's text in the model input is the server's
  //      answer followed by the mark with the first call's id (`toolCallIdOf(script, 1)`), the first call's text has no mark; the stored result row of the second call (`tool_results`, as
  //      read in tool-result-reading INT-1) holds the server's answer only, no mark; the third call is `refused repeated_call`, its text names the earlier call ids and gives the hint; the audit capture
  //      gains exactly one entry with reason `repeated_call` (three entries in all). Refused calls of row A are not counted: the first valid call of A in step 2 carries no mark.
  //   C. the journal (AC-07.1, AC-07.2, NFR-01): the `agent step finished` record of step 1 carries `toolsShown` = the number of tools in the recorded model call (`script.calls[0].toolDescriptions`, taken
  //      independently of the implementation), `toolNamesShown` = those names, `toolsChosen` = `['mcp__<LOGS_SERVER>__get_trace', 'mcp__<LOGS_SERVER>__get_trace']`, `directCalls` 2, `runCodeCalls` 0,
  //      `cutOff` false; the `tool call finished` record of step 2's call carries `resultChars` equal to the length of the text the model read for it (`toolOutputOf(...).length`, the result is short
  //      and not wrapped). Over `harness.logs`, no record named `agent step finished`, `tool call finished`, `tool arguments not checked` or `compaction returned an empty summary` contains
  //      SECRET_MARK anywhere in its JSON (the argument error text may repeat the value and goes to the model and the history only).
  // Catches: (1) a refused call that still reaches the MCP server because the argument check sits after the send, or does not run for a schema read from the stored tool list (the unit test of `check`
  //   starts from a schema it is given and cannot see this); (2) a refusal that is audited twice, or not at all, or as `access_denied` (the port accepts the new entry but the step does not write it, or writes
  //   one per tool call of the answer instead of one per refusal); (3) the repeat rule not given the visible history by the tool step (the pure function is right but always sees an empty list), counting
  //   refused calls, or the mark written into the stored result so that `readResult` hands the model platform text as server data (KD-1); (4) a secret in the argument error text copied into the journal.
  //   Only this test crosses check -> rule -> audit port -> `tool_result` text -> model input -> log over the real database.
  // @category: core-functionality
  // @dependency: ToolRunner.check (MCP schema validator), repeat rule, tool step (ToolStep with the history calls), AccessAudit port, toolResultOf, model step journal, McpRegistry stored tool list, Postgres, MCP fixture (logs), ScriptedModel
  // @complexity: high
  it(
    'INT-1: invalid MCP arguments and a third identical call are refused before the server, once each in the audit, the model reads the reason and the second identical call carries the repeat mark, and the journal holds names and numbers only',
    async () => {
      // Given: an agent on the `logs` server whose script makes two invalid calls, then the same valid call three times
      const ownerId = await newUser();
      const fixture = createFixtureFiles();
      const model = createScriptedModel();
      const looper = model.script({ task: 'Read the trace until it changes' }, [
        {
          calls: [
            { tool: GET_TRACE, args: {} },
            { tool: GET_TRACE, args: { traceId: { token: SECRET_MARK } } },
          ],
        },
        { calls: [{ tool: GET_TRACE, args: TRACE_A }] },
        { calls: [{ tool: GET_TRACE, args: TRACE_A }] },
        { calls: [{ tool: GET_TRACE, args: TRACE_A }] },
        { text: 'the trace does not change' },
      ]);
      const harness = await createAgentsHarness({
        model,
        fixture,
        access: { [ownerId]: [LOGS_SERVER] },
        root: testRecord('looper', { servers: [LOGS_SERVER] }),
      });
      try {
        // When: the agent works to its report
        const { agentId } = await harness.sessions.start({
          ownerId,
          prompt: 'Read the trace until it changes',
          description: 'looper',
        });
        await looper.called(5);
        await waitForTaskStatus(harness, agentId, ownerId, 'waiting');

        const [missingId, wrongTypeId] = looper.calls[0]?.toolCallIds ?? [];
        const [firstId] = looper.calls[1]?.toolCallIds ?? [];
        const [secondId] = looper.calls[2]?.toolCallIds ?? [];
        const [thirdId] = looper.calls[3]?.toolCallIds ?? [];
        if (
          firstId === undefined ||
          secondId === undefined ||
          thirdId === undefined
        ) {
          throw new Error('the looper made fewer calls than scripted');
        }

        // Then (A, B): only the first two valid calls reached the server; the history shows each refusal
        expect(
          fixtureCallsOf(fixture.callLog, { tool: 'get_trace' }),
        ).toHaveLength(2);
        expect(
          fixtureCallsOf(fixture.callLog, { tool: 'get_trace', args: TRACE_A }),
        ).toHaveLength(2);
        expect(
          historyLines(await historyOf(harness, agentId, ownerId)),
        ).toEqual([
          'task: Read the trace until it changes',
          `model_answer:  [${LOGS_SERVER}/get_trace, ${LOGS_SERVER}/get_trace]`,
          'tool_result: get_trace refused invalid_arguments',
          'tool_result: get_trace refused invalid_arguments',
          `model_answer:  [${LOGS_SERVER}/get_trace]`,
          'tool_result: get_trace success',
          `model_answer:  [${LOGS_SERVER}/get_trace]`,
          'tool_result: get_trace success',
          `model_answer:  [${LOGS_SERVER}/get_trace]`,
          'tool_result: get_trace refused repeated_call',
          'model_answer: the trace does not change []',
        ]);

        // Then (A, B): one `tool_call_refused` audit record per refusal, none for the calls that ran
        const refusedEntry = (reason: string) => ({
          kind: 'tool_call_refused',
          actor: ownerId,
          objectType: 'tool',
          objectId: `${LOGS_SERVER}/get_trace`,
          outcome: 'rejected',
          reason,
        });
        expect(harness.auditEntries).toEqual([
          refusedEntry('invalid_arguments'),
          refusedEntry('invalid_arguments'),
          refusedEntry('repeated_call'),
        ]);

        // Then (A): the model reads which argument is wrong and what was expected
        const afterInvalid = looper.calls[1]?.messages ?? [];
        expect(toolOutputOf(afterInvalid, missingId)).toContain(
          "[refused: invalid_arguments]\ndata must have required property 'traceId'",
        );
        expect(toolOutputOf(afterInvalid, wrongTypeId)).toContain(
          '[refused: invalid_arguments]\ndata/traceId must be string',
        );

        // Then (B): the first valid call has no mark (refused calls are not counted), the second carries the mark
        // with the first call's id, the third reads the hint with both ids
        const mark = `[repeat] You already made this call with the same arguments: ${firstId}.`;
        expect(
          toolOutputOf(looper.calls[2]?.messages ?? [], firstId),
        ).not.toContain('[repeat]');
        expect(
          toolOutputOf(looper.calls[3]?.messages ?? [], secondId),
        ).toContain(`\n\n${mark}`);
        expect(
          toolOutputOf(looper.calls[4]?.messages ?? [], thirdId),
        ).toContain(
          `[refused: repeated_call]\nThis call was already made with the same arguments: ${firstId}, ${secondId}. ` +
            'Change the arguments or finish your work.',
        );

        // Then (B): the mark is in the second call's history text only, never in its stored result
        const calls = new Map(
          (await toolCallRowsOf(harness.db, agentId)).map((call) => [
            call.callId,
            call,
          ]),
        );
        const firstText = calls.get(firstId)?.resultText;
        if (typeof firstText !== 'string')
          throw new Error('the first valid call has no result text');
        expect(calls.get(secondId)?.resultText).toBe(`${firstText}\n\n${mark}`);
        const stored = await harness.db
          .select({
            callId: toolResults.callId,
            text: toolResults.text,
          })
          .from(toolResults)
          .where(eq(toolResults.conversationId, agentId));
        expect(stored.map((row) => row.callId).sort()).toEqual(
          [firstId, secondId].sort(),
        );
        expect(
          stored.find((row) => row.callId === secondId)?.text,
        ).not.toContain('[repeat]');

        // Then (C): the first model step's journal names what the model saw and chose
        const [firstStep] = harness.logs.filter(
          (record) =>
            record.message === 'agent step finished' &&
            record.fields.agentId === agentId &&
            record.fields.stepKind === 'model',
        );
        const shown = looper.calls[0]?.toolNames ?? [];
        expect(firstStep?.fields).toMatchObject({
          toolsShown: shown.length,
          toolNamesShown: shown,
          toolsChosen: [GET_TRACE, GET_TRACE],
          directCalls: 2,
          runCodeCalls: 0,
          cutOff: false,
        });

        // Then (C): the result size of the first valid call is the length of the text the model read
        const finished = harness.logs.find(
          (record) =>
            record.message === 'tool call finished' &&
            record.fields.callId === firstId,
        );
        expect(finished?.fields.resultChars).toBe(firstText.length);

        // Then (C): no record of this part carries the secret-looking argument value (NFR-01)
        const journal = harness.logs.filter((record) =>
          [
            'agent step finished',
            'tool call finished',
            'tool arguments not checked',
            'compaction returned an empty summary',
          ].includes(record.message),
        );
        expect(journal.length).toBeGreaterThan(0);
        expect(
          journal.filter((record) =>
            JSON.stringify(record).includes(SECRET_MARK),
          ),
        ).toEqual([]);
      } finally {
        await harness.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2: a mutating call with no answer is `unknown`, and the model reads its text
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-04.1 "Given сотрудник подтвердил вызов, создающий тикет, when сервер не ответил в срок, then в истории вызовов агента у этого вызова исход «неизвестно», а модель видит, что тикет мог быть создан и что повторять вызов без проверки нельзя."
  //   AC-03.1 "Given MCP-сервер не ответил в срок, when модель получает исход вызова, then она видит, что вызов не удался из-за таймаута."
  //   Design: UC-6, KD-4; Flow 3.
  // Behavior: `MCP_CALL_TIMEOUT_MS` set low through the harness `variables` (a few hundred ms) -> the fixture's fault schedule makes the server never answer (`hang`, `occurrences: 'all'`) for
  //   `create_incident_note` (changing, no hint) -> the scripted agent calls `create_incident_note`, the employee approves the request (`sessions.confirmations` / `resolveConfirmation`, as in
  //   agent-platform-agents INT-3 C) -> the call times out -> the agent reads the result and reports.
  // Rows (one scripted run, literal expected values):
  //   A. the changing call: the call record (`toolCallRowsOf`) ends `create_incident_note done unknown`; the history line is `tool_result: create_incident_note unknown`; the text the model reads next
  //      (`toolOutputOf`) says the action may have been done, that it must not be repeated without checking, and names the reason (timeout); the call is not recorded as `transport_failure`.
  //   A read call that times out (`transport_failure`, AC-04.2) and the other reasons (lost connection, protocol error, unauthorized, client error) are rows of the `toOutcome` unit table;
  //   INT-3 F of agent-platform-agents already proves a dropped connection on a read.
  // Catches: (1) `readOnly` of the stored tool (`readOnlyHint`) not reaching `toOutcome` from the call path, so a ticket-creating call that timed out is recorded as a harmless failure and the model retries it - a duplicate
  //   ticket in the external system; (2) the outcome `unknown` written for the call but dropped on the way to `tool_result` (or the call record) because only the old path (a lost step) knew that outcome;
  //   (3) the platform text missing from the history entry, so the model reads a bare `[unknown]` as today. The `toOutcome` unit table starts from a given `readOnly` and a given response and sees none of these.
  // @category: core-functionality
  // @dependency: McpClient (real timeout), toOutcome, tool runner, tool step commit, confirmation request, toolResultOf, McpRegistry stored tool list (readOnlyHint), Postgres, MCP fixture (backoffice, fault schedule), ScriptedModel
  // @complexity: medium
  it(
    'INT-2: a confirmed create_incident_note that times out ends unknown, and the model reads its text',
    async () => {
      // Given: a writer whose one answer writes a note, on a server that never answers a call
      const ownerId = await newUser();
      const fixture = createFixtureFiles();
      fixture.setFaults([
        {
          tool: 'create_incident_note',
          argsHash: '*',
          occurrences: 'all',
          mode: 'hang',
        },
      ]);
      const model = createScriptedModel();
      const writer = model.script(
        { task: 'Write the note to a silent server' },
        [
          { calls: [{ tool: CREATE_INCIDENT_NOTE, args: INCIDENT_NOTE }] },
          { text: 'report after the timeout' },
        ],
      );
      const harness = await createAgentsHarness({
        model,
        fixture,
        access: { [ownerId]: [BACKOFFICE_SERVER] },
        variables: { MCP_CALL_TIMEOUT_MS: String(MCP_CALL_TIMEOUT_MS) },
        root: testRecord('writer', { servers: [BACKOFFICE_SERVER] }),
      });
      try {
        // When: the employee approves the note, and the note times out
        const { agentId } = await harness.sessions.start({
          ownerId,
          prompt: 'Write the note to a silent server',
          description: 'writer',
        });
        await waitFor(
          () => harness.sessions.get(agentId, ownerId),
          (view) => view.status === 'awaiting_confirmation',
          'the confirmation request of the writer',
        );
        const [request] = (
          await harness.sessions.confirmations(agentId, ownerId)
        ).filter((c) => c.status === 'open');
        if (request === undefined)
          throw new Error('the writer has no confirmation request');
        expect(
          await harness.sessions.resolveConfirmation({
            decisionId: request.decisionId,
            ownerId,
            approve: true,
          }),
        ).toBe('resolved');
        await writer.called(2);
        await waitForTaskStatus(harness, agentId, ownerId, 'waiting');

        // Then: the request reached its server once and got no answer
        expect(
          fixtureCallsOf(fixture.callLog, {
            tool: 'create_incident_note',
            args: INCIDENT_NOTE,
          }).map((entry) => entry.mode),
        ).toEqual(['hang']);

        // Then (A): the changing call is `unknown` in the call record and the history
        expect(
          (await toolCallRowsOf(harness.db, agentId)).map(
            (call) => `${call.tool} ${call.state} ${call.outcome ?? '-'}`,
          ),
        ).toEqual(['create_incident_note done unknown']);
        expect(
          historyLines(await historyOf(harness, agentId, ownerId)),
        ).toEqual([
          'task: Write the note to a silent server',
          `model_answer:  [${BACKOFFICE_SERVER}/create_incident_note]`,
          'tool_result: create_incident_note unknown',
          'model_answer: report after the timeout []',
        ]);

        // Then (A): the model's next input holds the platform's text of the outcome
        const [noteCallId] = writer.calls[0]?.toolCallIds ?? [];
        expect(
          toolOutputOf(writer.calls[1]?.messages ?? [], noteCallId),
        ).toContain(
          `[unknown]\nThe call to ${BACKOFFICE_SERVER} got no answer: the server did not answer in time (timeout). ` +
            'The action may have been carried out. Do not repeat it before checking whether it was.',
        );
      } finally {
        await harness.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-3: a cut-off report of a child agent is not the report: the child gets a notice and writes it again, its parent receives the second text
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-01.1 "Given исполнитель пишет отчёт и ответ модели оборвался на пределе длины без вызовов инструментов, when шаг модели заканчивается, then исполнитель не завершён, координатор отчёта не получил, а в истории исполнителя есть уведомление об обрезке."
  //   AC-01.2 "Given ответ модели был обрезан, when следующий её ответ заканчивается нормально, then отчётом становится этот ответ."
  //   AC-07.1 (the `cutOff` field of the step record). Design: UC-2, KD-3; Flow 1.
  // Behavior: a root (tools `start_agent`, agents `[scout]`) starts a child agent `scout` (a record added to the library double, as in agent-platform-agents INT-3 grandchild setup) -> the scripted model answers
  //   the scout's first call with a text and `cutOff: true` (no tool calls), its second call with a full text -> the scout works to the end.
  // Rows (one test, literal expected values):
  //   A. after the first scout answer: the scout's task is not `completed`, the root's history holds no `child_report` yet (read after `scout` script `called(1)` and before the second answer is released with a latch,
  //      or from the final history: the root has exactly one `child_report`, whose text is the second answer's); the scout's history lines are
  //      `task: ...`, `model_answer: <cut text> []`, `notice: <says the answer was cut off and is not accepted as the report>`, `model_answer: <full text> []`.
  //   B. the scout's second model input holds the notice after the first answer; the root receives the second, full text as the report and never the cut one; the turn counter and the ledger count both
  //      model calls (two ledger rows for the scout).
  //   C. the journal: the scout's two `agent step finished` records carry `cutOff` true and false in that order, `toolsChosen` empty, `directCalls` 0, `runCodeCalls` 0.
  // Catches: the flag set by `ModelClient` but not handed to `endOfTurn` by the model step (the cut text is delivered to the parent as a finished report, truncated mid-sentence - the defect that started the
  //   feature); a notice written but the task also completed; a notice that is not part of the next model input; the report taken from the first answer after the notice. `endOfTurn` and the finish-reason mapping are
  //   unit tables, which cannot see how the model step hands one to the other.
  // @category: core-functionality
  // @dependency: ModelClient.call (cutOff), endOfTurn, model step, start_agent, child report delivery, runtime ledger, Postgres, ScriptedModel (cutOff answer)
  // @complexity: medium
  it(
    'INT-3: a child agent whose answer is cut off at the length limit gets a notice and finishes only with its next, complete answer, which is the report its parent receives',
    async () => {
      // Given: a root that starts the child agent `scout`, whose first answer is cut off at the length limit
      const ownerId = await newUser();
      const library = createLibraryDouble();
      library.add(testRecord('scout'));
      const model = createScriptedModel();
      const root = model.script(
        { task: 'Coordinate the scout' },
        [
          {
            calls: [
              {
                tool: 'start_agent',
                args: {
                  agent: 'scout',
                  description: 'scout',
                  prompt: 'Scout task',
                },
              },
            ],
          },
        ],
        { thereafter: { text: 'noted' } },
      );
      const scout = model.script({ task: 'Scout task' }, [
        { text: 'The report starts and brea', cutOff: true },
        { text: 'The full report' },
      ]);
      const harness = await createAgentsHarness({
        model,
        access: {},
        library,
        root: testRecord('coordinator', { tools: ['start_agent'] }),
      });
      try {
        // When: the root starts the scout, the scout answers twice, the root reads the report
        const { agentId: rootId } = await harness.sessions.start({
          ownerId,
          prompt: 'Coordinate the scout',
          description: 'coordinator',
        });
        const rootCalls = await waitFor(
          () => toolCallRowsOf(harness.db, rootId),
          (calls) => calls.some((call) => call.childTaskId !== null),
          'the scout started by the root',
        );
        const agentId = rootCalls.find(
          (call) => call.childTaskId !== null,
        )?.childTaskId;
        if (agentId === undefined || agentId === null)
          throw new Error('the root started no scout');
        await waitForTaskStatus(harness, agentId, ownerId, 'completed');
        await root.called(3);
        await waitForTaskStatus(harness, rootId, ownerId, 'waiting');

        // Then (A): the cut answer is followed by the notice, and only the full answer finished the scout
        expect(
          historyLines(await historyOf(harness, agentId, ownerId)),
        ).toEqual([
          'task: Scout task',
          'model_answer: The report starts and brea []',
          `notice: ${CUT_OFF_NOTICE}`,
          'model_answer: The full report []',
        ]);
        const rootReports = (await historyOf(harness, rootId, ownerId)).flatMap(
          (entry) =>
            entry.kind === 'child_report' ? [entry.content.text] : [],
        );
        expect(rootReports).toEqual(['The full report']);

        // Then (B): the second input holds the notice after the cut answer; the root was told once, with the
        // full text; both scout calls are ledger rows
        expect(inputLines(scout.calls[1]?.messages ?? [])).toEqual([
          'user: Scout task',
          'assistant: The report starts and brea []',
          `user: [notice] ${CUT_OFF_NOTICE}`,
        ]);
        const notices = await childNoticesOf(harness.db, rootId, agentId);
        expect(
          notices.map(({ payload }) => [
            payload.status,
            payload.result?.report,
          ]),
        ).toEqual([['completed', 'The full report']]);
        expect(await ledgerRowsOf(harness.db, ownerId, agentId)).toHaveLength(
          2,
        );

        // Then (C): the journal of the scout's two model steps
        const steps = harness.logs
          .filter(
            (record) =>
              record.message === 'agent step finished' &&
              record.fields.agentId === agentId,
          )
          .map(({ fields }) => [
            fields.cutOff,
            fields.toolsChosen,
            fields.directCalls,
            fields.runCodeCalls,
          ]);
        expect(steps).toEqual([
          [true, [], 0, 0],
          [false, [], 0, 0],
        ]);
      } finally {
        await harness.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-4: an empty compaction summary does not fail the task, writes no compaction, and the next step is the model over the whole history
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-05.1 "Given модель вернула пустую сводку при сжатии истории, then задача агента не завершена ошибкой, история агента не потеряна, журнал записывает пустую сводку, и агент делает следующий шаг."
  //   Design: UC-9, KD-7; Flow 5.
  // Behavior: `AGENT_COMPACT_AT_TOKENS` set low through `variables` (as INT-1 E of agent-platform-agents) -> the scripted agent's first answer reports `usage.inputTokens` at the threshold -> the employee sends a
  //   message -> the next step is the compaction call, which the script answers with an empty text -> the step after it is a model call, answered with a normal text (small usage).
  // Rows (one test, literal expected values):
  //   A. the task is not `failed` (no `handler_error`) and ends `waiting`; the history lines are `task`, `model_answer: <first>`, `user_message: <the sent message>` (the message the compaction step
  //      delivered is there), `model_answer: <last>`: no `compaction:` line, no `event: compacted`.
  //   B. the third scripted call is a model call over the whole history, not a second compaction: its input ends with the sent message, not with the compaction request (the same literal `COMPACTION_REQUEST` text of
  //      agent-platform-agents); the script was called exactly three times.
  //   C. the log has one `compaction returned an empty summary` warn record with the agent id, the step number and the model (no summary text); the compaction call is in the ledger and the turn counter is not advanced by it.
  // Catches: the step still throwing on an empty summary (the whole task dies with `handler_error` - today's behaviour); the step returning `continue` but leaving `lastInputTokens` above the threshold, so the
  //   next step compacts again and the agent loops on paid empty summaries (row B); the delivered message lost because the commit of the empty-summary branch writes no continuation. A unit test of
  //   the pure helpers cannot see the commit; the happy-path compaction test (INT-1 E of agent-platform-agents) never reaches this branch.
  // @category: edge-case
  // @dependency: compaction step (step-handler commit), step handler order, runtime ledger, logger, Postgres, ScriptedModel
  // @complexity: medium
  it(
    'INT-4: a compaction that returns an empty summary keeps the task running with its whole history, writes no compaction entry, and the next step is a model call, not a second compaction',
    async () => {
      // Given: a root whose first answer reports input tokens at AGENT_COMPACT_AT_TOKENS and whose compaction
      // call returns an empty summary
      const ownerId = await newUser();
      const model = createScriptedModel();
      const compactor = model.script({ agent: 'empty-compactor' }, [
        { text: 'first answer', usage: { inputTokens: COMPACT_AT_TOKENS } },
        { text: '' },
        { text: 'answer after the empty summary' },
      ]);
      const harness = await createAgentsHarness({
        model,
        access: {},
        variables: { AGENT_COMPACT_AT_TOKENS: String(COMPACT_AT_TOKENS) },
        root: testRecord('empty-compactor'),
      });
      try {
        // When: the root answers at the threshold, then gets a message
        const { agentId } = await harness.sessions.start({
          ownerId,
          prompt: 'Compact me',
          description: 'compactor',
        });
        await compactor.called(1);
        await waitForTaskStatus(harness, agentId, ownerId, 'waiting');
        await harness.sessions.send({
          agentId,
          ownerId,
          text: 'next question',
        });
        await compactor.called(3);
        await waitForTaskStatus(harness, agentId, ownerId, 'waiting');

        // Then (A): the task did not fail; the history keeps the delivered message and has no compaction
        expect(
          historyLines(await historyOf(harness, agentId, ownerId)),
        ).toEqual([
          'task: Compact me',
          'model_answer: first answer []',
          'user_message: next question',
          'model_answer: answer after the empty summary []',
        ]);

        // Then (B): the second call was the compaction, the third a model call over the whole history
        expect(compactor.calls).toHaveLength(3);
        expect(inputLines(compactor.calls[1]?.messages ?? [])).toEqual([
          'user: Compact me',
          'assistant: first answer []',
          `user: ${COMPACTION_REQUEST}`,
        ]);
        expect(inputLines(compactor.calls[2]?.messages ?? [])).toEqual([
          'user: Compact me',
          'assistant: first answer []',
          'user: next question',
        ]);

        // Then (C): one warn with the agent, the step and the model; the compaction call is a ledger row but
        // not a turn (the message reset the root's counter, the last model call made it 1)
        const warns = harness.logs.filter(
          (record) => record.message === 'compaction returned an empty summary',
        );
        expect(
          warns.map(({ level, fields }) => [
            level,
            fields.agentId,
            fields.model,
          ]),
        ).toEqual([['warn', agentId, TEST_MODEL_DEFAULT]]);
        expect(typeof warns[0]?.fields.stepNo).toBe('number');
        expect(await ledgerRowsOf(harness.db, ownerId, agentId)).toHaveLength(
          3,
        );
        const [session] = await harness.db
          .select({ turns: conversations.turns })
          .from(conversations)
          .where(eq(conversations.id, agentId));
        expect(session?.turns).toBe(1);
      } finally {
        await harness.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
