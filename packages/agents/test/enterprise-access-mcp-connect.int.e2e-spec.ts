// enterprise-access / mcp-connect - agents-package integration skeletons (real Postgres, real `createAgents`, MCP fixture process over HTTP)
// Design Doc: docs/features/enterprise-access/design-mcp-connect.md (v1.5, Approved), Test Strategy UC-1, UC-2 (call half), UC-3, UC-4, UC-E4;
//   PRD: docs/features/enterprise-access/prd.md (v2.4) FR-12, FR-13, FR-14 (AC-12.3..12.5, AC-13.1..13.3, AC-14.2..14.5).
// Generated: 2026-11-16 (rewritten to v1.5) | Budget Used: 2 of the part's 3 integration skeletons here (INT-1, INT-2); the third (INT-3, the
//   registry and the connect flow over HTTP) is apps/api/test/enterprise-access-mcp-connect.int.e2e-spec.ts. 0 E2E: the Test Strategy names none.
// Test Type: Integration. Every case is `it.todo` - skeletons only, no implementation.
//
// Harness (follows packages/agents/test/support/agentsHarness.ts): the package's own `createRuntime` + `createAgents` over their own pool, no
//   `apps/api`, ONE instance (the feature is one API process, Constraints). Only the model (`createScriptedModel`) is a double. Postgres,
//   the runtime, `ToolRegistry`, `McpRegistry`, `McpAccounts`, `McpClient` and the MCP servers are real. MCP servers are the
//   `packages/mcp-fixture` PROCESS over HTTP with its own authorization server (KD-7); the fixture's journal (source, tool, ACCOUNT of the
//   bearer it actually received) is the proof of "the server received nothing" and of "the call came with Аня's account", and the
//   authorization-server log (token requests, refresh counter) is the proof of "no refresh was asked".
//   Support the implementation tasks add (not skeletons): `agentsHarness` registers fixture sources through `Agents.mcp.register` instead of
//   `fixtureServersFile`, takes `mcpRedirectUrl` and an `ownerGate` option (a port double that throws `OwnerDisabledError` after a flag is
//   set; the real gate is proven by identity INT-2 row 5); a `fixtureProcess()` helper that starts/stops the process and exposes the
//   KD-7 controls (token lifetime, revoke the refresh tokens of an account, refresh counter, add a tool, `hang` and `drop_connection`
//   rules, the journal); `connectAccount(harness, ownerId, server)` = `Agents.mcp.beginConnect`, GET the authorization URL without
//   following redirects, hand `code`/`state`/`iss` to `Agents.mcp.finishConnect`.
// Mock boundary: the model, and the owner-gate port in INT-2 row 5 only. Do NOT mock the fixture, the database, the token clock (expiry
//   is set by moving the account row's `expires_at`) or `McpAccounts`.
//
// Adapted by this design, not duplicated here:
//   - packages/agents/test/agent-platform-agents.int.e2e-spec.ts INT-3 A (refusal reasons, "server never reached", an allowed owner
//       succeeds) and INT-3 F (a failing server becomes `transport_failure`): KEPT as the proof for shared-token servers, adapted to the
//       registry + HTTP fixture harness (`crash_process` is replaced by `drop_connection`, KD-7); INT-1 row 6 adds only the oauth-mode refusal.
//   - packages/agents/test/code-execution.int.e2e-spec.ts: INT-3 row A (refusals from `run_code`) is adapted to the same harness; INT-1 row D
//       (a server credential in the script's env masked in the run log) loses its premise - `secretValuesOf` now carries only
//       `ANTHROPIC_API_KEY` (Security Considerations) - and is dropped by the implementation task.
//   - packages/agents/src/config.spec.ts: the `MCP_SERVERS_FILE` rows are deleted with the loader; `checkCatalog` keeps the name-form rows.
//   - stdio transport, `createMcpClients` cache, `McpStartupError`, `fixtureServersFile` and their tests are deleted with the code.
//
// `provenAt: unit` (small tables next to the code, not skeletons): the scheme check of a server or authorization-server address
//   (`insecure_url`); the error-to-outcome map of `McpClient`/`mcp-failure` in `packages/agents/src/mcp/mcp-failure.spec.ts`
//   (`UnauthorizedError`/`ClientHttpAuthentication` -> `auth_required` for oauth and `transport_failure`/`unauthorized` for shared; fetch
//   failure -> `connection_lost`; timeout or step signal -> `timeout`; unreadable reply -> `protocol_error`); `toMcpTool` / `readOnlyHint`
//   in `mcp-outcome.spec.ts`; the set rule as a pure function if it is written as one (definition ∩ enabled ∩ allowed ∩ connected).
// Not automated: AC-15.1 (`seed:mcp` on a clean development database) - the manual L1 run of the script, it is a developer tool, not a
//   product path; AC-15.2 is a property of this whole suite (it runs on the fixture and needs no internet), not a case.

import { describe, it } from 'vitest';

describe('enterprise-access / mcp-connect - agents integration (real Postgres + createAgents + MCP fixture process over HTTP)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-1: whose token a call carries, who may call at all, and what the registry and accounts change without a restart
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-12.3 "на сервере появился новый инструмент, администратор обновляет список: инструмент появляется в реестре";
  //   AC-12.4 "администратор выключил сервер: инструменты сервера пропадают из его набора со следующего вызова модели, а вызов такого
  //   инструмента получает отказ"; AC-12.5 "сервер зарегистрирован и указан в определении агента ... инструменты сервера доступны агенту
  //   без рестарта платформы"; AC-13.1 "сервер с общей учётной записью, агенты двух сотрудников вызывают его инструмент: оба вызова идут
  //   с учётной записью из реестра, а в аудите каждый вызов записан на своего сотрудника"; AC-13.2 "сервер с личным OAuth и подключённые
  //   аккаунты Ани и Бориса, агент Ани вызывает инструмент: вызов идёт с токеном Ани, а токен Бориса не используется"; AC-14.2 "аккаунт
  //   Ани в Sentry не подключён: инструментов Sentry в его наборе нет, и агент работает без них"; AC-14.3 (the set half: "следующий
  //   вызов модели её работающего агента уже видит инструменты"; the status half is INT-3); AC-14.4 "Аня отключила аккаунт: инструменты
  //   пропадают у него со следующего вызова модели, а статус - «нужна аутентификация»". Design: DC-1, DC-2, DC-11; UC-1, UC-2 (calls), UC-4, UC-E4.
  // Behavior: an admin or employee operation on `Agents.mcp` -> the next model call of a running agent builds its set from the database ->
  //   the scripted model asks for tools -> `ToolRunner` asks the one access function, then opens ONE connection with the owner's token ->
  //   fixture journal and `agent_tool_calls` rows.
  // Steps (one story, literal expectations; the registry is empty at the start; Аня and Борис are permitted `logs` and `backoffice` and Глеб
  //   nothing, `MCP_ACCESS_TABLE` keyed by their ids; the definitions name `*` and also `ghost`, which is never registered; an agent of Аня is running):
  //   1. DC-11: startup passed with `ghost` in the definitions; `ghost` yields no tool in any set.
  //   2. AC-12.5 / AC-13.1: the admin registers `logs` (shared token); at Аня's next model call her set holds the `logs` tools, no restart.
  //      Аня's and Борис's agents each call one `logs` tool -> the journal holds two calls with the shared identity, and each
  //      `agent_tool_calls` row belongs to its own agent and `ownerId`.
  //   3. AC-14.2 / AC-14.3: `backoffice` (personal OAuth) is registered and the admin account is connected. Аня has no account: the set of her
  //      next model call has no `backoffice` tool and her agent keeps working (the scripted model finishes the turn). Аня and Борис connect;
  //      at their next model calls the sets hold the `backoffice` tools.
  //   4. AC-13.2: the fixture holds Аня's `backoffice` call (`hang`); while it is open Борис's call is sent -> the journal shows Аня's call
  //      with account `anya` and Борис's with account `boris`; neither call carried the other's bearer.
  //   5. AC-14.4: Аня disconnects (`Agents.mcp.disconnect`) -> her next model call has no `backoffice` tool and `connections(anya)` says
  //      `needs_auth`; Борис's set and status are unchanged.
  //   6. DC-2 / UC-E4: Глеб's model asks for `mcp__logs__...` and `mcp__backoffice__...` and the same two from a `run_code` script ->
  //      four `no_access`; the journal holds no call from him and the authorization server got no token or refresh request for him
  //      (oauth mode included: no token lookup for a refused owner).
  //   7. AC-12.3 / AC-12.4: the fixture gains a tool; the admin refreshes `logs` -> `added` names it and Аня's next set holds it; the admin
  //      disables `logs`; the model of Аня's agent still asks for a `logs` tool -> `tool_not_in_definition`, the journal count is unchanged.
  // Catches: Аня's token sent in Борис's call (the design's biggest risk: one connection shared per server, or a connection that outlives a
  //   call); a registry or account change that reaches a running agent only after a restart (state cached in the process); a disabled
  //   server still called; a name without a server (`ghost`) stopping startup or yielding tools; a refused owner reaching the server,
  //   or having his token looked up, in oauth mode or from a script; a disconnected account still giving tools.
  // @category: core-functionality
  // @dependency: ToolRegistry, ToolRunner, McpRegistry, McpAccounts, McpClient, runtime workers, scripted model, MCP fixture process + its authorization server, Postgres
  // @complexity: high
  it.todo(
    "INT-1: every call carries only its owner's token on its own connection, a refused owner reaches no server in either mode or from a script, and registry and account changes reach the next model call without a restart",
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2: how a call ends - one refresh for simultaneous calls, a lost account, a failing shared server, the owner gate inside a script
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-13.3 "срок токена Ани истёк, а обновить его можно: платформа обновляет токен, вызов проходит, и Аню ни о чём не спрашивают";
  //   AC-14.5 "обновить токен Ани не удалось: вызов получает ошибку «нужно подключить аккаунт», статус в списке - «нужна аутентификация»,
  //   а агент продолжает работу". Design: DC-3, DC-4, DC-10, KD-5; UC-3, UC-E4 (connection loss); the `OwnerGate` refusal inside `run_code`
  //   (identity KD-4, `packages/agents/src/tools/builtin/run-code.ts`), a row the identity part left without a proof.
  // Behavior: access token past its time (the account row's `expires_at` moved) -> two calls of Аня at once -> one refresh, both pass;
  //   then the refresh token is revoked -> the call ends `auth_required` without a request to the server; other endings are tied to their causes.
  // Rows (the fixture's authorization server rotates the refresh token on every refresh and counts refreshes):
  //   1. DC-4 / AC-13.3: Аня has `backoffice` connected and her `expires_at` is in the past; two of her agents are held (latch) just before the
  //      call and released together -> both tool calls end `success`, the refresh counter reads exactly 1, the journal shows both calls with
  //      the same new access token, the stored account holds the new tokens. Nothing asks Аня anything.
  //   2. DC-3 / AC-14.5: the fixture revokes Аня's refresh tokens and her `expires_at` is moved into the past again -> her agent calls the
  //      tool -> outcome `auth_required` (not `refused`, not `transport_failure`), the text the model gets names «Мой доступ», the journal
  //      got no request for this call, the `agent_mcp_accounts` row is deleted, `connections(anya)` is `needs_auth`, her next model call has
  //      no `backoffice` tool and the agent stays running. Борис's account and call are untouched.
  //   3. the same loss through the other door: a still-valid access token which the server answers 401 to, and a refresh that then fails
  //      -> `auth_required`, row deleted.
  //   4. DC-10: the fixture revokes the shared token of `tracker` -> Аня's call to `tracker` ends `transport_failure` with reason
  //      `unauthorized` in the log, and her `backoffice` account is still there (a shared-token fault is the administrator's, not the employee's).
  //   5. UC-E4: a `drop_connection` rule on one `logs` call -> `transport_failure`, the step does not fail and the agent goes on to its next
  //      model call (the real SDK failure class, which the unit map cannot show).
  //   6. owner gate inside a script: Аня's agent runs a `write`-class `run_code` script that calls a `logs` tool twice; the first call is held
  //      on the fixture; the owner-gate double is switched to refusing; the first call is released -> `agent_code_calls`: seq 1 `success`,
  //      seq 2 `interrupted` (not `unknown`, although the run is `write`) with no `refusalReason`; the journal holds no second `logs` call
  //      from Аня; the agent's task ends `failed` with reason `owner_disabled`.
  // Catches: a refresh token spent twice (one per simultaneous call) so a rotating authorization server revokes the whole chain and the
  //   employee has to reconnect for no reason; a refresh failure that crashes the step, or a dead account still claiming `connected`;
  //   a call sent without a token; a shared server's 401 deleting or blaming employees' accounts; a dropped connection that fails the step
  //   instead of becoming an outcome; a code call refused by the owner gate left open or closed `unknown`, so the history says a blocked
  //   employee's script may have acted.
  // @category: core-functionality
  // @dependency: McpAccounts (refresh, in-process wait per server+owner), McpClient (AuthProvider, onUnauthorized), mcp-failure, run-code tool, code-calls repository, owner-gate port double, MCP fixture process + authorization server, Postgres
  // @complexity: high
  it.todo(
    'INT-2: two simultaneous calls spend one refresh and both pass, a lost account gives auth_required without a request to the server, a failing shared server blames no employee, and an owner refused inside a script closes the code call as interrupted',
  );
});
