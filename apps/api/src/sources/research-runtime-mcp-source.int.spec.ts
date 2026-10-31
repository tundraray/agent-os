// research-runtime / mcp-source Integration Test Skeletons - Design Doc: docs/features/research-runtime/design-mcp-source.md
// Upstream contract consumed: docs/features/research-runtime/design-runtime.md (TaskContext, HandlerResult, Coverage, FailureReason, reservation rule)
// PRD: docs/features/research-runtime/prd.md
// Generated: 2026-10-31 | Part: mcp-source | Test type: integration, NO Postgres (runs in CI `check` via vitest.config.ts, include '**/*.spec.ts')
//
// Environment (Design Doc "Test Boundaries"):
// - Real fixture process (packages/mcp-fixture, spawned over stdio by McpSourceClient). Never mocked: codes and drops are only provable on a real transport.
// - TaskContext is an in-memory fake that implements the runtime reservation rule (retry / call limits, deadline, injectable
//   `fenced` / `not_current_attempt` / `cancel_requested`). Postgres-only behaviour (guarded UPDATE, fencing, recovery) lives in
//   apps/api/test/research-runtime-mcp-source.e2e-spec.ts.
// - Backoff jitter and clock are injected; SOURCE_CALL_TIMEOUT_MS is set to a few hundred ms so hang / malformed_json rows stay fast.
// - Isolation (Design Doc Risks): every test builds its own fixture rules keyed by argsHash, with its own window/filter and its own
//   FIXTURE_CALL_LOG file in a temp dir. No shared journal, no test order dependency.
// - The independent counter is the fixture call log (JSONL, only `tools/call`). Assert `log lines === toolCallsUsed` wherever calls happen.
//
// All cases are `it.todo`. Implement each following its Arrange/Act/Assert notes when its task lands. Do not convert a todo into a passing stub.
//
// Budget: integration 4 of 5 (limit 3; the 4th names a defect no other test catches - see INT-4). Pure rules are proven at unit level, see the
// "Proven at unit level" block at the end of this file; do not re-check their variants here.

import { describe, it } from 'vitest';

describe('research-runtime / mcp-source - integration (fixture process, in-memory TaskContext)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-1  Failure-class matrix against the real fixture
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original ACs, verbatim from prd.md / design-mcp-source.md):
  // AC-11.1: "Given инструмент не входит в allowlist типа workflow задачи, Then вызов отклонён без обращения к источнику, исход записан как отказ allowlist."
  // AC-11.2: "Given аргументы не проходят схему инструмента, Then вызов отклонён без обращения к источнику, исход записан как ошибка валидации."
  // AC-13.2: "Given источник вернул ошибку инструмента, Then задача `failed` с классом «ошибка инструмента» и текстом ошибки; автоматического повтора нет."
  // AC-13.3: "Given соединение с источником оборвано, Then исход записан классом «сбой транспорта/протокола» и обрабатывается по FR-14."
  // AC-13.4: "Given источник вернул ответ, который не разбирается или нарушает контракт инструмента, Then этот вызов записан классом «сбой транспорта/протокола»
  //          и никогда не записан как пустой результат: evidence «не найдено в области» по нему не создаётся."
  // AC-14.1: "Given источник даёт 2 временных сбоя транспорта подряд, а затем ответ, лимит повторов задачи 3 и лимит вызовов 5, Then задача `succeeded` после 3 вызовов."
  // AC-14.2: "Given источник даёт временный сбой транспорта на каждый вызов, лимит повторов 2 и лимит вызовов 5, Then задача `failed` с классом «сбой транспорта/протокола», источник вызван ровно 3 раза."
  // AC-14.3: "Given источник даёт временный сбой транспорта на каждый вызов, лимит повторов 5 и лимит вызовов 2, Then задача `failed` с классом «сбой транспорта/протокола», источник вызван ровно 2 раза."
  // AC-14.4: "Given источник отвечает ошибкой протокола JSON-RPC «неизвестный инструмент» или «некорректный запрос», лимит повторов 3 и лимит вызовов 5, Then источник вызван ровно 1 раз,
  //          задача `failed` с классом «сбой транспорта/протокола» и причиной «несоответствие конфигурации или протокола». Given источник отклоняет аргументы результатом
  //          инструмента с `isError` при тех же лимитах, Then источник вызван ровно 1 раз, задача `failed` с классом «ошибка инструмента» (AC-13.2)."
  // AC-15.4: "Given тестовый режим отказа (сбой транспорта, ошибка инструмента, ошибка инструмента при проверке аргументов, некорректный ответ, ошибка протокола
  //          «неизвестный инструмент» или «некорректный запрос», задержка), Then fixture воспроизводит выбранный отказ на заданных вызовах."
  // AC-MS-2: "If `structuredContent` отсутствует или нарушает контракт результата, then вызов записан `transport_protocol` с кодом `result_contract_violation`,
  //          повторяется по FR-14 и не даёт evidence «не найдено»."
  // AC-MS-5: "When соединение оборвалось, следующий вызов идёт по новому соединению; рукопожатие не входит ни в `toolCallsUsed`, ни в журнал вызовов fixture."
  // AC-MS-7: "While fixture перезапускается после `crash_process`, номер вхождения правила отказа продолжает считаться по журналу вызовов."
  // PRD metric 4: "100 % внедрённых отказов fixture записаны своим классом, 0 повторов вне бюджета, 0 повторов несоответствия конфигурации или протокола" (30 calls per class).
  // Use cases: UC-E1, UC-E3, UC-E4, UC-E5, UC-E6, UC-E7 (EARS: If-then - branch per failure class).
  //
  // Primary failure mode (turns red when): a local client error is classified as a server one (or the reverse), a K-3 / K-9 / K-13 outcome is retried,
  // a retry is issued without `reserveToolCall(retry: true)`, a malformed / contract-violating reply is stored as an empty "not found" result, or the
  // fixture call log disagrees with `toolCallsUsed` (e.g. the initialize handshake is counted).
  // ROI: 7.4 (raw formula: (9 x 8 + 0 + 9) / 11) | Business Value: 9 (a wrong class drives wrong retries and false "not found") | Frequency: 8 (every fetch)
  // Behavior: fault rule on (tool, argsHash, occurrence) -> ToolExecutor.execute against the real fixture -> ToolOutcome class/code, retries, and the call-log count match the table
  // @category: core-functionality
  // @dependency: ToolExecutor, FixtureSourceAdapter, McpSourceClient, mcp-fixture process, in-memory TaskContext, FIXTURE_FAULTS, FIXTURE_CALL_LOG
  // @complexity: high
  //
  // Table-driven rows (one row = one fault rule; fixed limits in brackets are retries / calls):
  //   pre-call, no fault rule      | get_trace not in source.fetch allowlist          | failed allowlist_rejected (tool_not_allowlisted) | log 0, toolCallsUsed 0   (UC-E1)
  //   pre-call, no fault rule      | search_logs pageSize 0                           | failed validation_rejected (tool_args_invalid)   | log 0, toolCallsUsed 0   (UC-E1)
  //   tool_error                   | [3/5] occurrence 1                               | failed tool_error, message = server text         | log 1                    (UC-E3, AC-13.2)
  //   tool_error_args              | [3/5] occurrence 1                               | failed tool_error                                | log 1                    (UC-E3, AC-14.4 second half)
  //   jsonrpc_error -32601         | [3/5] occurrence 1                               | failed transport_protocol config_or_protocol_mismatch | log 1               (UC-E5, AC-14.4)
  //   jsonrpc_error -32602         | [3/5] occurrence 1                               | same as above                                    | log 1                    (UC-E5)
  //   jsonrpc_error -32600         | [3/5] occurrence 1                               | same as above                                    | log 1                    (UC-E5)
  //   crash_process                | [3/5] occurrences 1-2, then success              | succeeded after 3 calls (new pid on call 2 and 3) | log 3 == toolCallsUsed 3 (UC-E4, AC-14.1, AC-MS-5, AC-MS-7)
  //   crash_process                | [2/5] occurrences all                            | failed transport_protocol connection_lost        | log 3 == toolCallsUsed 3 (UC-E4, AC-14.2)
  //   crash_process                | [5/2] occurrences all                            | failed transport_protocol connection_lost        | log 2 == toolCallsUsed 2 (UC-E4, AC-14.3)
  //   malformed_json               | occurrence 1, then success                       | first call transport_protocol timeout, 2nd succeeds | no "not found" evidence (UC-E6, AC-MS-2/13.4)
  //   invalid_result               | occurrence 1, then success                       | first call transport_protocol invalid_result      | no "not found" evidence (UC-E6, AC-13.4)
  //   contract_violation           | occurrence 1, then success                       | first call transport_protocol result_contract_violation | no "not found" evidence (UC-E6, AC-MS-2)
  //   rest of the mode catalogue   | drop_connection, jsonrpc_error -32603, late_response, delay_ms vs timeout, empty (K-12) | each lands in its class from the Error Handling table
  //                                  | 0 retries outside a reservation, 0 retries of K-3 / K-9 / K-13                                   (UC-E7, AC-15.4)
  // Metric 4 acceptance run: each class repeated 30 times (a `repeat` column or loop around the row); the short-timeout setting keeps this fast.
  //
  // Verification items:
  // - Row outcome: kind, FailureReason.class, FailureReason.code, message truncated to the FailureReason limit
  // - Retries only after reserveToolCall(retry: true) (the in-memory TaskContext records every reservation)
  // - Fixture call log line count equals toolCallsUsed; handshake never appears in the log
  // - On crash rows: the `pid` column of the log changes between calls, `occurrence` keeps counting 1, 2, 3 across the restart
  // - No evidence with 0 matches exists for any malformed / invalid / contract-violation row
  it.todo(
    'INT-1: every injected fault lands in its class, retries stay inside the reservation rule, and the fixture log equals toolCallsUsed',
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2  Pagination, coverage and stop conditions of a fetch task
  // ---------------------------------------------------------------------------------------------------------------
  // Covers:
  // AC-12.2: "Given совпадений больше, чем помещается в одну страницу, Then признак усечения выставлен, `returned` меньше `totalMatched`, а состояние пагинации позволяет получить следующую страницу."
  // AC-12.3: "Given источник не сообщает общее число совпадений, Then `totalMatched` помечен как неизвестный, а не записан нулём."
  // AC-13.1: "Given источник вернул пустой результат, Then задача `succeeded`, evidence `observed` с нулём совпадений и областью поиска; это «не найдено в области», а не ошибка."
  // AC-17.1: "Given 2 500 совпадений при странице 500 и достаточном бюджете, Then задача получила 5 страниц, усечения нет."
  // AC-17.2: "Given бюджет позволяет 3 страницы, Then задача `succeeded` с признаком неполного охвата и состоянием пагинации для продолжения."
  // AC-MS-4: "If срез страницы отличается от закреплённого, then задача `failed` `snapshot_changed`, страница не сохранена, прежние страницы в `outputRefs` не входят."
  // AC-MS-6: "If `putEvidence` или резерв вернули `fenced`/`not_current_attempt`, then исполнитель больше не вызывает источник в этой попытке."
  // AC-MS-9: "When задача сохранила `SOURCE_MAX_PAGES` страниц, а курсор не исчерпан, then она `succeeded` с охватом `partial` и курсором следующей страницы в `continuation`, без следующего вызова."
  // Use cases: UC-2, UC-3, UC-E10, UC-E12 (EARS: When / If-then - the loop's exits).
  //
  // Primary failure mode (turns red when): the page loop stops or continues on the wrong condition - a complete status for an unconfirmed count, a lost or wrong
  // `continuation` cursor, a page of a different snapshot saved (or kept in outputRefs), an extra source call after `fenced` / `not_current_attempt` or after the page cap,
  // an empty page treated as an error or `totalMatched` null recorded as 0.
  // ROI: 6.5 (raw formula: (8 x 8 + 0 + 8) / 11) | Business Value: 8 (coverage drives "is the answer complete" downstream) | Frequency: 8 (every "all" fetch)
  // Behavior: fetch task with a fixture query over 2 500 matches (page 500) -> FetchHandler/ToolExecutor loop -> per-page evidence page-NNNN, checkpoint, coverage and call count match the table
  // @category: core-functionality
  // @dependency: FetchHandler, ToolExecutor, FixtureSourceAdapter, mcp-fixture process, in-memory TaskContext (reservation limits, injectable fenced / not_current_attempt)
  // @complexity: high
  //
  // Table-driven rows (2 500-match window, pageSize 500 unless stated):
  //   "sample"                         | 1 page, truncated, continuation = cursor of page 2, coverage partial                   | 1 call   (UC-2)
  //   "all", call limit 10             | 5 pages page-0001..page-0005, no truncation, coverage complete, outputRefs in order      | 5 calls  (UC-2, AC-17.1)
  //   "all", call limit 3              | succeeded, partial, 3 pages, continuation = cursor of page 4                            | 3 calls  (UC-2, AC-17.2)
  //   "all", SOURCE_MAX_PAGES 2        | succeeded, partial, 2 pages, continuation = cursor of page 3, no third call             | 2 calls  (UC-2, AC-MS-9)
  //   filter with no matches           | succeeded, evidence observed with 0 matches and the search scope in normalizedArgs, complete | 1 call (UC-3, AC-13.1)
  //   unknown_total                    | succeeded, partial, totalMatched null (not 0)                                           | (UC-3, AC-12.3)
  //   snapshot_flip after occurrence 2 | failed snapshot_changed; 2 evidence stored, outputRefs empty, no 3rd page saved          | (UC-E10, AC-MS-4)
  //   fenced from putEvidence of page 1| stopped (AttemptStoppedError), 1 source call in the log                                 | (UC-E12, AC-MS-6)
  //   not_current_attempt from the reservation of page 2 | stopped, 1 source call in the log                              | (UC-E12, AC-MS-6)
  //
  // Verification items:
  // - Each row asserts: task outcome, coverage {status, truncated, continuation, returned, totalMatched}, evidence keys, outputRefs, call-log count
  // - Evidence provenance.snapshot equals the pinned snapshot on every stored page; `outputRefs` lists stored pages in order, and is empty for snapshot_changed
  // - The completeness rule (eq / gte / null / exhausted / source_ended_early) is NOT re-tested here - one unit table owns it (see unit list at the end)
  it.todo(
    'INT-2: the page loop ends on the right condition with the right coverage, continuation and call count, and makes no call after a fence or a snapshot change',
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-3  Deadline and cancellation take precedence over error classification
  // ---------------------------------------------------------------------------------------------------------------
  // Covers:
  // AC-19.3: "Given fetch-задача прервана по дедлайну, а лимиты повторов и вызовов не исчерпаны, Then повтора нет: источник больше не вызван, исход записан причиной «дедлайн»,
  //          а не классом «сбой транспорта/протокола»."
  // AC-MS-1: "If вызов завершился любой ошибкой, а `ctx.signal` уже прерван, then исход берётся из `signal.reason.kind` и не повторяется."
  // AC-MS-3: "If очередная задержка backoff не меньше остатка дедлайна, then задача `failed` с классом `deadline` без следующего вызова."
  // Use cases: UC-E8 (and the executor side of UC-E9) (EARS: If-then - signal true / false).
  //
  // Primary failure mode (turns red when): an aborted signal surfaces from the SDK as RequestTimeout / ConnectionClosed and is recorded as transport_protocol and retried,
  // or a retry delay that would outlive the deadline is slept and followed by another call.
  // ROI: 2.9 (raw formula: (8 x 3 + 0 + 8) / 11) | Business Value: 8 (a deadline mislabelled as a source failure misleads the investigation) | Frequency: 3 (only on deadline / cancel)
  // Behavior: `hang` call (or retryable fault with a backoff delay >= remaining deadline) -> signal aborts with reason deadline / cancelled -> ToolOutcome class from signal.reason.kind, no further source call
  // @category: edge-case
  // @dependency: ToolExecutor, McpSourceClient, mcp-fixture process (hang), in-memory TaskContext (signal, deadline), injected clock and jitter
  // @complexity: medium
  //
  // Rows:
  //   hang, abort reason deadline            | failed deadline (K-1, not transport_protocol); retries/calls remain; log 1 call    (UC-E8, AC-19.3, AC-MS-1)
  //   hang, call timeout cut to deadline rest| failed deadline_in_call (K-2)                                                      (UC-E8)
  //   retryable fault, backoff >= remaining  | failed deadline with NO next call; log shows only the first call                  (UC-E8, AC-MS-3)
  //   hang, abort reason cancelled           | cancelled outcome from signal.reason.kind; no retry; log does not grow after abort (AC-MS-1; Postgres cancel path is E2E-2)
  //
  // Verification items:
  // - FailureReason.class is `deadline` (never `transport_protocol`) for the three deadline rows
  // - Fixture call log count unchanged after the abort (wait a bounded interval, re-read the log)
  // - The late response of an aborted `hang` call is dropped (no evidence, no outcome change)
  it.todo(
    'INT-3: a deadline or cancellation during a call is reported by signal.reason, not as a transport failure, and is never retried',
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-4  Fixture dataset: determinism, scenario signal, ground truth, versions
  // ---------------------------------------------------------------------------------------------------------------
  // Why a 4th integration test (limit 3, up to 5): nothing else detects a drifting generator. If the fixture is non-deterministic, loses the post-release timeout
  // rise, or its ground truth falls out of step with regenerated data, the PRD acceptance scenario (metric 1, 3) and every other test built on the fixture silently
  // test the wrong data. This is its only test.
  // Covers:
  // AC-15.1: "Given одна версия данных и один запрос, Then ответы двух вызовов совпадают байт в байт."
  // AC-15.2: "Given агрегат timeout платёжного сервиса до и после релиза, Then после релиза значение выше; Given записи затронутого `traceId`, Then время внешнего ответа позже локального timeout."
  // AC-15.3: "Given объём данных fixture, Then в ней не меньше 100 000 записей логов, и ни один инструмент не меняет данные."
  // AC-15.5: "Given fixture переключена на новую версию данных с дополнительными записями, Then срез данных в provenance меняется (основа для AC-06.4)."
  // AC-21.1: "Given сгенерированные данные, Then рядом лежит эталон с причиной и списком `traceId`, и каждый `traceId` из эталона находится инструментом получения по `traceId`."
  // PRD metric 5: "100 % совпадение ответов при одной версии данных (AC-15.1)", 100 requests.
  // Use cases: UC-5, UC-6 (EARS: Given/Then - basic functionality).
  //
  // Primary failure mode (turns red when): two processes of the same dataset version answer one query differently (even one byte), the timeout aggregate does not rise after the release,
  // an affected trace's provider response is not later than the local timeout, ground-truth/<version>.json differs from regeneration or lists a traceId `get_trace` cannot find,
  // `recordCount` < 100 000, `v2` keeps the `v1` snapshot, or a tool mutates data.
  // ROI: 4.5 (raw formula: (7 x 6 + 0 + 7) / 11) | Business Value: 7 (foundation of every fixture-based acceptance run) | Frequency: 6 (every acceptance run)
  // Behavior: two fixture processes `v1` -> 100 identical queries each -> byte-equal; aggregates before/after release; affected traces; regeneration vs ground truth; then `v2` process -> snapshot and totalMatched differ
  // @category: core-functionality
  // @dependency: mcp-fixture (process x2), packages/mcp-fixture generator, ground-truth/<version>.json, McpSourceClient (read-only use)
  // @complexity: medium
  //
  // Rows / steps:
  //   determinism   | 2 processes v1, 100 identical search_logs requests each | `result` byte-equal pairwise                                    (UC-5, AC-15.1, metric 5)
  //   scenario      | aggregate_logs groupBy status=timeout, hourly, before vs after release | after-release count higher (both from the fixture)  (UC-5, AC-15.2)
  //   late response | get_trace for each affectedTraceIds entry                 | provider response later than the local timeout; trace found     (UC-5, AC-15.2, AC-21.1)
  //   ground truth  | regenerate ground truth for v1 and compare with the file  | equal; every traceId found; aggregate and trace fetches complete (UC-5, AC-21.1)
  //   size          | fixture://source-info                                    | recordCount >= 100 000                                          (UC-5, AC-15.3)
  //   versions      | process v1 then process v2; currentSnapshot + one query over the v2 window | snapshots differ; totalMatched(v2) > totalMatched(v1) (UC-6, AC-15.5)
  //
  // Verification items:
  // - Byte-equality compares the serialized `result`, not a parsed-and-reserialized copy
  // - The 100 000 floor is read from the fixture's own resource, not recomputed
  it.todo(
    'INT-4: one dataset version answers byte-identically, the release shows the timeout signal, and ground truth matches regeneration',
  );
});

// -----------------------------------------------------------------------------------------------------------------
// Proven at unit level (provenAt: unit). Named for the plan; NOT part of the integration budget; do not re-check their variants above.
// -----------------------------------------------------------------------------------------------------------------
// - sources.registry.spec.ts (SourceRegistry factory, table-driven): AC-11.3 / UC-E2 - allowlisted tool with readOnly: false, pair missing from the descriptor,
//   duplicate sourceId, FIXTURE_FAULTS set without FIXTURE_CALL_LOG -> each throws with sourceId and toolName; the fixture process is never spawned
//   (spawn spy at the process boundary). `readOnlyHint` from the server is not read.
// - tool-executor.spec.ts (ToolExecutor + non-MCP stub adapter + in-memory TaskContext): AC-16.1 / UC-7 - a stub adapter with its own descriptor, currentSnapshot and
//   allowlist row yields a succeeded fetch with the same provenance format, with no change to ToolExecutor or runtime. Needs no Postgres or process;
//   the Design Doc lists it under e2e-runtime, but nothing in it depends on the database (pushed down).
// - completeness.spec.ts (pagination-and-coverage rule, table): complete only when nextCursor null AND (totalRelation eq with sum(returned) == totalMatched OR exhausted);
//   gte / null totals never complete; eq with a shortfall -> partial + warning source_ended_early; page_cap and total_cap shapes. INT-2 proves only the wiring.
// - mcp-error-classifier.spec.ts (McpSourceClient classifier, table over synthetic SDK errors): K-3..K-9, K-13, K-14 including codes the fixture cannot emit
//   (SdkHttpError 5xx/408/429, CapabilityNotSupported, spawn error, unknown SdkError code, non-SDK exception). INT-1 proves the real-client rows.
// - backoff.spec.ts (full jitter, injected random): delay in [0, min(cap, base x 2^n)], interruptible by signal.
//
// Not automated in the suite: UC-N1 / UC-N2 (p95 executor overhead and fixture page latency) - timing-sensitive, run on demand by a separate script
// (p95 = sorted[ceil(0.95 n) - 1] after warm-up), per testing-principles.
