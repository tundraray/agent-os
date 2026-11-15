// enterprise-access / mcp-connect - E2E skeletons (whole API process against real Postgres, workers on, scripted model, MCP fixture process)
// Design Doc: docs/features/enterprise-access/design-mcp-connect.md (v1.1), Test Strategy UC-2 (end to end), UC-E3, UC-5;
//   PRD: docs/features/enterprise-access/prd.md FR-12, FR-13, FR-14, FR-15 (AC-15.1), NFR-01, NFR-02.
// Generated: 2026-11-15 | Budget Used: 2/2 E2E for the part (integration skeletons: enterprise-access-mcp-connect.int.e2e-spec.ts here,
//   the agents one in packages/agents/test, and the web one). Implementation timing: after the whole part is built (final phase).
// Test Type: End-to-End. Every case is `it.todo` - skeletons only.
//
// Why these two: E2E-1 is the part's main path in one running process with workers on, plus the only place that scans every store for
//   secret values after a real agent run and runs `secrets:reset` over MCP data; E2E-2 is the developer's first-run path (`seed:mcp`
//   script + fixture process + agent), which no integration skeleton starts. Neither repeats an integration assertion: token isolation and
//   refresh (agents INT-1/INT-2), connect-request hardening (API INT-4) and registry verification (API INT-3) are not re-proven here.
//   The repository has no browser E2E tool (no Playwright): the browser part of the journey is the web skeleton plus the part's L1 browser
//   checklist (Sentry registration on `http://localhost:4000`, then on an `https` tunnel; first call after access-token expiry; Risks and Mitigation).
//
// Harness: `createTestApp({ workers: true, model, fixtureProcess, env })` as in agent-platform-chat.int.e2e-spec.ts and the identity E2E file;
//   the log is captured (the NFR-02 scan, as in identity INT-4 step 6); the process is started more than once for `secrets:reset`
//   (identity E2E-2 harness). E2E-2 runs the `seed:mcp` script as a child process against the test database and fixture process.
//   Cases clean up their own rows; no case depends on another.

import { describe, it } from 'vitest';

describe('enterprise-access / mcp-connect - E2E (full API process + real Postgres + MCP fixture process)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // E2E-1: from registration to Аня's call with her own token, and no secret anywhere, also after a key reset
  // ---------------------------------------------------------------------------------------------------------------
  // User Journey: admin registers `logs` (shared token) and `backoffice` (personal OAuth) and connects his account -> Аня connects hers
  //   through the browser redirect -> her running agent (workers on, scripted model) calls both servers, once with a call that ends
  //   `auth_required` after her account is removed behind her back -> the operator scans every store -> `secrets:reset` with a new key -> the
  //   process starts again.
  // AC: AC-12.1 "регистрация прошла: в реестре виден список инструментов"; AC-13.2 "вызов идёт с токеном Ани"; AC-14.3 "Аня подключила
  //   аккаунт ... статус - «подключено», а следующий вызов модели её работающего агента уже видит инструменты"; NFR-01 "в базе только
  //   зашифрованные"; NFR-02 "ни в логах, ни в аудите, ни в ответах, ни в истории агентов"; AC-13.5 as the stored value check.
  //   Design: DC-9; UC-2 (end to end), UC-E3.
  // Verification items:
  //   - the journey runs through HTTP only (admin cookie, Аня's cookie, `GET /api/events` open on Аня's session): register -> connect ->
  //     return -> chat message to her agent; the stream shows her tool calls with outcome `success` for `logs` and `backoffice`, and the
  //     fixture journal shows the `backoffice` call with Аня's account and the `logs` call with the shared identity
  //   - the account is then deleted in the table behind the agent's back and her agent calls `backoffice` again -> the history entry has outcome
  //     `auth_required` (the contract value reaches the chat history with `refusalReason` null), the stream delivers it, the agent finishes
  //   - scan with the known values (the shared token, the fixture's access and refresh tokens of Аня and of the admin, the OAuth client secret if
  //     the fixture issues one, `state`, the authorization `code`, the sealed `SECRETS_KEY` value): every text column of every `app` table
  //     (`agent_mcp_*` hold sealed values with their own purposes; the connect request holds only the `state` hash), the captured process
  //     log, the audit rows (`secret_changed`, no values), every response of the journey, the agent history and the stored tool outputs
  //     hold none of them in clear form; the log lines carry server, employee, call and request ids and `expiresIn` only
  //   - `secrets:reset` with a new key, then start -> no account rows or connect requests; the client registration is cleared; `logs` is
  //     disabled without a token; `backoffice` is still enabled with its tool list; Аня's `GET /api/mcp/connections` shows `needs_auth`;
  //     the registry operation `PATCH logs` with a new token re-enables it and a fresh call succeeds
  // Catches: a token, code or `state` written to the log, audit, history or a response by a path no integration test reads (the
  //   OAuth callback's redirect logging, the transport's error text, `agent_tool_calls` outputs); sealed values left readable after the
  //   operator rotated the key (old ciphertext kept, or an enabled shared server with a token that no longer opens); `auth_required`
  //   lost between the step and the browser; the main path working only with workers off.
  // @category: e2e
  // @dependency: full-system (AdminMcpServersController, McpConnectionsController, McpAccounts, McpClient, SecretBox, AuditLog, logger masker, secrets:reset command, runtime workers, LiveHub, scripted model, MCP fixture process + authorization server)
  // @complexity: high
  it.todo('E2E-1: a registered, connected and used server leaves no secret value in any table, log, audit row, response or history, and secrets:reset empties the accounts and disables shared tokens');

  // ---------------------------------------------------------------------------------------------------------------
  // E2E-2: the developer's first run - `seed:mcp` and an agent reading logs
  // ---------------------------------------------------------------------------------------------------------------
  // User Journey: developer starts the fixture process on a clean development database -> runs `seed:mcp` -> signs in as the development
  //   employee -> asks the agent to read the logs.
  // AC: AC-15.1 "чистая база разработки, разработчик запускает скрипт начальных данных: тестовые серверы есть в реестре, и агент
  //   сотрудника с правом вызывает их инструменты"; AC-15.2 (the whole run is offline: only the fixture process is contacted).
  //   Design: KD-7; UC-5.
  // Verification items:
  //   - `seed:mcp` exits 0 against an empty `app` schema and prints no token value; the registry holds `logs` and `tracker` (shared token,
  //     enabled, tool lists) and `backoffice` (personal OAuth, enabled with its tool list: the script played the administrator's sign-in at
  //     the fixture authorization server)
  //   - running the script a second time changes nothing and does not fail (names are taken, the registry keeps one row each)
  //   - with `MCP_ACCESS_TABLE` `*` for the development employee (dev sign-in) and an agent definition naming `*`, the scripted model asks
  //     for a `logs` tool -> the call ends `success` and the fixture journal contains it; `backoffice` shows `needs_auth` for the
  //     employee in `GET /api/mcp/connections`
  //   - the production image's file list does not contain the fixture (checked as a build-manifest assertion, one line; the rest of KD-7
  //     is covered by the build)
  // Catches: a seed script that fails or duplicates on the second run, a development registry that needs the internet or hand-made
  //   OAuth accounts, a first-run agent without any tool because the seeded servers were never made visible, a fixture shipped inside
  //   the production image.
  // @category: e2e
  // @dependency: full-system (seed:mcp script, McpRegistry, McpAccounts, SessionGuard dev sign-in, runtime workers, scripted model, MCP fixture process + authorization server)
  // @complexity: medium
  it.todo('E2E-2: seed:mcp on a clean database registers logs, tracker and backoffice without the internet, is safe to run twice, and the development employee\'s agent calls a seeded tool');
});
