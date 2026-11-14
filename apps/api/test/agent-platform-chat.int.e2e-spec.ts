// agent-platform / chat Integration Test Skeletons - Design Doc: docs/features/agent-platform/design-chat.md (Test Strategy UC-1..UC-8, UC-E1..UC-E3; Flows 1-6; Invariants 1-4; DC-1..DC-5)
// PRD: docs/features/agent-platform/prd.md (FR-14..FR-17 acceptance criteria; the web-facing API for FR-21..FR-24 and FR-29; AC-28.1..AC-28.3 in the chat's share; NFR-02, NFR-06). Upstream: design-agents.md, design-workflows.md, design-runtime.md (Contract Definitions, Test Strategy)
// Generated: 2026-11-14 | Part: chat (backend, apps/api) | Test type: Integration (the real `AppModule` over real Postgres, real runtime + agents + workflows in the api process, scripted model), run by `pnpm --filter api test:e2e`
// Implementation timing: created alongside the slice each test names (INT-1 the conversation over HTTP + SSE; INT-2 the web API over agents, decisions, runs and spend; INT-3 conversation list, title and delete; INT-4 isolation of every endpoint and the stream).
//
// File name and place follow the project convention (`apps/api/test/*.e2e-spec.ts`, picked up by `vitest.config.e2e.ts`, never in the default `vitest run`); the `.int.` infix marks it as in-process, like `packages/agents/test/agent-platform-agents.int.e2e-spec.ts`.
// Started as `it.todo` skeletons; the Given/When/Then comments are the rows' specification. Tests are written with their tasks and run once, at the end of the part (project rule "Tests only at the end").
// The existing `chat-threads`, `app` and `threads` specs and the Mastra-based `test/support` (seed, countMessages, rawMessageContents, createTestMastra, mockModels) are deleted or rewritten by the implementation tasks (Design Doc, "Сборка и что уходит"); this file does not touch them.
//
// Light test process (CLAUDE.md "Tests"): skeletons exist only where a defect is invisible below this level - the HTTP edge, the SSE stream and the NOTIFY hub over a real database, the first-send row lock, the new `chat_conversations` table, and the owner check of every route. Already proven by the lower parts and NOT repeated here:
// step recovery and the process-kill matrix, inbox order and single delivery, the fence, the closure of a stopped tree (runtime INT-1..INT-3, E2E-1); the owner check of the `runtime_*` operations and the ledger/month window/cost rule (runtime INT-4, INT-5); the history loop, interrupt/stop internals, report routing between agents, turn limit, the tool gate and the confirmation lifecycle
// (agents INT-1..INT-4); the brief decision mechanics, the coordinator and the run view's content (workflows part). Here a lower-part behaviour appears only as the wiring that reaches the employee: the HTTP answer, the SSE note, the row the web re-reads.
//
// Environment (Design Doc "Test Strategy"):
// - Postgres 16 from infra/docker-compose.yml (DATABASE_URL from apps/api/.env), migrations applied once by the global setup. The real `AppModule` boots in the process (`createTestApp`, rewritten for this part: no Mastra override), `RUNTIME_WORKERS` on, so the chat answers in the runtime workers, not in the HTTP request. No mock of Postgres, the runtime, agents, workflows, `LiveHub` or the controllers.
// - The model is the only double: a scripted `ModelClient` at the boundary the agents package defines ("модель подменяется сценарием на границе `ModelClient`"), keyed by agent description. A scenario is a list of answers per agent: text parts (so `onTextDelta` is exercised with three parts) and/or tool calls plus `usage`; answers can be gated on a latch to hold a step with its model call in flight. The same double answers `agents.completeText` for the title (answers, fails, or waits per scenario).
// - MCP is the real `packages/mcp-fixture` stdio process through `MCP_SERVERS_FILE` (`logs` read-only with a delayed read; `backoffice` with the mutating `create_incident_note`), `FIXTURE_CALL_LOG` is the evidence of what reached a server; `MCP_ACCESS_TABLE` per test maps the test's owners to servers.
// - The SSE client is a small helper over a raw HTTP request to `GET /api/events` (EventSource is a browser API; the helper parses `event:`/`data:` lines and exposes "wait for the next event of type X" and the received list with arrival times). Requests are made with supertest; the user is the `x-user-id` header, as in the existing e2e specs, and SessionGuard is real.
// - Isolation (project convention, no truncate): a unique owner `newUser()` per test, a unique conversation per test; each test reads only its own data. `fileParallelism: false`. No sleeps for ordering and no latency assertions: tests synchronise on the double's latches, the fixture's latches, SSE events and rows. NFR-02 (a report in the open conversation within 2 s) is asserted as "the `tree` note arrives after the report row and before the test's own wait ends"; the p95 figure belongs to an on-demand script, not to this suite.
// - Support to write alongside (test/support): createTestApp.ts (rewritten: `AppModule` with the scripted `ModelClient` and the fixture config), scriptedModel.ts (scenarios, latches, recorded inputs, title scenarios), sseClient.ts (parse, wait, record), fixtureLog.ts (read and filter the call log), api.ts (typed helpers over supertest validating bodies with the `packages/contracts` schemas: ConversationView, AgentPageView, AgentListPage, ApiErrorSchema).
//
// Budget: Integration 4 of 3 (base 3, extended by one under the integration-e2e-testing rule). Core: INT-1, INT-2, INT-3. Extra: INT-4.
//   INT-4 unique defect: one route or the stream of the part that reads a conversation, an agent, a run, a decision or the spend by id without the owner check, or answers a foreign id differently from a missing one (a leak in itself), or hands another employee's `tree` note or text part to a stream. No lower test can see it: the runtime INT-4 and agents INT-4 cover only the `runtime_*` and `agent_*` operations, not `chat_conversations`, the controllers, the SSE hub or `GET /spend`;
//   NFR-06 asks one two-user test per access point and CLAUDE.md lists isolation first.
//
// E2E: 0 of 1-2 - the file `agent-platform-chat.e2e-spec.ts` is deliberately not generated. The user journey that crosses the browser (the composer, the stream drawn in the feed, the agent tray) belongs to the `web` part's E2E; the API half of the same journey is INT-1 over real HTTP and a real SSE stream. A child-process row here would only repeat the kill matrix of runtime E2E-1; the one restart-specific fact of this part (`ready` after the stream reconnects, state re-read gives the same rows) is INT-1 row E without killing the process.
//
// Proven elsewhere (not in this file; the plan reads this to avoid a second test for an AC already proven):
// - unit, apps/api/src, one table-driven file per rule (literal rows, no database):
//     * the message and rename schemas - empty or whitespace-only text, longer than `CHAT_MESSAGE_MAX_LENGTH`, title after trim 1..`THREAD_TITLE_MAX_LENGTH`, `afterSeq` and cursor shapes (`VALIDATION_FAILED`, `INVALID_CURSOR`) - the contract schemas; the HTTP mapping of one error code is wired by INT-3 row A and INT-4
//     * the chat status derivation (State Transitions): `new`, `idle`, `working`, `awaiting_confirmation`, `interrupted`, `failed`, and "a root stopped by anything but delete shows as `idle`" - from the task and the `AgentView` of the root; the status reaching the web is read in INT-1
//     * the text-part coalescing of `DeltaPublisher` - first part at once, the rest merged within 100 ms, chunks below the NOTIFY payload limit, `offset` arithmetic - the property test: FOR ALL part sequences, the concatenation of the published chunks equals the input and offsets are the running lengths (SHRINK: fewest parts); the end-to-end wiring (delta events reach the stream) is INT-1 row A
//     * the `LiveHub` filter - a note goes to the streams of the conversation's owner; a part goes to the same owner's stream that watches that agent; `watch` parsing (`thread:<id>`, `agent:<id>`, unknown value is not an error) - the rules; the defect "a foreign stream receives it" is INT-4
//     * the cursor of the conversation list and of `GET /agents` (`updatedAt`/`createdAt` + id, stable under equal timestamps) - the format is reused from the current `thread-cursor.ts` tests; the SQL page and the no-duplicate/no-gap walk over 25 rows is INT-3 row A
//     * the title rules - trimmed to `GENERATED_THREAD_TITLE_MAX_LENGTH`, quotes and trailing punctuation stripped (the existing `TitleService` rules, kept) - AC-14.3 in the rules' share
//     * `Confirmation` mapping from `decisions.listTree` (kind, status, `templateTitle`) and the `AgentNode` tree assembly
// - agents, workflows and runtime parts: everything listed under "Light test process" above.
// - not automated: the choice of the FR-15 branch by the real model (AC-15.1, AC-15.4..AC-15.6: a judgement of the prompt, checked by a manual run after the part, per the Design Doc "Test Strategy" and the PRD Assumptions); the time to first token against the current chat (NFR-03: a manual measurement after the part, per the Design Doc risk list); `Last-Event-ID`-free reconnect hint `retry: 2000` and the 20 s `ping` (a constant and a timer of the NestJS `@Sse()` contract, not our rule);
//   removal of `@mastra/*` from `apps/api` (a dependency check of the quality gate, not a test).
//
// AC -> proving test:
// - AC-14.1: INT-1 row A; AC-14.2: INT-1 rows B and C; AC-14.3: INT-3 rows A and B (list, rename, delete, title) + `threads.e2e-spec.ts` (list pages and cursor walk, rename, delete) + unit schemas and title rules; AC-14.4: INT-3 row C
// - AC-15.1: not automated (model choice) - the tool path itself is agents INT-3 row A; AC-15.2, AC-15.3: INT-2 row C (the chat's own list/message/stop tools through the real definition); AC-15.4, AC-28.1..AC-28.3: INT-2 row D (the brief); AC-15.5, AC-15.6: not automated (model choice) - the start itself is INT-1 row B
// - AC-16.1: INT-1 row C; AC-16.2: INT-1 row D
// - AC-17.1, AC-06.1, NFR-02: INT-1 row B; AC-17.2: INT-1 row B (reload); AC-17.3, AC-24.2: INT-1 row B (tool confirmation at depth 2) and INT-2 row D (brief)
// - AC-21.1, AC-21.2: INT-2 row A (list) and INT-4 (foreign); AC-22.1, AC-22.2: INT-2 row B (history of an agent, `inherited`) and INT-1 row B (live notes); AC-23.1, AC-23.2: INT-2 row C (the web routes over send, interrupt, stop, restart)
// - AC-24.1: INT-2 row A (the tree of a conversation) and INT-1 row B (`tree` note); AC-29.1, AC-29.2: INT-2 row E
// - NFR-06 and DC-3, DC-4, AC-13.3 at the HTTP edge: INT-4; DC-5: INT-1 row E; DC-1: INT-1 rows A and F; DC-2: INT-3 row B

import { randomUUID } from 'node:crypto';
import { createLatch, inputLines, modelError, type ScriptedToolCall } from '@agent-os/agents/testing';
import {
  AGENTS_TOOL_CONFIRMATION,
  LiveEventSchema,
  WORKFLOWS_BRIEF_CONFIRMATION,
  type AgentListNode,
  type AgentListPage,
  type AgentNode,
  type ConversationView,
  type HistoryEntry,
} from '@agent-os/contracts';
import { fixtureCallsOf, holdCall } from '@agent-os/mcp-fixture';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIVE_HUB_APPLICATION_NAME } from '../src/chat/live-hub.js';
import { type ChatApi, chatApi, expectError, type Method, waitFor } from './support/api.js';
import { createTestApp, type TestApp } from './support/createTestApp.js';
import { newUser } from './support/new-user.js';
import { openStream, type SseEvent, type SseStream } from './support/sseClient.js';

/** Bound of one test; the rows and notes settle far sooner. */
const TEST_TIMEOUT_MS = 120_000;

/** MCP servers of the fixture (`createTestApp`) and the tools as the model names them. */
const LOGS_SERVER = 'logs';
const BACKOFFICE_SERVER = 'backoffice';
const GET_TRACE = 'mcp__logs__get_trace';
const CREATE_INCIDENT_NOTE = 'mcp__backoffice__create_incident_note';
const GENERAL_PURPOSE = 'general-purpose';
const START_AGENT = 'start_agent';
const START_WORKFLOW = 'start_workflow';
/** `start_agent`'s agent name for a copy of the caller. */
const FORK = 'fork';
/** The shipped workflow template (`packages/workflows`, deep-research.json): name and title. */
const DEEP_RESEARCH = { name: 'deep-research', title: 'Глубокий ресерч' } as const;
/** `AGENT_DEFAULT_MODEL` of the test environment: every agent that names no model runs on it. */
const DEFAULT_MODEL = 'anthropic/claude-haiku-5-5';
/** The title every first message gets (the text script of `beforeAll`). */
const GENERATED_TITLE = 'Conversation title';

/** The `retry:` hint of the stream's first event (EventsController). */
const STREAM_RETRY_MS = 2000;

/**
 * The employees of the file: one per test row. They exist before the app boots, because the access
 * table (`MCP_ACCESS_TABLE`) is read once at the start.
 */
const INT1 = {
  a: newUser(),
  b: newUser(),
  c: newUser(),
  d: newUser(),
  e: newUser(),
  f: newUser(),
} as const;
const INT2 = {
  a: newUser(),
  b: newUser(),
  c: newUser(),
  d: newUser(),
  e: newUser(),
  /** Another owner whose model calls must not reach the spend of `e`. */
  eOther: newUser(),
} as const;
const INT3 = {
  a: newUser(),
  b: newUser(),
  c: newUser(),
} as const;
const INT4 = {
  /** The owner of the data. */
  a: newUser(),
  /** The other employee who calls every route with A's ids. */
  b: newUser(),
} as const;

/** `get_trace` arguments, one per held or plain read call of the file (the fixture counts calls per arguments). */
const TRACE_B = { traceId: 'b1'.repeat(16) };
const TRACE_C = { traceId: 'c1'.repeat(16) };
const TRACE_D1 = { traceId: 'd1'.repeat(16) };
const TRACE_D2 = { traceId: 'd2'.repeat(16) };
const TRACE_INT2_B = { traceId: 'b2'.repeat(16) };
const TRACE_INT2_C = { traceId: 'c2'.repeat(16) };
const TRACE_INT4 = { traceId: 'a4'.repeat(16) };
/** INT-3 C: the child's held read, the read it would make next, and the control conversation's read. */
const TRACE_INT3_C = { traceId: 'c3'.repeat(16) };
const TRACE_INT3_C_NEXT = { traceId: 'c4'.repeat(16) };
const TRACE_INT3_CONTROL = { traceId: 'c5'.repeat(16) };
/** Arguments of the mutating call of INT-1 B. */
const NOTE_B = { orderId: 'ORD-1001', text: 'INT-1 B: customer charged twice' };
/** Arguments of the mutating calls of INT-2 and INT-4 (each waits for a confirmation). */
const NOTE_INT2_A = { orderId: 'ORD-2001', text: 'INT-2 A: grandchild note' };
const NOTE_INT2_B = { orderId: 'ORD-2002', text: 'INT-2 B: helper note' };
const NOTE_INT4 = { orderId: 'ORD-4001', text: 'INT-4: the owner\'s note' };

/** Names of the fixture's file latches: each holds one read call of the file until released. */
const FIXTURE_LATCHES = {
  c: 'int1-c',
  d1: 'int1-d1',
  d2: 'int1-d2',
  int2b: 'int2-b',
  int2c: 'int2-c',
  int3c: 'int3-c',
  int4: 'int4-a',
} as const;

/** A history entry as one literal line: `<kind>: <text>`, an answer with its calls, a result with its outcome. */
function entryLine(entry: HistoryEntry): string {
  switch (entry.kind) {
    case 'task':
    case 'user_message':
    case 'agent_message':
    case 'notice':
      return `${entry.kind}: ${entry.content.text}`;
    case 'model_answer': {
      const calls = entry.content.toolCalls.map((call) =>
        call.server === null ? call.tool : `${call.server}/${call.tool}`,
      );
      return `model_answer: ${entry.content.text} [${calls.join(', ')}]`;
    }
    case 'tool_result':
      return `tool_result: ${entry.content.tool} ${entry.content.outcome}`;
    case 'child_report':
      return `child_report: ${entry.content.description} ${entry.content.status}`;
    case 'event':
      return `event: ${entry.content.event}`;
    case 'compaction':
      return 'compaction';
  }
}

function linesOf(entries: readonly HistoryEntry[]): string[] {
  return entries.map(entryLine);
}

/** The text parts the stream carried, in arrival order (validated with the contract's `LiveEventSchema`). */
function deltasOf(events: readonly SseEvent[]): { agentId: string; offset: number; text: string }[] {
  return events.flatMap((event) => {
    if (event.type !== 'delta') return [];
    const parsed = LiveEventSchema.parse({ type: event.type, data: event.data });
    return parsed.type === 'delta' ? [parsed.data] : [];
  });
}

/**
 * The conversation as the web builds it from live reads: each read asks for the entries after the last
 * one it holds and appends them; the view of the last read carries the decisions and the agent tree.
 */
interface LiveReader {
  readonly entries: HistoryEntry[];
  read(): Promise<ConversationView>;
}

function liveReader(api: ChatApi, threadId: string): LiveReader {
  const entries: HistoryEntry[] = [];
  return {
    entries,
    async read() {
      const view = await api.history(threadId, entries.at(-1)?.seq ?? 0);
      entries.push(...view.entries);
      return view;
    },
  };
}

/**
 * Takes the stream's `tree` notes one by one, re-reading the conversation in the handler of each, until
 * `done` holds: what the test then sees became visible through a note, not through polling.
 */
async function untilNoted(
  stream: SseStream,
  threadId: string,
  read: () => Promise<ConversationView>,
  done: (view: ConversationView) => boolean,
  what: string,
  timeoutMs = 30_000,
): Promise<{ view: ConversationView; note: SseEvent }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const note = await stream.next('tree', Math.max(deadline - Date.now(), 1)).catch((error: unknown) => {
      throw new Error(`No tree note made ${what} visible: ${String(error)}`);
    });
    expect(note.data).toEqual({ threadId });
    const view = await read();
    if (done(view)) return { view, note };
  }
}

/** Waits until the chat of the conversation is free (`idle`) and the view satisfies `done`. */
function untilIdle(
  api: ChatApi,
  threadId: string,
  done: (view: ConversationView) => boolean,
  what: string,
): Promise<ConversationView> {
  return waitFor(
    () => api.history(threadId),
    (view) => view.chat.status === 'idle' && done(view),
    what,
  );
}

/** Whether the read call with these arguments has reached the fixture (and is held there when a rule holds it). */
function untilFixtureCall(args: Readonly<Record<string, unknown>>, callLog: string): Promise<unknown> {
  return waitFor(
    () => fixtureCallsOf(callLog, { tool: 'get_trace', args }),
    (calls) => calls.length === 1,
    `the get_trace call ${JSON.stringify(args)} on the fixture`,
  );
}

/** A `start_agent` call of a scripted answer. */
function startAgent(description: string, prompt: string, agent: string = GENERAL_PURPOSE): ScriptedToolCall {
  return { tool: START_AGENT, args: { agent, description, prompt } };
}

/** `start_workflow` arguments for the deep-research template; an edited decision sends them whole. */
function briefArgs(question: string): { template: string; question: string; boundaries: string; result: string } {
  return { template: DEEP_RESEARCH.name, question, boundaries: '', result: '' };
}

/** The coordinator's task: the brief as `start_workflow` writes it (question, boundaries, result). */
function briefTask(question: string): string {
  return JSON.stringify({ question, boundaries: '', result: '' });
}

/** An agent subtree as one literal line: `<description> [<children>]`. */
function nodeLine(node: AgentNode): string {
  return `${node.description} [${node.children.map(nodeLine).join(', ')}]`;
}

/** Every agent id of a subtree. */
function treeIds(nodes: readonly AgentNode[]): string[] {
  return nodes.flatMap((node) => [node.agentId, ...treeIds(node.children)]);
}

function agentNamed(nodes: readonly AgentNode[], description: string): AgentNode {
  const found = nodes.find((node) => node.description === description);
  if (found === undefined) {
    throw new Error(`No agent "${description}" among [${nodes.map((node) => node.description).join(', ')}]`);
  }
  return found;
}

function rootOf(view: ConversationView): string {
  if (view.chat.rootAgentId === null) throw new Error(`Conversation ${view.thread.id} has no root`);
  return view.chat.rootAgentId;
}

/** Walks `GET /agents` page by page along `nextCursor`. */
async function allAgents(api: ChatApi): Promise<{ pages: AgentListPage[]; agents: AgentListNode[] }> {
  const pages: AgentListPage[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.agentList(cursor);
    pages.push(page);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined && pages.length < 50);
  return { pages, agents: pages.flatMap((page) => page.agents) };
}

/** Whether a stream event is a `tree` note of this thread. */
function isTreeOf(event: SseEvent, threadId: string): boolean {
  if (event.type !== 'tree') return false;
  const parsed = LiveEventSchema.parse({ type: event.type, data: event.data });
  return parsed.type === 'tree' && parsed.data.threadId === threadId;
}

/** One route of the API with the id in its path; the body, when given, is sent as JSON. */
interface RouteCall {
  readonly method: Method;
  readonly path: (id: string) => string;
  readonly body?: object;
}

/**
 * INT-4: the route called with `foreignId` answers exactly as with an id that exists for nobody — the
 * same status and the same whole body — and that answer is 404 with `code`.
 */
async function expectSameAsMissing(api: ChatApi, route: RouteCall, foreignId: string, code: string): Promise<void> {
  const label = `${route.method.toUpperCase()} ${route.path(':id')}${route.body === undefined ? '' : ` ${JSON.stringify(route.body)}`}`;
  const foreign = await api.raw(route.method, route.path(foreignId), route.body);
  const missing = await api.raw(route.method, route.path(randomUUID()), route.body);
  expect({ route: label, status: foreign.status, body: foreign.body as unknown }).toEqual({
    route: label,
    status: missing.status,
    body: missing.body as unknown,
  });
  expect({ route: label, errorCode: (await expectError(missing, 404)).errorCode }).toEqual({ route: label, errorCode: code });
}

/** The agent routes of DC-3 (Contract «Агенты»); a foreign, missing or root id answers `AGENT_NOT_FOUND`. */
const AGENT_ROUTES: readonly RouteCall[] = [
  { method: 'get', path: (id) => `/agents/${id}/history` },
  { method: 'get', path: (id) => `/agents/${id}/inherited` },
  { method: 'get', path: (id) => `/agents/${id}/run` },
  { method: 'post', path: (id) => `/agents/${id}/messages`, body: { text: 'INT-4: a message to someone else\'s agent' } },
  { method: 'post', path: (id) => `/agents/${id}/interrupt` },
  { method: 'post', path: (id) => `/agents/${id}/interrupt`, body: { text: 'INT-4: an interrupt of someone else\'s agent' } },
  { method: 'post', path: (id) => `/agents/${id}/stop` },
  { method: 'post', path: (id) => `/agents/${id}/restart` },
];

/** The conversation routes that take an id (Contract «Беседы»); a foreign or missing id answers `THREAD_NOT_FOUND`. */
const THREAD_ROUTES: readonly RouteCall[] = [
  { method: 'get', path: (id) => `/threads/${id}` },
  { method: 'patch', path: (id) => `/threads/${id}`, body: { title: 'INT-4: renamed by someone else' } },
  { method: 'delete', path: (id) => `/threads/${id}` },
  { method: 'get', path: (id) => `/threads/${id}/history` },
  { method: 'get', path: (id) => `/threads/${id}/agents` },
  { method: 'post', path: (id) => `/threads/${id}/messages`, body: { text: 'INT-4: a message into someone else\'s conversation' } },
  { method: 'post', path: (id) => `/threads/${id}/interrupt` },
  { method: 'post', path: (id) => `/threads/${id}/interrupt`, body: { text: 'INT-4: an interrupt of someone else\'s conversation' } },
];

/**
 * INT-4: the rows of the owner's tree that a foreign call could change — the conversation row (with its
 * row version), the tasks, their queues, histories and decisions. Read through the harness pool: the
 * rows the plan's test names.
 */
async function treeSnapshot(harness: TestApp, threadId: string, rootId: string): Promise<Record<string, unknown[]>> {
  const read = async (sql: string, params: unknown[]): Promise<unknown[]> => (await harness.pool.query(sql, params)).rows;
  return {
    conversation: await read(
      'SELECT id, owner_id, title, root_id, updated_at, xmin::text AS version FROM app.chat_conversations WHERE id = $1',
      [threadId],
    ),
    tasks: await read(
      'SELECT task_id, parent_id, status, wait_reason, step_no, next_message_seq FROM app.runtime_tasks WHERE root_id = $1 ORDER BY task_id',
      [rootId],
    ),
    inbox: await read(
      `SELECT i.message_id, i.recipient_id, i.kind, i.status FROM app.runtime_inbox i
         JOIN app.runtime_tasks t ON t.task_id = i.recipient_id WHERE t.root_id = $1 ORDER BY i.message_id`,
      [rootId],
    ),
    history: await read(
      `SELECT m.task_id, count(*)::int AS entries FROM app.agent_messages m
         JOIN app.runtime_tasks t ON t.task_id = m.task_id WHERE t.root_id = $1 GROUP BY m.task_id ORDER BY m.task_id`,
      [rootId],
    ),
    decisions: await read(
      'SELECT decision_id, status FROM app.runtime_decisions WHERE root_id = $1 ORDER BY decision_id',
      [rootId],
    ),
  };
}

/**
 * INT-3 B (Invariant 4): the owner's ledger rows split into model calls of agents (with a task id) and
 * calls without a task (the title). Read through the harness pool: the rows the plan's test names.
 */
async function ledgerCalls(harness: TestApp, ownerId: string): Promise<{ agentCalls: number; withoutTask: number }> {
  const { rows } = await harness.pool.query<{ agentCalls: number; withoutTask: number }>(
    `SELECT count(task_id)::int AS "agentCalls", (count(*) - count(task_id))::int AS "withoutTask"
       FROM app.runtime_model_calls WHERE owner_id = $1`,
    [ownerId],
  );
  const [counts] = rows;
  if (counts === undefined) throw new Error('the ledger count returned no row');
  return counts;
}

/** INT-3 C: chat sessions of the owner that no conversation names as its root (an orphan root). */
async function orphanChatRoots(harness: TestApp, ownerId: string): Promise<number> {
  const { rows } = await harness.pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM app.agent_sessions s
       WHERE s.owner_id = $1 AND s.definition = 'chat'
         AND NOT EXISTS (SELECT 1 FROM app.chat_conversations c WHERE c.root_id = s.task_id)`,
    [ownerId],
  );
  const [row] = rows;
  if (row === undefined) throw new Error('the orphan count returned no row');
  return row.count;
}

describe('agent-platform / chat - integration (real AppModule + real Postgres + real MCP fixture, scripted model)', () => {
  // One boot of `AppModule` per file (plan Notes 4): two apps with workers over one database would step
  // each other's tasks with the wrong model double.
  let harness: TestApp;

  beforeAll(async () => {
    harness = await createTestApp({
      workers: true,
      agentPageSize: 2,
      mcpAccess: Object.fromEntries(
        [...Object.values(INT1), ...Object.values(INT2), ...Object.values(INT3), ...Object.values(INT4)].map((ownerId) => [
          ownerId,
          [LOGS_SERVER, BACKOFFICE_SERVER],
        ]),
      ),
      faults: (files) => [
        holdCall('get_trace', TRACE_C, files.latch(FIXTURE_LATCHES.c)),
        holdCall('get_trace', TRACE_D1, files.latch(FIXTURE_LATCHES.d1)),
        holdCall('get_trace', TRACE_D2, files.latch(FIXTURE_LATCHES.d2)),
        holdCall('get_trace', TRACE_INT2_B, files.latch(FIXTURE_LATCHES.int2b)),
        holdCall('get_trace', TRACE_INT2_C, files.latch(FIXTURE_LATCHES.int2c)),
        holdCall('get_trace', TRACE_INT3_C, files.latch(FIXTURE_LATCHES.int3c)),
        holdCall('get_trace', TRACE_INT4, files.latch(FIXTURE_LATCHES.int4)),
      ],
    });
    // Every first message starts a title in the background; it answers, so no title call fails.
    harness.model.completeText({ text: GENERATED_TITLE });
    // The SSE client speaks raw HTTP: the app listens on a port of its own.
    await harness.app.listen(0, '127.0.0.1');
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (harness === undefined) return;
    for (const name of Object.values(FIXTURE_LATCHES)) harness.fixtureLog.latch(name).release();
    await harness.close();
  }, TEST_TIMEOUT_MS);

  // ---------------------------------------------------------------------------------------------------------------
  // INT-1  A conversation over HTTP and SSE: the answer arrives in parts, the history is the same after a reload, a busy chat takes a message, an interrupt, a background report, a reconnect
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-14.1: "Given сотрудник отправил сообщение, when чат отвечает, then ответ появляется по мере генерации."
  // AC-14.2: "Given беседа с вызовами инструментов, отчётами агентов и запросами на действия, when сотрудник открывает её снова, then видит всё так же, как видел вживую."
  // AC-16.1: "Given чат отвечает, when сотрудник отправляет новое сообщение, then оно принято, видно в беседе как ожидающее и учитывается чатом на ближайшей границе (FR-07)."
  // AC-16.2: "Given чат отвечает, when сотрудник прерывает ответ, then чат прекращает текущую операцию по FR-08."
  // AC-17.1: "Given беседа открыта, when агент этой беседы сдаёт отчёт, then отчёт появляется без перезагрузки страницы."
  // AC-17.2: "Given беседа закрыта, когда агент сдал отчёт, when сотрудник открывает беседу, then видит отчёт и ответ чата на него."
  // AC-17.3: "Given агент любой глубины в дереве беседы ждёт подтверждения, when сотрудник смотрит беседу, then видит этот запрос и может его решить."
  // AC-06.1: "Given агент сдал отчёт, when родитель свободен, then отчёт начинает его следующий ход: в беседе чат сам отвечает на отчёт, без нового сообщения сотрудника."
  // NFR-02: "Отчёт фонового агента появляется в открытой беседе не позже чем через 2 с после сдачи (p95). Измеряется по отметкам времени в e2e-тесте."
  // DC-1 (Flow 1): "первое сообщение создаёт корень с этим текстом как заданием, а следующие ложатся в его очередь; у беседы не бывает двух корней."
  // DC-5: "После каждого подключения поток первым отправляет `ready`; после восстановления `LISTEN` — тоже."
  // Use cases: UC-1, UC-2, UC-5, UC-7, UC-E2, UC-E3. EARS: When / While. Design flows: Flow 1 (a message and the answer in parts), Flow 2 (a message while the chat works, interrupt), Flow 3 (a background report), Flow 5 (reconnect), KD-1, KD-2, KD-3.
  //
  // Catches: (A) the answer that arrives only whole (the `onTextDelta` hook not wired through `DeltaPublisher` and `LiveHub` to the stream), a first part that waits for the 100 ms merge, `offset` not starting at 0, a delta that is persisted (a draft stored as a second answer in the history), a first message that does not become the task of the root or whose conversation row never gets the root id, a `tree` note without the row it announces;
  //   (B) a report from a background agent that reaches the history but never wakes the stream (no `tree` note on a child's event: the hub resolves the conversation only by the root's own events), a decision of a depth-2 agent missing from the conversation view or showing `open` after the decision, a reload that differs from what the live notes produced (an entry duplicated or lost across the `afterSeq` boundary);
//   (C) a message to a busy chat that is lost, delivered before the result of the running call, or not visible in `pending` while it waits; (D) an interrupt without text that still calls the model or leaves `working`, one with text that does not continue, a "not_active with text" that drops the text (FR-16), an interrupt on a conversation with no root that errors instead of `not_active`;
//   (E) a stream that does not send `ready` first, a `LISTEN` connection lost and never reopened (silent stream forever), a re-read after reconnect that repeats or skips entries; (F) two first messages sent together that create two roots or lose one message (the row lock of KD-1).
// Not re-checked here: the order, single delivery and wake-up of the inbox, the cut-off step and the closure of open calls (runtime INT-2, INT-3; agents INT-2), the tool gate and the decision's one execution (agents INT-3), the history loop and routing of reports between agents (agents INT-1), the chat-status derivation, the coalescing arithmetic and the hub's filter (unit), the foreign owner's stream (INT-4).
// Behavior: HTTP command (202) -> worker step with scripted model -> text parts as `delta` events and the finished step as history rows + `tree` note -> the view re-read from the last number equals the live picture -> pending, interrupt, report and reconnect leave one consistent history
// @category: core-functionality
// @dependency: AppModule (ConversationsService, ConversationsRepository, ThreadsController, EventsController, LiveHub, DeltaPublisher), createRuntime, createAgents (onTextDelta), createWorkflows, scripted model double, MCP fixture (`logs` delayed read, `backoffice` mutating), Postgres
// @complexity: high
//
// Verification items (table-driven by scenario; ids, texts and counts are hardcoded literals):
// - Row A "first message, answer in parts, then the same after a reload" (UC-1, AC-14.1, DC-1): a new conversation (`POST /threads`, empty title, no root, `GET .../history` shows chat status `new` and no entries); the SSE stream is open with `watch=thread:<id>` and its first event is `ready`; the scenario answers the first message with three text parts. `POST .../messages` answers 202 with an empty `messageId`.
//   Then: the stream carries `delta` events whose `offset` starts at 0 and whose texts concatenate to the final answer, then a `tree` note with the thread id; `GET .../history?afterSeq=0` shows the task entry with the message text and exactly ONE `model_answer` with the joined text, the conversation row now has the root id (`rootAgentId` in the view), status `idle`; no entry holds a part of the answer; the second message returns a non-empty `messageId`, lands in the SAME root's history (same `rootAgentId`) and produces one more answer.
// - Row B "a background agent reports into the open conversation; the reload equals the live picture" (UC-2, UC-7, AC-14.2, AC-17.1..AC-17.3, AC-06.1, NFR-02): the stream is open on the thread; the chat's script calls the read `logs` tool, then `start_agent` (general-purpose), then answers text; the child asks the mutating `create_incident_note` (held for confirmation, depth 2), then after the decision reports. The test reads `GET .../history` after each `tree` note, with the last `nextAfterSeq`.
//   Then: a `tree` note arrives when the child starts, one when its request opens (the view lists the request under `decisions` with status `open`, the agent description and the arguments, and the chat status is still `idle`/`working` without a new employee message), one after `POST /decisions/:id` (200 `resolved`; the request now reads `resolved` with the decision and the final arguments), one when the child reports; the report is a `child_report` entry in the root history, followed by a chat `model_answer` that the test never asked for; the `tree` note for the report arrives after the report row exists (the row is read in the handler of the note) and within the test's own 2 s wait (NFR-02 shape);
//   the fixture journal has exactly one `create_incident_note`. A fresh read of the view with `afterSeq=0` returns the same entries, the same call outcomes, the same `resolved` request and the same `agents` tree as the sum of the incremental reads (equal after sorting by seq, no duplicate seq, no gap).
// - Row C "a message to a busy chat waits in pending and lands after the result" (UC-5, AC-16.1): the chat's step holds a delayed `logs` read call; `POST .../messages` twice. Then: both return 202 with distinct `messageId`s; `GET .../history` lists them in `pending` in order with `source` `user` while the call is held and the chat status is `working`; after the release the history reads `tool_result`, message 1, message 2, `model_answer`, `pending` is empty, and the model's next input saw both after the result.
// - Row D "interrupt with and without text" (UC-5, AC-16.2; two cases + the not-active case): (1) the same held call, `POST .../interrupt` with text -> 200 `interrupted`; once the step runs the open call has outcome `interrupted`, the text stands after it and the chat continues (status `working`, then `idle`). (2) The held call again, `POST .../interrupt` without text -> 200 `interrupted`, status `interrupted`, the model double's call counter unchanged until the next message, which clears it. (3) A free chat (status `idle`) and a conversation with no root: `interrupt` without text -> 200 `not_active`; `interrupt` with text on the free chat -> 200 `not_active` WITH a `messageId`, and the text is in the history as an ordinary delivered message (not lost).
// - Row E "reconnect" (UC-E2, DC-5): a second stream to the same thread after the first was dropped by the client: its first event is `ready` and no earlier note is replayed; the view re-read from the last known number returns only entries after it (none duplicated). Then the hub's `LISTEN` backend is terminated in the database (`pg_terminate_backend` on the session whose `application_name`/query is the `LISTEN`, found through `pg_stat_activity`); the open stream receives a new `ready`, and an entry written after that produces a `tree` note again.
// - Row F "two first messages at once" (UC-E3, DC-1, Invariant 1): a conversation with no root; two `POST .../messages` are started in the same tick. Then: both return 202; exactly one has an empty `messageId` (the task) and the other a non-empty one (the queue); the history holds ONE task entry and ONE delivered/pending message; `GET /threads/:id/agents` and the root id are single (no second root created: the count of sessions of the owner with the `chat` definition is 1).
  it('INT-1 A: the first message creates the root with its text as the task, the answer arrives as delta events from offset 0 followed by a tree note, the history holds one answer and no draft, and the next message goes to the same root', async () => {
    // Given: a new conversation (no root, status `new`) and a stream watching it
    const api = chatApi(harness.app, INT1.a);
    const firstMessage = 'INT-1 A: what does the trace show?';
    const secondMessage = 'INT-1 A: and what caused them?';
    // The answer is held until the 202 is back, so the conversation row already names the root when
    // the parts are published (a part of a root no conversation names yet is not routed to a thread).
    const answerHeld = createLatch();
    const chat = harness.model.script({ task: firstMessage }, [
      { text: ['The trace ', 'shows two ', 'errors.'], latch: answerHeld },
      { text: 'Both errors are timeouts.' },
    ]);
    const thread = await api.createThread();
    expect(thread.title).toBeNull();
    const empty = await api.history(thread.id);
    expect([empty.chat.status, empty.chat.rootAgentId, empty.chat.model, empty.entries]).toEqual(['new', null, null, []]);
    const stream = await openStream(harness.app, INT1.a, `thread:${thread.id}`);
    try {
      const ready = await stream.next('ready');
      expect(stream.events[0]?.type).toBe('ready');
      expect(ready.retry).toBe(STREAM_RETRY_MS);

      // When: the first message is sent and the answer streams in three parts
      expect(await api.send(thread.id, firstMessage)).toEqual({ messageId: null });
      await answerHeld.reached();
      answerHeld.open();

      // Then: the parts arrive as delta events from offset 0, the first part alone, the texts adding up to the answer
      await stream.until(
        (events) => deltasOf(events).map((delta) => delta.text).join('') === 'The trace shows two errors.',
        'the whole first answer in delta events',
      );
      const deltas = deltasOf(stream.events);
      expect(deltas[0]).toMatchObject({ offset: 0, text: 'The trace ' });
      expect(deltas.map((delta) => delta.offset)).toEqual(
        deltas.map((_, index) => deltas.slice(0, index).reduce((length, delta) => length + delta.text.length, 0)),
      );

      // Then: a tree note announces the answer row; the history holds the task and ONE answer, no draft
      const reader = liveReader(api, thread.id);
      await untilNoted(
        stream,
        thread.id,
        () => reader.read(),
        () => reader.entries.some((entry) => entry.kind === 'model_answer'),
        'the first answer',
      );
      const answered = await untilIdle(api, thread.id, (view) => view.entries.length === 2, 'the first answer to settle');
      expect(linesOf(answered.entries)).toEqual([
        'task: INT-1 A: what does the trace show?',
        'model_answer: The trace shows two errors. []',
      ]);
      const rootId = answered.chat.rootAgentId;
      if (rootId === null) throw new Error('the conversation row did not get the root id');
      expect(new Set(deltas.map((delta) => delta.agentId))).toEqual(new Set([rootId]));
      expect(chat.calls).toHaveLength(1);

      // When: the next message is sent
      const second = await api.send(thread.id, secondMessage);

      // Then: it is queued (a message id), lands in the SAME root's history and gets one more answer
      expect(second.messageId).toEqual(expect.any(String));
      await chat.called(2);
      const continued = await untilIdle(api, thread.id, (view) => view.entries.length === 4, 'the second answer');
      expect(continued.chat.rootAgentId).toBe(rootId);
      expect(linesOf(continued.entries)).toEqual([
        'task: INT-1 A: what does the trace show?',
        'model_answer: The trace shows two errors. []',
        'user_message: INT-1 A: and what caused them?',
        'model_answer: Both errors are timeouts. []',
      ]);
    } finally {
      answerHeld.open();
      stream.close();
    }
  }, TEST_TIMEOUT_MS);

  it('INT-1 B: a background agent\'s tool confirmation and report reach the open stream as tree notes, the decision resolves, the chat answers the report by itself, and a reload returns exactly what the live reads produced', async () => {
    // Given: the chat reads a trace, starts a general-purpose writer and answers; the writer asks to
    // create an incident note (held for confirmation) and, after the decision, reports
    const api = chatApi(harness.app, INT1.b);
    const task = 'INT-1 B: check the trace and have the incident noted';
    const writerTask = 'INT-1 B: write the incident note';
    const reportHeld = createLatch();
    harness.model.script({ task }, [
      { calls: [{ tool: GET_TRACE, args: TRACE_B }] },
      {
        calls: [
          {
            tool: 'start_agent',
            args: { agent: GENERAL_PURPOSE, description: 'incident writer', prompt: writerTask },
          },
        ],
      },
      { text: 'A writer is filing the note.' },
      { text: 'The writer filed the note.' },
    ]);
    harness.model.script({ task: writerTask }, [
      { calls: [{ tool: CREATE_INCIDENT_NOTE, args: NOTE_B }] },
      { text: 'Note filed.', latch: reportHeld },
    ]);
    const thread = await api.createThread();
    const stream = await openStream(harness.app, INT1.b, `thread:${thread.id}`);
    const reader = liveReader(api, thread.id);
    try {
      await stream.next('ready');

      // When: the employee sends the message
      expect(await api.send(thread.id, task)).toEqual({ messageId: null });

      // Then: a tree note shows the writer started under the chat
      const started = await untilNoted(stream, thread.id, () => reader.read(), (view) => view.agents.length === 1, 'the writer');
      expect(
        started.view.agents.map((agent) => `${agent.definition} ${agent.description} ${agent.children.length}`),
      ).toEqual(['general-purpose incident writer 0']);
      const writerId = started.view.agents[0]?.agentId;

      // Then: a tree note shows its request open, with the agent's description and the arguments,
      // while the chat itself took no new employee message
      const requested = await untilNoted(
        stream,
        thread.id,
        () => reader.read(),
        (view) => view.decisions.some((decision) => decision.status === 'open'),
        'the writer\'s open request',
      );
      expect(requested.view.decisions).toHaveLength(1);
      const [request] = requested.view.decisions;
      if (request === undefined) throw new Error('no request in the view');
      expect(request).toMatchObject({
        agentId: writerId,
        description: 'incident writer',
        kind: AGENTS_TOOL_CONFIRMATION,
        tool: 'create_incident_note',
        server: 'backoffice',
        args: NOTE_B,
        status: 'open',
        resolution: null,
        // The fixture server's title of the tool and of its arguments, read from its tool list
        toolTitle: 'Создать заметку по инциденту',
        argLabels: { orderId: 'Заказ', text: 'Текст' },
      });
      expect(['idle', 'working']).toContain(requested.view.chat.status);
      expect(requested.view.pending).toEqual([]);

      // When: the employee approves the request from the conversation
      expect(await api.decide(request.decisionId, { approve: true })).toEqual({ outcome: 'resolved' });

      // Then: a tree note shows it resolved, with the decision and the final arguments
      const resolved = await untilNoted(
        stream,
        thread.id,
        () => reader.read(),
        (view) => view.decisions[0]?.status === 'resolved',
        'the resolved request',
      );
      expect(resolved.view.decisions).toHaveLength(1);
      expect(resolved.view.decisions[0]).toMatchObject({
        decisionId: request.decisionId,
        status: 'resolved',
        resolution: { approve: true, args: NOTE_B },
      });

      // When: the writer reports
      await reportHeld.reached();
      reportHeld.open();

      // Then (NFR-02 shape): the tree note whose re-read shows the report arrives within the test's 2 s wait
      await untilNoted(
        stream,
        thread.id,
        () => reader.read(),
        () => reader.entries.some((entry) => entry.kind === 'child_report'),
        'the writer\'s report',
        2_000,
      );
      // Then: the chat answers the report by itself, without an employee message
      await untilNoted(
        stream,
        thread.id,
        () => reader.read(),
        () => reader.entries.at(-1)?.kind === 'model_answer' && reader.entries.some((entry) => entry.kind === 'child_report'),
        'the chat\'s answer to the report',
      );
      await untilIdle(api, thread.id, (view) => view.entries.length === 8, 'the chat to settle after the report');
      const live = await reader.read();
      expect(linesOf(reader.entries)).toEqual([
        'task: INT-1 B: check the trace and have the incident noted',
        'model_answer:  [logs/get_trace]',
        'tool_result: get_trace success',
        'model_answer:  [start_agent]',
        'tool_result: start_agent success',
        'model_answer: A writer is filing the note. []',
        'child_report: incident writer completed',
        'model_answer: The writer filed the note. []',
      ]);
      expect(fixtureCallsOf(harness.fixtureLog.callLog, { tool: 'create_incident_note', args: NOTE_B })).toHaveLength(1);

      // Then: a reload from the start equals the sum of the live reads: no duplicate seq, no gap, the
      // same call outcomes, the same resolved request and the same agent tree
      const reloaded = await api.history(thread.id, 0);
      const liveSeqs = reader.entries.map((entry) => entry.seq);
      expect(new Set(liveSeqs).size).toBe(liveSeqs.length);
      expect(reloaded.entries.map((entry) => entry.seq)).toEqual(liveSeqs);
      expect(linesOf(reloaded.entries)).toEqual(linesOf(reader.entries));
      expect(reloaded.entries.filter((entry) => entry.kind === 'tool_result')).toEqual(
        reader.entries.filter((entry) => entry.kind === 'tool_result'),
      );
      expect(reloaded.decisions).toEqual(live.decisions);
      expect(reloaded.agents).toEqual(live.agents);
      expect(reloaded.agents.map((agent) => agent.status)).toEqual(['completed']);
    } finally {
      reportHeld.open();
      stream.close();
    }
  }, TEST_TIMEOUT_MS);

  it('INT-1 C: messages sent to a busy chat wait in pending in order and land after the running call\'s result', async () => {
    // Given: the chat's read call is held on the fixture
    const api = chatApi(harness.app, INT1.c);
    const task = 'INT-1 C: read the slow trace';
    const held = harness.fixtureLog.latch(FIXTURE_LATCHES.c);
    const chat = harness.model.script({ task }, [
      { calls: [{ tool: GET_TRACE, args: TRACE_C }] },
      { text: 'Read the trace and both messages.' },
    ]);
    const thread = await api.createThread();
    try {
      await api.send(thread.id, task);
      await untilFixtureCall(TRACE_C, harness.fixtureLog.callLog);

      // When: two messages are sent while the call is held
      const first = await api.send(thread.id, 'INT-1 C: first while busy');
      const second = await api.send(thread.id, 'INT-1 C: second while busy');

      // Then: both are accepted with distinct ids and wait in `pending`, in order, while the chat works
      expect([typeof first.messageId, typeof second.messageId]).toEqual(['string', 'string']);
      expect(second.messageId).not.toBe(first.messageId);
      const busy = await api.history(thread.id);
      expect(busy.chat.status).toBe('working');
      expect(
        busy.pending.map((message) =>
          message.source === 'report' ? 'report' : `${message.source} ${message.text}`,
        ),
      ).toEqual(['user INT-1 C: first while busy', 'user INT-1 C: second while busy']);
      expect(busy.pending.map((message) => message.messageId)).toEqual([first.messageId, second.messageId]);

      // When: the call is released
      held.release();
      await chat.called(2);

      // Then: the result comes first, then the two messages in order, then the answer; nothing pending
      const settled = await untilIdle(api, thread.id, (view) => view.entries.length === 6, 'the answer after the result');
      expect(linesOf(settled.entries)).toEqual([
        'task: INT-1 C: read the slow trace',
        'model_answer:  [logs/get_trace]',
        'tool_result: get_trace success',
        'user_message: INT-1 C: first while busy',
        'user_message: INT-1 C: second while busy',
        'model_answer: Read the trace and both messages. []',
      ]);
      expect(settled.pending).toEqual([]);
      // Then: the model's next input saw both messages after the result
      expect(inputLines(chat.calls[1]?.messages ?? []).slice(-3)).toEqual([
        'tool: mcp__logs__get_trace',
        'user: INT-1 C: first while busy',
        'user: INT-1 C: second while busy',
      ]);
    } finally {
      held.release();
    }
  }, TEST_TIMEOUT_MS);

  it('INT-1 D: interrupt with text continues with the text, without text leaves the chat interrupted and silent, and on a free chat returns not_active and still delivers the text', async () => {
    const api = chatApi(harness.app, INT1.d);
    const heldWithText = harness.fixtureLog.latch(FIXTURE_LATCHES.d1);
    const heldWithoutText = harness.fixtureLog.latch(FIXTURE_LATCHES.d2);
    try {
      // Case 1 - Given: the chat's read call is held; When: it is interrupted with text
      const withTextTask = 'INT-1 D: read the first trace';
      const continuationHeld = createLatch();
      const withText = harness.model.script({ task: withTextTask }, [
        { calls: [{ tool: GET_TRACE, args: TRACE_D1 }] },
        { text: 'Switched to the other trace.', latch: continuationHeld },
        { text: 'Noted the late remark.' },
      ]);
      const first = await api.createThread();
      await api.send(first.id, withTextTask);
      await untilFixtureCall(TRACE_D1, harness.fixtureLog.callLog);
      expect(await api.interrupt(first.id, 'INT-1 D: look at the other trace instead')).toEqual({
        outcome: 'interrupted',
      });

      // Then: the chat goes on with the text (status `working`), then is free; the open call reads
      // `interrupted` and the text stands after it
      await continuationHeld.reached();
      expect((await api.history(first.id)).chat.status).toBe('working');
      continuationHeld.open();
      const continued = await untilIdle(api, first.id, (view) => view.entries.length === 6, 'the answer to the interrupt');
      expect(linesOf(continued.entries)).toEqual([
        'task: INT-1 D: read the first trace',
        'model_answer:  [logs/get_trace]',
        'tool_result: get_trace interrupted',
        'event: interrupted',
        'user_message: INT-1 D: look at the other trace instead',
        'model_answer: Switched to the other trace. []',
      ]);
      heldWithText.release();

      // Case 2 - Given: another conversation whose read call is held; When: it is interrupted without text
      const withoutTextTask = 'INT-1 D: read the second trace';
      const withoutText = harness.model.script({ task: withoutTextTask }, [
        { calls: [{ tool: GET_TRACE, args: TRACE_D2 }] },
        { text: 'Carrying on with the message.' },
      ]);
      const second = await api.createThread();
      await api.send(second.id, withoutTextTask);
      await untilFixtureCall(TRACE_D2, harness.fixtureLog.callLog);
      expect(await api.interrupt(second.id)).toEqual({ outcome: 'interrupted' });

      // Then: the chat is `interrupted`, the history ends with the event, and the model was not called again
      const interrupted = await waitFor(
        () => api.history(second.id),
        (view) => view.chat.status === 'interrupted' && linesOf(view.entries).at(-1) === 'event: interrupted',
        'the interrupted chat',
      );
      expect(linesOf(interrupted.entries)).toEqual([
        'task: INT-1 D: read the second trace',
        'model_answer:  [logs/get_trace]',
        'tool_result: get_trace interrupted',
        'event: interrupted',
      ]);
      heldWithoutText.release();
      expect(withoutText.calls).toHaveLength(1);

      // When: the next message comes; Then: it clears the mark and the chat answers it
      await api.send(second.id, 'INT-1 D: go on');
      await withoutText.called(2);
      const resumed = await untilIdle(api, second.id, (view) => view.entries.length === 6, 'the answer after the interrupt');
      expect(linesOf(resumed.entries).slice(-2)).toEqual([
        'user_message: INT-1 D: go on',
        'model_answer: Carrying on with the message. []',
      ]);

      // Case 3 - Given: a conversation with no root and the free chat of case 1
      const noRoot = await api.createThread();

      // Then: an interrupt without text is `not_active` on both, and nothing is created
      expect(await api.interrupt(noRoot.id)).toEqual({ outcome: 'not_active' });
      expect((await api.history(noRoot.id)).chat.status).toBe('new');
      expect(await api.interrupt(first.id)).toEqual({ outcome: 'not_active' });

      // When: an interrupt with text reaches the free chat
      const late = await api.interrupt(first.id, 'INT-1 D: one more remark');

      // Then: `not_active` with a message id, and the text is delivered as an ordinary message
      expect(late).toEqual({ outcome: 'not_active', messageId: expect.any(String) });
      await withText.called(3);
      const delivered = await untilIdle(api, first.id, (view) => view.entries.length === 8, 'the answer to the late remark');
      expect(linesOf(delivered.entries).slice(-2)).toEqual([
        'user_message: INT-1 D: one more remark',
        'model_answer: Noted the late remark. []',
      ]);
    } finally {
      heldWithText.release();
      heldWithoutText.release();
    }
  }, TEST_TIMEOUT_MS);

  it('INT-1 E: a new stream opens with ready, and after the hub\'s LISTEN connection is cut the stream gets ready again and notes resume without duplicated or lost entries', async () => {
    // Given: a conversation with one answered message, read live through a first stream
    const api = chatApi(harness.app, INT1.e);
    const task = 'INT-1 E: first message';
    harness.model.script({ task }, [
      { text: 'First answer.' },
      { text: 'Second answer.' },
      { text: 'Third answer.' },
    ]);
    const thread = await api.createThread();
    const reader = liveReader(api, thread.id);
    const firstStream = await openStream(harness.app, INT1.e, `thread:${thread.id}`);
    let secondStream: SseStream | undefined;
    try {
      await firstStream.next('ready');
      await api.send(thread.id, task);
      await untilNoted(
        firstStream,
        thread.id,
        () => reader.read(),
        () => reader.entries.some((entry) => entry.kind === 'model_answer'),
        'the first answer',
      );
      await untilIdle(api, thread.id, (view) => view.entries.length === 2, 'the first answer to settle');
      await reader.read();
      const lastSeq = reader.entries.at(-1)?.seq ?? 0;

      // When: the client drops the stream and opens a new one
      firstStream.close();
      secondStream = await openStream(harness.app, INT1.e, `thread:${thread.id}`);

      // Then: its first event is `ready` and no earlier note is replayed
      const ready = await secondStream.next('ready');
      expect(ready.retry).toBe(STREAM_RETRY_MS);
      expect(secondStream.events.map((event) => event.type)).toEqual(['ready']);

      // Then: a re-read from the last known number returns only the entries after it
      await api.send(thread.id, 'INT-1 E: second message');
      await untilNoted(
        secondStream,
        thread.id,
        () => reader.read(),
        () => reader.entries.filter((entry) => entry.kind === 'model_answer').length === 2,
        'the second answer',
      );
      await untilIdle(api, thread.id, (view) => view.entries.length === 4, 'the second answer to settle');
      expect(linesOf((await api.history(thread.id, lastSeq)).entries)).toEqual([
        'user_message: INT-1 E: second message',
        'model_answer: Second answer. []',
      ]);

      // When: the hub's LISTEN connection is terminated in the database
      const { rows: hubSessions } = await harness.pool.query<{ pid: number }>(
        'SELECT pid FROM pg_stat_activity WHERE application_name = $1 AND datname = current_database()',
        [LIVE_HUB_APPLICATION_NAME],
      );
      expect(hubSessions.length).toBeGreaterThanOrEqual(1);
      for (const { pid } of hubSessions) {
        await harness.pool.query('SELECT pg_terminate_backend($1)', [pid]);
      }

      // Then: the open stream gets `ready` again once LISTEN is back, and a new entry is announced by a note
      await secondStream.next('ready', 15_000);
      await api.send(thread.id, 'INT-1 E: third message');
      await untilNoted(
        secondStream,
        thread.id,
        () => reader.read(),
        () => reader.entries.filter((entry) => entry.kind === 'model_answer').length === 3,
        'the third answer after LISTEN came back',
      );
      await untilIdle(api, thread.id, (view) => view.entries.length === 6, 'the third answer to settle');
      await reader.read();

      // Then: the live reads hold every entry once, as a reload does
      expect(linesOf(reader.entries)).toEqual([
        'task: INT-1 E: first message',
        'model_answer: First answer. []',
        'user_message: INT-1 E: second message',
        'model_answer: Second answer. []',
        'user_message: INT-1 E: third message',
        'model_answer: Third answer. []',
      ]);
      const reloaded = await api.history(thread.id, 0);
      expect(reloaded.entries.map((entry) => entry.seq)).toEqual(reader.entries.map((entry) => entry.seq));
    } finally {
      firstStream.close();
      secondStream?.close();
    }
  }, TEST_TIMEOUT_MS);

  it('INT-1 F: two first messages sent together create one root, one is the task and the other sits in its queue', async () => {
    // Given: a conversation with no root; either message may become the task
    const api = chatApi(harness.app, INT1.f);
    const one = 'INT-1 F: first of two at once';
    const two = 'INT-1 F: second of two at once';
    harness.model.script({ task: one }, [], { thereafter: { text: 'Answer to F.' } });
    harness.model.script({ task: two }, [], { thereafter: { text: 'Answer to F.' } });
    const thread = await api.createThread();

    // When: two messages are sent in the same tick
    const answers = await Promise.all([api.send(thread.id, one), api.send(thread.id, two)]);

    // Then: exactly one is the task (no message id) and the other went to the queue
    expect(answers.map((answer) => answer.messageId === null).sort((a, b) => Number(a) - Number(b))).toEqual([false, true]);
    const taskText = answers[0]?.messageId === null ? one : two;
    const queuedText = taskText === one ? two : one;
    const settled = await untilIdle(
      api,
      thread.id,
      (view) => view.pending.length === 0 && view.entries.some((entry) => entry.kind === 'user_message'),
      'both messages delivered',
    );
    expect(linesOf(settled.entries.filter((entry) => entry.kind === 'task' || entry.kind === 'user_message'))).toEqual([
      `task: ${taskText}`,
      `user_message: ${queuedText}`,
    ]);

    // Then: one root: the conversation has no other agent and the owner has one chat session
    expect(await api.threadAgents(thread.id)).toEqual([]);
    const { rows } = await harness.pool.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM app.agent_sessions WHERE owner_id = $1 AND definition = 'chat'",
      [INT1.f],
    );
    expect(rows).toEqual([{ count: 1 }]);
  }, TEST_TIMEOUT_MS);

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2  The web API over agents, decisions, runs and spend: tree, agent history, controls, brief decision, month's spend
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-21.1: "Given сотрудник запустил агента из беседы, when открыт список агентов, then агент появляется в списке без перезагрузки, а смена его статуса видна сразу."
  // AC-22.1: "Given агент работал, when сотрудник открывает его, then видит задание, ответы модели, вызовы инструментов с аргументами и результатами, доставленные и ожидающие сообщения, запросы на действия и отчёты дочерних агентов."
  // AC-23.1: "Given агент открыт, when сотрудник отправляет сообщение, then оно видно как ожидающее до доставки и доставляется по FR-07."
  // AC-23.2: "Given агент открыт, when сотрудник прерывает, останавливает, продолжает или запускает его с нуля, then исход совпадает с FR-08 и FR-09, а новый статус виден в истории и в списке."
  // AC-24.1: "Given в беседе идёт workflow deep-research, when сотрудник смотрит беседу, then видит агентов, которых вызвал координатор, и их статусы, и картина обновляется без перезагрузки."
  // AC-24.2: "Given в беседе ждёт запрос на действие или бриф, when сотрудник решает его в беседе, then исход совпадает с AC-12.3, AC-12.4 или AC-28.2, AC-28.3."
  // AC-15.2: "Given беседа, when сотрудник спрашивает, какие агенты работают, then чат перечисляет агентов этой беседы с их статусами."
  // AC-15.3: "Given в беседе работает агент, when сотрудник просит чат написать агенту или остановить его, then сообщение доставляется по FR-07, а остановка происходит по FR-08."
  // AC-15.4: "Given беседа, when вопрос сотрудника подходит под описание шаблона deep-research или сотрудник называет шаблон по имени, then чат готовит бриф (FR-28), а не запускает workflow сразу." (the wiring: a `start_workflow` call becomes a brief request, not a run)
  // AC-28.1: "Given чат подготовил бриф, when сотрудник ещё не решил, then workflow не запущен, а бриф ждёт решения в беседе."
  // AC-28.2: "Given бриф ждёт, when сотрудник подтверждает его, в том числе исправив текст, then запускается один workflow, и его агенты получают подтверждённый бриф, но не историю беседы."
  // AC-28.3: "Given бриф ждёт, when сотрудник отказывается, then workflow не запускается, а чат получает результат «отклонено пользователем» (как AC-12.4)."
  // AC-29.1: "Given у сотрудника в этом месяце были вызовы модели, when он открывает веб, then видит сумму их стоимостей, и она совпадает с журналом токенов."
  // AC-29.2: "Given агент сотрудника потратил ещё, when сотрудник перезагружает страницу, then цифра включает новые вызовы."
  // Contract (DC-3, Contract Definitions "Агенты"): "Корень беседы для этих маршрутов не существует: `AGENT_NOT_FOUND`." (asserted in INT-4 with the foreign ids)
  // Use cases: UC-6, UC-8. EARS: When / While. Design flows: Flow 4 (a decision from the web), KD-5, KD-6, KD-7, Contract Definitions ("Агенты", "Решения и расход").
  //
  // Catches: (A) a `GET /agents` page that misses the agents of an older conversation, repeats an agent across pages, includes the chat root itself, or a count (`/agents/awaiting`) that ignores a request of a depth-2 agent or counts a resolved one (KD-7: the list is assembled from the owner's conversations, the one place a loop over `chat_conversations` can be wrong); `GET /threads/:id/agents` that lists the root or another conversation's agents;
  //   (B) an agent page that does not carry the thread id and title, an `inherited` route that returns the parent's entries beyond `throughSeq` or for an agent that is not a fork, a `GET /agents/:id/run` that answers 200 for an agent that is not a run's coordinator (`RUN_NOT_FOUND`) or fails to map `WorkflowRunView`;
  //   (C) a control route that is not wired to its operation (message answers 202 without queuing, stop answers without listing the stopped ids, restart of a working agent not `409 NOT_FINISHED`, restart after the parent finished not `409 PARENT_FINISHED`, `interrupt` not_active with text dropping the text), and the chat's own tools (`list_agents`, `message_agent`, `stop_agent`) missing from the registered `chat` definition or wired to another conversation's agents;
  //   (D) a brief that starts a run at once or twice, a corrected question that does not reach the brief, a `POST /decisions` that answers 500 or 200 for a schema-failing edit (`INVALID_ARGUMENTS` must be 400 and the request still open), a second resolve that is not `already_resolved`, a rejected brief that starts a run; (E) a `GET /spend` that is not the ledger sum of the month (UTC), that drops the rows without a `taskId` (title calls, Invariant 4), or that falls after `deleteTree`.
// Not re-checked here: the tool-confirmation lifecycle and its one execution (agents INT-3, runtime E2E-1), the coordinator's own steps and the run view's content (workflows part), the status derivation and the `Confirmation`/`AgentNode` mapping (unit), the cost of a call and the month window (runtime INT-5), the foreign owner's answers (INT-4), the stream notes (INT-1).
// Behavior: the web reads the owner's agents, one agent's page, a run and the month's spend -> the controls and the decision change the state through the same operations as the chat -> the next read shows the new state and the right HTTP outcome
// @category: core-functionality
// @dependency: AppModule (AgentControlService, AgentsController, DecisionsController, SpendController, ThreadsController), createAgents (sessions.list/history/send/interrupt/stop/restart/confirmations, completeText), createWorkflows (runs.get, start_workflow), createRuntime (ledger.monthSpend), scripted model double, MCP fixture, Postgres
// @complexity: high
//
// Verification items (table-driven by route family; every row validates the body with the contract schema and asserts literal ids and counts):
// - Row A "the tree and the list" (AC-21.1, AC-24.1, KD-7): owner U has three conversations; two hold agents (one with a parent-child pair), one has no root; the test starts five top agents in total and the app's `AGENT_PAGE_SIZE` is set to 2 for this test (if the constant is not overridable, the test starts 21 agents) so the cursor walk is visible. Then: `GET /agents` lists the top agents (children of roots), newest first, with subtrees, `threadId` and `threadTitle`; walking `nextCursor` returns each top agent exactly once and no root; `GET /threads/:id/agents` returns that conversation's tree without the root; `GET /agents/awaiting` equals the number of open requests across all conversations, counts an open request of a grandchild and drops it after the decision; the status of an agent seen in the list changes after `stop` (AC-21.1 "смена статуса").
// - Row B "one agent's page and the fork's inherited history" (AC-22.1): an agent that made a read call, got a pending message while a call was held, received a child's report. Then: `GET /agents/:id/history?afterSeq=0` returns `agent` (with `threadId`, `threadTitle`, model), `entries` in order (task, `model_answer`, call with arguments and outcome, `child_report`), `pending` with the waiting message, `decisions` of this agent only, `children`; a fork's `inherited` returns the parent's entries up to `throughSeq` and nothing after it, and for a non-fork returns an empty page; `GET /agents/:id/run` for the coordinator of a workflow run returns the `WorkflowRunView` (status and steps as scripted), for a plain agent returns 404 `RUN_NOT_FOUND`.
// - Row C "the controls, and the chat's own tools" (AC-23.1, AC-23.2, AC-15.2, AC-15.3): an agent working on a held call. `POST /agents/:id/messages` -> 202 with a `messageId`, shown in its `pending`; `POST .../interrupt` with text -> 200 `interrupted`; `POST .../stop` -> 200 with the stopped ids (the agent and its child); `POST .../restart` on the finished agent -> 201 with a NEW `agentId` (task text and parent as before), on a working agent -> 409 `NOT_FINISHED`, on an agent whose parent has finished -> 409 `PARENT_FINISHED`; `interrupt` with text on a finished agent -> 200 `not_active` with a `messageId` (the text delivered as a message).
//   Then, with the chat itself: three employee messages drive the scripted chat through `list_agents` (the tool result lists the agent with its status, literally), `message_agent` (the message stands in that agent's history) and `stop_agent` (the agent reads `stopped`); none of them touches an agent of another conversation of the same owner.
// - Row D "the brief from the web" (UC-6, AC-15.4, AC-24.2, AC-28.1..AC-28.3): the chat's script calls `start_workflow` for the `deep-research` template. Then before any decision: the view has one request of kind `workflows.brief` with `templateTitle` and status `open`, and NO coordinator agent exists under the conversation (AC-28.1). `POST /decisions/:id` with `approve` true, `template` unchanged and the question edited, plus one invalid edit first (a brief field failing its schema): the invalid one answers 400 `INVALID_ARGUMENTS` and the request stays `open`; the valid one answers 200 `resolved`; the view then shows the request `resolved`, exactly ONE new coordinator in `agents` and the corrected question in its task/brief; a repeated `POST /decisions/:id` answers 200 `already_resolved` and no second run appears. A second conversation: `approve` false -> `resolved` with the rejection, no coordinator, and the chat's next input holds the result "rejected by the user" (AC-28.3). An id that exists for nobody answers 404 `DECISION_NOT_FOUND`.
// - Row E "month's spend" (AC-29.1, AC-29.2, Invariant 4): the owner's runs wrote model calls with scripted `usage` and literal prices (including one title call without a task); `GET /spend` returns the current UTC month `YYYY-MM` and a `costUsd` equal to the literal sum of those ledger rows (the test computes it by hand, not by the ledger query); one more scripted call and a second read include it; a call dated the previous month (written by the test directly) is not counted; another owner's calls are not counted.
  it('INT-2 A: the owner\'s agent list pages each top agent once with its thread, a conversation lists its agents without the root, and the awaiting count includes deep requests and drops resolved ones', async () => {
    // Given: three conversations of one owner — the first with a parent-child pair (the grandchild asks
    // for a confirmation) and a second agent, the second with three agents (one held working), the
    // third without a root; five top agents in all, the page size is 2 (beforeAll)
    const api = chatApi(harness.app, INT2.a);
    const firstTask = 'INT-2 A: first conversation';
    const secondTask = 'INT-2 A: second conversation';
    const threeHeld = createLatch();
    harness.model.script(
      { task: firstTask },
      [{ calls: [startAgent('A1 parent', 'INT-2 A: parent assignment'), startAgent('A1 second', 'INT-2 A: second assignment')] }],
      { thereafter: { text: 'First conversation noted.' } },
    );
    harness.model.script(
      { task: 'INT-2 A: parent assignment' },
      [{ calls: [startAgent('A1 grandchild', 'INT-2 A: grandchild assignment')] }],
      { thereafter: { text: 'Parent noted.' } },
    );
    harness.model.script(
      { task: 'INT-2 A: grandchild assignment' },
      [{ calls: [{ tool: CREATE_INCIDENT_NOTE, args: NOTE_INT2_A }] }],
      { thereafter: { text: 'Grandchild done.' } },
    );
    harness.model.script({ task: 'INT-2 A: second assignment' }, [], { thereafter: { text: 'Second done.' } });
    harness.model.script(
      { task: secondTask },
      [
        {
          calls: [
            startAgent('A2 one', 'INT-2 A: one assignment'),
            startAgent('A2 two', 'INT-2 A: two assignment'),
            startAgent('A2 three', 'INT-2 A: three assignment'),
          ],
        },
      ],
      { thereafter: { text: 'Second conversation noted.' } },
    );
    harness.model.script({ task: 'INT-2 A: one assignment' }, [], { thereafter: { text: 'One done.' } });
    harness.model.script({ task: 'INT-2 A: two assignment' }, [], { thereafter: { text: 'Two done.' } });
    harness.model.script({ task: 'INT-2 A: three assignment' }, [{ text: 'Three done.', latch: threeHeld }]);
    try {
      const first = await api.createThread();
      await api.renameThread(first.id, 'INT-2 A: first');
      await api.send(first.id, firstTask);
      const firstView = await waitFor(
        () => api.history(first.id),
        (view) =>
          view.agents.length === 2 &&
          view.agents.some((agent) => agent.children.length === 1) &&
          view.decisions.some((decision) => decision.status === 'open'),
        'the first conversation\'s agents and the grandchild\'s open request',
      );
      const second = await api.createThread();
      await api.renameThread(second.id, 'INT-2 A: second');
      await api.send(second.id, secondTask);
      await threeHeld.reached();
      const secondView = await waitFor(
        () => api.history(second.id),
        (view) => view.agents.length === 3,
        'the second conversation\'s three agents',
      );
      const third = await api.createThread();

      // When: the owner's agent list is walked along its cursor
      const { pages, agents } = await allAgents(api);

      // Then: three pages of 2, 2 and 1; each top agent once, newest conversation first, no root
      expect(pages.map((page) => [page.agents.length, page.nextCursor === null])).toEqual([
        [2, false],
        [2, false],
        [1, true],
      ]);
      expect(new Set(agents.map((agent) => agent.agentId)).size).toBe(5);
      expect(agents.map((agent) => `${agent.threadId} ${agent.threadTitle} ${agent.depth}`)).toEqual([
        `${second.id} INT-2 A: second 1`,
        `${second.id} INT-2 A: second 1`,
        `${second.id} INT-2 A: second 1`,
        `${first.id} INT-2 A: first 1`,
        `${first.id} INT-2 A: first 1`,
      ]);
      expect(agents.map((agent) => agent.description).sort()).toEqual([
        'A1 parent',
        'A1 second',
        'A2 one',
        'A2 three',
        'A2 two',
      ]);
      const byOrder = (left: AgentListNode, right: AgentListNode): number =>
        right.createdAt.localeCompare(left.createdAt) || (right.agentId < left.agentId ? -1 : right.agentId > left.agentId ? 1 : 0);
      expect(agents.map((agent) => agent.agentId)).toEqual([...agents].sort(byOrder).map((agent) => agent.agentId));
      const roots = [rootOf(firstView), rootOf(secondView)];
      expect(agents.filter((agent) => roots.includes(agent.agentId))).toEqual([]);
      expect(agents.filter((agent) => agent.threadId === third.id)).toEqual([]);
      expect(agentNamed(agents, 'A1 parent').children.map(nodeLine)).toEqual(['A1 grandchild []']);
      // design v1.2 (A-1): no agent here is a workflow coordinator, so none carries `template`
      for (const agent of agents) expect(agent).not.toHaveProperty('template');

      // Then: a conversation lists its own agents without the root; the conversation without a root lists none
      expect((await api.threadAgents(first.id)).map(nodeLine)).toEqual(['A1 parent [A1 grandchild []]', 'A1 second []']);
      expect((await api.threadAgents(second.id)).map(nodeLine).sort()).toEqual(['A2 one []', 'A2 three []', 'A2 two []']);
      expect(await api.threadAgents(third.id)).toEqual([]);

      // Then: the awaiting count holds the grandchild's request and drops it once it is decided
      expect(await api.awaiting()).toEqual({ count: 1 });
      const [request] = firstView.decisions;
      if (request === undefined) throw new Error('no request of the grandchild');
      const grandchild = agentNamed(agentNamed(firstView.agents, 'A1 parent').children, 'A1 grandchild');
      expect([request.agentId, grandchild.depth]).toEqual([grandchild.agentId, 2]);
      expect(await api.decide(request.decisionId, { approve: true })).toEqual({ outcome: 'resolved' });
      expect(await api.awaiting()).toEqual({ count: 0 });

      // When: a working agent seen in the list is stopped; Then: the list shows its new status
      const three = agentNamed(agents, 'A2 three');
      expect(three.status).toBe('working');
      expect(await api.stopAgent(three.agentId)).toEqual({ stopped: [three.agentId] });
      const afterStop = await allAgents(api);
      expect(agentNamed(afterStop.agents, 'A2 three').status).toBe('stopped');
    } finally {
      threeHeld.open();
    }
  }, TEST_TIMEOUT_MS);

  it('INT-2 B: an agent page returns its entries, pending, own requests and children, a fork\'s inherited history stops at the fork point, and a run view exists only for a coordinator', async () => {
    // Given: the chat starts a reader and a fork of itself, then asks for a deep-research brief; the
    // reader reads a trace (held), starts a helper that asks for a confirmation and reports; the
    // coordinator starts a plan and an answer step
    const api = chatApi(harness.app, INT2.b);
    const task = 'INT-2 B: read, fork and research';
    const readerTask = 'INT-2 B: reader assignment';
    const forkTask = 'INT-2 B: fork assignment';
    const helperTask = 'INT-2 B: helper assignment';
    const question = 'INT-2 B: how do payments fail?';
    const planTask = 'INT-2 B: plan assignment';
    const answerTask = 'INT-2 B: answer assignment';
    const queued = 'INT-2 B: also check the queue';
    const held = harness.fixtureLog.latch(FIXTURE_LATCHES.int2b);
    harness.model.script(
      { task },
      [
        { calls: [startAgent('B reader', readerTask), startAgent('B fork', forkTask, FORK)] },
        { calls: [{ tool: START_WORKFLOW, args: briefArgs(question) }] },
      ],
      { thereafter: { text: 'Noted.' } },
    );
    harness.model.script(
      { task: readerTask },
      [
        { calls: [{ tool: GET_TRACE, args: TRACE_INT2_B }] },
        { calls: [startAgent('B helper', helperTask)] },
        { text: 'Helper started.' },
      ],
      { thereafter: { text: 'Helper reported.' } },
    );
    harness.model.script(
      { task: helperTask },
      [{ calls: [{ tool: CREATE_INCIDENT_NOTE, args: NOTE_INT2_B }] }],
      { thereafter: { text: 'Helper done.' } },
    );
    harness.model.script({ task: forkTask }, [], { thereafter: { text: 'Fork done.' } });
    harness.model.script(
      { task: briefTask(question) },
      [
        { calls: [startAgent('B plan', planTask, 'deep-research-plan')] },
        { calls: [startAgent('B answer', answerTask, 'deep-research-answer')] },
      ],
      { thereafter: { text: 'Run done.' } },
    );
    harness.model.script({ task: planTask }, [], { thereafter: { text: '1. logs' } });
    harness.model.script({ task: answerTask }, [], { thereafter: { text: 'The answer.' } });
    try {
      const thread = await api.createThread();
      await api.renameThread(thread.id, 'INT-2 B: thread');
      await api.send(thread.id, task);
      await untilFixtureCall(TRACE_INT2_B, harness.fixtureLog.callLog);
      const started = await waitFor(
        () => api.history(thread.id),
        (view) =>
          view.agents.length === 2 &&
          view.decisions.some((decision) => decision.kind === WORKFLOWS_BRIEF_CONFIRMATION && decision.status === 'open'),
        'the reader, the fork and the brief',
      );
      const rootId = rootOf(started);
      const readerId = agentNamed(started.agents, 'B reader').agentId;
      const forkId = agentNamed(started.agents, 'B fork').agentId;

      // When: the employee writes to the reader while its call is held
      const sent = await api.sendToAgent(readerId, queued);

      // Then: the message waits in the reader's queue
      expect(sent.messageId).toEqual(expect.any(String));
      const busy = await api.agentPage(readerId);
      expect(busy.agent.status).toBe('working');
      expect(busy.pending.map((message) => (message.source === 'report' ? 'report' : `${message.source} ${message.text}`))).toEqual([
        `user ${queued}`,
      ]);
      expect(busy.pending.map((message) => message.messageId)).toEqual([sent.messageId]);

      // When: the brief is confirmed and the read call is released
      const brief = started.decisions.find((decision) => decision.kind === WORKFLOWS_BRIEF_CONFIRMATION);
      if (brief === undefined) throw new Error('no brief in the view');
      expect(await api.decide(brief.decisionId, { approve: true })).toEqual({ outcome: 'resolved' });
      held.release();

      // Then: the helper's request is on the helper's page only, and the helper names its parent (A-2)
      const helperStarted = await waitFor(
        () => api.agentPage(readerId),
        (page) => page.children.length === 1 && linesOf(page.entries).includes('model_answer: Helper started. []'),
        'the reader\'s helper',
      );
      const helperId = agentNamed(helperStarted.children, 'B helper').agentId;
      const helperAsks = await waitFor(
        () => api.agentPage(helperId),
        (page) => page.decisions.some((decision) => decision.status === 'open'),
        'the helper\'s open request',
      );
      expect(helperAsks.agent).toMatchObject({ depth: 2, parentId: readerId, parentDescription: 'B reader' });
      expect(helperAsks.decisions).toHaveLength(1);
      expect(helperAsks.decisions[0]).toMatchObject({
        agentId: helperId,
        description: 'B helper',
        kind: AGENTS_TOOL_CONFIRMATION,
        tool: 'create_incident_note',
        server: 'backoffice',
        args: NOTE_INT2_B,
        status: 'open',
      });
      expect((await api.agentPage(readerId)).decisions).toEqual([]);
      const helperRequest = helperAsks.decisions[0];
      if (helperRequest === undefined) throw new Error('no request of the helper');
      expect(await api.decide(helperRequest.decisionId, { approve: true })).toEqual({ outcome: 'resolved' });

      // Then: the reader's page holds its whole work in order, its conversation, no queue, no request of its own
      const reader = await waitFor(
        () => api.agentPage(readerId),
        (page) => page.agent.status === 'completed',
        'the reader to finish after the helper\'s report',
      );
      expect(reader.agent).toMatchObject({
        agentId: readerId,
        parentId: rootId,
        depth: 1,
        definition: GENERAL_PURPOSE,
        description: 'B reader',
        model: DEFAULT_MODEL,
        threadId: thread.id,
        threadTitle: 'INT-2 B: thread',
      });
      expect(reader.agent).not.toHaveProperty('parentDescription');
      expect(reader.agent).not.toHaveProperty('template');
      expect(linesOf(reader.entries)).toEqual([
        'task: INT-2 B: reader assignment',
        'model_answer:  [logs/get_trace]',
        'tool_result: get_trace success',
        'user_message: INT-2 B: also check the queue',
        'model_answer:  [start_agent]',
        'tool_result: start_agent success',
        'model_answer: Helper started. []',
        'child_report: B helper completed',
        'model_answer: Helper reported. []',
      ]);
      const read = reader.entries.find((entry) => entry.kind === 'tool_result' && entry.content.tool === 'get_trace');
      expect(read?.kind === 'tool_result' ? [read.content.server, read.content.args] : null).toEqual(['logs', TRACE_INT2_B]);
      expect([reader.pending, reader.decisions, reader.nextAfterSeq]).toEqual([[], [], null]);
      expect(reader.children.map((child) => `${child.description} ${child.status}`)).toEqual(['B helper completed']);

      // Then: the fork's inherited history is the chat's history up to the fork point and nothing after it
      const fork = await api.agentPage(forkId);
      const forkedFrom = fork.agent.forkedFrom;
      if (forkedFrom === null) throw new Error('the fork has no fork point');
      expect([fork.agent.definition, forkedFrom.agentId]).toEqual(['chat', rootId]);
      const inherited = await api.inherited(forkId);
      expect(linesOf(inherited.entries)).toEqual(['task: INT-2 B: read, fork and research']);
      expect(inherited.nextAfterSeq).toBeNull();
      expect(inherited.entries.filter((entry) => entry.seq > forkedFrom.throughSeq)).toEqual([]);
      const chatHistory = await api.history(thread.id);
      expect(chatHistory.entries.some((entry) => entry.seq > forkedFrom.throughSeq)).toBe(true);
      expect(await api.inherited(readerId)).toEqual({ entries: [], nextAfterSeq: null });

      // Then: the run view exists for the coordinator (with its template, A-1) and not for a plain agent
      const ran = await waitFor(
        () => api.history(thread.id),
        (view) => view.agents.some((agent) => agent.definition === DEEP_RESEARCH.name && agent.status === 'completed'),
        'the workflow run to finish',
      );
      const coordinator = agentNamed(ran.agents, question);
      expect(coordinator.template).toEqual(DEEP_RESEARCH);
      const run = await api.run(coordinator.agentId);
      expect(run).toMatchObject({
        agentId: coordinator.agentId,
        template: DEEP_RESEARCH,
        brief: { question, boundaries: '', result: '' },
      });
      expect(run.coordinator.status).toBe('completed');
      expect(run.steps.map((step) => `${step.definition} ${step.description} ${step.status}`)).toEqual([
        'deep-research-plan B plan completed',
        'deep-research-answer B answer completed',
      ]);
      const coordinatorPage = await api.agentPage(coordinator.agentId);
      expect(coordinatorPage.agent.template).toEqual(DEEP_RESEARCH);
      expect(coordinatorPage.agent).not.toHaveProperty('parentDescription');
      expect((await expectError(api.raw('get', `/agents/${readerId}/run`), 404)).errorCode).toBe('RUN_NOT_FOUND');
    } finally {
      held.release();
    }
  }, TEST_TIMEOUT_MS);

  it('INT-2 C: the agent routes message, interrupt, stop and restart give the documented outcomes and codes, and the chat\'s list, message and stop tools act on the conversation\'s own agents', async () => {
    // Given: a worker that started a sub-agent (held) and reads a trace (held on the fixture)
    const api = chatApi(harness.app, INT2.c);
    const task = 'INT-2 C: start a worker';
    const workerTask = 'INT-2 C: worker assignment';
    const subTask = 'INT-2 C: sub assignment';
    const toolsTask = 'INT-2 C: start a helper';
    const helperTask = 'INT-2 C: helper assignment';
    const held = harness.fixtureLog.latch(FIXTURE_LATCHES.int2c);
    const workerHeld = createLatch();
    const subHeld = createLatch();
    const helperHeld = createLatch();
    // The chat's own tools target the helper, whose id is known once it started.
    let helperId = '';
    harness.model.script({ task }, [{ calls: [startAgent('C worker', workerTask)] }], {
      thereafter: { text: 'Worker noted.' },
    });
    harness.model.script(
      { task: workerTask },
      [
        { calls: [startAgent('C sub', subTask), { tool: GET_TRACE, args: TRACE_INT2_C }] },
        { text: 'Switched focus.', latch: workerHeld },
      ],
      { thereafter: { text: 'Worker done.' } },
    );
    harness.model.script({ task: subTask }, [{ text: 'Sub done.', latch: subHeld }]);
    harness.model.script(
      { task: toolsTask },
      [
        { calls: [startAgent('C2 helper', helperTask)] },
        { text: 'Helper started.' },
        { calls: [{ tool: 'list_agents', args: {} }] },
        { text: 'One agent works.' },
        () => ({ calls: [{ tool: 'message_agent', args: { agentId: helperId, message: 'Hurry up.' } }] }),
        { text: 'Told it.' },
        () => ({ calls: [{ tool: 'stop_agent', args: { agentId: helperId } }] }),
        { text: 'Stopped it.' },
      ],
      { thereafter: { text: 'Noted.' } },
    );
    harness.model.script({ task: helperTask }, [{ text: 'Helper done.', latch: helperHeld }]);
    try {
      const thread = await api.createThread();
      await api.send(thread.id, task);
      await untilFixtureCall(TRACE_INT2_C, harness.fixtureLog.callLog);
      await subHeld.reached();
      const started = await waitFor(
        () => api.history(thread.id),
        (view) => view.agents.length === 1 && view.agents[0]?.children.length === 1,
        'the worker and its sub-agent',
      );
      const rootId = rootOf(started);
      const worker = agentNamed(started.agents, 'C worker');
      const subId = agentNamed(worker.children, 'C sub').agentId;

      // When: a message to the working agent; Then: 202 with a message id shown in its queue
      const sent = await api.sendToAgent(worker.agentId, 'INT-2 C: a note while busy');
      expect(sent.messageId).toEqual(expect.any(String));
      expect((await api.agentPage(worker.agentId)).pending.map((message) => message.messageId)).toEqual([sent.messageId]);

      // When: an interrupt with text; Then: `interrupted`, and the agent goes on working with the text
      expect(await api.interruptAgent(worker.agentId, 'INT-2 C: switch focus')).toEqual({ outcome: 'interrupted' });
      await workerHeld.reached();

      // Then: a restart of the working agent is 409 NOT_FINISHED
      expect((await expectError(api.raw('post', `/agents/${worker.agentId}/restart`), 409)).errorCode).toBe('NOT_FINISHED');

      // When: the agent is stopped; Then: the answer lists it and its sub-agent
      const stop = await api.stopAgent(worker.agentId);
      expect([...stop.stopped].sort()).toEqual([worker.agentId, subId].sort());
      await waitFor(() => api.agentPage(worker.agentId), (page) => page.agent.status === 'stopped', 'the stopped worker');

      // Then: a restart of the sub-agent, whose parent has finished, is 409 PARENT_FINISHED
      expect((await expectError(api.raw('post', `/agents/${subId}/restart`), 409)).errorCode).toBe('PARENT_FINISHED');

      // When: the finished worker is restarted; Then: 201 with a NEW agent with the same task and parent
      const restarted = await api.restartAgent(worker.agentId);
      expect(restarted.agentId).not.toBe(worker.agentId);
      const fresh = await waitFor(
        () => api.agentPage(restarted.agentId),
        (page) => page.agent.status === 'completed',
        'the restarted worker to finish',
      );
      expect(fresh.agent).toMatchObject({ parentId: rootId, definition: GENERAL_PURPOSE, description: 'C worker' });
      expect(linesOf(fresh.entries)).toEqual(['task: INT-2 C: worker assignment', 'model_answer: Worker done. []']);

      // When: an interrupt with text reaches the finished agent; Then: `not_active` and the text is delivered
      const late = await api.interruptAgent(restarted.agentId, 'INT-2 C: one more remark');
      expect(late).toEqual({ outcome: 'not_active', messageId: expect.any(String) });
      const remarked = await waitFor(
        () => api.agentPage(restarted.agentId),
        (page) =>
          page.agent.status === 'completed' &&
          linesOf(page.entries).includes('user_message: INT-2 C: one more remark') &&
          linesOf(page.entries).at(-1) === 'model_answer: Worker done. []',
        'the restarted worker\'s answer to the remark',
      );
      expect(linesOf(remarked.entries).filter((line) => line.startsWith('model_answer'))).toEqual([
        'model_answer: Worker done. []',
        'model_answer: Worker done. []',
      ]);

      // Given: a second conversation of the same owner whose chat starts a helper (held working)
      const tools = await api.createThread();
      await api.send(tools.id, toolsTask);
      await helperHeld.reached();
      const withHelper = await untilIdle(
        api,
        tools.id,
        (view) => view.agents.length === 1 && linesOf(view.entries).includes('model_answer: Helper started. []'),
        'the chat\'s helper',
      );
      helperId = agentNamed(withHelper.agents, 'C2 helper').agentId;

      // When: the employee asks which agents work; Then: list_agents lists this conversation's helper only
      await api.send(tools.id, 'INT-2 C: which agents work?');
      const listed = await untilIdle(
        api,
        tools.id,
        (view) => linesOf(view.entries).includes('model_answer: One agent works. []'),
        'the chat\'s answer after list_agents',
      );
      const listResult = listed.entries.find((entry) => entry.kind === 'tool_result' && entry.content.tool === 'list_agents');
      expect(listResult?.kind === 'tool_result' ? JSON.parse(listResult.content.text ?? 'null') : null).toEqual([
        { agentId: helperId, description: 'C2 helper', definition: GENERAL_PURPOSE, model: DEFAULT_MODEL, status: 'working' },
      ]);

      // When: the employee asks to write to the helper; Then: the parent's message stands in the helper's queue
      await api.send(tools.id, 'INT-2 C: tell it to hurry');
      await untilIdle(api, tools.id, (view) => linesOf(view.entries).includes('model_answer: Told it. []'), 'the chat\'s answer after message_agent');
      expect(
        (await api.agentPage(helperId)).pending.map((message) =>
          message.source === 'report' ? 'report' : `${message.source} ${message.text}`,
        ),
      ).toEqual(['parent Hurry up.']);

      // When: the employee asks to stop the helper; Then: the helper reads `stopped`
      await api.send(tools.id, 'INT-2 C: stop it');
      await untilIdle(api, tools.id, (view) => linesOf(view.entries).includes('model_answer: Stopped it. []'), 'the chat\'s answer after stop_agent');
      expect((await api.agentPage(helperId)).agent.status).toBe('stopped');

      // Then: nothing of the first conversation was touched by the chat's tools
      expect((await api.agentPage(restarted.agentId)).agent.status).toBe('completed');
      expect((await api.threadAgents(thread.id)).map((node) => `${node.description} ${node.status}`).sort()).toEqual([
        'C worker completed',
        'C worker stopped',
      ]);
    } finally {
      held.release();
      workerHeld.open();
      subHeld.open();
      helperHeld.open();
    }
  }, TEST_TIMEOUT_MS);

  it('INT-2 D: a brief waits without a run, an invalid edit leaves it open with 400, a confirmed edited brief starts exactly one run with the edited question, a repeat is already_resolved, and a rejection starts nothing', async () => {
    // Given: the chat asks for a deep-research brief
    const api = chatApi(harness.app, INT2.d);
    const task = 'INT-2 D: research the checkout slowdown';
    const question = 'INT-2 D: why did checkout slow down?';
    const corrected = 'INT-2 D: why did checkout slow down last week?';
    const answerTask = 'INT-2 D: answer assignment';
    const rejectedTask = 'INT-2 D: research something else';
    const rejectedQuestion = 'INT-2 D: a question nobody wants';
    harness.model.script({ task }, [{ calls: [{ tool: START_WORKFLOW, args: briefArgs(question) }] }], {
      thereafter: { text: 'The research is running.' },
    });
    harness.model.script(
      { task: briefTask(corrected) },
      [{ calls: [startAgent('D answer', answerTask, 'deep-research-answer')] }],
      { thereafter: { text: 'Run done.' } },
    );
    harness.model.script({ task: answerTask }, [], { thereafter: { text: 'The answer.' } });
    const rejectedChat = harness.model.script(
      { task: rejectedTask },
      [{ calls: [{ tool: START_WORKFLOW, args: briefArgs(rejectedQuestion) }] }],
      { thereafter: { text: 'Not started, as you decided.' } },
    );
    const thread = await api.createThread();
    await api.send(thread.id, task);

    // Then: the brief waits as a request with the template's title, and no coordinator exists (AC-28.1)
    const waiting = await waitFor(() => api.history(thread.id), (view) => view.decisions.length === 1, 'the brief');
    const [brief] = waiting.decisions;
    if (brief === undefined) throw new Error('no brief in the view');
    expect(brief).toMatchObject({
      kind: WORKFLOWS_BRIEF_CONFIRMATION,
      tool: START_WORKFLOW,
      server: null,
      args: briefArgs(question),
      content: { title: DEEP_RESEARCH.title, question, boundaries: '', result: '' },
      status: 'open',
      resolution: null,
      templateTitle: DEEP_RESEARCH.title,
    });
    expect(waiting.agents).toEqual([]);

    // When: an edit whose question fails the brief's schema; Then: 400 INVALID_ARGUMENTS and the brief stays open
    const invalid = await expectError(
      api.raw('post', `/decisions/${brief.decisionId}`, { approve: true, args: briefArgs('') }),
      400,
    );
    expect(invalid.errorCode).toBe('INVALID_ARGUMENTS');
    expect((await api.history(thread.id)).decisions.map((decision) => decision.status)).toEqual(['open']);

    // When: the brief is confirmed with the corrected question; Then: resolved with the edited arguments
    expect(await api.decide(brief.decisionId, { approve: true, args: briefArgs(corrected) })).toEqual({
      outcome: 'resolved',
    });
    expect((await api.history(thread.id)).decisions[0]).toMatchObject({
      status: 'resolved',
      resolution: { approve: true, args: briefArgs(corrected) },
    });

    // When: the decision is repeated; Then: `already_resolved`
    expect(await api.decide(brief.decisionId, { approve: true })).toEqual({ outcome: 'already_resolved' });

    // Then: exactly one coordinator, with the template (A-1) and the corrected question as its brief
    const ran = await waitFor(
      () => api.history(thread.id),
      (view) => view.agents.some((agent) => agent.definition === DEEP_RESEARCH.name && agent.status === 'completed'),
      'the workflow run to finish',
    );
    expect(ran.agents.map((agent) => `${agent.definition} ${agent.description}`)).toEqual([`${DEEP_RESEARCH.name} ${corrected}`]);
    const coordinator = agentNamed(ran.agents, corrected);
    expect(coordinator.template).toEqual(DEEP_RESEARCH);
    expect(linesOf((await api.agentPage(coordinator.agentId)).entries)[0]).toBe(`task: ${briefTask(corrected)}`);
    expect((await api.run(coordinator.agentId)).brief).toEqual({ question: corrected, boundaries: '', result: '' });

    // Given: a second conversation with a brief; When: it is rejected
    const other = await api.createThread();
    await api.send(other.id, rejectedTask);
    const otherWaiting = await waitFor(() => api.history(other.id), (view) => view.decisions.length === 1, 'the second brief');
    const [otherBrief] = otherWaiting.decisions;
    if (otherBrief === undefined) throw new Error('no second brief in the view');
    expect(await api.decide(otherBrief.decisionId, { approve: false })).toEqual({ outcome: 'resolved' });

    // Then: no run, the call reads `rejected`, and the chat's next input holds the rejection (AC-28.3)
    await rejectedChat.called(2);
    const rejected = await untilIdle(
      api,
      other.id,
      (view) => linesOf(view.entries).at(-1) === 'model_answer: Not started, as you decided. []',
      'the chat\'s answer to the rejection',
    );
    expect(linesOf(rejected.entries)).toEqual([
      'task: INT-2 D: research something else',
      'model_answer:  [start_workflow]',
      'tool_result: start_workflow rejected',
      'model_answer: Not started, as you decided. []',
    ]);
    expect(rejected.agents).toEqual([]);
    expect(rejected.decisions[0]).toMatchObject({ status: 'resolved', resolution: { approve: false } });
    const toolInput = rejectedChat.calls[1]?.messages.filter((message) => message.role === 'tool').at(-1);
    expect(
      toolInput?.role === 'tool'
        ? toolInput.results.map((result) => `${result.toolName} ${JSON.stringify(result.output).includes('[rejected]')}`)
        : [],
    ).toEqual(['start_workflow true']);

    // Then: an id that exists for nobody is 404 DECISION_NOT_FOUND
    expect(
      (await expectError(api.raw('post', `/decisions/${randomUUID()}`, { approve: true }), 404)).errorCode,
    ).toBe('DECISION_NOT_FOUND');
  }, TEST_TIMEOUT_MS);

  it('INT-2 E: the spend endpoint returns the UTC month\'s ledger sum including calls without a task and nothing of another month or owner', async () => {
    // Given: the owner's chat answers with literal usage on the default model
    // (prices of config/model-prices.json, anthropic/claude-haiku-5-5: input 0.1, output 0.5 USD per MTok)
    const api = chatApi(harness.app, INT2.e);
    const other = chatApi(harness.app, INT2.eOther);
    const task = 'INT-2 E: first message';
    const otherTask = 'INT-2 E: another owner\'s message';
    harness.model.script({ task }, [
      // 2000 × 0.1 + 400 × 0.5 = 400 µUSD
      { text: 'First answer.', usage: { inputTokens: 2000, outputTokens: 400 } },
      // 4000 × 0.1 + 1000 × 0.5 = 900 µUSD
      { text: 'Second answer.', usage: { inputTokens: 4000, outputTokens: 1000 } },
    ]);
    harness.model.script({ task: otherTask }, [{ text: 'Other answer.', usage: { inputTokens: 50_000, outputTokens: 5000 } }]);
    const thread = await api.createThread();
    await api.send(thread.id, task);
    await untilIdle(api, thread.id, (view) => view.entries.length === 2, 'the first answer');
    // The title call of the first message is a ledger row without a task: 1000 × 0.1 + 100 × 0.5 = 150 µUSD
    await waitFor(() => api.getThread(thread.id), (summary) => summary.title === GENERATED_TITLE, 'the generated title');
    // Another owner's calls in the same month
    const otherThread = await other.createThread();
    await other.send(otherThread.id, otherTask);
    await untilIdle(other, otherThread.id, (view) => view.entries.length === 2, 'the other owner\'s answer');
    // A call of the previous UTC month, written by the test into the ledger (the one write into a foreign table)
    const now = new Date();
    const lastSecondOfPreviousMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1) - 1000);
    await harness.pool.query(
      `INSERT INTO app.runtime_model_calls
         (call_id, owner_id, task_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd, called_at)
       VALUES ($1, $2, NULL, $3, 1000000, 1000000, 0, 0, 0.6, $4)`,
      [randomUUID(), INT2.e, DEFAULT_MODEL, lastSecondOfPreviousMonth],
    );
    const month = now.toISOString().slice(0, 7);

    // When: the owner reads the spend
    const spend = await api.spend();

    // Then: the current UTC month and the sum of this month's rows: 400 + 150 µUSD
    expect(spend.month).toBe(month);
    expect(spend.costUsd).toBeCloseTo(0.00055, 9);

    // When: one more answer is made; Then: the next read includes it: 550 + 900 µUSD
    await api.send(thread.id, 'INT-2 E: second message');
    await untilIdle(api, thread.id, (view) => view.entries.length === 4, 'the second answer');
    const after = await api.spend();
    expect(after.month).toBe(month);
    expect(after.costUsd).toBeCloseTo(0.00145, 9);
  }, TEST_TIMEOUT_MS);

  // ---------------------------------------------------------------------------------------------------------------
  // INT-3  Conversations: list, rename, delete (with a working agent), the automatic title, on the new tables
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-14.3: "Given у сотрудника есть беседы, when он работает со списком, then список, переименование, удаление и автоматический заголовок ведут себя как в `chat-shell` FR-13, FR-15–FR-17."
  // AC-14.4: "Given в беседе работают агенты, when сотрудник удаляет беседу, then её агенты останавливаются и удаляются вместе с ней."
  // DC-2 (Flow 1): "Заголовок генерируется по первому сообщению и пишется только в пустой заголовок; сбой генерации оставляет его пустым и повторяется при следующей отправке."
  // Invariant 2: "Автоматический заголовок не перезаписывает непустой заголовок."
  // Flow 6: "беседы, её агентов, очередей, запросов и событий нет; строки журнала токенов остались, расход месяца не уменьшился. Строка беседы заблокирована на время удаления, поэтому первая отправка в ту же беседу ждёт и затем получает 404."
  // Use cases: UC-3, UC-4. EARS: When / If-then. Design flows: Flow 1 (title in the background), Flow 6 (delete), KD-1, KD-6.
  //
  // Catches: (A) a list that duplicates or skips a conversation across pages once the page moves to SQL over `chat_conversations`, ignores `updatedAt` growth on send or rename (a conversation does not move to the top), returns another state for rename of a blank title (must be 400), reads a deleted conversation (404 on read, send, history); the old mapping of a missing id to 404 changed by the new table;
  //   (B) the automatic title that overwrites a title the employee set meanwhile (the conditional write "only into empty"), a generation failure that leaves a half-written or default title, one that is not retried by the next send, a title call that leaves no ledger row (Invariant 4) or is not a row without a task id, a title that blocks the first message's 202;
  //   (C) a delete that leaves the working agent running (it still calls its tool and the model after the 204), leaves rows of the tree readable by id (the agent still answers 200), or removes the ledger rows so that the month's spend falls (AC-14.4 plus "журнал токенов цел"); a delete racing a first send that creates a root nobody can see or an orphan conversation row.
// Not re-checked here: the stop of the tree's tasks and the rows `deleteTree` removes (runtime INT-3), the ledger surviving `deleteTree` as a runtime rule (runtime INT-5; here only through the HTTP spend), the cursor encoding, the title rules and the schemas (unit), the foreign owner (INT-4), the stream (INT-1).
// Behavior: HTTP list/rename/delete/send -> `chat_conversations` and the agents tree -> the next list, read, send and spend show the new state; the title is written in the background under the conditional update
// @category: core-functionality
// @dependency: AppModule (ConversationsService, ConversationsRepository, TitleService, ThreadsController), agents.completeText, createRuntime (tasks.deleteTree, ledger), scripted model double (answer, fail, gated title scenarios), MCP fixture (delayed read), Postgres
// @complexity: medium
//
// Verification items (table-driven by scenario):
// - Row A "list, rename, delete" (UC-3, AC-14.3): owner U has 25 conversations with distinct `updatedAt`. Then: page 1 has 20 items and a `nextCursor`, page 2 has 5 and none; the union is the 25 ids, no duplicates, in `updatedAt` descending order; a send into the oldest conversation moves it to the top of page 1; rename with `"  "` answers 400 `VALIDATION_FAILED` and with `" Отчёт "` answers 200 with the trimmed title; a bad cursor answers 400 `INVALID_CURSOR`; delete answers 204, then `GET`, `PATCH`, `GET .../history`, `POST .../messages` and a second `DELETE` all answer 404 `THREAD_NOT_FOUND` with the same body as for a random id; the list no longer contains it.
// - Row B "the automatic title" (UC-3, DC-2, Invariant 2, Invariant 4; four cases): (1) the first message with a scripted title: the 202 is returned before the title is written (the title call is held on a latch), then after the release the thread's title is the scripted text (trimmed per the unit rules) and the ledger holds one extra row without a task id; (2) the employee renames the conversation while the generation is held: after the release the manual title is intact; (3) a generation that fails: the title stays empty, a warning is logged without the message text, the message itself was accepted and answered; (4) the next send retries the generation and the title is then written.
// - Row C "delete with a working agent, and the money" (UC-4, AC-14.4, Flow 6): a conversation whose child agent waits on a held read call, with ledger rows written by the chat and the child (literal costs). Record `GET /spend` and the fixture journal length. Delete the conversation -> 204. Then: `GET /agents/:childId/history` and `.../run` answer 404 `AGENT_NOT_FOUND`; `GET /agents` lists nothing of it; after the held call is released and workers run, the fixture journal gains no entry and the scripted model's call counter for the tree is unchanged; `GET /spend` returns the same sum as before; sending to the deleted conversation answers 404. Second case: a delete and a first send started together on a conversation without a root: the outcome is either (send 202, then the delete removes the new root, the list loses the conversation) or (delete 204, the send 404), never an orphan root readable by id.
  // Plan Notes 5(б): the pages of 25 conversations, the renames and the bad cursor of row A are rows of
  // the rewritten `threads.e2e-spec.ts` (T6.4); here row A asserts only the move to the top on a send and
  // the 404 of the conversation's new routes after a delete.
  it('INT-3 A: the conversation list pages 25 conversations without duplicates, a send moves one to the top, a blank rename is 400 and a deleted conversation answers 404 on every route like a random id', async () => {
    // Given: three conversations of one owner, listed last changed first
    const api = chatApi(harness.app, INT3.a);
    const task = 'INT-3 A: summarise the bottom conversation';
    harness.model.script({ task }, [{ text: 'The bottom conversation, summarised.' }]);
    for (let created = 0; created < 3; created += 1) await api.createThread();
    const before = (await api.listThreads()).threads.map((summary) => summary.id);
    expect(before).toHaveLength(3);
    const bottom = before[2];
    if (bottom === undefined) throw new Error('no bottom conversation');

    // When: a message goes into the conversation at the bottom
    expect(await api.send(bottom, task)).toEqual({ messageId: null });

    // Then: it moves to the top; the others keep their order
    expect((await api.listThreads()).threads.map((summary) => summary.id)).toEqual([bottom, before[0], before[1]]);
    await untilIdle(api, bottom, (view) => view.entries.length === 2, 'the answer in the bottom conversation');

    // When: the conversation is deleted
    await api.deleteThread(bottom);

    // Then: its history, a send and an interrupt (with and without text) answer 404 `THREAD_NOT_FOUND`
    // with the same body as a random id
    const afterDelete = THREAD_ROUTES.filter((route) => /\/(history|messages|interrupt)$/.test(route.path(':id')));
    expect(afterDelete).toHaveLength(4);
    for (const route of afterDelete) await expectSameAsMissing(api, route, bottom, 'THREAD_NOT_FOUND');
  }, TEST_TIMEOUT_MS);

  it('INT-3 B: the generated title is written only into an empty title, a failure leaves it empty and the next send retries, and the title call is a ledger row without a task', async () => {
    // Given: three conversations, each answered by the chat; the title model's script changes per case
    const api = chatApi(harness.app, INT3.b);
    const titledFirst = 'INT-3 B: first message of the titled conversation';
    const failingFirst = 'INT-3 B: first message whose title fails';
    const failingSecond = 'INT-3 B: second message retries the title';
    const renamedFirst = 'INT-3 B: first message renamed meanwhile';
    const manualTitle = 'INT-3 B: my own title';
    harness.model.script({ task: titledFirst }, [{ text: 'Answer one.' }]);
    harness.model.script({ task: failingFirst }, [{ text: 'Answer two.' }, { text: 'Answer three.' }]);
    harness.model.script({ task: renamedFirst }, [{ text: 'Answer four.' }]);
    const titleHeld = createLatch();
    try {
      // Case 1 - Given: the title model answers; When: the first message is sent
      const titles = harness.model.completeText({ text: 'Trace error review' });
      const titled = await api.createThread();
      expect(await api.send(titled.id, titledFirst)).toEqual({ messageId: null });

      // Then: the title is written, and its call is a ledger row without a task beside the chat's own row
      await waitFor(() => api.getThread(titled.id), (summary) => summary.title === 'Trace error review', 'the title');
      await untilIdle(api, titled.id, (view) => view.entries.length === 2, 'the first answer');
      expect(await ledgerCalls(harness, INT3.b)).toEqual({ agentCalls: 1, withoutTask: 1 });

      // Case 2 - Given: the title model fails on every attempt; When: the first message is sent
      const callsBeforeFailure = titles.calls.length;
      harness.model.completeText(modelError());
      const failing = await api.createThread();
      expect(await api.send(failing.id, failingFirst)).toEqual({ messageId: null });

      // Then: after the three attempts the title stays empty and no ledger row is written for it, while
      // the message itself was accepted and answered
      await titles.called(callsBeforeFailure + 3);
      await untilIdle(api, failing.id, (view) => view.entries.length === 2, 'the answer despite the failed title');
      expect((await api.getThread(failing.id)).title).toBeNull();
      expect(await ledgerCalls(harness, INT3.b)).toEqual({ agentCalls: 2, withoutTask: 1 });

      // Case 3 - Given: the title model answers again; When: the next message is sent
      harness.model.completeText({ text: 'Failed then retried' });
      expect((await api.send(failing.id, failingSecond)).messageId).toEqual(expect.any(String));

      // Then: the send retries the generation and the title is written
      await waitFor(() => api.getThread(failing.id), (summary) => summary.title === 'Failed then retried', 'the retried title');
      await untilIdle(api, failing.id, (view) => view.entries.length === 4, 'the answer to the second message');
      expect(await ledgerCalls(harness, INT3.b)).toEqual({ agentCalls: 3, withoutTask: 2 });

      // Case 4 - Given: the title call is held; When: the first message is sent
      harness.model.completeText({ text: 'Generated while renamed', latch: titleHeld });
      const renamed = await api.createThread();
      expect(await api.send(renamed.id, renamedFirst)).toEqual({ messageId: null });

      // Then: the 202 came back while the title call is still held, and no title is written yet
      await titleHeld.reached();
      expect((await api.getThread(renamed.id)).title).toBeNull();

      // When: the employee renames the conversation, then the title call answers
      expect((await api.renameThread(renamed.id, manualTitle)).title).toBe(manualTitle);
      titleHeld.open();

      // Then: the generated title does not overwrite the employee's (Invariant 2); its call is still a ledger row
      await untilIdle(api, renamed.id, (view) => view.entries.length === 2, 'the answer in the renamed conversation');
      await waitFor(
        () => ledgerCalls(harness, INT3.b),
        (counts) => counts.withoutTask === 3,
        'the ledger row of the held title call',
      );
      expect((await api.getThread(renamed.id)).title).toBe(manualTitle);
      expect(await ledgerCalls(harness, INT3.b)).toEqual({ agentCalls: 4, withoutTask: 3 });

      // Then: every title call was made from the conversation's first message, the retry included (Notes 5(в))
      expect(titles.calls.filter((call) => call.prompt.includes('INT-3 B')).map((call) => call.prompt)).toEqual([
        '<message>\nINT-3 B: first message of the titled conversation\n</message>',
        '<message>\nINT-3 B: first message whose title fails\n</message>',
        '<message>\nINT-3 B: first message whose title fails\n</message>',
        '<message>\nINT-3 B: first message whose title fails\n</message>',
        '<message>\nINT-3 B: first message whose title fails\n</message>',
        '<message>\nINT-3 B: first message renamed meanwhile\n</message>',
      ]);
    } finally {
      titleHeld.open();
      // The rest of the file expects the title of `beforeAll`.
      harness.model.completeText({ text: GENERATED_TITLE });
    }
  }, TEST_TIMEOUT_MS);

  it('INT-3 C: deleting a conversation with a working agent removes the agent for every route, stops its tool and model calls, and leaves the month\'s spend unchanged', async () => {
    // Given: the chat starts a reader whose read call is held on the fixture; the reader would read a
    // second trace next and the chat would answer its report
    const api = chatApi(harness.app, INT3.c);
    const task = 'INT-3 C: have the slow trace read';
    const readerTask = 'INT-3 C: read the slow trace';
    const controlTask = 'INT-3 C: a control conversation after the delete';
    const raceTask = 'INT-3 C: a first message racing the delete';
    const held = harness.fixtureLog.latch(FIXTURE_LATCHES.int3c);
    const chat = harness.model.script(
      { task },
      [{ calls: [startAgent('trace reader', readerTask)] }, { text: 'A reader is on it.' }],
      { thereafter: { text: 'The reader reported.' } },
    );
    const reader = harness.model.script(
      { task: readerTask },
      [{ calls: [{ tool: GET_TRACE, args: TRACE_INT3_C }] }, { calls: [{ tool: GET_TRACE, args: TRACE_INT3_C_NEXT }] }],
      { thereafter: { text: 'Both traces read.' } },
    );
    harness.model.script({ task: controlTask }, [
      { calls: [{ tool: GET_TRACE, args: TRACE_INT3_CONTROL }] },
      { text: 'Control done.' },
    ]);
    harness.model.script({ task: raceTask }, [], { thereafter: { text: 'Raced.' } });
    try {
      const thread = await api.createThread();
      await api.send(thread.id, task);
      await untilFixtureCall(TRACE_INT3_C, harness.fixtureLog.callLog);
      const working = await untilIdle(
        api,
        thread.id,
        (view) => view.entries.length === 4 && view.agents.length === 1,
        'the chat to answer while the reader works',
      );
      const readerId = agentNamed(working.agents, 'trace reader').agentId;
      await waitFor(() => api.getThread(thread.id), (summary) => summary.title === GENERATED_TITLE, 'the title');
      // 2 chat answers + 1 reader answer + 1 title call, each 1000 × 0.1 + 100 × 0.5 = 150 µUSD
      expect((await api.spend()).costUsd).toBeCloseTo(0.0006, 9);
      expect([chat.calls.length, reader.calls.length]).toEqual([2, 1]);

      // When: the conversation is deleted while the reader's call is held
      await api.deleteThread(thread.id);

      // Then: the reader answers every agent route exactly as a missing agent, and no list shows it
      for (const route of AGENT_ROUTES) await expectSameAsMissing(api, route, readerId, 'AGENT_NOT_FOUND');
      expect((await allAgents(api)).agents).toEqual([]);
      // Then: the ledger rows stay: the month's spend did not fall
      expect((await api.spend()).costUsd).toBeCloseTo(0.0006, 9);

      // When: the held call is released and a control conversation of the same owner runs a whole turn
      // through the workers and the fixture
      held.release();
      const control = await api.createThread();
      await api.send(control.id, controlTask);
      await untilIdle(api, control.id, (view) => view.entries.length === 4, 'the control conversation');

      // Then: nothing of the deleted tree called a tool or the model after the delete
      expect(fixtureCallsOf(harness.fixtureLog.callLog, { tool: 'get_trace', args: TRACE_INT3_C })).toHaveLength(1);
      expect(fixtureCallsOf(harness.fixtureLog.callLog, { tool: 'get_trace', args: TRACE_INT3_C_NEXT })).toEqual([]);
      expect([chat.calls.length, reader.calls.length]).toEqual([2, 1]);

      // Case 2 - Given: a conversation without a root; When: its first message and its delete start together
      const racing = await api.createThread();
      const [sent, deleted] = await Promise.all([
        api.raw('post', `/threads/${racing.id}/messages`, { text: raceTask }),
        api.raw('delete', `/threads/${racing.id}`),
      ]);

      // Then: the row lock orders them: the send went first (202, the delete removed the new root) or
      // found nothing (404); the delete succeeds either way
      expect(deleted.status).toBe(204);
      expect({ status: sent.status, body: sent.body as unknown }).toEqual(
        sent.status === 202
          ? { status: 202, body: { messageId: null } }
          : { status: 404, body: expect.objectContaining({ errorCode: 'THREAD_NOT_FOUND' }) },
      );
      // Then: the list lost the conversation and no chat root outlived its conversation
      expect((await api.listThreads()).threads.map((summary) => summary.id)).toEqual([control.id]);
      expect(await orphanChatRoots(harness, INT3.c)).toBe(0);
    } finally {
      held.release();
    }
  }, TEST_TIMEOUT_MS);

  // ---------------------------------------------------------------------------------------------------------------
  // INT-4  Isolation: every endpoint and the stream answer a foreign id as a missing one
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // NFR-06: "Изоляция данных пользователей — как в бизнес-ограничении 2 в `.claude/skills/project-context/SKILL.md`: каждая точка доступа к агентам, сессиям и workflow покрыта e2e-тестом с двумя пользователями."
  // AC-13.3: "Given агент принадлежит другому сотруднику, when сотрудник пытается его открыть, написать ему или остановить его, then ответ такой же, как для несуществующего агента."
  // AC-21.2: "Given у другого сотрудника есть агенты, when сотрудник открывает список, then чужих агентов в нём нет."
  // DC-3: "Каждая точка API отвечает на чужой id так же, как на несуществующий, тем же телом; маршруты агентов так же отвечают на id корня беседы."
  // DC-4: "Поток SSE отдаёт сотруднику заметки только о его беседах и части текста только его агентов."
  // Invariant 3: "Заметка `tree` и часть текста уходят только потокам владельца дерева."
  // Use case: UC-E1. EARS: If-then. Design flow: Contract Definitions (all routes), Security Considerations.
  //
  // Catches: one route of the part that serves a conversation, an agent, a run, a decision or the spend by id without the owner check or with a different answer for "foreign" and "missing" (a leak by itself: 403 vs 404, a different body or error code); a route that accepts the id of the conversation's ROOT as an agent id (the root is not an agent for the web, `AGENT_NOT_FOUND`); a stream that hands another employee's `tree` note or text part to a subscriber (hub keyed by the wrong owner, `watch=agent:<A's agent>` honoured for B);
//   a `GET /agents`, `GET /agents/awaiting` or `GET /spend` that includes another owner's data; a foreign `POST /decisions` that resolves A's request; a foreign `DELETE` that deletes A's tree; a send or interrupt that queues a message in A's conversation.
// Not re-checked here: the owner check of the `runtime_*` and `agent_*` operations themselves (runtime INT-4, agents INT-4), the MCP access table (agents INT-3 row A), authentication in production (every route 401 before real auth: one SessionGuard unit/contract check, not repeated per route).
// Behavior: owner B calls each route with owner A's ids and watches A's agent on a stream while A's agent writes history and text -> every answer equals the answer for an id that exists for nobody and B's stream stays silent -> nothing of A's changed
// @category: core-functionality
// @dependency: AppModule (every controller, LiveHub), createAgents, createWorkflows, createRuntime, scripted model double, MCP fixture (one mutating call awaiting confirmation), Postgres
// @complexity: medium
//
// Verification items (table-driven by route; A has a conversation with a root, a child agent, a coordinator of a workflow run, one open request, a held read call and ledger rows; B has own conversation and agent):
// - Rows: `GET /threads/:id`, `PATCH /threads/:id`, `DELETE /threads/:id`, `GET /threads/:id/history`, `GET /threads/:id/agents`, `POST /threads/:id/messages`, `POST /threads/:id/interrupt` (with and without text); `GET /agents/:id/history`, `.../inherited`, `.../run`, `POST /agents/:id/messages`, `.../interrupt`, `.../stop`, `.../restart` (with A's child id AND with A's ROOT id); `POST /decisions/:id` (approve and reject); `GET /events?watch=thread:<A's id>` and `watch=agent:<A's child id>` as B.
// - For each row the same request is made with a well-formed id that exists for nobody (the "missing" reference). Then: status code, `errorCode` (`THREAD_NOT_FOUND`, `AGENT_NOT_FOUND`, `RUN_NOT_FOUND`, `DECISION_NOT_FOUND`) and the whole body are equal, with nothing of A's data (title, task text, argument, count) in the answer; for the ROOT id the agent routes answer `AGENT_NOT_FOUND`, the same as for a missing agent.
// - The stream: B's stream (open on A's thread and on A's child agent, plus B's own thread) receives `ready` and only B's own notes while A's agent writes history and three text parts and its request is resolved by A; after the run B's received list contains no `tree` with A's thread id and no `delta` of A's agent; A's own stream (a control) did receive them.
// - B's lists: `GET /threads`, `GET /agents` (all pages), `GET /agents/awaiting` and `GET /spend` contain none of A's conversations or agents, count none of A's open request and sum none of A's ledger rows.
// - After all rows: a row-version snapshot of A's `chat_conversations` row, the agents tree and its inbox equals the snapshot before; A's request is still open and A can approve it (the fixture journal then holds one call); A's conversation and agent read in full for A.
  it('INT-4: every route and the stream called as another employee answer exactly as for a missing id, including the root id on agent routes, leak nothing of the owner\'s data, deliver none of the owner\'s notes or text parts, and change none of the owner\'s rows', async () => {
    // Given: A's conversation with a root, a reader whose call is held, a writer whose request is open,
    // and a finished workflow run; B's own conversation with one finished agent
    const a = chatApi(harness.app, INT4.a);
    const b = chatApi(harness.app, INT4.b);
    const aTitle = 'INT-4 A: the secret thread';
    const aTask = 'INT-4 A: the secret task';
    const aQuestion = 'INT-4 A: the secret question';
    const readerTask = 'INT-4 A: reader assignment';
    const writerTask = 'INT-4 A: writer assignment';
    const answerTask = 'INT-4 A: answer assignment';
    const bTask = 'INT-4 B: own task';
    const bOwnTask = 'INT-4 B: own assignment';
    const writerParts = ['A part one, ', 'A part two, ', 'A part three.'];
    const readerHeld = harness.fixtureLog.latch(FIXTURE_LATCHES.int4);
    const bOwnHeld = createLatch();
    harness.model.script(
      { task: aTask },
      [
        { calls: [startAgent('A reader', readerTask), startAgent('A writer', writerTask)] },
        { calls: [{ tool: START_WORKFLOW, args: briefArgs(aQuestion) }] },
      ],
      { thereafter: { text: 'A noted.' } },
    );
    harness.model.script({ task: readerTask }, [{ calls: [{ tool: GET_TRACE, args: TRACE_INT4 }] }], {
      thereafter: { text: 'Reader done.' },
    });
    harness.model.script(
      { task: writerTask },
      [{ calls: [{ tool: CREATE_INCIDENT_NOTE, args: NOTE_INT4 }] }, { text: writerParts }],
      { thereafter: { text: 'Writer noted.' } },
    );
    harness.model.script(
      { task: briefTask(aQuestion) },
      [{ calls: [startAgent('A answer', answerTask, 'deep-research-answer')] }],
      { thereafter: { text: 'Run done.' } },
    );
    harness.model.script({ task: answerTask }, [], { thereafter: { text: 'A answer.' } });
    harness.model.script(
      { task: bTask },
      [{ calls: [startAgent('B own', bOwnTask)] }, { text: 'B started one.' }],
      { thereafter: { text: 'B noted.' } },
    );
    harness.model.script({ task: bOwnTask }, [{ text: 'B own done.', latch: bOwnHeld }]);
    const streams: SseStream[] = [];
    try {
      const aThread = await a.createThread();
      await a.renameThread(aThread.id, aTitle);
      await a.send(aThread.id, aTask);
      const briefOpen = await waitFor(
        () => a.history(aThread.id),
        (view) =>
          view.agents.length === 2 &&
          view.decisions.some((decision) => decision.kind === WORKFLOWS_BRIEF_CONFIRMATION && decision.status === 'open'),
        'A\'s agents and brief',
      );
      const aBrief = briefOpen.decisions.find((decision) => decision.kind === WORKFLOWS_BRIEF_CONFIRMATION);
      if (aBrief === undefined) throw new Error('no brief of A');
      expect(await a.decide(aBrief.decisionId, { approve: true })).toEqual({ outcome: 'resolved' });
      await untilFixtureCall(TRACE_INT4, harness.fixtureLog.callLog);
      // A's tree is still: the run reported and the chat answered, the reader is held, the writer waits
      const aSettled = await untilIdle(
        a,
        aThread.id,
        (view) =>
          view.pending.length === 0 &&
          linesOf(view.entries).includes(`child_report: ${aQuestion} completed`) &&
          view.entries.at(-1)?.kind === 'model_answer' &&
          view.decisions.some((decision) => decision.tool === 'create_incident_note' && decision.status === 'open'),
        'A\'s tree to settle',
      );
      const aRoot = rootOf(aSettled);
      const readerId = agentNamed(aSettled.agents, 'A reader').agentId;
      const writerId = agentNamed(aSettled.agents, 'A writer').agentId;
      const coordinatorId = agentNamed(aSettled.agents, aQuestion).agentId;
      const aTreeIds = [aRoot, ...treeIds(aSettled.agents)];
      const aRequest = aSettled.decisions.find((decision) => decision.tool === 'create_incident_note');
      if (aRequest === undefined) throw new Error('no request of A\'s writer');

      const bThread = await b.createThread();
      await b.send(bThread.id, bTask);
      await bOwnHeld.reached();
      await untilIdle(b, bThread.id, (view) => linesOf(view.entries).includes('model_answer: B started one. []'), 'B\'s chat');
      bOwnHeld.open();
      await untilIdle(
        b,
        bThread.id,
        (view) =>
          view.pending.length === 0 &&
          linesOf(view.entries).includes('child_report: B own completed') &&
          view.entries.at(-1)?.kind === 'model_answer',
        'B\'s agent to report',
      );
      await waitFor(() => b.getThread(bThread.id), (summary) => summary.title === GENERATED_TITLE, 'B\'s title');

      // Given: B's streams on A's thread, on A's writer and on B's own thread; A's own stream on the writer (control)
      const bOnAThread = await openStream(harness.app, INT4.b, `thread:${aThread.id}`);
      streams.push(bOnAThread);
      const bOnAWriter = await openStream(harness.app, INT4.b, `agent:${writerId}`);
      streams.push(bOnAWriter);
      const bOnOwn = await openStream(harness.app, INT4.b, `thread:${bThread.id}`);
      streams.push(bOnOwn);
      const aControl = await openStream(harness.app, INT4.a, `agent:${writerId}`);
      streams.push(aControl);
      for (const stream of streams) await stream.next('ready');
      const before = await treeSnapshot(harness, aThread.id, aRoot);

      // When / Then: B calls every route with A's ids — each answer equals the answer for a missing id
      for (const route of THREAD_ROUTES) await expectSameAsMissing(b, route, aThread.id, 'THREAD_NOT_FOUND');
      for (const agentId of [readerId, aRoot]) {
        for (const route of AGENT_ROUTES) await expectSameAsMissing(b, route, agentId, 'AGENT_NOT_FOUND');
      }
      await expectSameAsMissing(b, { method: 'get', path: (id) => `/agents/${id}/run` }, coordinatorId, 'AGENT_NOT_FOUND');
      for (const approve of [true, false]) {
        await expectSameAsMissing(
          b,
          { method: 'post', path: (id) => `/decisions/${id}`, body: { approve } },
          aRequest.decisionId,
          'DECISION_NOT_FOUND',
        );
      }
      // When / Then: the conversation's ROOT is not an agent even for its owner (DC-3)
      for (const route of AGENT_ROUTES) await expectSameAsMissing(a, route, aRoot, 'AGENT_NOT_FOUND');

      // Then: B's lists hold only B's conversation, agent and money; none of A's request is counted
      expect((await b.listThreads()).threads.map((summary) => summary.id)).toEqual([bThread.id]);
      expect((await allAgents(b)).agents.map((agent) => `${agent.threadId} ${agent.description}`)).toEqual([
        `${bThread.id} B own`,
      ]);
      expect(await b.awaiting()).toEqual({ count: 0 });
      // 3 chat answers + 1 agent answer + 1 title call, each 1000 × 0.1 + 100 × 0.5 = 150 µUSD
      expect((await b.spend()).costUsd).toBeCloseTo(0.00075, 9);

      // Then: nothing of A's changed; A's request is still open
      expect(await treeSnapshot(harness, aThread.id, aRoot)).toEqual(before);
      expect(await a.awaiting()).toEqual({ count: 1 });

      // When: A approves the request; the writer writes its note and answers in three text parts
      expect(await a.decide(aRequest.decisionId, { approve: true })).toEqual({ outcome: 'resolved' });
      await waitFor(
        () => fixtureCallsOf(harness.fixtureLog.callLog, { tool: 'create_incident_note', args: NOTE_INT4 }),
        (calls) => calls.length === 1,
        'A\'s note on the fixture',
      );
      await aControl.until(
        (events) => deltasOf(events).map((delta) => delta.text).join('') === writerParts.join(''),
        'the writer\'s text parts on A\'s stream',
      );
      await aControl.until((events) => events.some((event) => isTreeOf(event, aThread.id)), 'a note of A\'s thread on A\'s stream');
      expect(new Set(deltasOf(aControl.events).map((delta) => delta.agentId))).toEqual(new Set([writerId]));
      await untilIdle(
        a,
        aThread.id,
        (view) =>
          view.pending.length === 0 &&
          agentNamed(view.agents, 'A writer').status === 'completed' &&
          linesOf(view.entries).includes('child_report: A writer completed') &&
          view.entries.at(-1)?.kind === 'model_answer',
        'A\'s chat after the writer\'s report',
      );

      // When: B writes in its own conversation (its note comes after every signal of A's: the hub handles them in order)
      await b.send(bThread.id, 'INT-4 B: still here');
      await bOnOwn.until((events) => events.some((event) => isTreeOf(event, bThread.id)), 'a note of B\'s own thread');

      // Then: B's streams started with `ready` and carried no note of A's thread and no part of A's agents
      for (const stream of [bOnAThread, bOnAWriter, bOnOwn]) {
        expect(stream.events[0]?.type).toBe('ready');
        expect(stream.events.filter((event) => isTreeOf(event, aThread.id))).toEqual([]);
        expect(deltasOf(stream.events).filter((delta) => aTreeIds.includes(delta.agentId))).toEqual([]);
      }

      // Then: A still reads its conversation and its agent in full
      const aView = await a.history(aThread.id);
      expect([aView.thread.title, aView.chat.rootAgentId, linesOf(aView.entries)[0]]).toEqual([aTitle, aRoot, `task: ${aTask}`]);
      expect(aView.decisions.find((decision) => decision.decisionId === aRequest.decisionId)?.status).toBe('resolved');
      const readerPage = await a.agentPage(readerId);
      expect([readerPage.agent.threadId, readerPage.agent.threadTitle, linesOf(readerPage.entries)[0]]).toEqual([
        aThread.id,
        aTitle,
        `task: ${readerTask}`,
      ]);
    } finally {
      readerHeld.release();
      bOwnHeld.open();
      for (const stream of streams) stream.close();
    }
  }, TEST_TIMEOUT_MS);
});
