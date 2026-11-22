// enterprise-access / mcp-connect - agents-package integration tests (real Postgres, real `createAgents`, MCP fixture process over HTTP)
// Design Doc: docs/features/enterprise-access/design-mcp-connect.md (v1.5, Approved), Test Strategy UC-1, UC-2 (call half), UC-3, UC-4, UC-E4;
//   PRD: docs/features/enterprise-access/prd.md (v2.4) FR-12, FR-13, FR-14 (AC-12.3..12.5, AC-13.1..13.3, AC-14.2..14.5).
// Budget Used: 2 of the part's 3 integration tests here (INT-1, INT-2); the third (INT-3, the registry and the connect flow over HTTP) is
//   apps/api/test/enterprise-access-mcp-connect.int.e2e-spec.ts. 0 E2E: the Test Strategy names none.
// Test Type: Integration.
//
// Harness (follows packages/agents/test/support/agentsHarness.ts): the package's own `createRuntime` + `createAgents` over their own pool, no
//   `apps/api`, ONE instance (the feature is one API process, Constraints). Only the model (`createScriptedModel`) is a double. Postgres,
//   the runtime, `ToolRegistry`, `McpRegistry`, `McpAccounts`, `McpClient` and the MCP servers are real. MCP servers are the
//   `packages/mcp-fixture` PROCESS over HTTP with its own authorization server (KD-7); the fixture's journal (source, tool, ACCOUNT of the
//   bearer it actually received) is the proof of "the server received nothing" and of "the call came with Аня's account", and the
//   authorization-server log (token requests, refresh counter) is the proof of "no refresh was asked".
//   Support: `createAgentsHarness` starts the fixture process (`harness.fixtureProcess`: its addresses and the KD-7 controls - revoke
//   tokens, hold a refresh, the per-account counters, add a tool) and takes a `refusedOwners` option (owners the `AccessGate` double of
//   `@agent-os/agents/testing` answers `owner_disabled` for; the real gate is `AccessService`, apps/api); `registerServer` / `removeServer` go through `Agents.mcp`;
//   `connectAccount(harness, ownerId, server)` = `Agents.mcp.beginConnect`, GET the authorization URL without following redirects, hand
//   `code`/`state`/`iss` to `Agents.mcp.finishConnect`.
// Mock boundary: the model, and the `AccessGate` port (a double by table; owner refusal in INT-2 row 6). Do NOT mock the fixture, the database, the token clock (expiry
//   is set by moving the account row's `expires_at`) or `McpAccounts`.
//
// Adapted by this design, not duplicated here:
//   - packages/agents/test/agent-platform-agents.int.e2e-spec.ts INT-3 A (refusal reasons, "server never reached", an allowed owner
//       succeeds) and INT-3 F (a failing server becomes `transport_failure`): KEPT as the proof for shared-token servers, adapted to the
//       registry + HTTP fixture harness (`crash_process` is replaced by `drop_connection`, KD-7); INT-1 row 6 adds only the oauth-mode refusal.
//   - packages/agents/test/code-execution.int.e2e-spec.ts: INT-3 row A (refusals from `run_code`) is adapted to the same harness; INT-1 row D
//       (a server credential in the script's env masked in the run log) loses its premise - the log mask holds only the keys in the
//       process secret memory, which the model provider rows fill (Security Considerations) - and is dropped by the implementation task.
//   - packages/agents/src/config.spec.ts: the `MCP_SERVERS_FILE` rows are deleted with the loader; the file keeps only the rows of the settings the package still reads.
//   - stdio transport, `createMcpClients` cache, `McpStartupError`, `fixtureServersFile` and their tests are deleted with the code.
//
// `provenAt: unit` (small tables next to the code, not skeletons): the scheme check of a server or authorization-server address
//   (`insecure_url`); the error-to-outcome map of `McpClient`/`mcp-failure` in `packages/agents/src/mcp/mcp-failure.spec.ts`
//   (`UnauthorizedError`/`ClientHttpAuthentication` -> `auth_required` for oauth and `transport_failure`/`unauthorized` for shared; fetch
//   failure -> `connection_lost`; timeout or step signal -> `timeout`; unreadable reply -> `protocol_error`); `toMcpTool` / `readOnlyHint`
//   in `mcp-outcome.spec.ts`; the set rule as a pure function if it is written as one (definition ∩ enabled ∩ allowed ∩ connected).
// Not automated: AC-15.1 (`seed:mcp` on a clean development database) - the manual L1 run of the script, it is a developer tool, not a
//   product path; AC-15.2 is a property of this whole suite (it runs on the fixture and needs no internet), not a case.

import type { AgentHistoryEntry } from '@agent-os/agents';
import {
  createScriptedModel,
  type RecordedModelCall,
  type ReplyFromInput,
  type Script,
  type ScriptedAnswer,
  type ScriptedToolCall,
} from '@agent-os/agents/testing';
import { agentMcpAccounts, agentSessions } from '@agent-os/db';
import { FIXTURE_SHARED_TOKEN, createFixtureFiles, fixtureCallsOf, holdCall, readFixtureLog } from '@agent-os/mcp-fixture';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  type AgentsHarness,
  codeCallRowsOf,
  createAgentsHarness,
  historyOf,
  setRootRecord,
  type TestRecord,
  testRecord,
  toolOutputOf,
  toolCallRowsOf,
  waitFor,
  waitForTaskStatus,
} from './support/agentsHarness';
import {
  BACKOFFICE_SERVER,
  LOGS_SERVER,
  TRACKER_SERVER,
  connectAccount,
  registerServer,
  removeServer,
  runName,
} from './support/mcp-servers';
import { newUser } from './support/new-user';

/** Bound of one in-process test; the story settles far sooner. */
const TEST_TIMEOUT_MS = 180_000;

/** A server name the records name and the registry never holds (DC-11). */
const GHOST_SERVER = runName('ghost');

/** The tools every conversation root offers its model, before any server's tools: the root's `start_deep_agent` and those of every session. */
const SESSION_TOOLS = [
  // The conversation's root always keeps a task list (deep-agents design-task-list.md KD-2).
  'task_create',
  'task_update',
  'task_get',
  'task_list',
  'start_deep_agent',
  'read_tool_result',
  'search_tool_result',
  'run_code',
];
/** The run's tools as the model names them; the registry keeps a server's tools sorted by name. */
const LOGS_TOOLS = [
  `mcp__${LOGS_SERVER}__aggregate_logs`,
  `mcp__${LOGS_SERVER}__get_trace`,
  `mcp__${LOGS_SERVER}__search_logs`,
];
const BACKOFFICE_TOOLS = [
  `mcp__${BACKOFFICE_SERVER}__create_incident_note`,
  `mcp__${BACKOFFICE_SERVER}__get_order`,
  `mcp__${BACKOFFICE_SERVER}__search_orders`,
];
const GET_TRACE = `mcp__${LOGS_SERVER}__get_trace`;
const SEARCH_ORDERS = `mcp__${BACKOFFICE_SERVER}__search_orders`;
const SEARCH_TICKETS = `mcp__${TRACKER_SERVER}__search_tickets`;
const TRACKER_TOOLS = [SEARCH_TICKETS];
/** The tool the fixture gains in step 7 (`control.addTool`), and its name in the model's set. */
const ADDED_TOOL = 'count_errors';
const ADDED_TOOL_NAME = `mcp__${LOGS_SERVER}__${ADDED_TOOL}`;

/** Arguments that tell the calls of one tool apart in the fixture journal: one set per employee and step. */
const TRACE_ANYA = { traceId: 'a'.repeat(32) };
const TRACE_BORIS = { traceId: 'b'.repeat(32) };
const TRACE_GLEB = { traceId: 'c'.repeat(32) };
const TRACE_AFTER_DISABLE = { traceId: 'd'.repeat(32) };
const ORDERS_WINDOW = { from: '2026-09-15T10:00:00.000Z', to: '2026-09-15T10:15:00.000Z' } as const;
const ORDERS_ANYA = { ...ORDERS_WINDOW, pageSize: 1 };
const ORDERS_BORIS = { ...ORDERS_WINDOW, pageSize: 2 };
const ORDERS_GLEB = { ...ORDERS_WINDOW, pageSize: 3 };
/** INT-2: the second agent's call of row 1 (Борис's is `ORDERS_BORIS`), and the calls that lose the account in rows 2 and 3. */
const ORDERS_SECOND_AGENT = { ...ORDERS_WINDOW, pageSize: 4 };
const ORDERS_REFRESH_REVOKED = { ...ORDERS_WINDOW, pageSize: 5 };
const ORDERS_ACCESS_REVOKED = { ...ORDERS_WINDOW, pageSize: 6 };
/** INT-2 row 6: the script's trace read before the owner gate refuses, and the one after. */
const TRACE_BEFORE_GATE = { traceId: 'e'.repeat(32) };
const TRACE_AFTER_GATE = { traceId: 'f'.repeat(32) };

/** The employee messages of the story; each starts one turn of a root agent. */
const READ_LOGS = 'Read the payment trace';
const LOOK_AT_BACKOFFICE = 'Look at the back office';
const READ_BACKOFFICE = 'Read the back-office orders';
const AFTER_DISCONNECT = 'Carry on after the account change';
const AFTER_REFRESH = 'Carry on after the tool list change';
const AFTER_DISABLE = 'Read the trace once more';
const READ_ORDERS_TOGETHER = 'Read the orders now';
const READ_AFTER_REVOKE = 'Read the orders again';
const AFTER_LOSS = 'Carry on without the back office';
const READ_AFTER_401 = 'Read the orders after reconnecting';
const READ_TICKETS = 'Read the tickets';
const RUN_WRITE = 'Read both traces in a write run';

/** The answer of the model after the results of its calls: the turn ends. */
const TURN_DONE: ScriptedAnswer = { text: 'done' };

/** A turn of a root agent: the employee's message and what the model answers it with. */
type Turns = Readonly<Record<string, ScriptedAnswer>>;

/**
 * A reply chosen by the latest message: an employee message (or the task) gets its scripted answer, the
 * results of the model's own calls end the turn.
 */
function byMessage(turns: Turns): ReplyFromInput {
  return (messages) => {
    const last = messages.at(-1);
    if (last?.role !== 'user') return TURN_DONE;
    const answer = turns[last.content];
    if (answer === undefined) throw new Error(`No scripted answer to the message "${last.content}"`);
    return answer;
  };
}

/** A running root agent of one employee and the model script that answers it. */
interface Employee {
  readonly ownerId: string;
  readonly agentId: string;
  readonly script: Script;
  readonly turns: Turns;
}

/** Starts a root agent of `ownerId` whose model answers by {@link byMessage}; its first turn is the task. */
async function startEmployee(
  harness: AgentsHarness,
  model: ReturnType<typeof createScriptedModel>,
  input: { readonly ownerId: string; readonly root: TestRecord; readonly task: string; readonly turns: Turns },
): Promise<Employee> {
  const turns = { [input.task]: TURN_DONE, ...input.turns };
  const script = model.script({ task: input.task }, [], { thereafter: byMessage(turns) });
  await setRootRecord(harness.library, input.root);
  const { agentId } = await harness.sessions.start({
    ownerId: input.ownerId,
    prompt: input.task,
    description: input.task,
  });
  const employee = { ownerId: input.ownerId, agentId, script, turns };
  await turnEnded(harness, employee, modelCallsOf(turns[input.task]));
  return employee;
}

/** One model call for a text answer, two for an answer with calls (the results end the turn). */
function modelCallsOf(answer: ScriptedAnswer | undefined): number {
  return (answer?.calls?.length ?? 0) > 0 ? 2 : 1;
}

/** Waits until the employee's script answered `calls` model calls and the root waits after its turn. */
async function turnEnded(harness: AgentsHarness, employee: Employee, calls: number): Promise<void> {
  await employee.script.called(calls);
  await waitForTaskStatus(harness, employee.agentId, employee.ownerId, 'waiting');
}

/**
 * Sends `text` to the employee's agent and waits until the turn it starts ends; returns the first model
 * call of the turn, whose tool set is the one built after everything that happened before the message.
 */
async function turn(harness: AgentsHarness, employee: Employee, text: string): Promise<RecordedModelCall> {
  const before = employee.script.calls.length;
  await harness.sessions.send({ agentId: employee.agentId, ownerId: employee.ownerId, text });
  await turnEnded(harness, employee, before + modelCallsOf(employee.turns[text]));
  const first = employee.script.calls[before];
  if (first === undefined) throw new Error(`The turn "${text}" made no model call`);
  return first;
}

/** An agent's audit rows with the owner of their session: `<owner> <server>/<tool> <outcome>[ <reason>]`. */
async function auditOf(harness: AgentsHarness, agentId: string): Promise<string[]> {
  // The calls are folded from the agent's history; their owner is the owner of its session row.
  const [session] = await harness.db
    .select({ ownerId: agentSessions.ownerId })
    .from(agentSessions)
    .where(eq(agentSessions.taskId, agentId));
  const rows = await toolCallRowsOf(harness.db, agentId);
  return rows.map((row) =>
    [
      session?.ownerId,
      row.server === null ? row.tool : `${row.server}/${row.tool}`,
      row.outcome ?? '-',
      ...(row.refusalReason === null ? [] : [row.refusalReason]),
    ].join(' '),
  );
}

/** The fixture journal as `<source> <account> <tool>` lines, in arrival order. */
function journalLines(callLog: string): string[] {
  return readFixtureLog(callLog).map((entry) => `${entry.source} ${entry.account} ${entry.tool}`);
}

/** The value a `run_code` run returned, as the history keeps it (JSON text). */
function returnedBy(history: readonly AgentHistoryEntry[], runCallId: string): unknown {
  const entry = history.find((candidate) => candidate.kind === 'tool_result' && candidate.content.callId === runCallId);
  if (entry?.kind !== 'tool_result') throw new Error(`The history holds no result of call ${runCallId}`);
  return JSON.parse(entry.content.text ?? '') as unknown;
}

/** A read script that calls each tool and returns `<outcome> <reason>` of each refusal (or that the call passed). */
function refusalsScript(requests: readonly ScriptedToolCall[]): string {
  return [
    `const requests = ${JSON.stringify(requests.map((request) => [request.tool, request.args]))};`,
    'const ends = [];',
    'for (const [name, args] of requests) {',
    '  try { await callTool(name, args); ends.push("вызов прошёл"); } catch (error) { ends.push(error.outcome + " " + error.reason); }',
    '}',
    'return ends;',
  ].join('\n');
}

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
  //   fixture journal and tool calls in `agent_messages`.
  // Steps (one story, literal expectations; the registry is empty at the start; Аня and Борис are permitted `logs` and `backoffice` and Глеб
  //   nothing, server rights of the access gate double keyed by their ids; the definitions name `*` and also `ghost`, which is never registered; an agent of Аня is running):
  //   1. DC-11: startup passed with `ghost` in the definitions; `ghost` yields no tool in any set.
  //   2. AC-12.5 / AC-13.1: the admin registers `logs` (shared token); at Аня's next model call her set holds the `logs` tools, no restart.
  //      Аня's and Борис's agents each call one `logs` tool -> the journal holds two calls with the shared identity, and each
  //      tool calls in `agent_messages` belongs to its own agent and `ownerId`.
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
  it("INT-1: every call carries only its owner's token on its own connection, a refused owner reaches no server in either mode or from a script, and registry and account changes reach the next model call without a restart", async () => {
    // Given: no server of this run in the registry; Аня and Борис may use `logs`, `backoffice` and `ghost`, Глеб
    // nothing; Аня's definition names every server (`*`), Борис's names `logs`, `backoffice` and `ghost`, which
    // is never registered
    const anya = newUser();
    const boris = newUser();
    const gleb = newUser();
    const admin = newUser();
    const everyServer = testRecord('every-server', { servers: ['*'] });
    const namedServers = testRecord('named-servers', { servers: [LOGS_SERVER, BACKOFFICE_SERVER, GHOST_SERVER] });
    const fixture = createFixtureFiles('mcp-connect');
    const model = createScriptedModel();
    const harness = await createAgentsHarness({
      model,
      fixture,
      mcpServers: [],
      access: {
        [anya]: [LOGS_SERVER, BACKOFFICE_SERVER, GHOST_SERVER],
        [boris]: [LOGS_SERVER, BACKOFFICE_SERVER, GHOST_SERVER],
      },
    });
    const { control } = harness.fixtureProcess;
    try {
      // 1. DC-11: the start passed with `ghost` in a definition; with no server of the run registered, both
      //    agents are offered only the tools every session has, and `ghost` gives no tool
      const anyaAgent = await startEmployee(harness, model, {
        ownerId: anya,
        root: everyServer,
        task: 'Аня investigates a failed payment',
        turns: {
          [READ_LOGS]: { calls: [{ tool: GET_TRACE, args: TRACE_ANYA }] },
          [LOOK_AT_BACKOFFICE]: { text: 'nothing to read in the back office' },
          [READ_BACKOFFICE]: { calls: [{ tool: SEARCH_ORDERS, args: ORDERS_ANYA }] },
          [AFTER_DISCONNECT]: TURN_DONE,
          [AFTER_REFRESH]: TURN_DONE,
          [AFTER_DISABLE]: { calls: [{ tool: GET_TRACE, args: TRACE_AFTER_DISABLE }] },
        },
      });
      const borisAgent = await startEmployee(harness, model, {
        ownerId: boris,
        root: namedServers,
        task: 'Борис checks the refunds',
        turns: {
          [READ_LOGS]: { calls: [{ tool: GET_TRACE, args: TRACE_BORIS }] },
          [READ_BACKOFFICE]: { calls: [{ tool: SEARCH_ORDERS, args: ORDERS_BORIS }] },
          [AFTER_DISCONNECT]: TURN_DONE,
        },
      });
      expect(anyaAgent.script.calls[0]?.toolNames).toEqual(SESSION_TOOLS);
      expect(borisAgent.script.calls[0]?.toolNames).toEqual(SESSION_TOOLS);

      // 2. AC-12.5 / AC-13.1: the admin registers `logs` with the shared token; at the next model call both sets
      //    hold its tools (no restart); both calls reach the server with the shared identity, and each audit row
      //    belongs to its own agent and owner
      await registerServer(harness.agents, {
        name: LOGS_SERVER,
        url: harness.fixtureProcess.sharedUrl('logs'),
        mode: 'shared',
        sharedToken: FIXTURE_SHARED_TOKEN,
      });
      expect((await turn(harness, anyaAgent, READ_LOGS)).toolNames).toEqual([...SESSION_TOOLS, ...LOGS_TOOLS]);
      expect((await turn(harness, borisAgent, READ_LOGS)).toolNames).toEqual([...SESSION_TOOLS, ...LOGS_TOOLS]);
      expect(journalLines(fixture.callLog)).toEqual(['logs shared get_trace', 'logs shared get_trace']);
      expect(fixtureCallsOf(fixture.callLog, { tool: 'get_trace', args: TRACE_ANYA })).toHaveLength(1);
      expect(fixtureCallsOf(fixture.callLog, { tool: 'get_trace', args: TRACE_BORIS })).toHaveLength(1);
      expect(await auditOf(harness, anyaAgent.agentId)).toEqual([`${anya} ${LOGS_SERVER}/get_trace success`]);
      expect(await auditOf(harness, borisAgent.agentId)).toEqual([`${boris} ${LOGS_SERVER}/get_trace success`]);

      // 3. AC-14.2 / AC-14.3: `backoffice` is registered with personal OAuth and the admin's account fills its
      //    list; Аня has no account, so her next set has no `backoffice` tool and her agent finishes the turn
      await registerServer(harness.agents, {
        name: BACKOFFICE_SERVER,
        url: harness.fixtureProcess.oauthUrl('backoffice'),
        mode: 'oauth',
      });
      const adminConnected = await connectAccount(harness, admin, BACKOFFICE_SERVER, { account: 'admin', isAdmin: true });
      expect([adminConnected.outcome, adminConnected.server, adminConnected.target]).toEqual([
        'connected',
        BACKOFFICE_SERVER,
        'admin',
      ]);
      expect(adminConnected.change?.added).toEqual(['create_incident_note', 'get_order', 'search_orders']);
      expect((await turn(harness, anyaAgent, LOOK_AT_BACKOFFICE)).toolNames).toEqual([...SESSION_TOOLS, ...LOGS_TOOLS]);
      expect((await harness.sessions.get(anyaAgent.agentId, anya)).status).not.toBe('failed');
      expect((await harness.agents.mcp.connections(anya)).map((c) => `${c.server} ${c.status}`)).toEqual([
        `${BACKOFFICE_SERVER} needs_auth`,
      ]);
      // KD-4 (custom-agents library): the servers Аня may use are of any mode, not only `oauth`
      expect(await harness.agents.mcp.usable(anya)).toEqual([BACKOFFICE_SERVER, LOGS_SERVER]);
      for (const [ownerId, account] of [
        [anya, 'anya'],
        [boris, 'boris'],
      ] as const) {
        expect((await connectAccount(harness, ownerId, BACKOFFICE_SERVER, { account })).outcome).toBe('connected');
      }

      // 4. AC-13.2: Аня's `backoffice` call is held on the fixture; while it is open Борис's call goes through.
      //    Their next sets hold the `backoffice` tools; the journal shows each call with its own account
      const anyaHeld = fixture.latch('anya-backoffice-call');
      fixture.setFaults([holdCall('search_orders', ORDERS_ANYA, anyaHeld)]);
      const anyaCallsBefore = anyaAgent.script.calls.length;
      await harness.sessions.send({ agentId: anyaAgent.agentId, ownerId: anya, text: READ_BACKOFFICE });
      await waitFor(
        () => fixtureCallsOf(fixture.callLog, { tool: 'search_orders', args: ORDERS_ANYA }),
        (calls) => calls.length === 1,
        "Аня's back-office call to reach the fixture",
      );
      expect((await turn(harness, borisAgent, READ_BACKOFFICE)).toolNames).toEqual([
        ...SESSION_TOOLS,
        ...BACKOFFICE_TOOLS,
        ...LOGS_TOOLS,
      ]);
      expect((await harness.runtime.tasks.get(anyaAgent.agentId, anya)).status).toBe('running');
      anyaHeld.release();
      await turnEnded(harness, anyaAgent, anyaCallsBefore + 2);
      fixture.setFaults([]);
      expect(anyaAgent.script.calls[anyaCallsBefore]?.toolNames).toEqual([...SESSION_TOOLS, ...BACKOFFICE_TOOLS, ...LOGS_TOOLS]);
      const anyaOrders = fixtureCallsOf(fixture.callLog, { tool: 'search_orders', args: ORDERS_ANYA });
      const borisOrders = fixtureCallsOf(fixture.callLog, { tool: 'search_orders', args: ORDERS_BORIS });
      expect(anyaOrders.map((entry) => `${entry.source} ${entry.account} ${entry.mode}`)).toEqual([
        'backoffice anya wait_for_file',
      ]);
      expect(borisOrders.map((entry) => `${entry.source} ${entry.account} ${entry.mode}`)).toEqual([
        'backoffice boris null',
      ]);
      expect(anyaOrders[0]?.tokenId).not.toBe(borisOrders[0]?.tokenId);
      expect(journalLines(fixture.callLog).filter((line) => line.startsWith('backoffice'))).toEqual([
        'backoffice anya search_orders',
        'backoffice boris search_orders',
      ]);
      expect(await auditOf(harness, anyaAgent.agentId)).toEqual([
        `${anya} ${LOGS_SERVER}/get_trace success`,
        `${anya} ${BACKOFFICE_SERVER}/search_orders success`,
      ]);
      expect(await auditOf(harness, borisAgent.agentId)).toEqual([
        `${boris} ${LOGS_SERVER}/get_trace success`,
        `${boris} ${BACKOFFICE_SERVER}/search_orders success`,
      ]);

      // 5. AC-14.4: Аня disconnects -> her next set has no `backoffice` tool and her status is `needs_auth`;
      //    Борис's set and status are unchanged
      await harness.agents.mcp.disconnect(anya, BACKOFFICE_SERVER);
      expect((await turn(harness, anyaAgent, AFTER_DISCONNECT)).toolNames).toEqual([...SESSION_TOOLS, ...LOGS_TOOLS]);
      expect((await harness.agents.mcp.connections(anya)).map((c) => `${c.server} ${c.status}`)).toEqual([
        `${BACKOFFICE_SERVER} needs_auth`,
      ]);
      expect((await harness.agents.mcp.connections(boris)).map((c) => `${c.server} ${c.status}`)).toEqual([
        `${BACKOFFICE_SERVER} connected`,
      ]);
      expect((await turn(harness, borisAgent, AFTER_DISCONNECT)).toolNames).toEqual([
        ...SESSION_TOOLS,
        ...BACKOFFICE_TOOLS,
        ...LOGS_TOOLS,
      ]);

      // 6. DC-2 / UC-E4: Глеб, who may use no server, asks for a `logs` and a `backoffice` tool directly and the
      //    same two from a `run_code` script -> four `no_access`; nothing of his reaches a server, no token of
      //    his is looked up, and the authorization server gets no request
      const journalBeforeGleb = readFixtureLog(fixture.callLog).length;
      const statsBeforeGleb = [await control.stats('anya'), await control.stats('boris')];
      const glebRequests: ScriptedToolCall[] = [
        { tool: GET_TRACE, args: TRACE_GLEB },
        { tool: SEARCH_ORDERS, args: ORDERS_GLEB },
      ];
      const glebTask = 'Глеб reads what he may not';
      const glebScript = model.script({ task: glebTask }, [
        {
          calls: [
            ...glebRequests,
            { tool: 'run_code', args: { description: 'Чтение без доступа', class: 'read', script: refusalsScript(glebRequests) } },
          ],
        },
        { text: 'nothing was read' },
      ]);
      await setRootRecord(harness.library, everyServer);
      const { agentId: glebAgentId } = await harness.sessions.start({
        ownerId: gleb,
        prompt: glebTask,
        description: glebTask,
      });
      await glebScript.called(2);
      await waitForTaskStatus(harness, glebAgentId, gleb, 'waiting');
      expect(glebScript.calls[0]?.toolNames).toEqual(SESSION_TOOLS);
      const glebRunId = glebScript.calls[0]?.toolCallIds[2] ?? '';
      expect(await auditOf(harness, glebAgentId)).toEqual([
        `${gleb} ${GET_TRACE} refused no_access`,
        `${gleb} ${SEARCH_ORDERS} refused no_access`,
        `${gleb} run_code success`,
      ]);
      expect(returnedBy(await historyOf(harness, glebAgentId, gleb), glebRunId)).toEqual([
        'refused no_access',
        'refused no_access',
      ]);
      expect(
        (await codeCallRowsOf(harness.db, glebAgentId, glebRunId)).map(
          (row) => `${row.seq} ${row.server}/${row.tool} ${row.outcome} ${row.refusalReason}`,
        ),
      ).toEqual([
        `1 ${LOGS_SERVER}/get_trace refused no_access`,
        `2 ${BACKOFFICE_SERVER}/search_orders refused no_access`,
      ]);
      expect(readFixtureLog(fixture.callLog)).toHaveLength(journalBeforeGleb);
      expect(
        harness.logs.filter((record) => record.message === 'mcp token issued' && record.fields.ownerId === gleb),
      ).toEqual([]);
      expect([await control.stats('anya'), await control.stats('boris')]).toEqual(statsBeforeGleb);

      // 7. AC-12.3 / AC-12.4: the fixture gains a tool and the admin refreshes `logs` -> `added` names it and
      //    Аня's next set holds it; the admin disables `logs` -> its tools leave her set, and the call her model
      //    still asks for is refused `tool_not_in_definition` without reaching the server
      await control.addTool({ source: 'logs', name: ADDED_TOOL });
      const refreshed = await harness.agents.mcp.refreshTools(LOGS_SERVER, admin);
      expect([refreshed.added, refreshed.removed]).toEqual([[ADDED_TOOL], []]);
      expect((await turn(harness, anyaAgent, AFTER_REFRESH)).toolNames).toEqual([
        ...SESSION_TOOLS,
        `mcp__${LOGS_SERVER}__aggregate_logs`,
        ADDED_TOOL_NAME,
        `mcp__${LOGS_SERVER}__get_trace`,
        `mcp__${LOGS_SERVER}__search_logs`,
      ]);
      await harness.agents.mcp.update(LOGS_SERVER, { enabled: false });
      expect(await harness.agents.mcp.usable(anya)).toEqual([BACKOFFICE_SERVER]);
      const journalBeforeDisabled = readFixtureLog(fixture.callLog).length;
      expect((await turn(harness, anyaAgent, AFTER_DISABLE)).toolNames).toEqual(SESSION_TOOLS);
      expect((await auditOf(harness, anyaAgent.agentId)).at(-1)).toBe(`${anya} ${GET_TRACE} refused tool_not_in_definition`);
      expect(fixtureCallsOf(fixture.callLog, { tool: 'get_trace', args: TRACE_AFTER_DISABLE })).toEqual([]);
      expect(readFixtureLog(fixture.callLog)).toHaveLength(journalBeforeDisabled);
    } finally {
      try {
        await removeServer(harness.agents, LOGS_SERVER);
        await removeServer(harness.agents, BACKOFFICE_SERVER);
      } finally {
        await harness.close();
      }
    }
  }, TEST_TIMEOUT_MS);

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2: how a call ends - one refresh for simultaneous calls, a lost account, a failing shared server, the owner gate inside a script
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-13.3 "срок токена Ани истёк, а обновить его можно: платформа обновляет токен, вызов проходит, и Аню ни о чём не спрашивают";
  //   AC-14.5 "обновить токен Ани не удалось: вызов получает ошибку «нужно подключить аккаунт», статус в списке - «нужна аутентификация»,
  //   а агент продолжает работу". Design: DC-3, DC-4, DC-10, KD-5; UC-3, UC-E4 (connection loss); the `AccessGate` owner refusal inside `run_code`
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
  //      on the fixture; the access gate double is switched to refusing; the first call is released -> `agent_code_calls`: seq 1 `success`,
  //      seq 2 `interrupted` (not `unknown`, although the run is `write`) with no `refusalReason`; the journal holds no second `logs` call
  //      from Аня; the agent's task ends `failed` with reason `owner_disabled`.
  // Catches: a refresh token spent twice (one per simultaneous call) so a rotating authorization server revokes the whole chain and the
  //   employee has to reconnect for no reason; a refresh failure that crashes the step, or a dead account still claiming `connected`;
  //   a call sent without a token; a shared server's 401 deleting or blaming employees' accounts; a dropped connection that fails the step
  //   instead of becoming an outcome; a code call refused by the owner gate left open or closed `unknown`, so the history says a blocked
  //   employee's script may have acted.
  // @category: core-functionality
  // @dependency: McpAccounts (refresh, in-process wait per server+owner), McpClient (AuthProvider, onUnauthorized), mcp-failure, run-code tool, code-calls repository, AccessGate port double, MCP fixture process + authorization server, Postgres
  // @complexity: high
  it('INT-2: two simultaneous calls spend one refresh and both pass, a lost account gives auth_required without a request to the server, a failing shared server blames no employee, and an owner refused inside a script closes the code call as interrupted', async () => {
    // Given: `logs` and `tracker` with the shared token, `backoffice` with personal OAuth; the admin, Аня and
    // Борис have connected their `backoffice` accounts; Аня runs two agents that name every server. The owner
    // gate lets everyone through until the test refuses Аня (row 6)
    const anya = newUser();
    const boris = newUser();
    const admin = newUser();
    const everyServer = testRecord('every-server', { servers: ['*'] });
    const fixture = createFixtureFiles('mcp-connect');
    const model = createScriptedModel();
    const refusedOwners: string[] = [];
    const harness = await createAgentsHarness({
      model,
      fixture,
      mcpServers: [],
      access: {
        [anya]: [LOGS_SERVER, BACKOFFICE_SERVER, TRACKER_SERVER],
        [boris]: [BACKOFFICE_SERVER],
      },
      refusedOwners,
    });
    const { control } = harness.fixtureProcess;
    try {
      for (const source of ['logs', 'tracker'] as const) {
        await registerServer(harness.agents, {
          name: runName(source),
          url: harness.fixtureProcess.sharedUrl(source),
          mode: 'shared',
          sharedToken: FIXTURE_SHARED_TOKEN,
        });
      }
      await registerServer(harness.agents, {
        name: BACKOFFICE_SERVER,
        url: harness.fixtureProcess.oauthUrl('backoffice'),
        mode: 'oauth',
      });
      // The authorization server numbers its access tokens in issue order: admin 1, Аня 2, Борис 3
      for (const [ownerId, account, isAdmin] of [
        [admin, 'admin', true],
        [anya, 'anya', false],
        [boris, 'boris', false],
      ] as const) {
        expect((await connectAccount(harness, ownerId, BACKOFFICE_SERVER, { account, isAdmin })).outcome).toBe(
          'connected',
        );
      }
      const writeScript = twoTraceReadsScript();
      const anyaFirst = await startEmployee(harness, model, {
        ownerId: anya,
        root: everyServer,
        task: 'Аня reconciles the refunds',
        turns: {
          [READ_ORDERS_TOGETHER]: { calls: [{ tool: SEARCH_ORDERS, args: ORDERS_ANYA }] },
          [READ_AFTER_REVOKE]: { calls: [{ tool: SEARCH_ORDERS, args: ORDERS_REFRESH_REVOKED }] },
          [AFTER_LOSS]: TURN_DONE,
          [READ_AFTER_401]: { calls: [{ tool: SEARCH_ORDERS, args: ORDERS_ACCESS_REVOKED }] },
          [READ_TICKETS]: { calls: [{ tool: SEARCH_TICKETS, args: {} }] },
          [RUN_WRITE]: {
            calls: [{ tool: 'run_code', args: { description: 'Две трассы', class: 'write', script: writeScript } }],
          },
        },
      });
      const anyaSecond = await startEmployee(harness, model, {
        ownerId: anya,
        root: everyServer,
        task: 'Аня checks the chargebacks',
        turns: { [READ_ORDERS_TOGETHER]: { calls: [{ tool: SEARCH_ORDERS, args: ORDERS_SECOND_AGENT }] } },
      });
      const borisAgent = await startEmployee(harness, model, {
        ownerId: boris,
        root: everyServer,
        task: 'Борис checks the refunds',
        turns: { [READ_ORDERS_TOGETHER]: { calls: [{ tool: SEARCH_ORDERS, args: ORDERS_BORIS }] } },
      });

      // 1. DC-4 / AC-13.3: Аня's and Борис's access tokens are past their time; Аня's refreshes are held on the
      //    authorization server; her two agents and Борис's call `backoffice` at once. Her second call joins the
      //    refresh of the first (the `joined` record; a second refresh request is the defect). Борис's call ends
      //    while her refresh is still held: his own refresh, his own new token (a wait keyed by the server alone
      //    would hold him too, or send Аня's token). Then the hold is released -> one refresh each, both of
      //    Аня's calls pass with her same new token, and the row holds the new tokens
      const beforeRefresh = await accountRowOf(harness, anya);
      await expireAccount(harness, anya);
      await expireAccount(harness, boris);
      const refreshHeld = fixture.latch('anya-refresh');
      await control.holdRefresh({ account: 'anya', path: refreshHeld.path });
      const firstBefore = anyaFirst.script.calls.length;
      const secondBefore = anyaSecond.script.calls.length;
      const borisBefore = borisAgent.script.calls.length;
      await Promise.all(
        [anyaFirst, anyaSecond, borisAgent].map((employee) =>
          harness.sessions.send({ agentId: employee.agentId, ownerId: employee.ownerId, text: READ_ORDERS_TOGETHER }),
        ),
      );
      await waitFor(
        async () => ({
          joined: harness.logs.some(
            (record) => record.message === 'mcp token refresh joined' && record.fields.ownerId === anya,
          ),
          refreshes: (await control.stats('anya')).refreshes,
        }),
        (seen) => seen.joined || seen.refreshes >= 2,
        "both of Аня's calls to reach her token",
      );
      await turnEnded(harness, borisAgent, borisBefore + 2);
      refreshHeld.release();
      await Promise.all([
        turnEnded(harness, anyaFirst, firstBefore + 2),
        turnEnded(harness, anyaSecond, secondBefore + 2),
      ]);
      await control.holdRefresh({ account: 'anya' });
      expect([(await control.stats('anya')).refreshes, (await control.stats('boris')).refreshes]).toEqual([1, 1]);
      expect((await auditOf(harness, anyaFirst.agentId)).at(-1)).toBe(`${anya} ${BACKOFFICE_SERVER}/search_orders success`);
      expect((await auditOf(harness, anyaSecond.agentId)).at(-1)).toBe(`${anya} ${BACKOFFICE_SERVER}/search_orders success`);
      expect(
        [ORDERS_BORIS, ORDERS_ANYA, ORDERS_SECOND_AGENT].flatMap((args) =>
          fixtureCallsOf(fixture.callLog, { tool: 'search_orders', args }).map((entry) => `${entry.account} ${entry.tokenId}`),
        ),
      ).toEqual(['boris 4', 'anya 5', 'anya 5']);
      const afterRefresh = await accountRowOf(harness, anya);
      expect(afterRefresh?.accessToken).not.toBe(beforeRefresh?.accessToken);
      expect(afterRefresh?.refreshToken).not.toBe(beforeRefresh?.refreshToken);
      expect(afterRefresh?.expiresAt?.getTime()).toBeGreaterThan(Date.now());

      // 2. DC-3 / AC-14.5: Аня's refresh tokens are revoked and her access is past its time again -> the call
      //    ends `auth_required` before any request to the server, the model is told to go to «Мой доступ», the
      //    account row is gone and her status is `needs_auth`; her next set has no `backoffice` tool and the agent
      //    keeps working. Борис's account is untouched
      await control.revoke({ account: 'anya', which: 'refresh' });
      await expireAccount(harness, anya);
      const lostAt = anyaFirst.script.calls.length;
      await turn(harness, anyaFirst, READ_AFTER_REVOKE);
      expect((await auditOf(harness, anyaFirst.agentId)).at(-1)).toBe(
        `${anya} ${BACKOFFICE_SERVER}/search_orders auth_required`,
      );
      const lostCallId = anyaFirst.script.calls[lostAt]?.toolCallIds[0];
      expect(toolOutputOf(anyaFirst.script.calls[lostAt + 1]?.messages ?? [], lostCallId)).toContain('«Мой доступ»');
      expect(fixtureCallsOf(fixture.callLog, { tool: 'search_orders', args: ORDERS_REFRESH_REVOKED })).toEqual([]);
      expect(await accountRowOf(harness, anya)).toBeUndefined();
      expect(await connectionLines(harness, anya)).toEqual([`${BACKOFFICE_SERVER} needs_auth`]);
      expect((await turn(harness, anyaFirst, AFTER_LOSS)).toolNames).toEqual([...SESSION_TOOLS, ...LOGS_TOOLS, ...TRACKER_TOOLS]);
      expect(await connectionLines(harness, boris)).toEqual([`${BACKOFFICE_SERVER} connected`]);
      expect((await control.stats('boris')).refreshes).toBe(1);

      // 3. the same loss through the other door: Аня connects again, then her live access token and her
      //    refresh tokens are revoked -> the server answers 401, the one refresh fails -> `auth_required`, row gone
      expect((await connectAccount(harness, anya, BACKOFFICE_SERVER, { account: 'anya' })).outcome).toBe('connected');
      await control.revoke({ account: 'anya', which: 'access' });
      await control.revoke({ account: 'anya', which: 'refresh' });
      const refreshesBefore401 = (await control.stats('anya')).refreshes;
      await turn(harness, anyaFirst, READ_AFTER_401);
      expect((await auditOf(harness, anyaFirst.agentId)).at(-1)).toBe(
        `${anya} ${BACKOFFICE_SERVER}/search_orders auth_required`,
      );
      expect((await control.stats('anya')).refreshes).toBe(refreshesBefore401 + 1);
      expect(fixtureCallsOf(fixture.callLog, { tool: 'search_orders', args: ORDERS_ACCESS_REVOKED })).toEqual([]);
      expect(await accountRowOf(harness, anya)).toBeUndefined();

      // 4. DC-10: Аня connects again; the shared token of `tracker` stops working -> her call ends
      //    `transport_failure` with reason `unauthorized`, and her `backoffice` account stays
      expect((await connectAccount(harness, anya, BACKOFFICE_SERVER, { account: 'anya' })).outcome).toBe('connected');
      await control.revokeShared('tracker');
      await turn(harness, anyaFirst, READ_TICKETS);
      expect((await auditOf(harness, anyaFirst.agentId)).at(-1)).toBe(
        `${anya} ${TRACKER_SERVER}/search_tickets transport_failure`,
      );
      expect(
        harness.logs
          .filter((record) => record.message === 'tool call finished' && record.fields.tool === 'search_tickets')
          .map((record) => `${String(record.fields.outcome)} ${String(record.fields.reason)}`),
      ).toEqual(['transport_failure unauthorized']);
      expect(await accountRowOf(harness, anya)).toBeDefined();
      expect(await connectionLines(harness, anya)).toEqual([`${BACKOFFICE_SERVER} connected`]);

      // 5. UC-E4 (a dropped connection becomes `transport_failure` and the agent goes on) is not repeated here:
      //    packages/agents/test/agent-platform-agents.int.e2e-spec.ts INT-3 F proves it on the same HTTP fixture
      //    (`drop_connection`), plan Notes 11.

      // 6. owner gate inside a script: Аня's confirmed `write` run reads two traces; the first is held on the
      //    fixture, the gate starts refusing Аня, the first is released -> seq 1 `success`, seq 2 `interrupted`
      //    without a reason and never at the server, and her agent fails with `owner_disabled`
      const firstTraceHeld = fixture.latch('anya-first-trace');
      fixture.setFaults([holdCall('get_trace', TRACE_BEFORE_GATE, firstTraceHeld)]);
      const runAt = anyaFirst.script.calls.length;
      await harness.sessions.send({ agentId: anyaFirst.agentId, ownerId: anya, text: RUN_WRITE });
      await waitFor(
        () => harness.sessions.get(anyaFirst.agentId, anya),
        (view) => view.status === 'awaiting_confirmation',
        'the request of the write run',
      );
      const [request] = await harness.sessions.confirmations(anyaFirst.agentId, anya);
      expect(
        await harness.sessions.resolveConfirmation({ decisionId: request?.decisionId ?? '', ownerId: anya, approve: true }),
      ).toBe('resolved');
      await waitFor(
        () => fixtureCallsOf(fixture.callLog, { tool: 'get_trace', args: TRACE_BEFORE_GATE }),
        (calls) => calls.length === 1,
        "the run's first trace at the server",
      );
      refusedOwners.push(anya);
      firstTraceHeld.release();
      await waitForTaskStatus(harness, anyaFirst.agentId, anya, 'failed');
      fixture.setFaults([]);
      const runCallId = anyaFirst.script.calls[runAt]?.toolCallIds[0] ?? '';
      expect(
        (await codeCallRowsOf(harness.db, anyaFirst.agentId, runCallId)).map(
          (row) => `${row.seq} ${row.server}/${row.tool} ${row.outcome} ${row.refusalReason}`,
        ),
      ).toEqual([`1 ${LOGS_SERVER}/get_trace success null`, `2 ${LOGS_SERVER}/get_trace interrupted null`]);
      expect(fixtureCallsOf(fixture.callLog, { tool: 'get_trace', args: TRACE_AFTER_GATE })).toEqual([]);
      const failed = await harness.sessions.get(anyaFirst.agentId, anya);
      expect([failed.status, failed.failureReason]).toEqual(['failed', 'owner_disabled']);
    } finally {
      try {
        for (const server of [LOGS_SERVER, BACKOFFICE_SERVER, TRACKER_SERVER]) await removeServer(harness.agents, server);
      } finally {
        await harness.close();
      }
    }
  }, TEST_TIMEOUT_MS);
});

/** The `run_code` script of INT-2 row 6: two trace reads, before and after the gate refuses. */
function twoTraceReadsScript(): string {
  return [
    `await callTool(${JSON.stringify(GET_TRACE)}, ${JSON.stringify(TRACE_BEFORE_GATE)});`,
    `await callTool(${JSON.stringify(GET_TRACE)}, ${JSON.stringify(TRACE_AFTER_GATE)});`,
    'return "both traces read";',
  ].join('\n');
}

/** Moves the access end of the owner's `backoffice` account a minute into the past (the clock is never faked). */
async function expireAccount(harness: AgentsHarness, ownerId: string): Promise<void> {
  const moved = await harness.db
    .update(agentMcpAccounts)
    .set({ expiresAt: new Date(Date.now() - 60_000) })
    .where(and(eq(agentMcpAccounts.ownerId, ownerId), eq(agentMcpAccounts.server, BACKOFFICE_SERVER)))
    .returning({ ownerId: agentMcpAccounts.ownerId });
  if (moved.length !== 1) throw new Error(`${ownerId} has no ${BACKOFFICE_SERVER} account to expire`);
}

/** The owner's stored `backoffice` account, if any. */
async function accountRowOf(harness: AgentsHarness, ownerId: string) {
  const [row] = await harness.db
    .select()
    .from(agentMcpAccounts)
    .where(and(eq(agentMcpAccounts.ownerId, ownerId), eq(agentMcpAccounts.server, BACKOFFICE_SERVER)));
  return row;
}

/** The owner's account statuses as `<server> <status>` lines. */
async function connectionLines(harness: AgentsHarness, ownerId: string): Promise<string[]> {
  return (await harness.agents.mcp.connections(ownerId)).map((c) => `${c.server} ${c.status}`);
}
