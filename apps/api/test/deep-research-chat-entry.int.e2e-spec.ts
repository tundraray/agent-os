// deep-research / chat-entry Integration Test Skeletons (api side) - Design Doc: docs/features/deep-research/design-chat-entry.md
// PRD: docs/features/deep-research/prd.md v1.12 (FR-19..FR-22, FR-26 (api share), FR-27, NFR-01, NFR-03). ADRs: ADR-0001 (runtime owner), ADR-0002 (app schema migrations), ADR-0003 (Drizzle data layer), ADR-0004 (api owns chat logic). UXRD: docs/features/deep-research/uxrd.md (only through DC-7 / MC-13 / MC-15 / MC-16 / MC-29 on the wire, and MC-31 / MC-32 / MC-33 as the text the server stores).
// Generated: 2026-11-01 | Updated: 2026-11-01 for the no-source mode (Design Doc v1.6: KD-8, DC-8, DC-9, UC-4, UC-12, UC-13, UC-E8) | Part: chat-entry | Test type: Integration (in-process Nest app + real runtime + real Postgres, scripted chat model, engine port double), CI job `e2e` of apps/api
// Implementation timing: created alongside the slice each test names (the `deepResearch` tool and ResearchLaunchService, the delivery loop, the tail/delete hooks).
//
// File name and placement. This follows the sibling api files (`research-runtime-wiring.e2e-spec.ts`, `threads.e2e-spec.ts`): `apps/api/test/*.e2e-spec.ts`, picked up by `vitest.config.e2e.ts`
// (include '**/*.e2e-spec.ts', fileParallelism false, RUNTIME_WORKERS default 'off'). The `.int.` infix separates these in-process tests from the process-level file `deep-research-chat-entry.e2e-spec.ts`
// (final phase), the way the engine part does. The plan adds an npm script next to `test:e2e:runtime` and turns RUNTIME_WORKERS on for this file only (the delivery loop needs it).
// The web half of the part is in apps/web/src/components/shell/shell.research-decisions.int.test.tsx and shell.research-delivery.int.test.tsx (INT-4, INT-5 below in the budget).
//
// Environment (Design Doc "Test Strategy", "Runtime settings"):
// - Postgres 16 from infra/docker-compose.yml, migrations applied once by test/support/migrate.global-setup.ts (`app.research_chat_launches` included). Real AppModule pieces: ChatController, ThreadsService with its
//   write lock, ThreadRunRegistry, Mastra Memory over PostgresStore, the real runtime (`createRuntime`) with InvestigationService and the EventConsumer registry, the part's ResearchLaunchService, the `deepResearch` tool,
//   ResearchAnswerConsumer, ResearchAnswerAppender, ResearchChatController. SessionGuard is real (users are told apart by `x-user-id`).
// - Boundaries that are doubled, and only these: (1) the chat model - the MockLanguageModel of test/support/mockModels.ts, scripted per turn (a `deepResearch` tool call with a goal and a token budget, or plain text);
//   it records the options of every call (the forced tool choice, the thinking setting) and the message list it received; (2) the engine port (`Engine.startInvestigation`, `Engine.readInvestigation`): a test double over the
//   real runtime that creates a real investigation whose controller task is a test handler held by a latch (wiring-handlers.ts `testHandler`), and answers `readInvestigation` with a scripted `InvestigationView`
//   (answer, claims, evidence records with provenance). The engine itself is proven in packages/engine; here its contract (design-engine.md, Contract Definitions) is the boundary.
//   The double also carries the source mode (design-engine.md v1.9): `Engine.sourceMode` is settable between steps of a test (the stand-in for restarting the process with another set of sources), the scripted `InvestigationView`
//   has its own `sourceMode` (set when the double starts the investigation, not changed afterwards, as the engine guarantees), and `EvidenceReader.get` is a counting spy so that "the loop reads no evidence" is observable.
// - Isolation (project convention, no truncate): a unique `resourceId = newUser()` per test as `x-user-id`, unique thread ids; afterAll removes the threads of every resourceId through ThreadsService.
// - Time: the delivery loop is driven by single passes (`runOnce`) instead of waiting for `RUNTIME_POLL_MS`; the clock behind `RESEARCH_APPEND_GIVE_UP_MS`, `RESEARCH_LAUNCH_RECOVERY_MS` and the retry pause is injected.
//   No sleeps for ordering.
// - Support to add with the slice (not created here): test/support/researchChatApp.ts (createTestApp + the part's module + the engine double + the clock + `runAppenderOnce`), test/support/researchChatDb.ts
//   (read-only snapshots of `research_chat_launches` and of a thread's stored messages with metadata, and a row-version snapshot for "nothing changed" checks).
//
// Budget (whole part): Integration 5 (limit 3; up to 5 under the integration-e2e-testing rule only when each extra test names the defect no other test catches).
//   INT-1..INT-3 (this file) are the core budget. INT-4 and INT-5 are the two web tests and the two extras; their unique defects are stated in their headers. Table-driven rows keep the ACs of one rule or one flow in one test.
//   E2E 2 (limit 2): E2E-1 in deep-research-chat-entry.e2e-spec.ts, E2E-2 the L1 browser scenario at the end of deep-research-chat-entry.e2e-spec.ts.
//   The no-source mode (PRD 1.12) adds rows to these tests, not tests: INT-1 A6, INT-2 D5, an assertion block in INT-2 D1. The count stays 5 of 5 for the part and the extras are still INT-4 and INT-5 only.
//
// Proven elsewhere (not in this file; see the "AC -> proving test" table in the generation report and "Proven at unit level" at the end of this file):
// - the runtime primitives (cancel idempotence, purge of investigations, event delivery, EventConsumer contract) - packages/runtime and research-runtime-wiring.e2e-spec.ts
// - "after cancel no new model call and no source call" (AC-01.4, the second half of AC-21.1) - engine INT-2 L5 (packages/engine/test/deep-research-engine.int.e2e-spec.ts)
// - the deletion order of ThreadsService.delete and owner isolation of the runtime - research-runtime-wiring.e2e-spec.ts INT-5; here only what the part adds to it (the `purge` hook of launch rows, T4)
// - restart of the process between steps (NFR-03, UC-5, UC-E6) - deep-research-chat-entry.e2e-spec.ts
// - what an engine without sources does (plan then one synthesis, claims as `assumed`, the single start warning, the mode kept across a rebuild) - packages/engine (INT-1 C7, INT-2 L6, loader table); here only what the part does with the mode the engine reports
// - AC-26.1, service side (the process starts with no fixture package and `connectedSources` is empty): the api composition - extends apps/api/test/sources-wiring.e2e-spec.ts (named for the plan; not part of this skeleton set). The chat side of AC-26.1
//   (chat accepts messages, the research is proposed and launched, and the part adds no source check) is A6 below
// - AC-26.2, AC-26.3 (the start warning in the log): engine unit loader table; the log of a real boot is read by hand in L1-7 (deep-research-chat-entry.e2e-spec.ts)

import { describe, it } from 'vitest';

describe('deep-research / chat-entry - integration (in-process Nest + real runtime + real Postgres, scripted chat model)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-1  Chat turns decide launches: only the mode or a confirmed card starts an investigation, and a decision is applied once
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-19.1: "Given пользователь явно выбрал глубокое исследование для сообщения, When он его отправил, Then по нему запущено расследование этого пользователя в этой беседе, а беседа показывает, что оно идёт."
  // AC-19.2: "Given пользователь не выбирал глубокое исследование и агент счёл, что вопрос его требует, Then агент предлагает запуск, показывая цель и оценку бюджета, а расследования у беседы нет, пока пользователь не подтвердил."
  // AC-19.3: "Given предложение показано, When пользователь подтвердил, Then запущено расследование с показанной целью и в пределах показанного бюджета, а беседа показывает, что оно идёт."
  // AC-19.4: "Given предложение показано, When пользователь отклонил его, Then расследование не запущено, а беседа продолжается как обычно."
  // AC-19.5: "Given пользователь не выбирал глубокое исследование и не подтверждал ни одного предложения, Then у беседы нет ни одного расследования, что бы ни решил агент."
  // AC-19.6: "Given расследование идёт, When пользователь пишет в беседу, Then главный агент отвечает как обычно."
  // AC-19.7: "Given предложение уже подтверждено, When пользователь подтверждает его повторно, Then новое расследование не запускается, и у этого предложения остаётся ровно одно расследование."
  // AC-20.5: "Given беседа и расследование пользователя U, Then другой пользователь не видит ни ответа, ни состояния расследования (бизнес-ограничение 2)."
  // AC-21.1 (first sentence, the stop half): "Given расследование идёт, When пользователь его остановил, Then ... беседа показывает, что расследование остановлено" (the "no new model or source call" half is engine AC-01.4; the "answer is not appended" half is INT-2 D3)
  // DC-1 (FR-19): "Когда пользователь нажимает «Запустить», «Не нужно» или «Остановить» на карточке, чья судьба уже решена, ход решения ничего не меняет, а карточка переходит в текущее состояние запуска без строки ошибки."
  // DC-2 (FR-19): "Когда пользователь отправляет следующее сообщение, открытые предложения беседы закрываются, и карточка показывает «Не запущен» с причиной MC-13 для продолжившейся беседы; нажатие кнопки карточки следующим сообщением не считается."
  // DC-7 (FR-19, server half): "ChatController помечает реплику хода решения метаданными researchDecisionReply с launchKey" - what the web hides is INT-4; here the marks are what is stored and returned by GET messages.
  // AC-26.1 (chat share): "Given в развёртывании не подключён ни один источник данных, When сервис запускается, Then он запускается без ошибки, чат принимает сообщения, а глубокое исследование можно запустить в режиме без источников."
  // AC-27.1 (server half): "Given в развёртывании не подключён ни один источник данных, When агент предлагает глубокое исследование, Then вместе с целью и оценкой бюджета предложение предупреждает, что источники данных не подключены и ответ будет опираться на знания модели." (the sentence MC-31 is drawn by the web; here the proposal's `sourceMode`)
  // AC-27.2 (server half): "Given в развёртывании не подключён ни один источник данных, When пользователь явно выбрал глубокое исследование и отправил сообщение, Then беседа показывает то же предупреждение там же, где показывает, что расследование идёт (AC-19.1), с момента запуска." (here: the first view the tool returns already has `sourceMode`)
  // AC-27.4 (server half): "Given подключён хотя бы один источник, Then беседа не показывает предупреждения режима без источников ни в предложении, ни в идущем расследовании, ни в ответе." (here: `sourceMode` `sources` in every view; the answer is INT-2 D1)
  // DC-8 (FR-27): "Пока у запуска нет расследования, карточка показывает MC-31 по режиму развёртывания в момент чтения; после старта — по режиму своего расследования, и рестарт с другим набором источников её не меняет."
  // Use cases: UC-1, UC-2, UC-3 (server half), UC-12 (launch half), UC-13, UC-E1 (the `decisionError` rows), UC-E2, UC-E5. Flow 1, Flow 2, Flow 4 (the branches that do not race with the answer). KD-1, KD-2, KD-8, Invariants 1, 2.
  //
  // Primary failure mode (turns red when): a turn without the mode or a decision starts an investigation (the agent launches itself); a mode turn runs without the forced `deepResearch` call or with reasoning on (the provider rejects it);
  // a confirm starts a second investigation, or starts one with the goal or budget the model passed in the decision turn instead of the recorded proposal; a decision on a settled launch changes it or answers an error; a decision turn
  // closes other proposals, or a plain follow-up does not; a decision with another user's `launchKey` changes that user's launch; the reply of a decision turn is stored without `researchDecisionReply`;
  // a deployment without sources refuses or does not offer the research (the part adds its own source check), or its proposal and first launch view lack the mode; a running launch follows the live engine mode after a restart with other sources
  // instead of keeping its investigation's mode, or a proposal keeps the old mode (the row stores what was read when it was proposed); a deployment with a source shows the no-source mode.
  // Behavior: POST /api/chat with message metadata (`deepResearch: true`, or `researchDecision` with action and `launchKey`) or without -> ChatController gives the turn its single forced tool and no reasoning, or none -> the scripted model calls
  //   `deepResearch` -> the tool reads the mode or decision from the turn context, not from model arguments -> ResearchLaunchService writes the `research_chat_launches` row under the thread lock and starts the investigation outside it ->
  //   the tool returns a ResearchLaunchView -> GET /api/threads/:threadId/research and GET /messages show the result
  // @category: core-functionality
  // @dependency: ChatController, deepResearch tool, ResearchLaunchService, ThreadsService (write lock), ThreadRunRegistry, Mastra Memory, runtime InvestigationService, engine port double, research_chat_launches, Postgres
  // @complexity: high
  //
  // Verification items (table of scenarios; each row names the AC it proves and shares the harness; every row ends by reading `research_chat_launches` and the runtime's investigations of the user, not logs):
  // - A1 explicit mode (UC-1, AC-19.1, AC-19.6): message with `deepResearch: true` -> the model double saw exactly one tool (`deepResearch`) forced, and reasoning off; the row is `running` with a `controllerTaskId` and one investigation of this
  //   user in this thread; the stored user message keeps `deepResearch: true` in GET /messages (the label survives a reload); a next message without the mode -> the double saw no forced tool, a text reply, still one investigation
  // - A2 proposal, no self-launch (UC-2 first half, AC-19.2, AC-19.5): a turn without mode where the double calls `deepResearch` with a goal and a budget -> the row is `proposed` and carries that goal and budget in GET /research; zero
  //   investigations of the user; a second proposal in the same thread is a second row with its own `launchKey`; nothing else (no later turn without a confirm) ever creates one
  // - A3 decisions (UC-2, UC-3 server half, UC-E1 rows, AC-19.3, AC-19.4, AC-19.7, AC-21.1 stop half, DC-1, DC-7): over two `proposed` rows and the table of actions:
  //     confirm, the double's tool call carrying a different goal and a bigger budget than the proposal -> one investigation started with the recorded goal and budget, row `running`
  //     decline -> `not_launched` with reason `declined`, no investigation
  //     confirm again, then decline, on the running one (the second tab) -> the same view, count of investigations still one, no `decisionError`
  //     stop on `running` -> `InvestigationService.cancel` called once, row `stopped`; stop again -> same view, no second effect
  //     engine double refuses the start -> row back in `proposed`, the tool result has `decisionError: launch_failed`; cancel refused on stop -> row unchanged, `decisionError: stop_failed`
  //     in every row the stored reply of the turn carries `researchDecisionReply` with the `launchKey`, the decision message carries `researchDecision`, and GET /messages returns both (the web hides them by these marks)
  // - A4 supersede (UC-E2, DC-2): proposal, then a plain next message -> row `not_launched` with reason `superseded`; a confirm on it afterwards -> same view, no investigation; a second proposal where a decision turn is sent for a different card
  //   leaves the other proposal `proposed`
  // - A5 another user (UC-E5, AC-20.5): user V reads GET /research of U's thread -> 404 THREAD_NOT_FOUND (ApiError schema); V sends a decision turn in V's own thread with U's `launchKey` -> `decisionError: not_found`, U's row version
  //   unchanged (row-version snapshot), no investigation for V
  // - A6 source mode of the launches (UC-12 launch half, UC-13, AC-26.1 chat share, AC-27.1, AC-27.2, AC-27.4, DC-8, KD-8; unique defect: the mode read from the wrong moment - the live engine mode for a running launch, or the mode stored at proposal time for a
  //   proposal - and a source check added by the part, which neither the web nor the engine suites can show): the double starts with `Engine.sourceMode` `model_knowledge` and the app is composed with no source adapter:
  //     a turn without the mode where the chat model double calls `deepResearch` -> the app takes the message, the double saw the same single tool and the same instruction text as in a `sources` run, the proposal is stored and GET /research shows it with `sourceMode` `model_knowledge`
  //     a turn with the mode -> one investigation started, the tool result (the first view) already has `sourceMode` `model_knowledge`, and the `research_chat_launches` row stores the investigation's mode copied at reconciliation
  //     rows with no investigation (declined, superseded, failed start, `launching`) show the current `Engine.sourceMode`
  //     then the double's `Engine.sourceMode` is set to `sources` (the restart with the fixture): the open proposal shows `sources`, the running launch keeps `model_knowledge`, a confirm of the proposal starts an investigation viewed as `sources`
  //   and in a run with `sources` from the start every view (proposal, running, completed) has `sourceMode` `sources`
  describe('INT-1', () => {
    it.todo('INT-1 A1: a turn with the research mode forces the deepResearch call without reasoning and starts one investigation; the next turn without the mode answers as usual and starts none');
    it.todo('INT-1 A2: a turn without the mode only records a proposal with its goal and budget, and no later turn without a confirm starts an investigation');
    it.todo('INT-1 A3: confirm starts exactly one investigation with the recorded goal and budget, decline starts none, repeated and stale decisions change nothing and answer no error, stop cancels once, refused start or stop returns decisionError, and every decision reply is marked');
    it.todo('INT-1 A4: a plain follow-up message closes open proposals as superseded, a decision turn does not close the other proposals, and a confirm on a superseded card starts nothing');
    it.todo('INT-1 A5: another user cannot read the launches of the thread (404) and a foreign launchKey in a decision turn changes nothing (not_found)');
    it.todo('INT-1 A6: without sources the chat still proposes and launches research with no source check by the part, each launch view carries the mode (current engine mode until the investigation exists, the investigation\'s own mode after), a restart with a source changes proposals but not a running launch, and with a source no view carries the no-source mode');
  });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2  Answer delivery: the answer is appended once, after the running chat turn, in completion order, and never after a stop or a give-up
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-20.1: "Given беседа открыта, When расследование завершено, Then ответ появляется в беседе без перезагрузки страницы (NFR-01), и беседа больше не показывает, что это расследование идёт." (server half: the stored message and GET /research; the live append is INT-5)
  // AC-20.2: "Given ответ дописан, When беседа перезагружена или открыта позже, Then ответ стоит в ней ровно один раз, на позиции, которую получил при завершении расследования." (position and uniqueness on redelivery; the kill case is E2E-1; the regenerate exception is INT-3 T2)
  // AC-20.3: "Given в момент завершения расследования в беседе стримится другой ответ, Then ответ расследования показан отдельным сообщением и не склеен со стримящимся ни вживую, ни после перезагрузки."
  // AC-20.4: "Given расследование завершилось ошибкой, Then беседа показывает, что оно не удалось, и больше не показывает, что оно идёт."
  // AC-20.6: "Given в беседе идут два расследования, When запущенное вторым завершилось первым, Then его ответ дописан раньше ответа первого, и каждый ответ ссылается на своё сообщение-запуск."
  // AC-20.7: "Given в развёртывании подключён хотя бы один источник данных, и ответ дописан, Then у каждого его утверждения в беседе видно, на какое evidence оно опирается (AC-09.2)." (server half: footnote numbers and source records in `researchAnswer`; the rendering is a component spec)
  // AC-27.3 (server half): "Given в беседу дописан ответ расследования в режиме без источников, Then беседа показывает предупреждение ответа и пометку знаний модели у каждого утверждения (AC-25.1, AC-25.2), в том числе после перезагрузки." (here: `sourceMode` in `researchAnswer`, MC-32 and MC-33 in the stored text, survival in GET /messages; the drawing is a component spec)
  // AC-27.4 (answer half): "Given подключён хотя бы один источник, Then беседа не показывает предупреждения режима без источников ни в предложении, ни в идущем расследовании, ни в ответе." (UC-4 with the fixture connected: asserted in D1)
  // DC-9 (FR-27): "Текстовая часть ответа в режиме без источников начинается с MC-32 и несёт MC-33 после каждого утверждения, поэтому «Копировать» и модель в следующих ходах получают ту же оговорку."
  // AC-21.1 (third part): "...а ответ не дописывается." (the stop wins over a finished controller)
  // DC-3 (FR-20): "Стримящийся ответ из NFR-01 - любой прогон чата беседы, зарегистрированный в ThreadRunRegistry этого процесса, в том числе ход решения; ответ ресерча дописывается после его конца."
  // DC-4 (FR-20): "Когда ответ не удаётся записать дольше RESEARCH_APPEND_GIVE_UP_MS с первой неудачи, запуск переходит в failed, и карточка показывает «Не удался»; так же кончается повторная запись ответа, убранного перегенерацией."
  // NFR-01 (server share only): "ответ завершённого расследования появляется в открытой беседе не позже чем через 5 с после завершения" - the measured end-to-end figure is E2E-2; here the answer is stored by the first pass after the event.
  // Use cases: UC-4 (server half, with a fixture connected), UC-6, UC-7, UC-12 (answer half), UC-E3, UC-E4, UC-E7 (server half), UC-E8. Flow 3, Flow 4 (race branch). KD-3, KD-4, KD-5, KD-8, Invariants 3, 4, 5, 6.
  //
  // Primary failure mode (turns red when): the answer is written in the middle of a chat turn or between the user message and its reply (DC-3); a later-finishing investigation's answer lands before an earlier one that is still retrying, or the
  // other way round for AC-20.6; a redelivered `TaskSucceeded` or a second pass writes a second message; a stopped or failed launch still gets an answer; a client copy of `research-answer-*` in the next chat request overwrites the stored answer;
  // the loop retries forever and the card stays "running", or gives up early; a child task or an investigation started outside a thread turns a row to `answer_pending`;
  // an answer of an investigation without sources is stored with footnotes, sources or `established` claims, or without `sourceMode` (the web then draws it as a checked answer), or its text carries no MC-32 / MC-33
  // (the copy and the next chat turn lose the caveat), or the loop reads evidence for it; an answer of an investigation with a source carries the no-source warning or marks.
  // Behavior: TaskSucceeded of the row's `controllerTaskId` -> consumer moves the row to `answer_pending` in the delivery transaction (no external call) -> the loop pass picks the rows in completion order, skips threads with a registered run, and under the
  //   thread lock re-reads the row, reads the answer and provenance through the engine port, saves `research-answer-<investigationId>` with Markdown text and `researchAnswer` metadata, marks `answered` -> GET /research and GET /messages show it
  // @category: core-functionality
  // @dependency: ResearchAnswerConsumer, ResearchAnswerAppender, ThreadRunRegistry, ThreadsService.withOwnedThread, ChatController (client copies of answers), engine port double (readInvestigation, EvidenceReader), Mastra Memory, injected clock, research_chat_launches, Postgres
  // @complexity: high
  //
  // Verification items (table; every row reads the stored messages of the thread with their metadata and `createdAt`, and the launch rows):
  // - D1 delivery and shape (UC-4 with a fixture connected, AC-20.1, AC-20.2 uniqueness, AC-20.4, AC-20.7, AC-27.4): TaskSucceeded of the controller task -> after one pass exactly one message `research-answer-<investigationId>` after the last message; its text is the
  //   whole answer in Markdown (header, groups, claims with `[n]`, source list); its `researchAnswer` metadata has goal, outcome, stop reason, the launch reference, claims with footnote numbers by first appearance and the source entries
  //   (sourceId, toolName, snapshot, truncated), and `sourceMode` `sources`; the text holds neither MC-32 nor MC-33 and the launch view has no no-source mode (AC-27.4); no `removed` section; GET /research shows `completed` with `answerMessageId`; the same event delivered again and a second pass change nothing (still one message, same position);
  //   a TaskSucceeded of a child task and of an investigation not started from a thread do not touch any row; TaskFailed -> row `failed` and TaskCancelled -> `stopped`, no message in both
  // - D2 order and running turns (UC-6, UC-E3, AC-20.3, AC-20.6, DC-3, UC-E7 server half): two launches in one thread, the second finishes first -> its answer is stored before the first one's, each with its own launch reference;
  //   a chat run registered in ThreadRunRegistry (a latch holds the model) -> passes write nothing for that thread; after the run ends, the next pass writes the answer after the run's reply, never between the user message and its reply;
  //   a decision turn that failed before its reply (stored: the decision message only) does not block the pass; the next chat request carries a client copy of the answer message with edited content -> the stored answer is unchanged
  // - D3 stop beats the answer (UC-7, AC-21.1): controller succeeded and row `answer_pending`, then the stop decision turn -> row `stopped`, cancel called, and passes before and after write no message; a stop on a row already `answered`
  //   changes nothing (the answer was delivered)
  // - D4 give-up window and queue (UC-E4, AC-20.6, DC-4): the memory write fails on every try -> the row stays `answer_pending`, the pauses between tries start at `RUNTIME_POLL_MS` and double up to 16 times that, a later finished
  //   investigation of the same thread writes nothing while the earlier one retries; at `RESEARCH_APPEND_GIVE_UP_MS` after the first failure the row is `failed` (GET /research: `failed`, no `answerMessageId`), the earlier-finished one is
  //   not retried again, and the next row is then written
  // - D5 answer without sources (UC-12 answer half, UC-E8, AC-27.3 server half, DC-9, KD-8; unique defect: the loop treating a no-source answer as a sourced one - reading evidence that does not exist, numbering footnotes, dropping the mode from the metadata - or
  //   storing the caveat only in the metadata so that the copy and the model lose it; the builder's rule table is a unit test): the double's `InvestigationView` has `sourceMode` `model_knowledge`, two claims in `assumed` with no evidence, `established` empty, outcome `answered`;
  //   one pass after TaskSucceeded -> one message `research-answer-<investigationId>`; `researchAnswer.sourceMode` is `model_knowledge`, `established` is empty, claims have no footnote numbers, the source list is empty; the text starts with MC-32 and has MC-33 after each of the two
  //   claims and no `[n]`; the counting spy on `EvidenceReader.get` has zero calls; GET /messages after a reload returns the same message once; the next plain chat turn of the thread: the message list the chat model double received contains that text with MC-32 and both MC-33
  //   (the model is not told the claims are checked); GET /research shows `completed` with `answerMessageId`.
  //   UC-E8 row: the view is a stop before the synthesis ended (outcome `inconclusive`, stop reason `budget_exhausted`, no claims) -> the stored text starts with MC-32 and states the stop reason MC-25, the metadata has no claims, and the launch is `completed`
  describe('INT-2', () => {
    it.todo('INT-2 D1: a finished controller task appends one answer message with Markdown text and researchAnswer metadata (mode sources, no no-source warning or mark) at the end of the thread, redelivery changes nothing, child and foreign events are ignored, and failure or cancel appends nothing');
    it.todo('INT-2 D2: answers are appended in completion order, only after the running chat turn of the thread has ended, never between a user message and its reply, and a client copy of an answer does not overwrite the stored one');
    it.todo('INT-2 D3: a stop decision on a launch whose controller already finished leaves the launch stopped and appends no answer, while an already delivered answer is untouched');
    it.todo('INT-2 D4: a write that keeps failing is retried with growing pauses and holds the later answers of its thread until RESEARCH_APPEND_GIVE_UP_MS, then the launch is failed and the queue moves on');
    it.todo('INT-2 D5: the answer of an investigation without sources is stored with the mode, no footnotes or sources and no evidence read, its text opens with the warning and marks every claim so that the reload, the copy and the next chat turn keep the caveat, and a stop before the synthesis ends gives a warning with the reason and no claims');
  });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-3  Regenerate and delete: the tail drops its research with it, other research is re-appended once, and nothing is left behind
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-22.1: "Given расследование беседы T идёт, When беседа T удалена, Then расследование остановлено и удалено (research-runtime/prd.md, FR-23), ответ не дописан, и беседа T не появилась снова."
  // AC-22.2: "Given перегенерирован ответ ассистента, который отвечает на сообщение-запуск расследования или сам им является, Then это расследование остановлено и его ответ не дописан; сразу за сообщением пользователя следует только перегенерированный ответ (chat-shell/prd.md, AC-14.6)."
  // AC-20.2 (the exception added by Design Doc KD-7): "...перегенерация удаляет сообщения после перегенерируемого ответа, среди них этот ответ, а его расследование перегенерация не останавливает. Тогда ответ дописывается заново после перегенерированного ответа и по-прежнему стоит в беседе ровно один раз."
  // DC-5 (FR-22): "Когда перегенерация удаляет хвост с ответом ресерча, чья карточка лежит вне хвоста, этот ответ дописывается снова после перегенерированного ответа, а его карточка остаётся «Завершён»."
  // DC-6 (FR-22, server half): GET /research of a thread answers the launches in `running` (the dialog counts them); the paragraph MC-22 itself is a component spec.
  // Use cases: UC-8 (server half), UC-9, UC-10 (server half), UC-11. Flow 5. KD-2 (tail and hidden pairs), KD-7, State Transitions (`discarded`, `answer_reappend`).
  //
  // Primary failure mode (turns red when): a regenerate leaves a card's investigation running or its answer alive; a hidden decision pair stays in the tail and sits between the user message and the new reply; the regenerate takes the decision
  // message for the last user message; the answer of another launch is deleted with the tail and never comes back, or comes back twice, or before the new reply; a failure of the tail selection still deletes the tail; a deleted thread leaves
  // `research_chat_launches` rows (proposals have no investigation to cascade from) or a later TaskSucceeded writes an answer into nothing.
  // Behavior: POST /api/chat repeating the last user message -> ChatController registers the run, `discardRepliesAfter` finds the last user message without `researchDecision` and the tail after it -> `beforeDelete` marks the launches of the tail
  //   `discarded` and cancels their investigations, marks the answers of launches whose card is outside the tail `answer_reappend` -> the tail is deleted whole -> the new reply streams -> after the run ends the loop writes the re-appended answers;
  //   DELETE /api/threads/:threadId -> runtime hook stops the investigations, `purge` hook deletes the launch rows
  // @category: core-functionality
  // @dependency: ChatController, ThreadsService.discardRepliesAfter (beforeDelete), ThreadsService.delete, ResearchLaunchService, ResearchChatModule purge hook, ResearchAnswerAppender, ThreadRunRegistry, runtime InvestigationService, Mastra Memory, research_chat_launches, Postgres
  // @complexity: high
  //
  // Verification items (table; thread contents are seeded through Memory.saveMessages, the way test/support/seed.ts does, with the part's metadata):
  // - T1 the tail takes its research with it (UC-9 first half, UC-10 server half, UC-11, AC-22.2): thread = user message U1, failed reply R1 carrying the card of launch X, then (a) a hidden decision pair from another tab and (b) in a second case X
  //   already `answered` with its answer message in the tail -> a repeated POST of U1 -> X is `discarded`, cancel called once, the whole tail including the pair and the answer is gone, the new reply directly follows U1; passes after the run
  //   never bring the answer back; GET /research no longer lists X; a repeat of the same request after a forced failure of the delete (below) finds X already `discarded` and does not cancel twice in effect
  // - T2 another launch's answer comes back once (UC-9 second half, AC-20.2 exception, DC-5): launch Y has its card above U1 and its answer after R1 in the tail -> regenerate marks Y `answer_reappend`; GET /research shows Y `completed` with
  //   `answerPending: true` and no `answerMessageId` target to a missing message; Y's investigation is not cancelled; while the new run is registered nothing is written; after it ends one pass writes `research-answer-<Y.investigationId>`
  //   after the new reply and Y is `answered`; a second pass changes nothing; with writes failing past `RESEARCH_APPEND_GIVE_UP_MS` Y ends `failed`
  // - T3 failed selection or delete keeps the tail (Flow 5 failure bullets): `beforeDelete` made to throw (engine double cancel refuses) -> the request answers an error before streaming and the tail is intact; the delete made to fail after
  //   `beforeDelete` passed -> tail intact, rows already `discarded` / `answer_reappend`; a retry deletes the tail and the answers marked `answer_reappend` are rewritten in place if no retry comes (same message id, `createdAt` unchanged)
  // - T4 thread deletion (UC-8 server half, AC-22.1, DC-6 server half): thread with a `running` launch, a `proposed` launch (no investigation) and an `answered` one; GET /research counts one `running` -> DELETE /threads/:id -> the running
  //   investigation is cancelled and deleted by the runtime hook, all three launch rows are gone (the `purge` hook), a later TaskSucceeded of the deleted investigation writes nothing and GET /threads/:id answers 404, the thread does not reappear
  describe('INT-3', () => {
    it.todo('INT-3 T1: regenerating a reply whose tail holds a card, its hidden decision pair or its answer discards the launch, cancels its investigation, removes the whole tail and never brings the answer back');
    it.todo('INT-3 T2: regenerating while another launch\'s answer sits in the tail re-appends that answer exactly once after the new reply, keeps its launch completed, and fails it only after the give-up window');
    it.todo('INT-3 T3: a failure of the tail selection or of the delete leaves the tail in place, and a retry completes without a second effect');
    it.todo('INT-3 T4: deleting a thread with running, proposed and answered launches stops the investigation, removes every launch row, and no later event writes an answer');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Proven at unit level (named for the plan; generated as specs next to the code, not here). One table-driven spec per rule, cases as rows; fast-check where noted.
// ---------------------------------------------------------------------------------------------------------------
// - Launch state machine of ResearchLaunchService (table over State Transitions): for every state x action (confirm, decline, stop, supersede, discard, TaskSucceeded, TaskFailed, TaskCancelled, write window expired) the next state or "no change",
//   and the ResearchLaunchView mapping (`launching` and `answer_pending` shown as `running`, `answered` and `answer_reappend` as `completed`, `declined` and `superseded` as `not_launched` with the reason, `answerPending` only for `answer_reappend`).
//   The `sourceMode` of the view (rows of the same table): a row with an investigation shows the mode copied from its `InvestigationView` at reconciliation whatever `Engine.sourceMode` is now; a row without one (`proposed`, `not_launched`, `failed` at start,
//   `launching`) shows the current `Engine.sourceMode`; reconciliation copies the mode once and never overwrites it. DC-8 (rule), KD-8.
//   AC-19.7 (rule), DC-1 (rule), DC-2 (rule), Invariants 1 and 2. The integration rows prove only that the real tool and the real lock reach this machine once.
// - `discardRepliesAfter` (extends threads.service.spec.ts): last user message is the last one without `researchDecision`, the tail may hold hidden pairs and answers, `repeated` is true only when the request's last message equals the stored one,
//   `beforeDelete` sees the tail before the delete and its exception cancels it. AC-22.2 (rule), KD-7.
// - `ThreadRunRegistry.hasRuns` (extends thread-run-registry.spec.ts).
// - Answer message builder (table + fast-check property): footnote numbers follow the first appearance of a source and are stable for the same input; the Markdown text and the `researchAnswer` metadata agree on the numbers; the section `removed`
//   never appears; outcome and stop reason pass through. AC-20.7 (server share).
//   Rows added for the mode `model_knowledge` (UC-12, UC-E8): the text starts with MC-32 and carries MC-33 after every claim (and after none when there are no claims), no `[n]` and no source section; `established` is empty and no claim has a footnote number;
//   the Markdown text and the metadata agree on the claims; in the mode `sources` neither MC-32 nor MC-33 appears. AC-27.3 (server share), DC-9 (rule).
// - Message-metadata schemas of `@agent-os/contracts` (`deepResearch`, `researchDecision`, `researchDecisionReply`, `researchAnswer`, `ResearchLaunchView`, `ThreadResearchResponse`): the part's own rules only (an unknown action is refused, `answerMessageId`
//   only with `completed`, a `researchAnswer` with `sourceMode` `model_knowledge` has an empty `established`, no footnote numbers and no source entries), not that zod parses.
// - Deterministic id and retry pause: `research-answer-<investigationId>`; pause doubling from `RUNTIME_POLL_MS` capped at 16x (fast-check property).
// - Settings parsing of `RESEARCH_APPEND_GIVE_UP_MS` and `RESEARCH_LAUNCH_RECOVERY_MS` (extends runtime-settings.spec.ts): defaults 300000 and 60000, invalid values refused.
