// enterprise-access / access - API integration skeletons (real AppModule + real Postgres + MCP fixture process, workers on, scripted model)
// Design Doc: docs/features/enterprise-access/design-access.md (v1.6, Approved), Test Strategy UC-1 (= INT-1), UC-2 (= INT-2 and INT-3), UC-3 (proven
//   by identity INT-2, see below), plus the one `GRANT_TARGET_UNKNOWN` / `GRANT_EXISTS` step of UC-7 that needs the registry and the database;
//   PRD: docs/features/enterprise-access/prd.md (v2.4) FR-16..FR-23 (AC-16.1, AC-16.2, AC-16.3, AC-17.1, AC-17.2, AC-17.3, AC-18.1..18.4,
//   AC-19.1..19.3, AC-20.1..20.4, AC-21.1, AC-21.3, AC-22.1, AC-22.2, AC-22.3, AC-22.7, AC-22.11, AC-23.1).
// Budget Used: 3/3 integration skeletons for the part (INT-1, INT-2, INT-3), all in this file. 0 E2E: the Test Strategy names none. 0 web
//   skeletons: the part's screens (the «Модели и расход» section, the refusal and failure texts) are a unit table (UC-8), not an integration test.
// Test Type: Integration. Every case is `it.todo` - skeletons only, no implementation.
//
// Harness (follows apps/api/test/support/*, enterprise-access-identity.int.e2e-spec.ts and enterprise-access-mcp-connect.int.e2e-spec.ts): one
//   `createTestApp({ workers: true, captureLog: true, mcpServers: [], defaultModel })` against the docker-compose Postgres, the real AppModule with
//   the real SessionGuard and the real `AccessService` behind `AccessGate`. Employees are written by `insertEmployee` and sign in with
//   `signInWithPassword`; the administrator is `seedSuperAdmin`; roles and their members go through `POST /api/admin/roles` and
//   `PUT /api/admin/users/:id/roles/:roleId` of `identity`. Only `AGENT_TURN_CLIENT` is the scripted model (it records, per request, the tool names
//   it was offered, and counts calls; the token counts of every scripted call are chosen by the test, so spend is known to the cent). MCP is the
//   `packages/mcp-fixture` PROCESS over HTTP, registered by the test through the `mcp-connect` admin operations under the run's names
//   (`runName`; shared-token servers `logs` and `tracker`, and `backoffice` with the mutating tool `create_incident_note`); its journal is the
//   proof that a server received nothing. The catalogue, rights and quotas are made ONLY through the admin operations of this design
//   (`POST /api/admin/models`, `POST /api/admin/grants`, `PATCH /api/admin/grants/:id`), so those routes are part of every setup. Time is never faked.
//   Models are named by the run (`runModel('a')`, a form `anthropic/<name>`), never the developer's real catalogue rows, and the chat's default
//   model of the app is one of them. Every case uses its own employees, roles and models, so rows of one case never meet another's; a case deletes
//   what it made in `afterAll` (users, roles, models - rights go with them by cascade - and the run's servers) and writes no setting that outlives
//   the file. Responses are parsed with `@agent-os/contracts` schemas.
//   Support the implementation tasks add (not skeletons):
//   - `test/support/access.ts`: `runModel(base)`; `addModel(admin, { id, prices })`, `grantTo(admin, holder, { effect, target, quotaUsd? })` and
//     `removeRunRows(pool, ...)` over the admin routes and the pool; `spendOf(pool, ownerId, model)` that reads `runtime_model_calls` for the cost
//     assertions; `auditOf(pool, { kind, objectType, ... })` that reads `access_denied` rows by object type (the kind is shared with the
//     administrator-route refusals of identity, so rows of tools and models are filtered by `objectType`).
//   - `createTestApp`: the `mcpAccess` option, `MCP_ACCESS_TABLE` and the price file are deleted; a `defaultModel` option sets `AGENT_DEFAULT_MODEL`
//     for the boot only (restored by `setEnv`, as `MCP_ACCESS_TABLE` is today), so no case writes the developer's environment or catalogue.
//   - A test workflow template whose agent definition names the `backoffice` server and whose agent runs a model script and a `run_code` script,
//     started by `start_workflow` of the employee's chat (INT-1 step 4); `packages/workflows` test support is the model for it.
//   - A latch around a scripted model call (the scripted model's `hold`/latch of the existing chat suite) so two calls stay in flight (INT-3).
// Mock boundary: the model only. Do NOT mock the database, `AccessService`, `effectiveAccess`, `IdentityDirectory`, the fixture process, `TokenLedger`.
//
// Proven elsewhere, not repeated here:
//   - `owner_disabled` (UC-3, DC-3, AC-07.2): identity INT-2 row 5 (apps/api/test/enterprise-access-identity.int.e2e-spec.ts) - the blocked
//       employee's agent ends `failed` with `owner_disabled` at its next model or tool call, and no call is made after the block. It passes through
//       the real application, so after this part it runs through `AccessService`; that file is ADAPTED by the implementation task (its
//       `IdentityOwnerGate` check of an unknown owner becomes `AccessGate.tools(unknownOwner)` answering `owner_disabled`; the assertions stay).
//       The inside of a `run_code` script for a refused owner is mcp-connect INT-2 row 6 (adapted the same way: its `ownerGate` double becomes an
//       `AccessGate` double). The verdict ORDER (disabled employee first) is the unit table of UC-5.
//   - `no_access` for an employee with NO right on a server, at every door: mcp-connect INT-1 row 6 and agent-platform-agents INT-3 A (adapted to
//       the gate double). INT-1 here starts from tool-level rows - a personal deny, a personal right on one tool, a removal at run time, a workflow.
//   - NFR-03 for this part's routes (`/api/admin/...`, `GET /api/access/models`): the route walk of identity INT-1 takes the new routes from the
//       router.
//   - The cost of a conversation title entering spend: agent-platform-chat INT-3 B (adapted: its employee gets a right to the default model
//       through `grantTo`). Spend endpoint `GET /spend`: agent-platform-chat INT-2 E (adapted: the model's price comes from `addModel`).
//
// `provenAt: unit` (tables next to the code, not skeletons - a rule never gets a second proof here):
//   - UC-4 `apps/api/src/access/effective-access.spec.ts`, one table over `effectiveAccess`: AC-16.1, AC-16.2, AC-17.1, AC-17.2, AC-17.3, AC-21.1
//       (quotas 50 + 20 + personal 30 = 100), AC-21.2, AC-21.5 (one grant without a quota removes the limit, also when added later), DC-1 (a tool
//       absent from the registry list gives nothing).
//   - UC-5 `apps/api/src/access/access.service.spec.ts`, the verdict order table: AC-16.3 (`no_models_allowed`), AC-20.2, AC-21.4 (prior-month spend
//       does not count), `owner_disabled` -> `model_not_connected` -> `model_not_allowed` / `no_models_allowed` -> `quota_exhausted` -> `allowed`
//       with the catalogue price; spend equal to the quota is exhausted, one cent below is not.
//   - UC-6 `model-client.spec.ts`: DC-7 (the title's `completeText` makes no call and calls the hook once on a refusal), verdict `allowed` passes
//       the price to `TokenLedger.record`, provider retries do not ask again.
//   - UC-7 `grant-rules.spec.ts`: the `GRANT_INVALID` rows (a deny for a role; a quota on a server or tool right; a quota outside 0,01..1 000 000
//       or with sub-cent digits). The `GRANT_TARGET_UNKNOWN` and `GRANT_EXISTS` rows need the registry, the catalogue and the unique index, so
//       they are one step of INT-1.
//   - UC-8 web tables next to the code: reason -> text (MC-10, MC-11, MC-14), `MyModels` row -> cell texts (MA-02): AC-20.2, AC-22.1, AC-23.1 as text.
//   - `packages/agents/src/model/model-choice.spec.ts` (no prices, the `unknown_model` rows deleted), `tool-gate.spec.ts` (the refusal reason
//       becomes `model_not_connected` / `model_not_allowed`), `packages/runtime` `monthOf` and `monthSpendByModel` tables; `model-cost.spec.ts`
//       loses the `parseModelPrices` rows, `callCostUsd` rows stay.
//
// Not automated: NFR-04 (the cost of the check) - UC-N1 is an on-demand measuring script, outside the suite (a slow machine must not turn the
//   suite red); `seed:access` on a clean development database - a developer tool, run by hand as `seed:mcp` is (mcp-connect AC-15.1).

import { describe, it } from 'vitest';

describe('enterprise-access / access - API integration (real AppModule + real Postgres + MCP fixture process)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-1: a tool is offered, called, confirmed and run from code only by the rights of that moment
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-16.1 "роль «SRE» имеет право на Sentry MCP, а Аня в этой роли и подключила аккаунт, when её агент работает, then ему доступны все
  //   инструменты Sentry"; AC-16.2 "у сотрудника нет права на сервер, но есть личное право на один его инструмент: из этого сервера ему доступен
  //   только этот инструмент"; AC-17.1 "роль даёт право на сервер, а у сотрудника личный запрет на один изменяющий инструмент этого сервера:
  //   доступны все инструменты сервера, кроме запрещённого, а вызов запрещённого получает отказ по правам"; AC-17.2 "личный запрет сервера и личное
  //   право на его инструмент: ни один инструмент сервера ему не доступен"; AC-18.1 "у сотрудника нет права на инструмент, а модель его агента всё
  //   равно просит этот инструмент: MCP-сервер не получает ни одного вызова, агент получает отказ, а в аудите - ровно одна запись «отказ по
  //   правам»"; AC-18.2 "агент работает, администратор снимает право: инструмента нет в наборе со следующего вызова модели, а вызов, начатый
  //   после снятия, получает отказ"; AC-18.3 "администратор даёт право: инструмент появляется в наборе со следующего вызова модели"; AC-18.4 "права
  //   сотруднику даёт роль, он запускает workflow и агент вызывает инструмент из скрипта `run_code`: агенты workflow и скрипт получают те же
  //   инструменты и те же отказы, что главный чат". Design: DC-1, DC-2, DC-4 (the tool half); UC-1, and the target-existence and duplicate rows of UC-7.
  // Behavior: the administrator makes rights through the admin operations -> the employees' agents run (workers on, scripted model) -> the set offered
  //   to the model, the check at the call (direct, after confirmation, from `run_code`, from a workflow agent) and the changes made while agents run all
  //   answer from the rights of that moment -> the fixture journal, `agent_tool_calls` / `agent_code_calls` rows and the audit.
  // Steps (one story, literal expectations; the registry holds `backoffice` with the mutating tool `create_incident_note` and the read tools
  //   `get_order`, `search_orders`, `logs` with `aggregate_logs`, `get_trace`, `search_logs`, and `tracker` with `search_tickets`; shared-token servers,
  //   so no account of an employee is involved):
  //   1. DC-2, before any right exists: `POST /api/admin/grants` for a deny to a role -> 422 `GRANT_INVALID`; a quota on a server right -> 422
  //      `GRANT_INVALID`; a right on tool `ghost_tool` of `backoffice` and a right on a model outside the catalogue -> 422 `GRANT_TARGET_UNKNOWN`
  //      both; the same personal right created twice -> 201 then 409 `GRANT_EXISTS`. The `access_grants` count after the step equals the
  //      successful creations only (nothing half saved). The step removes its one right.
  //   2. Setup: role `sre` holds the right to server `backoffice`; Аня is in `sre` and has a personal deny of `create_incident_note`; Борис has a
  //      personal right on the tool `logs/get_trace`, a personal deny of the server `logs`, and a personal right on the one tool
  //      `tracker/search_tickets` with no right on the server; Глеб has a role right on `logs` and a personal right on the mutating tool
  //      `backoffice/create_incident_note`.
  //   3. AC-16.1, AC-17.1, AC-16.2, AC-17.2: the request the scripted model receives for Аня offers `run_code` and every `backoffice` tool except
  //      `create_incident_note`; Борис's offers `run_code` and exactly `tracker/search_tickets` (the deny of `logs` closes `get_trace`); Глеб's offers
  //      all `logs` tools and `create_incident_note`.
  //   4. AC-18.1, AC-18.4, DC-4, the doors: Аня's model asks `create_incident_note`; Борис's model asks `get_trace` of `logs`; Борис's `run_code`
  //      script calls the same tool; Аня starts a workflow whose agent asks `create_incident_note` and whose `run_code` script calls it -> every one
  //      of the five answers `no_access` (as the result of the call, the agent continues), the fixture journal holds no call for them, and the audit holds
  //      exactly one `access_denied` (objectType `tool`, id `<server>/<tool>`, the employee, the reason `no_access`) per refusal - five, not more. The
  //      workflow agent's set is the same as Аня's chat set. Борис's allowed `search_tickets` call reaches the fixture once (the check lets the
  //      right through).
  //   5. After approval: Глеб's agent asks `create_incident_note` (the call changes data, so the confirmation opens); before he approves, the administrator
  //      deletes his personal right; he approves -> the call is refused `no_access`, the journal has no `create_incident_note`, and one
  //      `access_denied` is added.
  //   6. AC-18.2 / AC-18.3, no restart: Глеб's running agent has the `logs` tools in its set; the administrator deletes the role right on `logs` and the
  //      model, still holding the old set in its script, asks a `logs` tool -> `no_access`, the journal unchanged; the administrator gives Глебу a personal
  //      right on the one tool `backoffice/get_order`; his next model call is offered `get_order` and no `logs` tool.
  // Catches: a deny that loses to a role right at one door only (the set, the call, `run_code`, or a workflow agent); the rights read once when the
  //   set was built, so a removed right still opens the call, or an approval that skips the check; a workflow agent or a script with its own looser rule
  //   than the main chat; a refusal that reaches the server or leaves zero or two audit rows; a grant for a tool or model that does not exist, or a
  //   duplicate, saved and then silently never matching.
  // @category: core-functionality
  // @dependency: AdminAccessController, AccessService, effectiveAccess, ToolRegistry, ToolRunner, run_code, start_workflow, AuditLog, McpRegistry, runtime workers, scripted model, MCP fixture process, Postgres
  // @complexity: high
  it.todo(
    'INT-1: tools are offered, run, confirmed and run from code or a workflow only by the rights of that moment, a deny wins at every door, and a refusal reaches no server and leaves exactly one audit record',
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2: a model call is made only on a verdict, at every place that starts one, and costs the price read before it
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-19.1 "администратор добавил модель с ценой и разрешил её сотруднику: вызов идёт, а его стоимость посчитана по этой цене"; AC-19.2
  //   "администратор поменял цену: вызовы до изменения посчитаны по старой цене, а после - по новой"; AC-19.3 "модели нет в каталоге: выбор
  //   отклоняется с причиной «модель не подключена»"; AC-17.3 "роль разрешает модель, а у сотрудника личный запрет этой модели: выбор отклоняется";
  //   AC-20.1 "Ане разрешён только Haiku, чат запускает для неё агента на Sonnet: агент не запускается, а в историю родителя приходит отказ «модель
  //   не разрешена: Sonnet»"; AC-20.3 "агент работает на модели, администратор снимает разрешение и агент делает следующий вызов: вызов не идёт, а
  //   агент получает статус «сбой» с причиной «модель не разрешена»"; AC-20.4 "выбор модели отклонён: в аудите есть запись с сотрудником, моделью и
  //   причиной"; AC-16.3 / AC-20.2 (the first-call half, the verdict itself is the unit table of UC-5) "у сотрудника нет ни ролей, ни личных
  //   прав, он пишет в чат: ответа модели нет, а сотрудник видит, что ему не разрешена ни одна модель". Design: KD-4, DC-4 (the model half), DC-5,
  //   DC-6; UC-2 (the model rights half).
  // Behavior: the administrator makes the catalogue and the rights -> agents of different employees call a model, start agents and answer in the chat
  //   -> every place asks the verdict before the call -> `runtime_model_calls` rows, the agent's status and failure reason, results in the parent's
  //   history, the audit, and the scripted model's call counter (read before and after each step).
  // Steps (catalogue made through `POST /api/admin/models`: `A` at 1 USD input and 5 USD output per million tokens, `B` at 3 and 15, cache prices 0; the
  //   app's default model is `A`):
  //   1. AC-19.1 / AC-19.2: Аня is allowed A by a role; her agent calls A with 1000 input and 100 output tokens -> the ledger row costs 0,0015 USD;
  //      the administrator `PATCH`es A to 2 and 10 -> the next call of the same size costs 0,003 USD and the first row still reads 0,0015.
  //   2. AC-20.1, AC-19.3, AC-17.3, AC-20.4: Аня's model runs `start_agent` on B (not allowed to her), then on `anthropic/<run>-not-in-catalogue`, then
  //      (after the administrator gives her a personal deny of A while the role still allows it) on A -> three refusals as call results in the parent's
  //      history, `model_not_allowed` (B), `model_not_connected`, `model_not_allowed` (A); no child task exists; three `access_denied` rows (objectType
  //      `model`, the employee, the model, the reason), one per refusal.
  //   3. AC-16.3 / AC-20.2, the main chat's first call (`sessions.start` checks nothing, KD-4): Борис has no role and no right and writes the first message
  //      of a new conversation -> no model call (the counter unchanged), the root agent is `failed` with `no_models_allowed`, the conversation view carries
  //      that reason, one `access_denied` row exists for him.
  //   4. AC-20.3, DC-5, a change at run time: Дима's agent on B waits for a message; the administrator deletes the role right on B; the next message makes it
  //      call B -> no call, the agent is `failed` with `model_not_allowed`, its parent gets one `child_finished` with the reason, one `access_denied`;
  //      a second agent of Димы on A (allowed): the administrator `DELETE`s A from the catalogue -> its next call fails `model_not_connected` (the rights
  //      on A went with the model), and the same for a new `start_agent` on A.
  // Catches: a model call made without a verdict at one place - the chat's first call, a `start_agent` start, the first call after a right was
  //   removed, a call on a model that left the catalogue; the cost taken from a cached or file price, so a price change rewrites or misprices history
  //   (money); a refused start that still creates the child or loses the refusal from the parent's history; a missing audit row, or one per retry; a
  //   catalogue removal that leaves rights or running agents on a model that is gone; a personal deny of a model that loses to the role's right.
  // @category: core-functionality
  // @dependency: AdminModelsController, AdminAccessController, AccessService, ModelClient, ModelStep, start_agent, TokenLedger, AuditLog, runtime workers, scripted model, Postgres
  // @complexity: high
  it.todo(
    'INT-2: every model call - chat first call, agent start, running agent - is made only on a verdict, costs what the catalogue said before that call, and a refusal is recorded once',
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-3: money - quotas add up across roles and personal rights, the call that reaches the quota is the last one, continuation after a raise
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-21.1 (the wiring of the sum, the arithmetic is the unit table of UC-4) "у роли квота на Sonnet, лично у Ани тоже, Аня в роли: её действующая
  //   квота - сумма"; AC-21.3 "расход ниже действующей квоты: вызов идёт сразу"; AC-22.1 "расход достиг квоты: вызов не идёт, агент получает статус
  //   «сбой» с причиной «квота исчерпана», Аня видит модель, свой расход и квоту за месяц, а в аудите появляется запись"; AC-22.2 "идут два вызова, и
  //   квота исчерпана во время них: их стоимость входит в расход, а следующий вызов не начинается"; AC-22.3 "агент закончился сбоем по квоте,
  //   администратор поднял квоту выше расхода и Аня пишет ему: агент продолжает работу с того места, где закончился"; AC-22.7 "агент на Sonnet
  //   закончился сбоем по квоте, а другой агент той же беседы работает на Haiku в пределах квоты: он продолжает работу"; AC-22.11 "квота всё ещё
  //   исчерпана, Аня пишет агенту: ответа модели нет, и Аня снова видит причину «квота исчерпана»"; AC-23.1 "Ане разрешены Haiku без квоты и Sonnet с
  //   квотой: видит обе модели и расход за месяц на каждую, у Sonnet - квоту и остаток, а у Haiku - «без предела»". Design: KD-5, DC-3 (the quota
  //   end), DC-8, DC-9; UC-2 (the money half).
  // Behavior: scripted calls of known size spend a quota to the cent -> the next call of the agent that needs the exhausted model does not start and
  //   the agent ends `failed` with `quota_exhausted` -> the employee's own message after a raise continues the conversation -> history, ledger, audit,
  //   `GET /api/access/models`.
  // Steps (`A` is 1 and 5 USD per million tokens and the app's default model, `B` is 3 and 15; Аня's quota on A is two rights, a role `duty` with
  //   0,004 USD and a personal one with 0,006 USD, so the sum is 0,01 USD; her right on B has no quota; Борис has a personal right on A with its own
  //   quota 0,01 USD; the call that stays in flight is 5000 input and 500 output tokens = 0,0075 USD):
  //   1. AC-21.1, AC-23.1, DC-9, before any call: `GET /api/access/models` for Аня parses with `MyModels`: A `quotaUsd` 0,01 (the sum of the role's and
  //      the personal grant), `spentUsd` 0, `remainingUsd` 0,01, `exhausted` false; B `quotaUsd` and `remainingUsd` null (without a limit), `exhausted`
  //      false; a model she is not allowed is absent from the list.
  //   2. AC-21.3, AC-22.2: Аня's main chat and a background agent of the same conversation, both on A, each hold a call in flight on a latch (spend was
  //      0 < 0,01, so both calls start); an agent of Ани in another conversation works on B. The latch is released -> both results stand in the
  //      histories and her spend on A reads 0,015 USD; the next model call of each agent on A is not made (the counter shows no new call).
  //   3. AC-22.1, AC-22.7, KD-5: the main chat and the background agent are each `failed` with `quota_exhausted`; the background agent's parent has one
  //      `child_finished` with the reason; the conversation view carries the reason; the audit holds one `access_denied` per ended agent (objectType
  //      `model`, the model, the reason `quota_exhausted`); the agent on B takes its next step and finishes its turn. `GET /api/access/models`: A
  //      `spentUsd` 0,015, `remainingUsd` 0, `exhausted` true; B unchanged.
  //   4. Isolation between employees: Борис's agent on A works and finishes while Аня's A is exhausted; his `GET /api/access/models` reads A `spentUsd` 0,
  //      `remainingUsd` 0,01 (Аня's spend is not his), and nothing of his is refused.
  //   5. AC-22.11, DC-9: Аня writes to the failed main chat while the quota is still exhausted -> no model call (the counter unchanged), the chat is
  //      `failed` with `quota_exhausted` again, one more `access_denied`; the page and the check agree - the same row said `exhausted` true.
  //   6. AC-22.3: the administrator `PATCH`es the personal grant's quota to 1 USD (the sum is 1,004) -> the response is 200 and the row reads the new
  //      quota; Аня writes to the main chat -> the model is called, the answer arrives and the chat ends its turn as after any message; her spend on A
  //      is 0,015 USD plus the cost of that call and `GET /api/access/models` reads `exhausted` false with the remaining amount from those numbers.
  // Catches: the quota checked against a stale or per-process spend, so an agent runs one call too many or ends one call early; the in-flight calls
  //   lost from the spend or blocked by the first one's end; a quota that counts only the personal grant or only the role's; spend summed over all
  //   employees so Борис is stopped by Аня's calls (isolation, money); an agent on another model ended with no reason or ended by an exhausted model
  //   it never calls; a continuation after a raise that does not happen, or a message sent while the quota stays exhausted that makes a model call;
  //   a page of the employee that says «Квота исчерпана» while the next call still goes (or the reverse).
  // @category: core-functionality
  // @dependency: AccessService, effectiveAccess, TokenLedger.monthSpendByModel, ModelClient, ModelStep, AdminAccessController, MyAccessController, AuditLog, runtime workers, scripted model, Postgres
  // @complexity: high
  it.todo(
    'INT-3: quotas of a role and of the employee add up, calls in flight finish and count, the next call of an exhausted model ends that agent with quota_exhausted, other agents and other employees go on, and a message after a raise continues the conversation',
  );
});
