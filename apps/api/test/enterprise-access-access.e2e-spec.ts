// enterprise-access / access - E2E skeletons (whole API process against real Postgres, workers on, scripted model, MCP fixture process)
// Design Doc: docs/features/enterprise-access/design-access.md (v1.1), Test Strategy UC-7 (end to end), UC-9 (restart half), Contract Definitions
//   «Runtime settings» (`seed:access`); PRD: docs/features/enterprise-access/prd.md
//   FR-19, FR-20, FR-21, FR-22 (AC-22.1, AC-22.3, AC-22.6, AC-22.9, AC-30.2), AC-23.1.
// Generated: 2026-11-15 | Budget Used: 2/2 E2E for the part (integration skeletons: apps/api/test/enterprise-access-access.int.e2e-spec.ts here,
//   the agents one in packages/agents/test, and the web one). Implementation timing: after the whole part is built (final phase).
// Test Type: End-to-End. Every case is `it.todo` - skeletons only.
//
// Why these two: E2E-1 is the part's main path - a quota reached by a real employee's real agent, the pause seen on the live stream, a process
//   restart in the middle, and the administrator's raise on another instance - the one thing the integration skeletons cannot hold (they run in one
//   process and read state over REST); E2E-2 is the developer's first run (`seed:access` + the `dev` role), which no integration skeleton starts and
//   which decides whether a fresh database answers any chat at all. Neither repeats an integration assertion: the rights at every door (API INT-1),
//   the model verdicts and cost by price (API INT-2), the pause's start, raise, refusal, new month and "Мой доступ" agreement (API INT-3), the
//   outcomes and the concurrent end (agents INT-4) and the texts (web INT-5) are not re-proven here. The disabled-employee stop is identity E2E-1
//   (adapted to `AccessGate`). The repository has no browser E2E tool; the browser part is the web skeleton plus the part's L1 browser checklist.
//
// Harness: `createTestApp({ workers: true, model, env })` as in agent-platform-chat.int.e2e-spec.ts and the identity / mcp-connect E2E files; the
//   process is started more than once on one database (identity E2E-2 harness) and a second instance runs beside it; the log is captured. Rights,
//   catalogue and quotas are made through the admin routes only (`addModel`, `grantTo` of `test/support/access.ts`). E2E-2 runs the `seed:mcp` and
//   `seed:access` scripts as child processes against the test database (the mcp-connect E2E-2 harness). Cases clean up their own rows; no case
//   depends on another.
//
// Adapted, not duplicated: enterprise-access-mcp-connect.e2e-spec.ts E2E-2 (the development employee's agent calls a seeded tool) now needs the `dev`
//   role of `seed:access` in place of `MCP_ACCESS_TABLE` `*`; it keeps the tool call, and E2E-2 below does not repeat it.

import { describe, it } from 'vitest';

describe('enterprise-access / access - E2E (full API process + real Postgres)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // E2E-1: the quota is reached, the process restarts, the administrator raises it - and the answer arrives on its own
  // ---------------------------------------------------------------------------------------------------------------
  // User Journey: the administrator makes a model, a role with a small quota and puts Аня in it -> Аня's chat answers twice, the third call finds
  //   the quota spent -> the live stream shows the pause -> Аня writes one more message, the process is restarted, a second instance starts beside
  //   it -> the administrator on the second instance raises the role's quota from the pause list -> Аня's stream, reconnected, gets the end of the pause
  //   and the answer -> "Мой доступ" and the audit agree.
  // AC: AC-22.1 "расход достиг квоты: вызов не идёт, агент получает статус «ждёт решения по квоте», а Аня видит модель, расход и квоту"; AC-22.6
  //   "агент на паузе, сервер перезапускают: агент по-прежнему ждёт решения по квоте"; AC-22.3 "администратор поднимает квоту её роли выше расхода:
  //   агент сам продолжает работу с того же места, и Ане не нужно ничего писать"; AC-30.2 "изменение сохранено: агенты продолжают, а строка
  //   пропадает"; AC-22.9 "в аудите запись начала и запись конца"; AC-23.1 "расход за месяц и остаток". Design: DC-8, DC-12; UC-7 (end to end),
  //   UC-9 (restart half).
  // Verification items:
  //   - the journey runs through HTTP only (admin cookie, Аня's cookie, `GET /api/events` open on Аня's session): `POST /api/admin/models` (model
  //     priced 1 and 5 USD per million), a role through the identity routes with a right to the model and quota 0,01 USD, Аня added to the
  //     role; Аня's first message and the next make two scripted calls of 5000 input and 500 output tokens (0,0075 USD each); the third call is not
  //     made (the scripted model's counter stays at 2)
  //   - the stream delivers the chat's status `awaiting_quota`, the `quota_paused` event and the `quotaPause` of the view (model name, month, spend
  //     0,015 USD, quota 0,01 USD, `waitUntil`) with no reload; a message Аня sends during the pause is accepted into the queue
  //   - the process is stopped and started again on the same database (workers on), and a second instance is started beside it: both start without
  //     error, the first pass of the review loop leaves the unchanged pause open (the chat is still `awaiting_quota`, one `quota` decision, the same
  //     `waitUntil`, no end entry in the audit), Аня's cookie is still valid and her reconnected stream reads the same status
  //   - on the second instance the administrator lists the pauses (one row: Аня, the model, 0,015 USD, the quota, 1 agent), raises the role's quota to
  //     1 USD -> the response arrives with the pause already closed; Аня's stream receives `quota_pause_ended` with `quota_raised`, the answer's text deltas
  //     for the first message and the queued one, and the chat ends `completed` with her text answered once each; the row is gone from the list
  //   - `GET /api/access/models` for Аня: spend 0,015 USD plus the two answers' cost, the quota 1 USD and the remaining amount computed from them;
  //     the audit holds exactly one `quota_pause_started` and one `quota_pause_ended` (`quota_raised`) for the chat and the administrator's
  //     `admin_change` rows with before and after; no row holds the text of the conversation
  // Catches: the pause lost, resumed or closed by the first pass of a restarted process; two instances both resuming the chat, so the answer arrives
  //   twice; the pause reaching the web only through a reload; an application wired so that the real `AccessService` is used for sets and calls
  //   but the pause loop, the review after an administrator's change or the stream's `awaiting_quota` is missing in the running process (each
  //   passes when its part is called directly); a raised quota that needs Аня to write again; a queued message lost across the restart.
  // @category: e2e
  // @dependency: full-system (AccessModule, AccessService, AdminAccessController, MyAccessController, QuotaPauses and its WorkerLoop, Decisions, LiveHub stream, SessionGuard, AuditLog, runtime workers on two instances, process start/stop, scripted model)
  // @complexity: high
  it.todo('E2E-1: after the quota is reached the stream shows the pause, a restart and a second instance leave it as it was, and the administrator\'s raise makes the answer arrive once without the employee doing anything');

  // ---------------------------------------------------------------------------------------------------------------
  // E2E-2: the developer's first run - `seed:access` and the `dev` role
  // ---------------------------------------------------------------------------------------------------------------
  // User Journey: developer has a clean development database with the fixture process and `seed:mcp` done -> runs `seed:access` -> signs in as a
  //   development employee -> sees no models -> an administrator gives the `dev` role from the panel routes -> the first chat message gets an answer.
  // AC: AC-19.1 "модель добавлена с ценой и разрешена: вызов идёт, стоимость по этой цене"; the Contract Definitions
  //   rule «`seed:access` - каталог из `anthropic/claude-haiku-5-5` и `anthropic/claude-sonnet-5-5` с ценами удалённого файла и роль `dev` с
  //   правами на серверы `seed:mcp` и на обе модели без квоты»; AC-15.1 (its access half, the tool call itself is mcp-connect E2E-2).
  //   Design: Contract Definitions («Runtime settings»); the deleted `model-prices.json` as the
  //   source of the literal prices.
  // Verification items:
  //   - `seed:access` exits 0 against a database where `seed:mcp` already ran, prints no secret value, and the catalogue (`GET /api/admin/models`)
  //     holds `anthropic/claude-haiku-5-5` at 0,1 / 0,5 / 0,125 / 0,01 USD per million with the long-context entry above 100 000 input tokens at
  //     0,5 / 2,5 / 0,625 / 0,05, and `anthropic/claude-sonnet-5-5` at 2 / 10 / 2,5 / 0,1 with no long-context entry
  //   - role `dev` holds a right to each server `seed:mcp` registered (`logs`, `tracker`, `backoffice`) and to both models, with `quotaUsd` null on every
  //     model right (`GET /api/admin/grants?roleId=`); the script created no right for any employee and gave no employee the role
  //   - running the script again changes nothing and does not fail (one catalogue row and one role right each, no duplicate)
  //   - a development employee signs in (dev sign-in): `GET /api/access/models` is `[]`; the administrator assigns `dev` through the role routes of
  //     `identity` -> the list holds both models without a quota; the employee's first message to the scripted model (10 000 input and 1000 output
  //     tokens on Haiku) is answered, and its ledger row costs 0,0015 USD (the price of the catalogue row, not of any file); `GET /spend` shows the same
  // Catches: a seed script that fails or duplicates on the second run; prices that drifted from the deleted file so every development cost differs
  //   from the numbers the team knows; a `dev` role missing a server or a model so the developer's first run answers with no tool or no model; a script
  //   that hands rights to named employees so a development database behaves unlike production.
  // @category: e2e
  // @dependency: full-system (seed:access script, seed:mcp script, AdminModelsController, AdminAccessController, AccessService, TokenLedger, SessionGuard dev sign-in, runtime workers, scripted model)
  // @complexity: medium
  it.todo('E2E-2: seed:access on a database after seed:mcp makes the catalogue with the old prices and the dev role, is safe to run twice, and the development employee gets an answer priced from the catalogue once the role is assigned');
});
