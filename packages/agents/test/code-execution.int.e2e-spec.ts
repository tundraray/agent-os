// code-execution / code-execution Integration Test Skeletons - Design Doc: docs/features/code-execution/design-code-execution.md (Test Strategy UC-1, UC-2, UC-E2 call rows, UC-E3, UC-E6, UC-E8, UC-E9, UC-E11; Invariants 1-7; DC-2, DC-5..DC-12, DC-16, DC-18)
// PRD: docs/features/code-execution/prd.md v1.8 (FR-01, FR-03..FR-05, FR-07..FR-11). UXRD: docs/features/code-execution/uxrd.md v1.3 (the decision card is a web unit test, see "Proven elsewhere")
// Generated: 2026-11-14 | Part: code-execution (single part) | Test type: Integration (in-process `createRuntime` + `createAgents` over real Postgres, real MCP fixture process, scripted model, REAL `packages/code-runner` executor process unless a row says "substituted CodeRunner")
// Implementation timing: created alongside the slice each test names (INT-1 the read run and its history, audit and log; INT-2 the write run's confirmation; INT-3 the rights and isolation of calls from code; INT-4 interrupt, stop and the per-employee limit).
//
// File name follows the repo convention of the `agents` part (`*.int.e2e-spec.ts` under packages/agents/test, picked up by `vitest.config.e2e.ts`, run with `pnpm --filter @agent-os/agents test:e2e`, never in the default `vitest run`). The single-part feature
// carries its part name in the file (`code-execution`); the child-process file of this part is `code-execution.e2e-spec.ts` (E2E-1) and the executor-process file lives in `packages/code-runner/test` (E2E-2).
// Skeletons are `it.todo`: the Given/When/Then comments are the rows' specification. Tests are written with their tasks and run once, at the end of the part (project rule "Tests only at the end").
//
// Light test process (CLAUDE.md "Tests"): skeletons exist only where a defect is invisible below this level - the bridge between the executor and the tool gate over a real database, a real MCP server and the confirmation flow. The sandbox rules, the
// result mapping, the "Может вызвать" list and the hidden-character check are table-driven unit tests ("Proven elsewhere"). Already proven by the agent-platform parts and NOT repeated here: the tool gate rule table, the confirmation decision resolving once and surviving
// a restart as a runtime row, the step commit boundary, the owner check of the `agents` operations (agents INT-4).
//
// Environment (Design Doc "Test Strategy"):
// - Postgres 16 from infra/docker-compose.yml, migrations applied once by the global setup. Real `createRuntime` and real `createAgents` over a real pool. No mock of Postgres, of the runtime or of any agents component.
// - The model is the only double: a scripted `ModelClient` double at the wrapper boundary ("модель подменяется на границе `ModelClient` сценарием ответов"); it records the input of every call, which is the assertion surface for "the next model call sees X".
// - MCP is real: the `packages/mcp-fixture` HTTP process each harness starts, its sources registered in the registry under the run's names (`LOGS_SERVER`, `BACKOFFICE_SERVER` of
//   test/support/mcp-servers.ts; `logs` read-only with `search_logs` over a week of logs and a result larger than the slice; `backoffice` with `create_incident_note` and `close_ticket`; `tracker`). `FIXTURE_CALL_LOG` (JSONL journal) is the
//   evidence of what reached a server: "the server received nothing" is an empty filtered journal, never a mock's call count.
// - The executor is the real `packages/code-runner` process with production limits shortened through the `CODE_RUN_*` settings; only INT-4 row C substitutes the `CodeRunner` (a double that holds each run until the test releases it), because that row proves the
//   admission rule, not the engine.
// - Isolation (project convention, no truncate): a unique owner `newUser()` per test, the test's own library double (the root runs its `chat` record); each test reads only its own tree. `fileParallelism: false`. No sleeps for ordering: latches the double and the fixture wait on, and rows.
// - Support (test/support): `agentsHarness.ts` takes a `CodeRunner` override and the `CODE_RUN_*` settings through `variables`, and hides the provider key in its logger as `apps/api` does; the journal is read with `fixtureCallsOf` of `@agent-os/mcp-fixture`, the model is `createScriptedModel` of `@agent-os/agents/testing`.
//
// Budget: Integration 4 of 3 (base 3, extended by one under the integration-e2e-testing rule). Core: INT-1, INT-2, INT-3. Extra: INT-4.
//   INT-4 unique defect: a run that goes on calling tools after the employee pressed "interrupt" or "stop" (a side effect the employee already refused), and a limit slot that is never freed (the employee is locked out of code until restart). INT-1..INT-3 never
//   cancel a run, and a unit test cannot see the live process, the fixture journal and the admission counter together.
//
// E2E: see `code-execution.e2e-spec.ts` (E2E-1, restart) and `packages/code-runner/test/executor-process.e2e-spec.ts` (E2E-2, hostile Node and broken process).
//
// Proven elsewhere (not in this file; the plan reads this to avoid a second test for an AC already proven):
// - unit, packages/code-runner/src, table-driven, real QuickJS, no database, no API (UC-E1 and the sandbox half of UC-E2): `process`, `require`, `fetch`, `import()`, `WebAssembly`, `Intl`; the constructor chain reaching only QuickJS's global; prototype pollution; a
//   global left by one run not seen by the next; a syntax error with its line; an exception with its line; infinite loop, catastrophic regex, never-resolving `await`, deep recursion, memory growth, `console.log` flood (16 KiB with the mark), result over the limit,
//   function result - AC-02.3, AC-02.5, AC-06.1, AC-07.1, AC-07.2, AC-07.3, AC-07.5, AC-10.4 (error text half), DC-3, DC-14
// - unit, packages/agents/src: result-to-outcome mapping (string as is, `undefined`/`null`/`""` as "empty result", `[]`/`{}`) - DC-2; `canCallOf` table (UC-6) - AC-05.7, DC-17; `run_code` in every agent's tool set and the rule in every instruction, catalog check
//   rejects a definition naming `run_code` (UC-3) - AC-01.2, AC-01.3, DC-1; `ToolRunner.check` hidden-character table, both classes (UC-E10) - AC-01.5, KD-9
// - unit, apps/web: the feed rows and the decision card for the history entries of a successful run, a failed run and an open write run (UC-5) - AC-05.2 (card half), AC-08.1 (view half)
// - runtime/agents parts: the gate rule table, decisions resolving once, the owner check of `agents` operations.
// - on demand, a script outside the suite: UC-N1 (5 MB within the limit, NFR-01), UC-N2 (p95 of the empty script, NFR-02), UC-N3 (the server answers while runs sit at their limit, NFR-04, AC-10.5).
// - not automated: AC-01.4 (UC-4, a manual Haiku run recorded in the plan's analysis file).
//
// AC -> proving test:
// - AC-01.1, AC-03.2, AC-03.5, AC-04.1, AC-04.2, AC-05.1, AC-08.1, AC-08.2, AC-09.1, DC-2 (wiring), DC-7: INT-1 row A
// - AC-07.4, AC-10.4 (the model sees the error text), DC-11, DC-12: INT-1 row B
// - AC-10.3: INT-1 row C. INT-1 row D (a server credential in the script's env masked in the run log, AC-11.1, AC-02.2 in the log half) is dropped by mcp-connect: MCP credentials are no
//   longer settings, and the log mask holds only the keys in the process secret memory, which the provider rows fill (design-mcp-connect.md,
//   Security Considerations; model-providers design-core.md KD-7)
// - AC-05.2, AC-05.3, AC-05.4, AC-05.6, AC-03.7, DC-9, DC-10, DC-16, FR-11: INT-2 rows A-E (AC-05.7 once in row A over the unit table)
// - AC-03.1, AC-03.3, AC-03.4, AC-03.6, AC-05.5, AC-04.3, AC-06.2, DC-5, DC-6, DC-8: INT-3 rows A-C
// - AC-10.1: INT-4 rows A, B; AC-07.6, DC-18: INT-4 row C

import { createHash } from 'node:crypto';
import type { AgentConfirmation, AgentHistoryEntry, AgentTurnMessage } from '@agent-os/agents';
import {
  createLibraryDouble,
  createScriptedModel,
  inputLines,
  type Script,
  type ScriptedModel,
} from '@agent-os/agents/testing';
import type { CodeRunner, RunOutcome } from '@agent-os/code-runner';
import {
  createFixtureFiles,
  type FixtureFiles,
  fixtureCallsOf,
  holdCall,
  readFixtureLog,
} from '@agent-os/mcp-fixture';
import { describe, expect, it } from 'vitest';
import {
  type AgentsHarness,
  type AgentsHarnessOptions,
  closeAll,
  codeCallRowsOf,
  createAgentsHarness,
  historyLines,
  historyOf,
  runLogsOf,
  testRecord,
  toolCallRowsOf,
  toolOutputOf,
  waitFor,
  waitForTaskStatus,
} from './support/agentsHarness.js';
import { ONE_RECORD, runCode, SEARCH_LOGS, toolCallIdOf, WINDOW } from './support/logs-reader.js';
import { BACKOFFICE_SERVER, LOGS_SERVER, TRACKER_SERVER } from './support/mcp-servers.js';
import { newUser } from './support/new-user.js';

/** Bound of one in-process test; the rows settle far sooner. */
const TEST_TIMEOUT_MS = 120_000;

// A read-class script of INT-1 A reads the full result of a direct `mcp__${LOGS_SERVER}__search_logs` (500 records, more than the slice) by `callId`.
// The fixture's `totalMatched` is the literal the script's count is compared with.

/** The fixture's `totalMatched` for {@link WINDOW}: 500 on the first page and 129 on the second. */
const TOTAL_MATCHED = 629;
// The direct answer for WINDOW is 120 598 bytes of JSON, longer than the default `storeFromChars` (50 000): the model
// gets the wrapper with a preview of its start, and the whole answer is stored under the call's callId.

/**
 * The `callId` the cut mark of a direct result names, as the model reads it (inside the data envelope the
 * quotes are `&quot;`): a script reads the full result by it.
 */
function readResultIdIn(messages: readonly AgentTurnMessage[]): string {
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    for (const result of message.results) {
      if (typeof result.output !== 'string') continue;
      const match = /readResult\(&quot;(.+?)&quot;\)/.exec(result.output);
      if (match?.[1] !== undefined) return match[1];
    }
  }
  throw new Error('No tool result the model saw carries a cut mark with readResult');
}

/** A `run_code` result as the model gets it: the data envelope of a built-in tool. */
function seenRunResult(data: string): string {
  return `<data source="tool run_code" author="agents">\n${data}\n</data>`;
}

/** One reader of a test: an agent of a fresh owner whose record reads the `logs` server. */
interface Reader {
  readonly harness: AgentsHarness;
  readonly fixture: FixtureFiles;
  readonly ownerId: string;
  readonly agentId: string;
}

/**
 * Starts a root agent with `prompt` as its task (the model's script must answer that task) over a fresh owner
 * who may use `logs`, with the real code executor. The caller closes `harness`.
 */
async function startReader(
  model: ScriptedModel,
  prompt: string,
  options: Pick<AgentsHarnessOptions, 'variables' | 'fixture'> = {},
): Promise<Reader> {
  const ownerId = newUser();
  const fixture = options.fixture ?? createFixtureFiles('code-execution');
  const harness = await createAgentsHarness({
    ...options,
    model,
    fixture,
    access: { [ownerId]: [LOGS_SERVER] },
    root: testRecord('reader', { servers: [LOGS_SERVER] }),
  });
  try {
    const { agentId } = await harness.sessions.start({ ownerId, prompt, description: 'reader' });
    return { harness, fixture, ownerId, agentId };
  } catch (error) {
    await harness.close();
    throw error;
  }
}

/** Waits until the reader's script answered `calls` model calls and the root agent waits after its last text. */
async function untilTurnEnds(reader: Reader, script: { called(count: number): Promise<void> }, calls: number) {
  await script.called(calls);
  await waitForTaskStatus(reader.harness, reader.agentId, reader.ownerId, 'waiting');
}

/** The tool call ids the scripted model gave its answers, in order. */
function answerCallIds(script: { calls: readonly { toolCallIds: readonly string[] }[] }): string[] {
  return script.calls.flatMap((call) => call.toolCallIds);
}

/** The script of INT-1 A: the full first page by `callId`, the second page from code, a count and errors per service. */
function countingScript(resultId: string): string {
  return [
    `const first = await readResult(${JSON.stringify(resultId)});`,
    `const second = await callTool("${SEARCH_LOGS}", { ...${JSON.stringify(WINDOW)}, cursor: first.nextCursor });`,
    'const records = [...first.records, ...second.records];',
    'console.log("записей: " + records.length + " из " + first.totalMatched);',
    'const errors = {};',
    'for (const record of records) {',
    '  if (record.status === "error") errors[record.service] = (errors[record.service] ?? 0) + 1;',
    '}',
    'const errorsByService = Object.fromEntries(Object.keys(errors).sort().map((service) => [service, errors[service]]));',
    'return { records: records.length, errorsByService };',
  ].join('\n');
}

describe('INT-1: a read run end to end - the main path, the call limit, the retry, the secrets', () => {
  // AC-01.1: "Given агенту нужно посчитать по данным, when агент вызывает `run_code` со скриптом, классом и описанием, then в историю агента приходит значение, которое вернул скрипт."
  // AC-03.2: "Given скрипт сделал несколько вызовов инструментов, when запуск закончился, then в аудите есть одна запись на сам запуск и ровно по одной на каждый вызов из кода, и по каждой записи вызова видно, из какого запуска он сделан."
  // AC-03.5: "Given агент вызвал инструмент напрямую, и данные с тех пор не менялись, when скрипт вызывает тот же инструмент под тем же именем и с теми же аргументами, then скрипт получает тот же полный результат."
  // AC-04.1: "Given результат инструмента больше среза, when он приходит модели, then модель видит срез, пометку, что результат обрезан, и идентификатор полного результата."
  // AC-04.2: "Given модель получила обрезанный результат, when скрипт читает его по идентификатору и считает в нём записи, then число совпадает с числом записей в полном результате."
  // AC-05.1: "Given агент объявил класс `read`, when запуск начинается, then скрипт выполняется без вопроса сотруднику."
  // AC-08.1: "Given запуск закончился успешно, when сотрудник открывает историю агента, then видит время, описание, класс запуска и исход, как у любого вызова ... и вывод скрипта, а полный текст скрипта раскрывается одним действием."
  // AC-08.2: "Given скрипт печатал по ходу работы и вернул значение, when модель делает следующий ход, then из этого запуска она получает только возвращённое значение, без вывода скрипта."
  // AC-09.1: "Given запуск упал на вызове инструмента, when разработчик ищет запуск в логах по его идентификатору, then находит начало, каждый вызов из кода с исходом и длительностью, вывод скрипта и причину сбоя."
  // Behavior: the agent calls `search_logs` directly (500 records, answer larger than the slice) -> the scenario calls `run_code` class `read`; the script reads that result by `callId`, takes page two through `callTool("mcp__${LOGS_SERVER}__search_logs", ...)`, prints the
  //   count and returns errors per service -> the model gets only the returned value, the history carries the value and the `output`, the audit has one run row and one from-code row linked to it, the log has start, call with outcome and duration, output and end under one `runId`
  // Catches: a run whose pieces work alone but not chained - `readResult` returning the 16 KiB slice instead of the full result (the count is not `totalMatched`), the script output reaching the model, a from-code call row not linked to its run row, or a run missing from the log
  // @category: core-functionality
  // @dependency: run_code tool, CodeRunner (real process), ToolRunner.callFromCode, agent_tool_results, tool calls in `agent_messages`, MCP fixture (logs), logger, ScriptedModel, Postgres
  // @complexity: high
  it('INT-1 row A: AC-01.1 a read run counts the full result by callId, reaches the second page, and the model gets only the returned value', async () => {
    // Given: the agent reads a quarter of an hour of logs directly (500 records, more than the slice), then runs a read script
    // that reads that result by the callId of the cut mark, takes page two from code, prints the count and returns errors per service
    const prompt = 'Count the errors per service in the payment logs';
    const model = createScriptedModel();
    const script = model.script({ task: prompt }, [
      { calls: [{ tool: SEARCH_LOGS, args: WINDOW }] },
      (messages) => ({ calls: [runCode('Ошибки по сервисам', countingScript(readResultIdIn(messages)))] }),
      { text: 'Ошибки посчитаны' },
    ]);
    const reader = await startReader(model, prompt);
    const { harness, fixture, ownerId, agentId } = reader;
    try {
      // When: the steps run to the end of the turn
      await untilTurnEnds(reader, script, 3);
      const [searchCallId, runCallId] = answerCallIds(script);
      if (searchCallId === undefined || runCallId === undefined) throw new Error('the model made no two tool calls');

      // Then: the model saw the wrapper, not the answer: its size and the direct call's callId with readResult (AC-04.1;
      // tool-result-reading R-1), and nothing of the answer past the preview - `totalMatched`, the last key of the
      // canonical JSON, is not there
      const seenWrapper = toolOutputOf(script.calls[1]?.messages ?? [], searchCallId);
      expect(seenWrapper.startsWith(
        `<data source="tool search_logs" author="${LOGS_SERVER}">\n[stored result] Output too large: `,
      )).toBe(true);
      expect(seenWrapper).toContain(` characters. The full output is stored under callId &quot;${searchCallId}&quot;.\n`);
      expect(seenWrapper).toContain(`readResult(&quot;${searchCallId}&quot;)`);
      expect(seenWrapper).not.toContain('totalMatched');

      // Then: the read run started without asking the employee (AC-05.1)
      expect(await harness.sessions.confirmations(agentId, ownerId)).toEqual([]);

      // Then: the model got only the returned value: the count equals the fixture's totalMatched (AC-04.2, AC-01.1, DC-2),
      // and nothing of the script's output reached any model call (AC-08.2, Invariant 7)
      const lastInput = script.calls[2]?.messages ?? [];
      expect(toolOutputOf(lastInput, runCallId)).toBe(
        seenRunResult(
          '{&quot;records&quot;:629,&quot;errorsByService&quot;:{&quot;checkout-web&quot;:11,&quot;payment-api&quot;:11}}',
        ),
      );
      expect(inputLines(lastInput)).toEqual([
        `user: ${prompt}`,
        `assistant:  [mcp__${LOGS_SERVER}__search_logs]`,
        `tool: mcp__${LOGS_SERVER}__search_logs`,
        'assistant:  [run_code]',
        'tool: run_code',
      ]);
      // The script text names the 'записей: ' prefix; only the printed line with its counts is the run's output
      expect(JSON.stringify(model.calls)).not.toContain('записей: 629 из 629');

      // Then: the history gives the run's value and its output (AC-08.1)
      const history = await historyOf(harness, agentId, ownerId);
      expect(historyLines(history)).toEqual([
        `task: ${prompt}`,
        `model_answer:  [${LOGS_SERVER}/search_logs]`,
        'tool_result: search_logs success',
        'model_answer:  [run_code]',
        'tool_result: run_code success',
        'model_answer: Ошибки посчитаны []',
      ]);
      const runEntry = history.find((entry) => entry.kind === 'tool_result' && entry.content.callId === runCallId);
      expect(runEntry?.kind === 'tool_result' ? [runEntry.content.text, runEntry.content.output] : []).toEqual([
        `{"records":${TOTAL_MATCHED},"errorsByService":{"checkout-web":11,"payment-api":11}}`,
        'записей: 629 из 629',
      ]);

      // Then: one run row and one from-code row linked to it (AC-03.2); the second page reached the server from code (AC-03.5)
      const runRows = await toolCallRowsOf(harness.db, agentId);
      expect(runRows.map((row) => `${row.tool} ${row.state} ${row.outcome} attempts ${row.attempts} ${row.output}`)).toEqual([
        'search_logs done success attempts 0 null',
        'run_code done success attempts 1 записей: 629 из 629',
      ]);
      const codeRows = await codeCallRowsOf(harness.db, agentId, runCallId);
      expect(codeRows.map((row) => `${row.runCallId} ${row.attempt} ${row.seq} ${row.server}/${row.tool} ${row.outcome}`)).toEqual([
        `${runCallId} 1 1 ${LOGS_SERVER}/search_logs success`,
      ]);
      expect(codeRows[0]?.args).toEqual({ ...WINDOW, cursor: expect.any(String) });
      expect(codeRows[0]?.finishedAt).not.toBeNull();
      // page 1 direct and page 2 from code: the fixture's args hash ignores the cursor, so both are one query
      expect(fixtureCallsOf(fixture.callLog, { tool: 'search_logs', args: WINDOW })).toHaveLength(2);

      // Then: the log holds the start, the call with outcome and duration, the output and the end under one runId (AC-09.1)
      const runLogs = runLogsOf(harness, runCallId);
      const steps = ['code run started', 'tool call finished', 'code run output', 'code run ended'];
      expect(runLogs.map((record) => record.message).filter((message) => steps.includes(message))).toEqual(steps);
      const callRecord = runLogs.find((record) => record.message === 'tool call finished');
      expect([callRecord?.fields.tool, callRecord?.fields.outcome, callRecord?.fields.seq]).toEqual(['search_logs', 'success', 1]);
      expect(typeof callRecord?.fields.durationMs).toBe('number');
      expect(runLogs.find((record) => record.message === 'code run output')?.fields.output).toBe('записей: 629 из 629');
      expect(runLogs.find((record) => record.message === 'code run ended')?.fields.outcome).toBe('success');
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  // AC-07.4: "Given скрипт сделал 50 вызовов инструментов, when он просит 51-й, then вызов не исполняется, а запуск заканчивается ошибкой «превышено число вызовов» и итогом не считается."
  // AC-10.4: "Given скрипт упёрся в предел или упал на синтаксической ошибке или исключении, when модель делает следующий ход, then она получает текст с причиной и, где она есть, номером строки скрипта, а не урезанный итог."
  // Behavior: rows - 51 calls in a row; `Promise.all` of 100 calls; `readResult` of large results past 64 MiB in total -> "превышено число вызовов" with exactly 50 audit rows (the refused 51st counts, DC-11); "превышено число вызовов"; "превышена память" (DC-12);
  //   the next model call carries the error text, not a truncated result; the API process still answers
  // Catches: refused calls not counted (a script loops on refusals forever), a burst of parallel calls getting past the limit of 50, data handed to the script past 64 MiB, and the model getting a cut-off result in place of the error
  // @category: edge-case
  // @dependency: run_code tool, CodeRunner (real process), tool call counter, tool calls in `agent_messages`, MCP fixture, ScriptedModel
  // @complexity: medium
  it('INT-1 row B: AC-07.4 the call and memory limits end the run with the error text the model sees on its next turn (rows: 51 calls, Promise.all of 100, readResult past 64 MiB)', async () => {
    // Given: the agent reads a large page directly, then runs three scripts at the production limits (50 calls, 64 MiB):
    // 51 calls in a row, each refused and caught; `Promise.all` of 100 read calls; `readResult` of that page 1000 times (about 120 MB)
    const prompt = 'Check the limits of a script';
    const model = createScriptedModel();
    const refusedInARow = [
      'for (let call = 1; call <= 51; call += 1) {',
      `  try { await callTool("mcp__${LOGS_SERVER}__no_such_tool", {}); } catch (refusal) { console.log(refusal.reason); }`,
      '}',
      'return "51 вызов прошёл";',
    ].join('\n');
    const hundredAtOnce = [
      'const calls = [];',
      `for (let call = 1; call <= 100; call += 1) calls.push(callTool("${SEARCH_LOGS}", ${JSON.stringify(ONE_RECORD)}));`,
      'await Promise.all(calls);',
      'return "100 вызовов прошли";',
    ].join('\n');
    const readsPast64MiB = (resultId: string) =>
      [
        `for (let read = 1; read <= 1000; read += 1) await readResult(${JSON.stringify(resultId)});`,
        'return "1000 чтений прошли";',
      ].join('\n');
    const script = model.script({ task: prompt }, [
      { calls: [{ tool: SEARCH_LOGS, args: WINDOW }] },
      { calls: [runCode('51 вызов подряд', refusedInARow)] },
      { calls: [runCode('100 вызовов сразу', hundredAtOnce)] },
      (messages) => ({ calls: [runCode('Чтения сверх 64 МиБ', readsPast64MiB(readResultIdIn(messages)))] }),
      { text: 'Пределы проверены' },
    ]);
    const reader = await startReader(model, prompt);
    const { harness, fixture, ownerId, agentId } = reader;
    try {
      // When: the steps run to the end of the turn
      await untilTurnEnds(reader, script, 5);
      const [, refusedRunId, burstRunId, memoryRunId] = answerCallIds(script);
      if (refusedRunId === undefined || burstRunId === undefined || memoryRunId === undefined) {
        throw new Error('the model made no three runs');
      }

      // Then: each run ended with its error text, which the model got on its next turn instead of a result (AC-07.4, AC-10.4, DC-11, DC-12)
      const callLimit = seenRunResult('[tool_error]\ntool call limit exceeded (50)');
      expect(toolOutputOf(script.calls[2]?.messages ?? [], refusedRunId)).toBe(callLimit);
      expect(toolOutputOf(script.calls[3]?.messages ?? [], burstRunId)).toBe(callLimit);
      expect(toolOutputOf(script.calls[4]?.messages ?? [], memoryRunId)).toBe(
        seenRunResult('[tool_error]\nmemory limit exceeded (512 MB)'),
      );
      expect(historyLines(await historyOf(harness, agentId, ownerId))).toEqual([
        `task: ${prompt}`,
        `model_answer:  [${LOGS_SERVER}/search_logs]`,
        'tool_result: search_logs success',
        'model_answer:  [run_code]',
        'tool_result: run_code tool_error',
        'model_answer:  [run_code]',
        'tool_result: run_code tool_error',
        'model_answer:  [run_code]',
        'tool_result: run_code tool_error',
        'model_answer: Пределы проверены []',
      ]);
      expect((await toolCallRowsOf(harness.db, agentId)).map((row) => `${row.tool} ${row.outcome} ${row.output}`)).toEqual([
        'search_logs success null',
        'run_code tool_error null',
        'run_code tool_error null',
        'run_code tool_error null',
      ]);

      // Then: refusals count as calls: exactly 50 audit rows and the 51st request never ran (DC-11)
      const refusedRows = await codeCallRowsOf(harness.db, agentId, refusedRunId);
      expect(refusedRows.map((row) => `${row.seq} ${row.tool} ${row.outcome} ${row.refusalReason}`)).toEqual(
        Array.from({ length: 50 }, (_, index) => `${index + 1} mcp__${LOGS_SERVER}__no_such_tool refused tool_not_in_definition`),
      );

      // Then: a burst of 100 parallel calls got no further than 50, on the server as in the audit
      const burstRows = await codeCallRowsOf(harness.db, agentId, burstRunId);
      expect(burstRows.map((row) => `${row.server}/${row.tool} ${row.outcome}`)).toEqual(
        Array.from({ length: 50 }, () => `${LOGS_SERVER}/search_logs success`),
      );
      expect(fixtureCallsOf(fixture.callLog, { tool: 'search_logs', args: ONE_RECORD })).toHaveLength(50);

      // Then: reads are not calls, and the run past 64 MiB ended with no audit row
      expect(await codeCallRowsOf(harness.db, agentId, memoryRunId)).toEqual([]);

      // Then: the API process still answers: the agent's view reads after the three failed runs
      expect((await harness.sessions.get(agentId, ownerId)).status).toBe('working');
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  // AC-10.3: "Given запуск закончился ошибкой, when модель исправляет код и снова вызывает `run_code`, then новый запуск идёт как обычный вызов, и отказа по числу попыток нет, пока не исчерпан предел ходов агента."
  // Behavior: scenario `run_code` with a syntax error, then the corrected script -> both runs execute, the second succeeds, no refusal on attempts
  // Catches: a failed run counted as an attempt that blocks the corrected one (the agent cannot recover from its own typo)
  // @category: core-functionality
  // @dependency: run_code tool, CodeRunner (real process), turn counter, ScriptedModel
  // @complexity: low
  it('INT-1 row C: AC-10.3 a run that failed on a syntax error is followed by a corrected run that executes and succeeds', async () => {
    // Given: the model's first script has a syntax error on line 3, its second is the corrected script
    const prompt = 'Add three numbers in a script';
    const model = createScriptedModel();
    const script = model.script({ task: prompt }, [
      { calls: [runCode('Сумма', 'const a = 1;\nconst b = 2;\nconst = 3;\nreturn a + b;')] },
      { calls: [runCode('Сумма, исправлено', 'const a = 1;\nconst b = 2;\nconst c = 3;\nreturn a + b + c;')] },
      { text: 'Сумма — 6' },
    ]);
    const reader = await startReader(model, prompt);
    const { harness, ownerId, agentId } = reader;
    try {
      // When: the agent works to the end of its turn
      await untilTurnEnds(reader, script, 3);
      const [brokenRunId, fixedRunId] = answerCallIds(script);

      // Then: the model got the reason with the line, and the corrected run executed as an ordinary call and succeeded
      expect(toolOutputOf(script.calls[1]?.messages ?? [], brokenRunId)).toBe(
        seenRunResult('[tool_error]\nsyntax error: SyntaxError: variable name expected; line 3'),
      );
      expect(toolOutputOf(script.calls[2]?.messages ?? [], fixedRunId)).toBe(seenRunResult('6'));
      expect((await toolCallRowsOf(harness.db, agentId)).map((row) => `${row.tool} ${row.outcome} attempts ${row.attempts}`)).toEqual([
        'run_code tool_error attempts 1',
        'run_code success attempts 1',
      ]);
      expect(historyLines(await historyOf(harness, agentId, ownerId))).toEqual([
        `task: ${prompt}`,
        'model_answer:  [run_code]',
        'tool_result: run_code tool_error',
        'model_answer:  [run_code]',
        'tool_result: run_code success',
        'model_answer: Сумма — 6 []',
      ]);
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);
});

// INT-2 and INT-3: a write run of three incident notes on the back office, the employee's one decision, and calls from
// code against the rights. The note ids are the fixture's: the first 12 hex digits of `argsHash` of each note's arguments.

/** The changing tool of the back office as the model and a script name it. */
const CREATE_NOTE = `mcp__${BACKOFFICE_SERVER}__create_incident_note`;
/** The order every note of a write script is about. */
const NOTE_ORDER = 'ord-int2';
/** The texts of the three notes a write script creates, in order. */
const NOTE_TEXTS = ['Заметка 1', 'Заметка 2', 'Заметка 3'] as const;
/** The fixture's `noteId` of each of {@link NOTE_TEXTS}. */
const NOTE_IDS = ['080250a8360c', '8f758d03b419', '3e8c00b5b6d3'];
/** The description of the write run the employee reads in the request. */
const NOTES_DESCRIPTION = 'Три заметки по заказу';

/** The arguments of one note. */
function noteArgs(text: string): { orderId: string; text: string } {
  return { orderId: NOTE_ORDER, text };
}

/** A write script that creates the three notes one after another, then runs `tail` (by default it returns their ids). */
function notesScript(tail: readonly string[] = ['return noteIds;']): string {
  return [
    'const noteIds = [];',
    `for (const text of ${JSON.stringify(NOTE_TEXTS)}) {`,
    `  const note = await callTool("${CREATE_NOTE}", { orderId: ${JSON.stringify(NOTE_ORDER)}, text });`,
    '  noteIds.push(note.noteId);',
    '}',
    ...tail,
  ].join('\n');
}

/** The script lines that run `call` and turn its refusal into `"<outcome> <reason> <text>"`. */
function caughtAs(variable: string, call: string): string[] {
  return [
    `let ${variable} = "вызов прошёл";`,
    `try { await ${call}; } catch (error) { ${variable} = error.outcome + " " + error.reason + " " + error.text; }`,
  ];
}

/** The history entry of one tool call's result. */
function resultEntryOf(history: readonly AgentHistoryEntry[], callId: string | undefined) {
  const entry = history.find((candidate) => candidate.kind === 'tool_result' && candidate.content.callId === callId);
  if (entry?.kind !== 'tool_result') throw new Error(`The history holds no result of call ${String(callId)}`);
  return entry.content;
}

/** The value a successful run returned, as the history keeps it (JSON text). */
function returnedBy(history: readonly AgentHistoryEntry[], runCallId: string | undefined): unknown {
  return JSON.parse(resultEntryOf(history, runCallId).text ?? '') as unknown;
}

/** The audit rows of a run's calls from code as `<seq> <server>/<tool> <outcome> <refusal reason>`. */
function codeCallLines(rows: Awaited<ReturnType<typeof codeCallRowsOf>>): string[] {
  return rows.map((row) => {
    const target = row.server === null ? row.tool : `${row.server}/${row.tool}`;
    return `${row.seq} ${target} ${row.outcome} ${row.refusalReason}`;
  });
}

/** The ids of the tool calls in the model's own earlier answers, as its input carries them. */
function answeredCallIds(messages: readonly AgentTurnMessage[]): string[] {
  return messages.flatMap((message) =>
    message.role === 'assistant' ? message.toolCalls.map((call) => call.toolCallId) : [],
  );
}

/** The log records that started a run: one per executor process started for it. */
function runStarts(harness: AgentsHarness, runCallId: string) {
  return runLogsOf(harness, runCallId).filter((record) => record.message === 'code run started');
}

/** The ids of the open requests of the agent's tree. */
async function openRequestIds(harness: AgentsHarness, agentId: string, ownerId: string): Promise<string[]> {
  const requests = await harness.sessions.confirmations(agentId, ownerId);
  return requests.filter((request) => request.status === 'open').map((request) => request.decisionId);
}

/** Waits until the agent asks the employee to decide and returns its one open request. */
async function untilRequest(harness: AgentsHarness, agentId: string, ownerId: string): Promise<AgentConfirmation> {
  await waitFor(
    () => harness.sessions.get(agentId, ownerId),
    (view) => view.status === 'awaiting_confirmation',
    'the request of the write run',
  );
  const open = (await harness.sessions.confirmations(agentId, ownerId)).filter((request) => request.status === 'open');
  const [request] = open;
  if (open.length !== 1 || request === undefined) throw new Error(`The writer has ${open.length} open requests`);
  return request;
}

/** One writer of a test: an agent of a fresh owner who may use both servers, waiting for the decision on its write run. */
interface Writer extends Reader {
  /** The harness options: a second instance over the same database and fixture is built from them. */
  readonly options: AgentsHarnessOptions;
  readonly request: AgentConfirmation;
}

/**
 * Starts a root agent with `prompt` as its task over a fresh owner who may use `logs` and `backoffice`, with the
 * real code executor, and waits for the request of its write run. The caller closes `harness`.
 */
async function startWriter(
  model: ScriptedModel,
  prompt: string,
  fixture: FixtureFiles = createFixtureFiles('code-execution'),
): Promise<Writer> {
  const ownerId = newUser();
  const options: AgentsHarnessOptions = {
    model,
    fixture,
    access: { [ownerId]: [LOGS_SERVER, BACKOFFICE_SERVER] },
    library: createLibraryDouble(),
    root: testRecord('writer', { servers: [LOGS_SERVER, BACKOFFICE_SERVER] }),
  };
  const harness = await createAgentsHarness(options);
  try {
    const { agentId } = await harness.sessions.start({ ownerId, prompt, description: 'writer' });
    const request = await untilRequest(harness, agentId, ownerId);
    return { harness, fixture, ownerId, agentId, options, request };
  } catch (error) {
    await harness.close();
    throw error;
  }
}

describe('INT-2: a write run - nothing moves before the decision, and only the confirmed script runs', () => {
  // AC-05.2: "Given агент объявил класс `write`, when запуск начинается, then скрипт не выполняется, а сотрудник видит запрос: какой агент просит, что запуск изменяющий, и описание. Код скрипта в запросе свёрнут ... раскрытый текст полон и совпадает с тем, что ..."
  // AC-05.3: "Given запрос на изменяющий запуск ждёт, when сотрудник подтверждает, then скрипт выполняется один раз, и его изменяющие вызовы исполняются без новых запросов."
  // AC-05.7 (once, over the unit table): "... в запросе есть список «Может вызвать» ровно из этих трёх инструментов ..."
  // Behavior: a `write` run whose script calls `mcp__${BACKOFFICE_SERVER}__create_incident_note` three times -> before the decision the fixture journal is empty and the request carries the agent, the description, the class, the full script and the one-item "Может вызвать" list ("меняет") -> approve -> three calls, no new request, the result
  // Catches: a mutating call reaching the server before the employee decided, a request that does not carry the list or the full script the employee will confirm, a confirmed script that asks again for each call
  // @category: core-functionality
  // @dependency: run_code tool, ToolRunner.check, decision (runtime), CodeRunner (real process), MCP fixture (backoffice), tool calls in `agent_messages`
  // @complexity: high
  it('INT-2 row A: AC-05.3 the request waits with the journal empty and carries script and "Может вызвать"; approve runs the three calls once, with no new request', async () => {
    // Given: a write run of three notes; the fixture holds the first note until the test releases it
    const prompt = 'Write three incident notes';
    const fixture = createFixtureFiles('code-execution');
    const firstNoteHeld = fixture.latch('first-note');
    fixture.setFaults([holdCall('create_incident_note', noteArgs(NOTE_TEXTS[0]), firstNoteHeld)]);
    const script = notesScript();
    const model = createScriptedModel();
    const writerScript = model.script({ task: prompt }, [
      { calls: [runCode(NOTES_DESCRIPTION, script, 'write')] },
      { text: 'Заметки созданы' },
    ]);
    const writer = await startWriter(model, prompt, fixture);
    const { harness, ownerId, agentId, request } = writer;
    try {
      const runCallId = toolCallIdOf(writerScript, 0);

      // Then: before the decision nothing moved: the journal is empty, no executor process started (the run has no
      // log record), no call from code was written, and the run waits for the decision (DC-10, AC-05.2)
      expect(readFixtureLog(fixture.callLog)).toEqual([]);
      expect(runLogsOf(harness, runCallId)).toEqual([]);
      expect(await codeCallRowsOf(harness.db, agentId, runCallId)).toEqual([]);
      expect((await toolCallRowsOf(harness.db, agentId)).map((row) => `${row.tool} ${row.state} attempts ${row.attempts}`)).toEqual([
        'run_code awaiting_confirmation attempts 0',
      ]);

      // Then: the request names the agent, the run and its class, carries the full script, and its "Может вызвать"
      // list is the one tool the script names, marked "меняет" (AC-05.2, AC-05.7 over the unit table)
      expect([request.agentId, request.description, request.kind, request.server, request.tool, request.toolTitle]).toEqual([
        agentId,
        'writer',
        'agents.tool_confirmation',
        null,
        'run_code',
        'Выполнить код',
      ]);
      expect(request.args).toEqual({ description: NOTES_DESCRIPTION, class: 'write', script });
      expect(request.content).toEqual({ canCall: [{ name: CREATE_NOTE, changes: true }] });

      // When: the employee approves
      expect(await harness.sessions.resolveConfirmation({ decisionId: request.decisionId, ownerId, approve: true })).toBe(
        'resolved',
      );

      // Then: while the script's first note is at the server, the run's row is in `sending`: the run started only
      // after the intent was written (Invariant 3)
      await waitFor(
        () => fixtureCallsOf(fixture.callLog, { tool: 'create_incident_note' }),
        (calls) => calls.length === 1,
        'the first note of the run at the server',
      );
      expect((await toolCallRowsOf(harness.db, agentId)).map((row) => `${row.tool} ${row.state}`)).toEqual([
        'run_code sending',
      ]);
      firstNoteHeld.release();
      await untilTurnEnds(writer, writerScript, 2);

      // Then: the script ran once: each note reached the server once, with no new request (AC-05.3)
      expect(readFixtureLog(fixture.callLog)).toHaveLength(3);
      for (const text of NOTE_TEXTS) {
        expect(fixtureCallsOf(fixture.callLog, { tool: 'create_incident_note', args: noteArgs(text) })).toHaveLength(1);
      }
      expect(runStarts(harness, runCallId)).toHaveLength(1);
      expect(codeCallLines(await codeCallRowsOf(harness.db, agentId, runCallId))).toEqual([
        `1 ${BACKOFFICE_SERVER}/create_incident_note success null`,
        `2 ${BACKOFFICE_SERVER}/create_incident_note success null`,
        `3 ${BACKOFFICE_SERVER}/create_incident_note success null`,
      ]);
      const requests = await harness.sessions.confirmations(agentId, ownerId);
      expect(requests.map((decided) => `${decided.decisionId} ${decided.status} ${decided.resolution?.approve}`)).toEqual([
        `${request.decisionId} resolved true`,
      ]);

      // Then: the run ended once with the notes' ids, and the agent went on to its answer
      expect((await toolCallRowsOf(harness.db, agentId)).map((row) => `${row.tool} ${row.state} ${row.outcome} attempts ${row.attempts}`)).toEqual([
        'run_code done success attempts 0',
      ]);
      const history = await historyOf(harness, agentId, ownerId);
      expect(historyLines(history)).toEqual([
        `task: ${prompt}`,
        'model_answer:  [run_code]',
        'tool_result: run_code success',
        'model_answer: Заметки созданы []',
      ]);
      expect(returnedBy(history, runCallId)).toEqual(NOTE_IDS);
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  // AC-05.4: "Given запрос на изменяющий запуск ждёт, when сотрудник отклоняет, then скрипт не выполняется, а агент получает результат «отклонено пользователем»."
  // Behavior: reject -> zero calls on the fixture, the agent's result is "отклонено"
  // Catches: a rejected script that runs anyway
  // @category: core-functionality
  // @dependency: run_code tool, decision (runtime), MCP fixture
  // @complexity: low
  it('INT-2 row B: AC-05.4 reject leaves the fixture journal empty and the agent gets "отклонено"', async () => {
    // Given: a write run of three notes waiting for the decision
    const prompt = 'Write three notes, then be rejected';
    const model = createScriptedModel();
    const writerScript = model.script({ task: prompt }, [
      { calls: [runCode(NOTES_DESCRIPTION, notesScript(), 'write')] },
      { text: 'Заметки не созданы' },
    ]);
    const writer = await startWriter(model, prompt);
    const { harness, fixture, ownerId, agentId, request } = writer;
    try {
      const runCallId = toolCallIdOf(writerScript, 0);

      // When: the employee rejects
      expect(await harness.sessions.resolveConfirmation({ decisionId: request.decisionId, ownerId, approve: false })).toBe(
        'resolved',
      );
      await untilTurnEnds(writer, writerScript, 2);

      // Then: the script never ran: no call reached a server, no executor process started, no call from code was written
      expect(readFixtureLog(fixture.callLog)).toEqual([]);
      expect(runStarts(harness, runCallId)).toEqual([]);
      expect(await codeCallRowsOf(harness.db, agentId, runCallId)).toEqual([]);

      // Then: the run is closed "отклонено", the model got the rejection, and the step's log records it under the run's callId
      expect((await toolCallRowsOf(harness.db, agentId)).map((row) => `${row.tool} ${row.state} ${row.outcome}`)).toEqual([
        'run_code done rejected',
      ]);
      expect(toolOutputOf(writerScript.calls[1]?.messages ?? [], runCallId)).toBe(seenRunResult('[rejected]'));
      expect(historyLines(await historyOf(harness, agentId, ownerId))).toEqual([
        `task: ${prompt}`,
        'model_answer:  [run_code]',
        'tool_result: run_code rejected',
        'model_answer: Заметки не созданы []',
      ]);
      expect(
        harness.logs.filter(
          (record) => record.message === 'tool call rejected by the employee' && record.fields.callId === runCallId,
        ),
      ).toHaveLength(1);
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  // Design DC-9 / FR-05: "Аргументы запуска `write` при подтверждении править нельзя: решение с аргументами получает `INVALID_ARGUMENTS`, а исполняется код из строки вызова."
  // Behavior: a decision with edited arguments -> `INVALID_ARGUMENTS`, the request stays open, nothing runs
  // Catches: an employee-edited (or forged) script replacing the one the agent proposed and the card showed
  // @category: edge-case
  // @dependency: run_code tool, decision (runtime), agents sessions
  // @complexity: low
  it('INT-2 row C: DC-9 a decision with edited arguments is refused with INVALID_ARGUMENTS and the request stays open', async () => {
    // Given: a write run of three notes waiting for the decision
    const prompt = 'Write three notes, then get a forged decision';
    const model = createScriptedModel();
    const writerScript = model.script({ task: prompt }, [{ calls: [runCode(NOTES_DESCRIPTION, notesScript(), 'write')] }]);
    const writer = await startWriter(model, prompt);
    const { harness, fixture, ownerId, agentId, request } = writer;
    try {
      const runCallId = toolCallIdOf(writerScript, 0);

      // When: a decision comes with an edited script in place of the one the request shows
      const forged = { description: NOTES_DESCRIPTION, class: 'write', script: 'return "подменённый скрипт";' };
      await expect(
        harness.sessions.resolveConfirmation({ decisionId: request.decisionId, ownerId, approve: true, args: forged }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });

      // Then: the request is still open, nothing ran and nothing reached a server
      expect(await openRequestIds(harness, agentId, ownerId)).toEqual([request.decisionId]);
      expect((await harness.sessions.get(agentId, ownerId)).status).toBe('awaiting_confirmation');
      expect((await toolCallRowsOf(harness.db, agentId)).map((row) => `${row.tool} ${row.state}`)).toEqual([
        'run_code awaiting_confirmation',
      ]);
      expect(runLogsOf(harness, runCallId)).toEqual([]);
      expect(readFixtureLog(fixture.callLog)).toEqual([]);
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  // AC-05.6: "Given запрос на изменяющий запуск ждёт, when сервер перезапускают, then запрос по-прежнему ждёт решения."
  // Behavior: restart (a second instance over the same database) before the decision -> the request is open and can be approved, the script then runs once
  // Catches: a write request lost by the restart or a run that starts without the decision
  // @category: core-functionality
  // @dependency: run_code tool, decision (runtime), second instance, MCP fixture
  // @complexity: medium
  it('INT-2 row D: AC-05.6 after a restart the request is still open and approving it runs the script once', async () => {
    // Given: a write run of three notes waiting for the decision on the first instance
    const prompt = 'Write three notes across a restart';
    const model = createScriptedModel();
    const writerScript = model.script({ task: prompt }, [
      { calls: [runCode(NOTES_DESCRIPTION, notesScript(), 'write')] },
      { text: 'Заметки созданы после рестарта' },
    ]);
    const writer = await startWriter(model, prompt);
    const { fixture, ownerId, agentId, request } = writer;
    let firstOpen = true;
    let second: AgentsHarness | undefined;
    try {
      const runCallId = toolCallIdOf(writerScript, 0);
      expect(runLogsOf(writer.harness, runCallId)).toEqual([]);

      // When: the first instance stops and a second one starts over the same database and fixture
      await writer.harness.close();
      firstOpen = false;
      second = await createAgentsHarness(writer.options);

      // Then: the request still waits there, and nothing reached a server
      expect(await openRequestIds(second, agentId, ownerId)).toEqual([request.decisionId]);
      expect(readFixtureLog(fixture.callLog)).toEqual([]);

      // When: the employee approves on the second instance
      expect(await second.sessions.resolveConfirmation({ decisionId: request.decisionId, ownerId, approve: true })).toBe(
        'resolved',
      );
      await writerScript.called(2);
      await waitForTaskStatus(second, agentId, ownerId, 'waiting');

      // Then: the script ran once there: one executor process, each note once at the server
      expect(runStarts(second, runCallId)).toHaveLength(1);
      expect(readFixtureLog(fixture.callLog)).toHaveLength(3);
      for (const text of NOTE_TEXTS) {
        expect(fixtureCallsOf(fixture.callLog, { tool: 'create_incident_note', args: noteArgs(text) })).toHaveLength(1);
      }
      const history = await historyOf(second, agentId, ownerId);
      expect(historyLines(history)).toEqual([
        `task: ${prompt}`,
        'model_answer:  [run_code]',
        'tool_result: run_code success',
        'model_answer: Заметки созданы после рестарта []',
      ]);
      expect(returnedBy(history, runCallId)).toEqual(NOTE_IDS);
    } finally {
      await closeAll([...(firstOpen ? [writer.harness] : []), ...(second === undefined ? [] : [second])]);
    }
  }, TEST_TIMEOUT_MS);

  // AC-03.7: "Given идёт подтверждённый запуск `write`, when скрипт вызывает инструмент агента, чьё имя не написано в тексте скрипта, например собрано из частей во время запуска, then MCP-сервер не получает вызова, скрипт получает отказ, причина которого называет инструмент и то, что его нет в подтверждённом ..."
  // Behavior: a confirmed script makes three note calls, then calls `mcp__${LOGS_SERVER}__search_logs` by a name built from two parts -> refusal `not_in_confirmed_script` naming the tool, audit row "отказ", the journal has three calls and no `search_logs`, the log's run start carries "подтверждён" and the code hash
  // Catches: a confirmed script reaching a tool the employee never saw in the "Может вызвать" list (the confirmation covers more than what was shown)
  // @category: core-functionality
  // @dependency: run_code tool, ToolRunner.callFromCode, decision list "Может вызвать", tool calls in `agent_messages`, MCP fixture, logger
  // @complexity: high
  it('INT-2 row E: AC-03.7 a confirmed script calling a tool absent from the confirmed list is refused not_in_confirmed_script and the server never sees it', async () => {
    // Given: a write script that creates the three notes, then calls `search_logs` by a name built from two parts at run time
    const prompt = 'Write three notes, then read the logs by a built name';
    const script = notesScript([
      `const name = "mcp__${LOGS_SERVER}__" + "search_logs";`,
      ...caughtAs('refusal', `callTool(name, ${JSON.stringify(ONE_RECORD)})`),
      'return { noteIds, refusal };',
    ]);
    const model = createScriptedModel();
    const writerScript = model.script({ task: prompt }, [
      { calls: [runCode(NOTES_DESCRIPTION, script, 'write')] },
      { text: 'Заметки созданы, логи не прочитаны' },
    ]);
    const writer = await startWriter(model, prompt);
    const { harness, fixture, ownerId, agentId, request } = writer;
    try {
      const runCallId = toolCallIdOf(writerScript, 0);
      // The employee confirms a list without the built name
      expect(request.content).toEqual({ canCall: [{ name: CREATE_NOTE, changes: true }] });

      // When: the employee approves
      expect(await harness.sessions.resolveConfirmation({ decisionId: request.decisionId, ownerId, approve: true })).toBe(
        'resolved',
      );
      await untilTurnEnds(writer, writerScript, 2);

      // Then: the built name was refused not_in_confirmed_script with a text naming the tool, and the server never saw it
      expect(returnedBy(await historyOf(harness, agentId, ownerId), runCallId)).toEqual({
        noteIds: NOTE_IDS,
        refusal:
          `refused not_in_confirmed_script mcp__${LOGS_SERVER}__search_logs: the tool is not in the confirmed code (not_in_confirmed_script, write run)`,
      });
      expect(fixtureCallsOf(fixture.callLog, { tool: 'search_logs' })).toEqual([]);
      expect(fixtureCallsOf(fixture.callLog, { tool: 'create_incident_note' })).toHaveLength(3);
      expect(codeCallLines(await codeCallRowsOf(harness.db, agentId, runCallId))).toEqual([
        `1 ${BACKOFFICE_SERVER}/create_incident_note success null`,
        `2 ${BACKOFFICE_SERVER}/create_incident_note success null`,
        `3 ${BACKOFFICE_SERVER}/create_incident_note success null`,
        `4 ${LOGS_SERVER}/search_logs refused not_in_confirmed_script`,
      ]);

      // Then: the log's run start is marked confirmed and carries the SHA-256 of the code (FR-11)
      const starts = runStarts(harness, runCallId);
      expect(starts).toHaveLength(1);
      expect(starts[0]?.fields).toMatchObject({
        runClass: 'write',
        confirmed: true,
        scriptSha256: createHash('sha256').update(script, 'utf8').digest('hex'),
      });
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);
});

describe('INT-3: rights and isolation of calls from code - employee A, employee B, a foreign result', () => {
  // AC-03.1: "Given MCP-сервер не разрешён сотруднику, when скрипт вызывает инструмент этого сервера, then сервер не получает ни одного вызова, скрипт получает отказ, а в аудите появляется запись с исходом «отказ по правам»."
  // AC-03.4: "Given скрипт просит встроенный инструмент платформы, when идёт запуск, then вызов не исполняется, а скрипт получает отказ с причиной."
  // AC-03.6: "Given инструмента нет в определении агента, when скрипт его вызывает, then вызов не исполняется, а скрипт получает отказ с причиной."
  // AC-05.5: "Given идёт запуск `read`, when скрипт вызывает изменяющий инструмент или инструмент без пометки, then MCP-сервер не получает вызова, скрипт получает отказ, причина которого называет инструмент и класс запуска, а в аудите появляется запись с исходом «отказ»."
  // Behavior: employee A is allowed `logs`, not `backoffice`; the definition names both servers; rows by script - `callTool("start_agent")` and `callTool("run_code")` -> `not_callable_from_code`; an invented name and a server tool outside the definition -> `tool_not_in_definition`; a `backoffice` tool -> `no_access`;
  //   `create_incident_note` in a `read` run -> `changing_in_read_run` with tool name and class -> every row has an audit row "отказ" and the fixture journal is empty
  // Catches: a script reaching a server its employee may not use, a built-in tool through the code door (it would start agents or nest runs past the gate), a change slipping into a read run
  // @category: core-functionality
  // @dependency: run_code tool, ToolRunner.callFromCode, MCP access table, tool calls in `agent_messages`, MCP fixture
  // @complexity: high
  it('INT-3 row A: AC-03.1 each refused call from code (built-in, invented, outside the definition, not permitted, changing in read) gets its reason and an audit row, and the server journal stays empty', async () => {
    // Given: the definition names `logs` and `backoffice`; employee A may use `logs` only, employee W both. A's read script
    // asks for `start_agent`, `run_code`, an invented name, a `tracker` tool (a server outside the definition) and a
    // `backoffice` tool; W's read script asks for `create_incident_note` (W has the server, so the run class decides)
    const employeeA = newUser();
    const employeeW = newUser();
    const requests = [
      ['start_agent', { agent: 'both-servers', description: 'вложенный агент', prompt: 'Сделай что-нибудь' }],
      ['run_code', { description: 'вложенный запуск', class: 'read', script: 'return 1;' }],
      [`mcp__${LOGS_SERVER}__no_such_tool`, {}],
      [`mcp__${TRACKER_SERVER}__search_tickets`, {}],
      [`mcp__${BACKOFFICE_SERVER}__search_orders`, { ...WINDOW }],
    ];
    const refusing = [
      `const requests = ${JSON.stringify(requests)};`,
      'const refusals = [];',
      'for (const [name, args] of requests) {',
      ...caughtAs('refusal', 'callTool(name, args)'),
      '  refusals.push(refusal);',
      '}',
      'return refusals;',
    ].join('\n');
    const changing = [...caughtAs('refusal', `callTool("${CREATE_NOTE}", ${JSON.stringify(noteArgs(NOTE_TEXTS[0]))})`), 'return refusal;'].join(
      '\n',
    );
    const promptA = 'Call tools from code against the rules';
    const promptW = 'Change something from a read run';
    const model = createScriptedModel();
    const scriptA = model.script({ task: promptA }, [
      { calls: [runCode('Просьбы против правил', refusing)] },
      { text: 'Отказы получены' },
    ]);
    const scriptW = model.script({ task: promptW }, [
      { calls: [runCode('Изменение в читающем запуске', changing)] },
      { text: 'Изменение не прошло' },
    ]);
    const fixture = createFixtureFiles('code-execution');
    const harness = await createAgentsHarness({
      model,
      fixture,
      access: { [employeeA]: [LOGS_SERVER], [employeeW]: [LOGS_SERVER, BACKOFFICE_SERVER] },
      root: testRecord('both-servers', { servers: [LOGS_SERVER, BACKOFFICE_SERVER] }),
    });
    try {
      // When: both runs go
      const { agentId: agentA } = await harness.sessions.start({
        ownerId: employeeA,
        prompt: promptA,
        description: 'refused',
      });
      const { agentId: agentW } = await harness.sessions.start({
        ownerId: employeeW,
        prompt: promptW,
        description: 'changing in read',
      });
      await untilTurnEnds({ harness, fixture, ownerId: employeeA, agentId: agentA }, scriptA, 2);
      await untilTurnEnds({ harness, fixture, ownerId: employeeW, agentId: agentW }, scriptW, 2);
      const runA = toolCallIdOf(scriptA, 0);
      const runW = toolCallIdOf(scriptW, 0);

      // Then: each request got its refusal, whose text names the tool, the reason and the run class (AC-03.4, AC-03.6,
      // AC-03.1, AC-05.5, DC-5, DC-6)
      expect(returnedBy(await historyOf(harness, agentA, employeeA), runA)).toEqual([
        'refused not_callable_from_code start_agent: refused, not_callable_from_code (read run)',
        'refused not_callable_from_code run_code: refused, not_callable_from_code (read run)',
        `refused tool_not_in_definition mcp__${LOGS_SERVER}__no_such_tool: refused, tool_not_in_definition (read run)`,
        `refused tool_not_in_definition mcp__${TRACKER_SERVER}__search_tickets: refused, tool_not_in_definition (read run)`,
        `refused no_access mcp__${BACKOFFICE_SERVER}__search_orders: refused, no_access (read run)`,
      ]);
      expect(resultEntryOf(await historyOf(harness, agentW, employeeW), runW).text).toBe(
        `refused changing_in_read_run mcp__${BACKOFFICE_SERVER}__create_incident_note: the tool is not marked read-only, and a read run only reads (changing_in_read_run)`,
      );

      // Then: every refusal has its audit row "отказ" with the reason
      expect(codeCallLines(await codeCallRowsOf(harness.db, agentA, runA))).toEqual([
        '1 start_agent refused not_callable_from_code',
        '2 run_code refused not_callable_from_code',
        `3 mcp__${LOGS_SERVER}__no_such_tool refused tool_not_in_definition`,
        `4 mcp__${TRACKER_SERVER}__search_tickets refused tool_not_in_definition`,
        `5 ${BACKOFFICE_SERVER}/search_orders refused no_access`,
      ]);
      expect(codeCallLines(await codeCallRowsOf(harness.db, agentW, runW))).toEqual([
        `1 ${BACKOFFICE_SERVER}/create_incident_note refused changing_in_read_run`,
      ]);

      // Then: no call reached any server, no agent was started and no run was nested
      expect(readFixtureLog(fixture.callLog)).toEqual([]);
      expect((await harness.sessions.list(agentA, employeeA)).map((view) => view.agentId)).toEqual([agentA]);
      expect((await toolCallRowsOf(harness.db, agentA)).map((row) => `${row.tool} ${row.outcome}`)).toEqual([
        'run_code success',
      ]);
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  // AC-03.3: "Given скрипт подставляет в аргументы идентификатор другого сотрудника, when вызывает инструмент, then вызов проверяется и записывается от имени владельца беседы и получает тот же ответ, что прямой вызов агента с этими аргументами."
  // Behavior: the script passes `ownerId` of employee B in the arguments of an allowed read tool -> the call is recorded for A and reaches the server as the direct call with the same arguments does, ending in the same outcome class
  // Catches: an owner taken from the script's arguments instead of from the step (Invariant 1) - one employee acting as another
  // @category: core-functionality
  // @dependency: run_code tool, ToolRunner.callFromCode, tool calls in `agent_messages`, MCP fixture
  // @complexity: medium
  it('INT-3 row B: AC-03.3 an ownerId of another employee in the arguments changes nothing: recorded for the owner, same outcome as the direct call', async () => {
    // Given: employee A may use `logs`, employee B no server at all; A's agent calls `search_logs` directly with B's id
    // as `ownerId` in the arguments, then a read script makes the same call
    const otherEmployee = newUser();
    const foreignArgs = { ...ONE_RECORD, ownerId: otherEmployee };
    const prompt = 'Read the logs with the id of another employee';
    const sameCall = [
      `try { await callTool("${SEARCH_LOGS}", ${JSON.stringify(foreignArgs)}); return "ответ без ошибки"; }`,
      'catch (error) { return { outcome: error.outcome, text: error.text }; }',
    ].join('\n');
    const model = createScriptedModel();
    const script = model.script({ task: prompt }, [
      { calls: [{ tool: SEARCH_LOGS, args: foreignArgs }] },
      { calls: [runCode('Вызов с чужим ownerId', sameCall)] },
      { text: 'Ответы сравнены' },
    ]);
    const reader = await startReader(model, prompt);
    const { harness, fixture, ownerId, agentId } = reader;
    try {
      // When: both calls go
      await untilTurnEnds(reader, script, 3);
      const directCallId = toolCallIdOf(script, 0);
      const runCallId = toolCallIdOf(script, 1);

      // Then: both calls reached the server, so both were checked as A: as B (no server allowed) the call from code
      // would have been refused no_access before the server (Invariant 1)
      expect(fixtureCallsOf(fixture.callLog, { tool: 'search_logs', args: foreignArgs })).toHaveLength(2);
      const codeRows = await codeCallRowsOf(harness.db, agentId, runCallId);
      expect(codeCallLines(codeRows)).toEqual([`1 ${LOGS_SERVER}/search_logs tool_error null`]);
      expect(codeRows[0]?.args).toEqual(foreignArgs);

      // Then: the direct call got the server's own refusal of the extra key; the script got the same outcome class, with
      // no server text (owner decision 2026-11-14)
      const answer = 'invalid arguments for search_logs: ✖ Unrecognized key: "ownerId"';
      const history = await historyOf(harness, agentId, ownerId);
      const direct = resultEntryOf(history, directCallId);
      expect([direct.outcome, direct.text]).toEqual(['tool_error', answer]);
      expect(returnedBy(history, runCallId)).toEqual({ outcome: 'tool_error', text: '' });
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  // AC-04.3: "Given результат получен в сессии другого агента или другого сотрудника, when скрипт просит его по идентификатору, then скрипт получает такой же ответ, как для несуществующего идентификатора."
  // AC-06.2: "Given два запуска идут одновременно, when скрипт второго пытается прочитать что-либо, оставленное первым, then он получает такой же ответ, как для несуществующих данных."
  // Behavior: `readResult` with a `callId` of B's session, of another agent of A, an invented id, the `callId` of a call that ended in an error, and a `callId` left by a concurrent run -> every answer is the same "result not found"
  // Catches: another employee's full result (or one from another session) readable by guessing a `callId`; an answer that differs between "foreign" and "missing" and so confirms the id exists
  // @category: core-functionality
  // @dependency: readResult, agent_tool_results, session and owner lookup, CodeRunner (real process)
  // @complexity: medium
  it('INT-3 row C: AC-04.3 readResult answers one "result not found" for a foreign session, another agent, an invented id, a failed call and a concurrent run', async () => {
    // Given: employees A and B may read `logs`. B's agent reads one record directly (its full result is stored). A's first
    // agent reads one record directly, then runs a script that leaves a global and calls `search_logs` with a page the
    // fixture holds, so that run is still going. A's second agent reads one record directly, makes a direct call that
    // ends in an error (`from` after `to`), then runs a script that reads by each id and by its own
    const employeeA = newUser();
    const employeeB = newUser();
    const heldPageArgs = { ...WINDOW, pageSize: 2 };
    const unorderedArgs = { from: WINDOW.to, to: WINDOW.from, pageSize: 1 };
    const fixture = createFixtureFiles('code-execution');
    const heldPage = fixture.latch('held-page');
    fixture.setFaults([holdCall('search_logs', heldPageArgs, heldPage)]);
    const holding = [
      'globalThis.leftByFirst = "след первого запуска";',
      `const page = await callTool("${SEARCH_LOGS}", ${JSON.stringify(heldPageArgs)});`,
      'return page.records.length;',
    ].join('\n');
    const reading = (ownResultId: string, ids: Readonly<Record<string, string>>) =>
      [
        `const ids = ${JSON.stringify(ids)};`,
        'const answers = {};',
        'for (const [name, id] of Object.entries(ids)) {',
        ...caughtAs('answer', 'readResult(id)'),
        '  answers[name] = answer;',
        '}',
        `const own = await readResult(${JSON.stringify(ownResultId)});`,
        'return { answers, ownRecords: own.records.length, leftByFirst: typeof globalThis.leftByFirst };',
      ].join('\n');
    const promptB = 'B reads one record';
    const promptFirst = 'A reads, then runs a long script';
    const promptSecond = 'A reads by ids that are not its own';
    const model = createScriptedModel();
    const scriptB = model.script({ task: promptB }, [
      { calls: [{ tool: SEARCH_LOGS, args: ONE_RECORD }] },
      { text: 'Б прочитал' },
    ]);
    const firstScript = model.script({ task: promptFirst }, [
      { calls: [{ tool: SEARCH_LOGS, args: ONE_RECORD }] },
      { calls: [runCode('Долгий запуск', holding)] },
      { text: 'Долгий запуск закончен' },
    ]);
    const secondScript = model.script({ task: promptSecond }, [
      {
        calls: [
          { tool: SEARCH_LOGS, args: ONE_RECORD },
          { tool: SEARCH_LOGS, args: unorderedArgs },
        ],
      },
      (messages) => {
        const [ownResultId, failedCallId] = answeredCallIds(messages);
        if (ownResultId === undefined || failedCallId === undefined) throw new Error('the second agent made no two calls');
        const ids = {
          foreignSession: toolCallIdOf(scriptB, 0),
          otherAgent: toolCallIdOf(firstScript, 0),
          invented: 'call-invented',
          failedCall: failedCallId,
          concurrentRun: toolCallIdOf(firstScript, 1),
        };
        return { calls: [runCode('Чтение по чужим id', reading(ownResultId, ids))] };
      },
      { text: 'Чужого не прочитано' },
    ]);
    const harness = await createAgentsHarness({
      model,
      fixture,
      access: { [employeeA]: [LOGS_SERVER], [employeeB]: [LOGS_SERVER] },
      root: testRecord('reader', { servers: [LOGS_SERVER] }),
    });
    const start = async (ownerId: string, prompt: string) =>
      (await harness.sessions.start({ ownerId, prompt, description: 'reader' })).agentId;
    try {
      // When: B's agent reads; A's first run holds at the server; A's second agent runs its script meanwhile
      const agentB = await start(employeeB, promptB);
      await untilTurnEnds({ harness, fixture, ownerId: employeeB, agentId: agentB }, scriptB, 2);
      const firstId = await start(employeeA, promptFirst);
      await waitFor(
        () => fixtureCallsOf(fixture.callLog, { tool: 'search_logs', args: heldPageArgs }),
        (calls) => calls.length === 1,
        'the held call of the first run',
      );
      const secondId = await start(employeeA, promptSecond);
      await untilTurnEnds({ harness, fixture, ownerId: employeeA, agentId: secondId }, secondScript, 3);
      const firstRunId = toolCallIdOf(firstScript, 1);
      const secondRunId = toolCallIdOf(secondScript, 1);

      // Then: the first run was still going: its call from code had no outcome yet (AC-06.2)
      expect(codeCallLines(await codeCallRowsOf(harness.db, firstId, firstRunId))).toEqual([`1 ${LOGS_SERVER}/search_logs null null`]);

      // Then: the failed direct call kept no full result (DC-8), and every id that is not the run's own successful
      // result answered the same "result not found"; the run read its own result and saw no global of the first run
      const secondHistory = await historyOf(harness, secondId, employeeA);
      expect(historyLines(secondHistory)).toEqual([
        `task: ${promptSecond}`,
        `model_answer:  [${LOGS_SERVER}/search_logs, ${LOGS_SERVER}/search_logs]`,
        'tool_result: search_logs success',
        'tool_result: search_logs tool_error',
        'model_answer:  [run_code]',
        'tool_result: run_code success',
        'model_answer: Чужого не прочитано []',
      ]);
      const notFound = 'not_found null result not found';
      expect(returnedBy(secondHistory, secondRunId)).toEqual({
        answers: {
          foreignSession: notFound,
          otherAgent: notFound,
          invented: notFound,
          failedCall: notFound,
          concurrentRun: notFound,
        },
        ownRecords: 1,
        leftByFirst: 'undefined',
      });

      // Then: released, the first run ends with its own page (the held call was its, not the second run's)
      heldPage.release();
      await untilTurnEnds({ harness, fixture, ownerId: employeeA, agentId: firstId }, firstScript, 3);
      expect(returnedBy(await historyOf(harness, firstId, employeeA), firstRunId)).toBe(2);
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);
});

// INT-4: runs the employee cuts off (interrupt, stop) and runs over the per-employee limit.

/** The pid of the executor process the run started, from the runner's `code executor started` record. */
function executorPidOf(harness: AgentsHarness, runCallId: string): number {
  const started = runLogsOf(harness, runCallId).find((record) => record.message === 'code executor started');
  const pid = started?.fields.pid;
  if (typeof pid !== 'number') throw new Error(`Run ${runCallId} logged no executor process`);
  return pid;
}

/** Waits until the run's executor process exited (the runner's `code executor exited` record). */
async function untilExecutorExited(harness: AgentsHarness, runCallId: string): Promise<void> {
  await waitFor(
    () => runLogsOf(harness, runCallId).some((record) => record.message === 'code executor exited'),
    (exited) => exited,
    `the executor process of run ${runCallId} to exit`,
  );
}

/** A run's end as the substituted runner reports it when the step's signal cut the run off. */
const ABORTED_RUN: RunOutcome = { status: 'failed', reason: 'aborted', text: null, line: null, output: '' };

/** A run the {@link HeldRunner} holds: its script and how the test ends it. */
interface HeldRun {
  readonly script: string;
  end(outcome: RunOutcome): void;
}

/**
 * The one `CodeRunner` double of the file (INT-4 C proves the admission rule, not the engine): it keeps every
 * script it got and holds each run until the test ends it; a run whose step is cut off ends "прерван".
 */
interface HeldRunner {
  readonly runner: CodeRunner;
  readonly runs: readonly HeldRun[];
  /** Ends every run still held, so the harness closes. */
  endAll(): void;
}

function createHeldRunner(): HeldRunner {
  const runs: HeldRun[] = [];
  const runner: CodeRunner = {
    run: (request) =>
      new Promise<RunOutcome>((resolve) => {
        runs.push({ script: request.script, end: resolve });
        request.signal?.addEventListener('abort', () => resolve(ABORTED_RUN), { once: true });
      }),
  };
  return {
    runner,
    runs,
    endAll: () => {
      for (const run of runs) run.end(ABORTED_RUN);
    },
  };
}

/** Waits until the substituted runner got `script` and returns its held run. */
async function heldRunOf(held: HeldRunner, script: string): Promise<HeldRun> {
  const runs = await waitFor(
    () => held.runs.filter((run) => run.script === script),
    (found) => found.length === 1,
    `the substituted runner to get the script ${JSON.stringify(script)}`,
  );
  const [run] = runs;
  if (run === undefined) throw new Error(`The substituted runner has no run of ${script}`);
  return run;
}

describe('INT-4: a run that is cancelled or limited - interrupt, stop, the per-employee limit', () => {
  // AC-10.1: "Given запуск идёт, when сотрудник прерывает или останавливает агента, then запуск прекращается, и из него больше не уходит ни одного вызова инструмента."
  // Design v1.3 (UC-E6, Flow 4, Invariants 4, 6): a cut-off `read` run and its open audit row close "прервано"; a confirmed `write` run is `sending`, so its open audit row closes
  // "исход неизвестен" at once, and the run row closes "исход неизвестен" in the first step after the stopped agent continues (`closeOpen`).
  // Behavior: row A - a read script calls `search_logs` in a loop, the fixture holds its third call, the agent is interrupted -> no new call reaches the fixture journal after the command
  //   (also once the held call is released and the agent continues), the executor process is gone, the run and its open audit row end "прервано".
  //   Row B - a confirmed write script's first `create_incident_note` is held, the agent is stopped -> no new call, no process, the open audit row "исход неизвестен", the run row stays
  //   `sending` and closes "исход неизвестен" after the agent continues, without running the script again.
  // Catches: a run that keeps calling tools after the employee said stop (side effects already refused), or an executor process left behind
  // @category: core-functionality
  // @dependency: run_code tool, CodeRunner (real process), runtime interrupt and stop, tool calls in `agent_messages`, MCP fixture (held call)
  // @complexity: high
  it('INT-4 row A: AC-10.1 interrupting the agent mid-run: no further call reaches the server, no executor process remains, the run and its audit row end "прервано"', async () => {
    // Given: a read script that calls `search_logs` ten times in a row; the fixture holds the third call
    const prompt = 'Read in a loop, then be interrupted';
    const fixture = createFixtureFiles('code-execution');
    const thirdCallHeld = fixture.latch('third-call');
    fixture.setFaults([holdCall('search_logs', ONE_RECORD, thirdCallHeld, [3])]);
    const loop = [
      'let pages = 0;',
      'for (let call = 1; call <= 10; call += 1) {',
      `  await callTool("${SEARCH_LOGS}", ${JSON.stringify(ONE_RECORD)});`,
      '  pages += 1;',
      '}',
      'return pages;',
    ].join('\n');
    const model = createScriptedModel();
    const script = model.script({ task: prompt }, [
      { calls: [runCode('Чтение в цикле', loop)] },
      { text: 'Продолжаю после прерывания' },
    ]);
    const reader = await startReader(model, prompt, { fixture });
    const { harness, ownerId, agentId } = reader;
    try {
      await waitFor(
        () => fixtureCallsOf(fixture.callLog, { tool: 'search_logs', args: ONE_RECORD }),
        (calls) => calls.length === 3,
        'the held third call of the loop',
      );
      const runCallId = toolCallIdOf(script, 0);
      const pid = executorPidOf(harness, runCallId);

      // When: the employee interrupts the agent while the third call is at the server
      expect(await harness.sessions.interrupt({ agentId, ownerId })).toBe('interrupted');
      await waitFor(
        () => historyOf(harness, agentId, ownerId),
        (entries) => historyLines(entries).at(-1) === 'event: interrupted',
        'the interrupted event of the agent',
      );

      // Then: the executor process is gone (Invariant 6)
      await untilExecutorExited(harness, runCallId);
      expect(() => process.kill(pid, 0)).toThrow();

      // Then: the run and its open audit row ended "прервано"; the two answered calls keep their outcome (Invariant 4)
      expect(historyLines(await historyOf(harness, agentId, ownerId))).toEqual([
        `task: ${prompt}`,
        'model_answer:  [run_code]',
        'tool_result: run_code interrupted',
        'event: interrupted',
      ]);
      expect((await toolCallRowsOf(harness.db, agentId)).map((row) => `${row.tool} ${row.state} ${row.outcome}`)).toEqual([
        'run_code done interrupted',
      ]);
      expect(codeCallLines(await codeCallRowsOf(harness.db, agentId, runCallId))).toEqual([
        `1 ${LOGS_SERVER}/search_logs success null`,
        `2 ${LOGS_SERVER}/search_logs success null`,
        `3 ${LOGS_SERVER}/search_logs interrupted null`,
      ]);

      // When: the server answers the held call late, and a message makes the agent go on
      thirdCallHeld.release();
      await harness.sessions.send({ agentId, ownerId, text: 'Продолжай' });
      await untilTurnEnds(reader, script, 2);

      // Then: no call reached the server after the command, and the run never started again (AC-10.1)
      expect(fixtureCallsOf(fixture.callLog, { tool: 'search_logs' })).toHaveLength(3);
      expect(runStarts(harness, runCallId)).toHaveLength(1);
    } finally {
      thirdCallHeld.release();
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  it('INT-4 row B: AC-10.1 stopping the agent mid-way through a confirmed write run: no further call reaches the server, no executor process remains, the open audit row ends "исход неизвестен" and the run row so once the agent continues', async () => {
    // Given: a confirmed write run of three notes; the fixture holds the first note
    const prompt = 'Write three notes, then be stopped';
    const fixture = createFixtureFiles('code-execution');
    const firstNoteHeld = fixture.latch('first-note');
    fixture.setFaults([holdCall('create_incident_note', noteArgs(NOTE_TEXTS[0]), firstNoteHeld)]);
    const model = createScriptedModel();
    const writerScript = model.script({ task: prompt }, [
      { calls: [runCode(NOTES_DESCRIPTION, notesScript(), 'write')] },
      { text: 'Продолжаю после остановки' },
    ]);
    const writer = await startWriter(model, prompt, fixture);
    const { harness, ownerId, agentId, request } = writer;
    try {
      expect(await harness.sessions.resolveConfirmation({ decisionId: request.decisionId, ownerId, approve: true })).toBe(
        'resolved',
      );
      await waitFor(
        () => fixtureCallsOf(fixture.callLog, { tool: 'create_incident_note' }),
        (calls) => calls.length === 1,
        'the held first note of the run',
      );
      const runCallId = toolCallIdOf(writerScript, 0);
      const pid = executorPidOf(harness, runCallId);

      // When: the employee stops the agent while the first note is at the server
      expect(await harness.sessions.stop({ agentId, ownerId })).toEqual([agentId]);
      expect((await harness.sessions.get(agentId, ownerId)).status).toBe('stopped');

      // Then: the executor process is gone (Invariant 6)
      await untilExecutorExited(harness, runCallId);
      expect(() => process.kill(pid, 0)).toThrow();

      // Then: the note that may have reached the server is "исход неизвестен" (Invariant 4); the run row stays `sending` until the agent continues
      const closedCalls = await waitFor(
        () => codeCallRowsOf(harness.db, agentId, runCallId),
        (rows) => rows.every((row) => row.outcome !== null),
        'the open audit row of the stopped run to close',
      );
      expect(codeCallLines(closedCalls)).toEqual([`1 ${BACKOFFICE_SERVER}/create_incident_note unknown null`]);
      expect((await toolCallRowsOf(harness.db, agentId)).map((row) => `${row.tool} ${row.state} ${row.outcome}`)).toEqual([
        'run_code sending null',
      ]);

      // When: the server answers the held note late, and a message makes the stopped agent continue
      firstNoteHeld.release();
      await harness.sessions.send({ agentId, ownerId, text: 'Продолжай' });
      await untilTurnEnds(writer, writerScript, 2);

      // Then: the run row closed "исход неизвестен" in the first step after the agent continued (Flow 4), and the script did not run again
      expect((await toolCallRowsOf(harness.db, agentId)).map((row) => `${row.tool} ${row.state} ${row.outcome}`)).toEqual([
        'run_code done unknown',
      ]);
      expect(runStarts(harness, runCallId)).toHaveLength(1);

      // Then: no call reached the server after the command: the second and third notes never went out (AC-10.1)
      expect(readFixtureLog(fixture.callLog)).toHaveLength(1);
      expect(codeCallLines(await codeCallRowsOf(harness.db, agentId, runCallId))).toEqual([
        `1 ${BACKOFFICE_SERVER}/create_incident_note unknown null`,
      ]);
    } finally {
      firstNoteHeld.release();
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  // AC-07.6: "Given у сотрудника А исполняются два запуска кода, а других запусков на сервере нет, when агент сотрудника А начинает третий, then третий скрипт не выполняется, вызывающий получает ошибку «превышено число одновременных запусков», а запуск, который в это время начинает сотрудник Б, исполняется ..."
  // Design KD-11, DC-18: "отказ по пределу сотрудника попытку читающего запуска не тратит"; the place is freed on any end of the run.
  // Behavior: substituted CodeRunner holds each run; `CODE_RUN_MAX_CONCURRENT_PER_USER` 2, `CODE_RUN_MAX_CONCURRENT` 4. Row 1: A has two running, A starts a third, B starts one -> A's third is `tool_error` "concurrent run limit exceeded (2)", the CodeRunner never got its script, `attempts` did not grow, B's run executes.
  //   Row 2: A has two running, one ends in an error, A starts another -> it executes (the slot was freed by the failure)
  // Catches: one employee filling the server's executor slots (and starving everyone else), a refused run spending a read run's attempt, a slot leaked by an error end so the employee is locked out of code
  // @category: edge-case
  // @dependency: run_code tool, admission counters, CodeRunner (substituted), tool calls in `agent_messages` attempts
  // @complexity: medium
  it('INT-4 row C: AC-07.6 the third concurrent run of an employee is refused without spending an attempt, another employee is served, and any end of a run frees the slot', async () => {
    // Given: employees A and B may read `logs`; the substituted runner holds every run; at most 2 runs of one employee, 4 in all
    const employeeA = newUser();
    const employeeB = newUser();
    const held = createHeldRunner();
    const model = createScriptedModel();
    const runOf = (prompt: string, label: string) => {
      const script = `return "${label}";`;
      const replies = model.script({ task: prompt }, [
        { calls: [runCode(`Запуск ${label}`, script)] },
        { text: `Конец ${label}` },
      ]);
      return { prompt, script, replies };
    };
    const firstA = runOf('A runs first', 'А1');
    const secondA = runOf('A runs second', 'А2');
    const thirdA = runOf('A runs third', 'А3');
    const onlyB = runOf('B runs while A is at the limit', 'Б');
    const afterFreeA = runOf('A runs after a freed place', 'А4');
    const harness = await createAgentsHarness({
      model,
      access: { [employeeA]: [LOGS_SERVER], [employeeB]: [LOGS_SERVER] },
      root: testRecord('reader', { servers: [LOGS_SERVER] }),
      variables: { CODE_RUN_MAX_CONCURRENT_PER_USER: '2', CODE_RUN_MAX_CONCURRENT: '4' },
      codeRunner: held.runner,
    });
    const start = async (ownerId: string, run: { prompt: string }) =>
      (await harness.sessions.start({ ownerId, prompt: run.prompt, description: 'reader' })).agentId;
    const untilEnds = (ownerId: string, agentId: string, run: { replies: Script }) =>
      untilTurnEnds({ harness, fixture: harness.fixture, ownerId, agentId }, run.replies, 2);
    const runRows = async (agentId: string) =>
      (await toolCallRowsOf(harness.db, agentId)).map(
        (row) => `${row.tool} ${row.state} ${row.outcome} attempts ${row.attempts}`,
      );
    try {
      // Given: two runs of A are held
      const firstId = await start(employeeA, firstA);
      const firstRun = await heldRunOf(held, firstA.script);
      const secondId = await start(employeeA, secondA);
      const secondRun = await heldRunOf(held, secondA.script);

      // When: A's third agent starts a run
      const thirdId = await start(employeeA, thirdA);
      await untilEnds(employeeA, thirdId, thirdA);

      // Then: the third run is refused with the limit's text, the runner never got its script, and its attempt was not spent (AC-07.6, DC-18)
      expect(toolOutputOf(thirdA.replies.calls[1]?.messages ?? [], toolCallIdOf(thirdA.replies, 0))).toBe(
        seenRunResult('[tool_error]\nconcurrent run limit exceeded (2)'),
      );
      expect(held.runs.map((run) => run.script)).toEqual([firstA.script, secondA.script]);
      expect(await runRows(thirdId)).toEqual(['run_code done tool_error attempts 0']);

      // When: B's agent starts a run while A is at the limit
      const onlyBId = await start(employeeB, onlyB);
      const onlyBRun = await heldRunOf(held, onlyB.script);
      onlyBRun.end({ status: 'returned', value: JSON.stringify('Б готово'), output: '' });
      await untilEnds(employeeB, onlyBId, onlyB);

      // Then: B's run executed: A's limit is not B's
      expect(toolOutputOf(onlyB.replies.calls[1]?.messages ?? [], toolCallIdOf(onlyB.replies, 0))).toBe(
        seenRunResult('Б готово'),
      );
      expect(await runRows(onlyBId)).toEqual(['run_code done success attempts 1']);

      // When: A's first run ends in an error, and A starts another run
      firstRun.end({ status: 'failed', reason: 'exception', text: 'Error: сбой', line: 1, output: '' });
      await untilEnds(employeeA, firstId, firstA);
      expect(await runRows(firstId)).toEqual(['run_code done tool_error attempts 1']);
      const afterFreeId = await start(employeeA, afterFreeA);

      // Then: the run executes: the failed run freed its place
      const afterFreeRun = await heldRunOf(held, afterFreeA.script);
      afterFreeRun.end({ status: 'returned', value: JSON.stringify('А4 готово'), output: '' });
      secondRun.end({ status: 'returned', value: JSON.stringify('А2 готово'), output: '' });
      await untilEnds(employeeA, afterFreeId, afterFreeA);
      await untilEnds(employeeA, secondId, secondA);
      expect(await runRows(afterFreeId)).toEqual(['run_code done success attempts 1']);
      expect(await runRows(secondId)).toEqual(['run_code done success attempts 1']);
      expect(held.runs.map((run) => run.script)).toEqual([
        firstA.script,
        secondA.script,
        onlyB.script,
        afterFreeA.script,
      ]);
    } finally {
      held.endAll();
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);
});
