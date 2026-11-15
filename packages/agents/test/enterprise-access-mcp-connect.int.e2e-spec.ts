// enterprise-access / mcp-connect - agents-package integration skeletons (real Postgres, real `createAgents`, MCP fixture process over HTTP)
// Design Doc: docs/features/enterprise-access/design-mcp-connect.md (v1.1), Test Strategy UC-1, UC-2 (call half), UC-3, UC-4, UC-E4 (new rows only);
//   PRD: docs/features/enterprise-access/prd.md FR-12, FR-13, FR-14 (AC-12.3..12.5, AC-13.1..13.3, AC-14.2, AC-14.4, AC-14.5).
// Generated: 2026-11-15 | Budget Used: 2 integration skeletons here + 2 API integration skeletons
//   (apps/api/test/enterprise-access-mcp-connect.int.e2e-spec.ts) + 1 web integration skeleton
//   (apps/web/src/components/shell/enterprise-access-mcp-connect.int.test.tsx) = 5/5 for the part (over the 3-test default, at the
//   5-test ceiling: each skeleton names a defect no other test catches, see "Catches"), 2 E2E in apps/api/test/enterprise-access-mcp-connect.e2e-spec.ts.
// Test Type: Integration. Every case is `it.todo` - skeletons only, no implementation.
//
// Harness (follows packages/agents/test/support/agentsHarness.ts): the package's own `createRuntime` + `createAgents` over their own pool, no
//   `apps/api`; a second instance ("the other server") is a second harness over the same database. Only the model (`createScriptedModel`) is a
//   double. Postgres, the runtime, `ToolRegistry`, `McpRegistry`, `McpAccounts`, `McpClient`, `SecretBox` and the MCP servers are real.
//   MCP servers are the `packages/mcp-fixture` PROCESS over HTTP with its own authorization server (KD-7); the journal of the fixture
//   (source, tool, account of the token) is the proof of "the server received nothing" and of "the call came with Anya's account".
//   Support the implementation tasks add (not skeletons): `agentsHarness` registers fixture sources through `Agents.mcp.register` instead of
//   `fixtureServersFile` and takes `secretBox` and `mcpRedirectUrl`; a `fixtureProcess()` helper that starts/stops the process and exposes the
//   authorization-server controls named in KD-7 (token lifetime, revoke refresh tokens of an account, refresh counter, add a tool); a
//   `playBrowser(authorizeUrl)` helper that GETs the authorization URL without following redirects and hands `code`/`state`/`iss` to
//   `Agents.mcp.finishConnect(ownerId, ...)`; `connectAccount(harness, ownerId, server)` built from them.
// Mock boundary: the model only. Do NOT mock the fixture, the database, the clock source (token expiry is set by moving the account row's
//   `expires_at`), or `SecretBox`.
//
// Replaced / adapted by this design (not duplicated here):
//   - packages/agents/test/agent-platform-agents.int.e2e-spec.ts INT-3 A (refusal reasons, "server never reached", an allowed owner succeeds)
//       and INT-3 F (a failing server becomes `transport_failure`): KEPT as the proof for shared-token servers and for the transport faults;
//       adapted to the registry + HTTP fixture harness, `crash_process` replaced by `drop_connection` (KD-7). This file adds only the rows
//       they cannot hold: the oauth-mode refusal for an employee without the right (INT-1 step 5) and the 401 outcomes (INT-2).
//   - packages/agents/test/code-execution.int.e2e-spec.ts: INT-3 row A (refusals from `run_code`) is adapted to the same harness and is the
//       proof that the `run_code` path asks the same function; INT-1 row D (a server credential in the script's env masked in the run log)
//       loses its premise - `secretValuesOf` now carries only `ANTHROPIC_API_KEY` (Security Considerations) - and is rewritten or dropped by
//       the implementation task, not duplicated here.
//   - packages/agents/src/config.spec.ts: the `MCP_SERVERS_FILE` rows are deleted with the loader; `checkCatalog` keeps only the name-form rows.
//   - stdio transport, `createMcpClients` cache, `McpStartupError`, `fixtureServersFile` and their tests are deleted with the code.
//
// `provenAt: unit` (small tables next to the code, not skeletons): the scheme check of a server or authorization-server address (`MCP_SERVER_CHECK_FAILED`
//   reason `insecure_url`: `http` refused outside `development`/`test`, `https` always allowed; a table in the registry's verification unit test);
//   the error-to-outcome map of `McpClient`/`mcp-failure` (`UnauthorizedError` and `ClientHttpAuthentication` -> `auth_required` for oauth and
//   `transport_failure`/`unauthorized` for shared; fetch failure -> `connection_lost`; request timeout or step signal -> `timeout`; unreadable
//   reply -> `protocol_error`) in `packages/agents/src/mcp/mcp-failure.spec.ts`; `toMcpTool` / `readOnlyHint` stays in `mcp-outcome.spec.ts`.

import { describe, it } from 'vitest';

describe('enterprise-access / mcp-connect - agents integration (real Postgres + createAgents + MCP fixture process over HTTP)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-1: whose token the call carries, and what the registry changes without a restart
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-12.3 "на сервере появился новый инструмент, администратор обновляет список: инструмент появляется в реестре";
  //   AC-12.4 "администратор выключил сервер: инструменты пропадают из набора со следующего вызова модели, а вызов такого инструмента
  //   получает отказ"; AC-12.5 "сервер зарегистрирован и указан в определении ... инструменты доступны агенту без рестарта платформы";
  //   AC-13.1 "сервер с общей учётной записью, агенты двух сотрудников ... оба вызова идут с учётной записью из реестра, а в аудите
  //   каждый вызов записан на своего сотрудника"; AC-13.2 "сервер с личным OAuth и подключённые аккаунты Ани и Бориса, агент Ани
  //   вызывает инструмент: вызов идёт с токеном Ани, а токен Бориса не используется"; AC-14.2 "аккаунт Ани не подключён: инструментов
  //   Sentry в его наборе нет, агент работает без них"; AC-14.4 "Аня отключила аккаунт: инструменты пропадают со следующего вызова
  //   модели". Design: DC-1, DC-2, DC-8, DC-11; UC-1, UC-2 (calls), UC-4, UC-E4 (oauth-mode refusal).
  // Behavior: admin operation on instance A -> next model call on instance B (and on A) builds its set from the database -> the scripted
  //   model asks for tools -> `ToolRunner` opens one connection with the owner's token -> fixture journal and `agent_tool_calls` rows.
  // Steps (one story over four employees; literal expectations; the registry is empty at the start):
  //   1. DC-11: the definitions name `*` and also `ghost` (never registered); both instances start without error; `ghost` yields no tool
  //      in any set. Аня and Борис are permitted `logs` and `backoffice`; Глеб is permitted nothing (`MCP_ACCESS_TABLE` keyed by their ids).
  //   2. UC-1: on instance A the admin registers `logs` (shared token) -> Аня's agent on instance B, at its next model call, has the `logs`
  //      tools (no restart); Аня's and Борис's agents each call one `logs` tool -> the journal holds two calls, both with the shared
  //      token's identity, and each `agent_tool_calls` row belongs to its own agent and `ownerId`.
  //   3. UC-2: `backoffice` is registered with personal OAuth and the admin account is connected (fixture authorization server). Аня has no
  //      account: the set of her next model call holds no `backoffice` tool and her agent keeps working (the scripted model finishes its
  //      turn). Аня and Борис then connect (`connectAccount`); at their next model calls the sets hold the `backoffice` tools.
  //   4. isolation: the fixture holds Аня's `backoffice` call on a latch; while it is open Борис's call is sent -> the journal shows Аня's
  //      call with account `anya` and Борис's with account `boris`, each token used only on its own call, and neither call saw the other's
  //      token (journal records the account of the bearer it actually received).
  //   5. Аня disconnects (`Agents.mcp.disconnect`) -> her next model call has no `backoffice` tool and `connections(anya)` says `needs_auth`;
  //      Борис's set is unchanged. Глеб's model asks for `mcp__logs__...` and `mcp__backoffice__...` anyway -> both `no_access`,
  //      the journal holds no call from him (oauth mode included: no token lookup for a refused owner).
  //   6. AC-12.3 / AC-12.4 / DC-2: the fixture gains a tool; the admin on instance A refreshes `logs` -> `added` names it and Аня's next set on
  //      instance B holds it; the admin disables `logs`; the model of Аня's agent still asks for a `logs` tool -> `tool_not_in_definition`,
  //      the journal's count is unchanged (the server received nothing).
  //   7. DC-8: the admin changes the address of `backoffice` (to the second fixture path) -> Борис's account row is gone, the registered
  //      OAuth client is cleared, the server is `awaiting_admin_account`, Борис's set has no `backoffice` tool and no request carrying his token
  //      reached the new address.
  // Catches: Аня's token sent in Борис's call (the design's biggest risk: one shared connection or a connection cached per server);
  //   a registry held in process memory so a change on one instance never reaches a running agent on another; a disabled or removed
  //   server still being called; a name without a server (`ghost`) stopping startup or yielding tools; a changed address that keeps old
  //   accounts and so sends employees' tokens to a host the owner never connected; the oauth refusal path asking a token store for an
  //   owner who has no right.
  // @category: core-functionality
  // @dependency: ToolRegistry, ToolRunner, McpRegistry, McpAccounts, McpClient, SecretBox, runtime workers, scripted model, MCP fixture process + its authorization server, Postgres
  // @complexity: high
  it.todo('INT-1: every call carries only its owner\'s token on its own connection, and registry changes on one instance reach the next model call of agents on another without a restart');

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2: token refresh across two instances, and a lost account
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-13.3 "срок токена Ани истёк, а обновить его можно: платформа обновляет токен, вызов проходит, и Аню ни о чём не
  //   спрашивают"; AC-14.5 "обновить токен Ани не удалось: вызов получает ошибку «нужно подключить аккаунт», статус в списке - «нужна
  //   аутентификация», а агент продолжает работу". Design: DC-3, DC-4, DC-10; UC-3.
  // Behavior: access token past its time (account row's `expires_at` moved) -> two calls of Аня on two instances at once -> one refresh under
  //   the pair lock -> both calls pass; then refresh tokens revoked -> call -> `auth_required`.
  // Steps (the fixture authorization server rotates the refresh token on every refresh and counts refreshes):
  //   1. Аня has `backoffice` connected; her account's `expires_at` is moved into the past; her two agents, one on instance A and one on
  //      instance B, are both held (latch) just before the call and released together -> both tool calls end `success`, the fixture's
  //      refresh counter reads exactly 1, the journal shows both calls with the same new access token, and the stored account was
  //      re-sealed once (new `updated_at`, an old sealed value no longer opens as the current one). No question to Аня anywhere.
  //   2. the fixture revokes Аня's refresh tokens and her `expires_at` is moved into the past again -> her agent calls the tool -> outcome
  //      `auth_required` (not `refused`, not `transport_failure`), the model-visible text names «Мой доступ», the journal received no request
  //      for this call, the `agent_mcp_accounts` row is deleted, `connections(anya)` is `needs_auth`, and her agent's next model call has
  //      no `backoffice` tool while the agent stays running. Борис's account and call are untouched.
  //   3. the same loss through the other door: a still-valid access token the server answers 401 to, and a refresh that then fails ->
  //      the same `auth_required`, row deleted.
  //   4. DC-10: the fixture revokes the shared token of `tracker` -> Аня's call to `tracker` ends `transport_failure` with reason
  //      `unauthorized` in the log; Аня's `backoffice` account is still there (a shared-token fault is the administrator's, not the employee's).
  // Catches: a refresh token spent twice (one call per instance) so a rotating authorization server revokes the whole chain and the
  //   employee has to reconnect for no reason; a refresh failure that crashes the step or leaves a dead account claiming `connected`;
  //   a shared server's 401 deleting or blaming employees' accounts; the call being sent anyway without a token.
  // @category: core-functionality
  // @dependency: McpAccounts (advisory lock on server+owner), McpClient (AuthProvider, onUnauthorized), mcp-failure, SecretBox, two createAgents instances, MCP fixture process + authorization server, Postgres
  // @complexity: high
  it.todo('INT-2: two simultaneous calls of one employee on two instances spend one refresh token once and both pass, and a refresh that fails deletes the account and gives auth_required without a request to the server');
});
