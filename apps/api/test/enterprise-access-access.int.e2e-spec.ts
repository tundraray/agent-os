// enterprise-access / access - API integration skeletons (real AppModule + real Postgres + MCP fixture process, workers on, scripted model)
// Design Doc: docs/features/enterprise-access/design-access.md (v1.1), Test Strategy UC-2, UC-3, UC-4, UC-5, UC-6, UC-7, UC-8 (refuse, new month),
//   UC-10, UC-E3, UC-E4; PRD: docs/features/enterprise-access/prd.md (v1.3) FR-16..FR-23 (AC-16.1, AC-16.2, AC-16.3, AC-17.1, AC-17.3, AC-18.1..18.4,
//   AC-19.1..19.3, AC-20.1..20.4, AC-21.3, AC-21.4, AC-22.1..22.4, AC-22.7, AC-22.8, AC-22.9 (raise and refuse), AC-23.1) and the `admin` ACs this part's
//   operations answer (AC-30.1..30.4).
// Generated: 2026-11-15 | Budget Used: 3 API integration skeletons here (INT-1, INT-2, INT-3) + 1 agents-package integration skeleton
//   (packages/agents/test/enterprise-access-access.int.e2e-spec.ts, INT-4) + 1 web integration skeleton
//   (apps/web/src/components/shell/enterprise-access-access.int.test.tsx, INT-5) = 5/5 for the part (over the 3-test default, at the 5-test
//   ceiling, as the two earlier parts: each skeleton names a defect no other test catches, see "Catches"), 2 E2E in
//   apps/api/test/enterprise-access-access.e2e-spec.ts.
// Test Type: Integration. Every case is `it.todo` - skeletons only, no implementation.
//
// Harness (follows apps/api/test/support/*, enterprise-access-identity.int.e2e-spec.ts and enterprise-access-mcp-connect.int.e2e-spec.ts): one
//   `createTestApp({ workers: true, model })` per file against the docker-compose Postgres, real AppModule with the real global SessionGuard
//   and the real `AccessService` behind `AccessGate`; employees from `devSignIn(app, name, { admin })` (cookie and `id`). Only `AGENT_TURN_CLIENT`
//   is the scripted model (it records, per request, the tool names it was offered and counts calls); MCP is the `packages/mcp-fixture` PROCESS over
//   HTTP registered through the admin operations of `mcp-connect` (shared-token servers `logs` and `tracker`, `backoffice`); its journal is the proof
//   that a server received nothing. Rights, catalogue, quotas and the pause limit are made ONLY through the admin operations of this design
//   (`POST /api/admin/models`, `POST /api/admin/grants`, `PUT /api/admin/settings/quota-pause`), so those routes are part of every setup.
//   Time is never faked: the pause's recorded `month` and `waitUntil`, and the month of ledger rows, are set by editing the rows; the pause review
//   is triggered by the admin operations themselves or by `app.agents.quotaPauses.review()` (the function the 60-second loop calls). The token
//   count of every scripted call is chosen by the test, so spend is known to the cent. Every case uses its own employees, so rows of one case never
//   meet another's. Responses are parsed with `@agent-os/contracts` schemas.
//   Support the implementation tasks add (not skeletons): `test/support/access.ts` with `addModel(admin, {id, prices})` and `grantTo(admin, holder,
//   {effect, target, quotaUsd?})` over the admin routes; `createTestApp` seeds the default model `anthropic/claude-haiku-5-5` into the catalogue and
//   `newUser()` / `devSignIn` give every employee an unlimited right to it unless the case says otherwise (it replaces the `mcpAccess` option
//   and the price file for all existing API suites, see "Replaced / adapted").
// Mock boundary: the model only. Do NOT mock the database, `AccessService`, `effectiveAccess`, `IdentityDirectory`, the fixture process, `TokenLedger`.
//
// Replaced / adapted by this design (not duplicated here):
//   - `serverAllowed` over `MCP_ACCESS_TABLE`, `parseAgentsConfig`'s table rows (packages/agents/src/config.spec.ts), `tool-access.ts` and
//       `createTestApp({ mcpAccess })`: deleted with the code. Every API suite that passed `mcpAccess` now gets its rights from `grantTo` (a role or
//       a personal right on the server): agent-platform-chat.int.e2e-spec.ts (line 435), enterprise-access-identity.e2e-spec.ts E2E-1 (its
//       `IdentityOwnerGate` dependency becomes `AccessGate`; its assertions - stop with `owner_disabled`, no model or tool call after the disable
//       moment - stay and are the proof of DC-3 end to end: not repeated here), enterprise-access-mcp-connect.e2e-spec.ts E2E-2 (the development
//       employee gets the `dev` role of `seed:access` instead of `*` in the table).
//   - agent-platform-chat.int.e2e-spec.ts INT-2 E (spend endpoint, prices from `config/model-prices.json`, line 1597): kept; the model's price comes
//       from the catalogue entry made through `addModel`. INT-3 B (title is a ledger row without a task): kept as the proof of the title's cost
//       entering spend; the employee's right to the default model is part of its setup. Neither is repeated here.
//   - NFR-03 for this part's routes (`/api/admin/...`, `GET /api/access/models`): the route walk of enterprise-access-identity.int.e2e-spec.ts INT-1
//       takes the new routes from the router, no skeleton here.
//
// `provenAt: unit` (tables next to the code, not skeletons - the rules never get a second proof here):
//   - `apps/api/src/access/effective-access.spec.ts`, one table over `effectiveAccess` (UC-1): role right on a server; personal right on one tool
//       without the server; personal deny of a tool under a role right; server deny with a personal tool right (AC-17.2: nothing); model deny under
//       a role right; quotas SRE 50 + Дежурный 20 + personal 30 = 100 with `parts` (AC-21.1, AC-29.1); one grant without a quota removes the limit
//       with `unlimitedBy` naming it, also when added later (AC-21.2, AC-21.5); a tool absent from the registry list gives nothing (DC-1).
//   - `apps/api/src/access/access.service.spec.ts`, the verdict order table: disabled or unknown employee first (`stopOwner` + `OWNER_DISABLED`,
//       the rows `OwnerGate`'s unit test held, DC-3), then catalogue (`model_not_connected`), then right (`model_not_allowed` / `no_models_allowed`),
//       then quota (spend equal to quota is exhausted, spend one cent below is not, no quota is never), the price from the catalogue row and
//       `waitUntil` from the limit read at that moment.
//   - `apps/api/src/access/grant-rules.spec.ts`: the `GRANT_INVALID` rows (a deny for a role; a quota on a server or tool right; a quota below 0,01 or
//       above 1 000 000 or with sub-cent digits) - the `GRANT_TARGET_UNKNOWN` and `GRANT_EXISTS` rows need the registry, the catalogue and the
//       unique index, so one step of INT-1 holds them.
//   - `packages/agents/src/model/model-choice.spec.ts` (no `pricedModels`, the `unknown_model` rows deleted), `tool-gate.spec.ts` line 248 (the
//       refusal reason becomes `model_not_connected` / `model_not_allowed`), `model-client.spec.ts` (verdict `allowed` passes the price to
//       `TokenLedger.record`; `quota_exhausted` / `refused` give "call not started" and no provider call; provider retries do not ask again;
//       `completeText` throws on "not started"), `agent-view.spec.ts` and `apps/api/src/chat/chat-status.spec.ts` (`awaiting_quota` by the kind of
//       the open decision, not `awaiting_confirmation`), `packages/runtime` `monthOf` table. `packages/runtime/src/model-cost.spec.ts`: the
//       `parseModelPrices` rows are deleted with the loader; `callCostUsd` rows stay.
//   - `packages/runtime/test/agent-platform-runtime.int.e2e-spec.ts`: INT-5 C (`UNKNOWN_MODEL_PRICE`, `pricedModels()`) is deleted with the code; INT-5 A
//       is adapted (the price arrives with the call); INT-5 B gains one row for `monthSpendByModel`. No new runtime skeleton.
//
// NOT here on purpose: effective-quota arithmetic and permission rules (unit above); the disabled-employee stop (identity E2E-1, adapted); the
//   response of `POST /api/decisions/:id` to a pause and the confirmations list (DC-11: INT-4, one level lower); pause outcomes `expired`,
//   `model_not_allowed`, `model_not_connected` and the concurrent review (INT-4); the 60-second loop's period (a constant, not tested);
//   the check's cost (NFR-04, on-demand script named in the report, not part of the suite).

import { describe, it } from 'vitest';

describe('enterprise-access / access - API integration (real AppModule + real Postgres + MCP fixture process)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-1: a tool is offered and run only by the rights of this moment, at every door
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-16.1 "роль «SRE» имеет право на Sentry MCP, а Аня в этой роли: ... ей доступны все инструменты Sentry"; AC-16.2 "нет права на сервер,
  //   но есть личное право на один его инструмент: из этого сервера ему доступен только этот инструмент"; AC-17.1 "роль даёт право на сервер, а
  //   у сотрудника личный запрет на один изменяющий инструмент: доступны все инструменты сервера, кроме запрещённого, а вызов запрещённого
  //   получает отказ"; AC-18.1 "у сотрудника нет права на инструмент, а модель всё равно просит: MCP-сервер не получает ни одного вызова, агент
  //   получает отказ, а в аудите - ровно одна запись «отказ по правам»"; AC-18.2 "администратор снимает право: инструмента нет в наборе со
  //   следующего вызова модели, а вызов, начатый после снятия, получает отказ"; AC-18.3 "администратор даёт право: инструмент появляется в наборе
  //   со следующего вызова модели"; AC-18.4 "права даёт роль, сотрудник запускает workflow, и агент вызывает инструмент из `run_code`: агенты
  //   workflow и скрипт получают те же инструменты и те же отказы, что главный чат". Design: DC-1, DC-2, DC-4; UC-2, UC-3, UC-E4 (the
  //   target-existence and duplicate rows); the Risks row "ошибка в правилах пропускает вызов без права".
  // Behavior: admin creates rights through the admin operations -> the employee's agents run (workers on, scripted model) -> the set offered to the
  //   model, the check at the call (direct, after confirmation, from `run_code`, from a workflow agent) and the changes made while agents run all
  //   answer from the grants of that moment -> fixture journal, `agent_tool_calls` / `agent_code_calls` rows and audit.
  // Steps (one story; literal expectations; the registry holds `backoffice` with a mutating tool `create_incident_note`, `logs` and `tracker`):
  //   1. DC-2 / UC-E4, before any right exists: `POST /api/admin/grants` for a deny to a role -> 422 `GRANT_INVALID`; a quota on a server right ->
  //      422 `GRANT_INVALID`; a right on tool `ghost_tool` of `backoffice` and on a model outside the catalogue -> 422 `GRANT_TARGET_UNKNOWN` both;
  //      the same personal right created twice -> 201 then 409 `GRANT_EXISTS`. The row count of `access_grants` after the table equals the count of the successful creations only (nothing half saved).
  //   2. Setup: role `sre` holds the right to server `backoffice`; Аня is in `sre` and has a personal deny of `create_incident_note`; Борис has
  //      nothing; Глеб has a role right to `logs` and a personal right on the one tool `list_tickets` of `tracker`.
  //   3. AC-16.1, AC-17.1, AC-16.2: the request the scripted model receives for Аня offers every `backoffice` tool except `create_incident_note`;
  //      Глеб's offers all `logs` tools and exactly `list_tickets` of `tracker`; Борис's offers no MCP tool.
  //   4. AC-18.1, DC-4, the doors: Аня's model asks `create_incident_note`; Борис's model asks a `backoffice` tool; Борис's `run_code` script calls
  //      the same tool; Аня starts a workflow whose agent asks `create_incident_note` and whose `run_code` script calls it -> every one of the five
  //      answers `no_access` (as a result of the call, the agent continues), the fixture journal is empty for them, and the audit holds exactly one
  //      `access_denied` (objectType `tool`, id `backoffice/create_incident_note`, the employee, no other field) per refusal - five, not more.
  //   5. After approval: Глеб's agent asks `list_tickets` of `tracker` marked as changing (the confirmation opens); before he approves, the admin
  //      deletes his personal right; he approves -> the call is refused `no_access`, the journal holds nothing, one `access_denied` is added.
  //   6. AC-18.2 / AC-18.3, no restart: Глеб's running agent has `logs` tools in its set; the admin deletes the role right to `logs` and the
  //      model, still holding the old set in its script, asks a `logs` tool -> `no_access`, journal unchanged; the admin gives Глебу a personal right
  //      to one `tracker` tool `get_ticket`; his next model call is offered `list_tickets` and `get_ticket` of `tracker` and no `logs` tool.
  // Catches: a deny that loses to a role right at one door only (the set, the call, or `run_code`); the rights read once when the set was built so
  //   a removed right still opens the call (and an approval that skips the check); a workflow agent or a script with its own looser rule than the
  //   main chat; a refusal that reaches the server or leaves zero or two audit rows; a grant for a tool or model that does not exist, or a
  //   duplicate, saved and then silently never matching.
  // @category: core-functionality
  // @dependency: AdminAccessController, AccessService, effectiveAccess, ToolRegistry, ToolRunner, run_code, workflow start, AuditLog, McpRegistry, runtime workers, scripted model, MCP fixture process, Postgres
  // @complexity: high
  it.todo('INT-1: tools are offered, run, confirmed and run from code only by the rights of that moment, and a refusal reaches no server and leaves exactly one audit record');

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2: a model call is made only with a verdict - at every place that calls a model
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-19.1 "администратор добавил модель с ценой и разрешил её сотруднику: вызов идёт, а его стоимость посчитана по этой цене"; AC-19.2
  //   "администратор поменял цену: вызовы до изменения посчитаны по старой цене, а после - по новой"; AC-19.3 "модели нет в каталоге: выбор
  //   отклоняется с причиной «модель не подключена»"; AC-20.1 "Ане разрешён только Haiku, чат запускает для неё агента на Sonnet: агент не
  //   запускается, а в историю родителя приходит отказ «модель не разрешена»"; AC-20.2 "модель главного чата не разрешена: ответа модели нет, а
  //   Аня видит, что модель ей не разрешена"; AC-20.3 "администратор снимает разрешение и агент делает следующий вызов: вызов не идёт, а агент
  //   получает статус «сбой» с причиной «модель не разрешена»"; AC-20.4 "выбор модели отклонён: в аудите запись с сотрудником, моделью и
  //   причиной"; AC-16.3 "нет ни ролей, ни личных прав: ответа модели нет, а сотрудник видит, что ему не разрешена ни одна модель"; AC-17.3 "роль
  //   разрешает модель, а у сотрудника личный запрет: выбор отклоняется". Design: DC-5, DC-6, DC-7, DC-4; UC-4, UC-5, UC-6, UC-E3.
  // Behavior: admin makes the catalogue and the rights -> agents of different employees call a model, start agents, fork, answer in the chat and
  //   make a title -> every place asks the verdict before the call -> `runtime_model_calls` rows, agent status and failure reason, results in the
  //   parent's history, audit, and the scripted model's call counter.
  // Steps (catalogue made through `POST /api/admin/models`: `A` at 1 USD input and 5 USD output per million tokens, `B` at 3 and 15, cache prices
  //   0; the scripted model's call counter is read before and after each step):
  //   1. AC-19.1 / AC-19.2: Аня is allowed A only; her agent calls A with 1000 input and 100 output tokens -> the row costs 0,0015 USD; the admin
  //      `PATCH`es A to 2 and 10 -> the next call of the same size costs 0,003 USD, and the first row still reads 0,0015.
  //   2. AC-20.1, AC-17.3, AC-19.3, AC-20.4: Аня's model runs `start_agent` on B, then on `anthropic/claude-not-in-catalogue`, then (after the
  //      admin gives her a personal deny of A while a role still allows it) on A -> three refusals as call results: `model_not_allowed` (B),
  //      `model_not_connected`, `model_not_allowed` (A); no child task exists; three `access_denied` rows (objectType `model`, the employee, the
  //      model, the reason); a fork or restart of an agent inherits its model and meets the same check at its next call.
  //   3. AC-16.3 / AC-20.2: Борис has nothing; Вера is allowed `anthropic/claude-sonnet-5-5` while the default model is Haiku. Each writes the first
  //      message of a new conversation -> no model call (counter unchanged), the chat is `failed`: Борис with `no_models_allowed`, Вера with
  //      `model_not_allowed`; the conversation view carries the reason the web maps to MC-11.
  //   4. AC-20.3, DC-5 mid-run: Дима's agent on B waits for a message; the admin removes B's right of his role; the next message makes it call
  //      B -> no call, agent `failed` with `model_not_allowed`, the parent gets one `child_finished` with the reason, one `access_denied`; a second
  //      agent of Димы on A: the admin `DELETE`s A from the catalogue -> its next call fails `model_not_connected`, and the rights on A are gone with it.
  //   5. DC-7 (the title is a model call too): Аня has no right to the default model but another model she may use is named at the start -> the
  //      title makes no model call, the conversation stays untitled, Аня sees no error; Борис's right to the default model has a quota already
  //      spent -> the same; `access_denied` rows exist for Аня. (The title's cost entering spend is chat INT-3 B, not repeated.)
  // Catches: a model call made without a verdict at one place - the title, the compaction call, the chat's first call, a forked or restarted agent
  //   that inherited its model, the first call after a right was removed; the cost taken from a cached or file price so a price change rewrites
  //   or misprices history (money); a refused start that still creates the child or loses the refusal from the parent's history; a missing audit
  //   row, or one per retry; a catalogue removal that leaves rights or running agents on a model that is gone.
  // @category: core-functionality
  // @dependency: AdminModelsController, AdminAccessController, AccessService, ModelClient, ModelStep, CompactionStep, start_agent, TitleService, TokenLedger, AuditLog, runtime workers, scripted model, Postgres
  // @complexity: high
  it.todo('INT-2: every model call - chat, agent start, running agent, title - is made only on a verdict, costs what the catalogue said before that call, and a refusal is recorded once');

  // ---------------------------------------------------------------------------------------------------------------
  // INT-3: quota - the call that reaches it is the last one, the pause is the platform's, and a raise or a refusal ends it before the answer
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-21.3 "расход ниже действующей квоты: вызов идёт сразу"; AC-21.4 "начался новый календарный месяц: расход против квоты считается с
  //   нуля"; AC-22.1 "расход достиг квоты: вызов не идёт, агент получает статус «ждёт решения по квоте», а Аня в беседе и в списке агентов видит
  //   модель, расход и квоту"; AC-22.2 "идут два вызова Sonnet, и квота исчерпана во время них: оба результата доходят, их стоимость входит в
  //   расход, а следующий вызов не начинается"; AC-22.3 "администратор поднимает квоту выше расхода: агент сам продолжает с того же места, и Ане не
  //   нужно ничего писать"; AC-22.4 "администратор отказывает: агент получает статус «сбой» с причиной «квота исчерпана», родитель получает
  //   уведомление"; AC-22.7 "один агент на паузе по Sonnet, а другой работает на Haiku: агент на Haiku работает без паузы"; AC-22.8 "агент на
  //   паузе, начинается новый месяц: агент сам продолжает"; AC-22.9 "пауза началась и закончилась: в аудите запись начала и запись конца с тем, как
  //   пауза кончилась"; AC-23.1 "Ане разрешены Haiku без квоты и Sonnet с квотой 100 $: видит обе модели и расход, у Sonnet - квоту и остаток, у
  //   Haiku - «без предела»"; AC-30.1 "агенты на паузе: список пауз - строка Ани с моделью, расходом, квотой, числом агентов и временем начала,
  //   без текста бесед"; AC-30.2 / AC-30.3 "поднял квоту / отказал из строки: агенты продолжают / получают «сбой», а строка пропадает"; AC-30.4
  //   "поменял предел ожидания: новая пауза кончается по новому пределу". Design: DC-8, DC-9, DC-13; UC-7, UC-8 (refuse, new month, limit), UC-10.
  // Behavior: the scripted calls of known size spend a personal quota to the cent -> the next call does not start and a `quota` decision opens
  //   -> the administrator lists the pauses, raises or refuses through the admin routes -> pauses end before the route answers -> the agents carry on
  //   on their own -> history, ledger, decisions, audit, `GET /api/access/models`.
  // Steps (A is 1 and 5 USD per million, B has a personal right without a quota; the limit is 24 h at the start):
  //   1. UC-7 setup: Аня has a personal right to A with quota 0,01 USD (spend 0) and to B without a quota; two of her agents on A each hold a call
  //      in flight (5000 input and 500 output tokens, 0,0075 USD each) on a latch, a third agent works on B, Аня sends a message to one agent on A.
  //   2. AC-21.3, AC-22.2: both calls were started (spend was 0 < 0,01); the latch is released, both results stand in the histories and spend reads
  //      0,015 USD; the next call of each agent on A is not started (the model's counter shows no new call), each agent is `awaiting_quota` and
  //      its view carries `quotaPause` {model A, month, spendUsd 0,015, quotaUsd 0,01, since, waitUntil = since + 24 h}; the agent on B keeps working
  //      and the quota-free right never pauses (AC-22.7); Аня's message is queued and not delivered; the audit holds one `quota_pause_started`
  //      per agent.
  //   3. AC-30.1: `GET /api/admin/quota-pauses` has one row: Аня, model A, spend 0,015, the effective quota with `grantId`, `agentCount` 2, `since`;
  //      it carries no conversation text.
  //   4. DC-9 / AC-30.4: the admin `PUT`s the limit to 2 h (`400 VALIDATION_FAILED` for 0 and for 721); a new agent of Ани on A starts a pause
  //      -> its `waitUntil` is `since + 2 h` while the two first pauses keep `since + 24 h` unchanged.
  //   5. AC-22.3, AC-30.2, DC-8: the admin `PATCH`es her personal quota on A to 1 USD -> when the 200 arrives, every `quota` decision of Ани is
  //      already closed with outcome `quota_raised` (read at once, before any wait); the agents continue by themselves, the queued message is
  //      delivered to the next step, the audit holds `quota_pause_ended` with `quota_raised` per pause (and no second one), the row is gone from
  //      the list. Raising it to a value below spend keeps the pauses open and the list shows the new quota.
  //   6. AC-22.4, AC-30.3: Борис's agent (a child of a parent agent) is on a pause on model C (priced like A, his personal quota on it 0,01 USD already spent); the admin `POST /api/admin/quota-pauses/refuse` ->
  //      `{ ended: 1 }`, the agent is `failed` with `quota_exhausted`, the parent has one `child_finished`, the audit holds `refused`; a second
  //      refusal -> `{ ended: 0 }`; an agent of Бориса that pauses on C afterwards is a new pause in the list.
  //   7. AC-21.4, AC-22.8: Вера's agent is on a pause on A; the ledger rows of her exhausted month are moved to the previous month and the
  //      recorded `month` of her pause is set to the previous month (time is set by rows) -> `quotaPauses.review()` closes it with `new_month`, her
  //      spend against the quota reads 0, and the agent continues.
  //   8. DC-13, AC-23.1, AC-21.1 wiring: Глеб has Haiku without a quota and Sonnet whose quota is the sum of two role quotas 50 + 20 and a personal
  //      30; spend on Sonnet 64,20 USD -> `GET /api/access/models` returns Haiku `quotaUsd` null and `remainingUsd` null, Sonnet quota 100 and
  //      remaining 35,80; after calls bring spend to 100 the answer holds Sonnet `exhausted` true with remaining 0, and Глеб's next Sonnet call
  //      starts a pause (the same sum and the same month rule); a model he is not allowed is absent.
  // Catches: the quota checked after the call or against a stale spend, so a pause starts one call late or never; in-flight calls lost or not
  //   counted; a pause that waits for the employee or for the next 60-second pass after an administrator's raise; a pause that never ends on a new
  //   month because the month is read in two places differently; a raise that resumes the agent twice, or an end audited twice or never; a limit
  //   change that rewrites running pauses; a refusal that leaves the agent paused or the parent unnotified; a page of the employee that says
  //   «Квота исчерпана» while the next call still goes (or the reverse).
  // @category: core-functionality
  // @dependency: AccessService, effectiveAccess, TokenLedger.monthSpendByModel, ModelClient, ModelStep, QuotaPauses, Decisions, AdminAccessController, MyAccessController, AuditLog, runtime workers, scripted model, Postgres
  // @complexity: high
  it.todo('INT-3: a quota reached by in-flight calls pauses the next call, a raise or a refusal ends the pause before the route answers, a new month ends it, and "Мой доступ" agrees with the check');
});
