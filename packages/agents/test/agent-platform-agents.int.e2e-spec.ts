// agent-platform / agents Integration Test Skeletons - Design Doc: docs/features/agent-platform/design-agents.md (Test Strategy UC-1..UC-5, UC-E1..UC-E11; Flows 1-7; Invariants 1-6; DC-1..DC-6)
// PRD: docs/features/agent-platform/prd.md (FR-03..FR-13, FR-25, FR-27 acceptance criteria; AC-01.2 and AC-02.1 in the agent's share; NFR-01, NFR-04, NFR-06, NFR-07). Upstream: docs/features/agent-platform/design-runtime.md (Contract Definitions, Test Strategy)
// Generated: 2026-11-14 | Part: agents | Test type: Integration (in-process `createRuntime` + `createAgents` over real Postgres, real MCP fixture process, scripted model), CI job `e2e-agents`
// Implementation timing: created alongside the slice each test names (INT-1 the agent loop and its history; INT-2 interrupt and stop; INT-3 the tool gate - refusals, confirmation, lost step; INT-4 the owner check of the agents operations).
//
// File name follows the project convention used by the runtime part (`*.e2e-spec.ts` under packages/<pkg>/test, picked up by `vitest.config.e2e.ts`, run with `pnpm --filter @agent-os/agents test:e2e`, never in the default `vitest run`).
// The package `packages/agents` does not exist yet: the part's first task creates it with the same `vitest.config.e2e.ts` and `test/support/migrate.global-setup.ts` shape as `packages/runtime`. The `.int.` infix separates in-process tests from a
// child-process file `agent-platform-agents.e2e-spec.ts`; THAT FILE IS NOT GENERATED (see "E2E" below). Started as `it.todo` skeletons; the Given/When/Then comments are the rows' specification. Tests are written with their tasks and run once, at the end of the part
// (project rule "Tests only at the end").
//
// Light test process (CLAUDE.md "Tests"): skeletons exist only where a defect is invisible below this level - the loop over a real database and the real runtime (history order, wake-ups, reports), a cancel with a call in flight, the tool gate in front of a real
// MCP server, and isolation of the `agent_*` tables. Every pure rule is a unit test named in "Proven elsewhere". Already proven by the runtime part and NOT repeated here: restart and recovery of a step and the process-kill matrix (runtime E2E-1), inbox order,
// one delivery and the lost wake-up race (runtime INT-2), the fence that refuses a cut-off step's late result, the closure of a stopped tree, its decisions and the one parent notification at the runtime level (runtime INT-3), the owner check of every runtime
// operation (runtime INT-4), the cost rule, the month window and the ledger surviving `deleteTree` (runtime INT-5), the decision surviving a restart and resolving once (runtime E2E-1 row "decision").
//
// Environment (Design Doc "Test Strategy"):
// - Postgres 16 from infra/docker-compose.yml (DATABASE_URL from apps/api/.env), migrations (runtime and agents) applied once by the global setup. Real `createRuntime` and real `createAgents` over a real pool, `RUNTIME_WORKERS` on. No mock of Postgres, of the runtime
//   or of any agents component.
// - The model is the only double: a scripted `ModelClient` double at the wrapper boundary (Design Doc: "модель подменяется на границе `ModelClient` сценарием ответов"). A scenario is a list of answers per agent (keyed by the agent's description), each answer text
//   and/or tool calls plus `usage`; the double records the input of every call (the messages as the provider would get them), which is the assertion surface for "the next model call sees X". The double sits INSIDE the wrapper, below its ledger write
//   (KD-6: "сразу после ответа обёртка пишет вызов в журнал токенов"), so INT-1 row A can assert real ledger rows; if the plan puts the double above the ledger write, that one assertion moves out of this file. Answers may be gated (the call waits on a latch) so a
//   step is held with its model call in flight.
// - MCP is real: the `packages/mcp-fixture` stdio process started through `MCP_SERVERS_FILE` (`logs` read-only; `backoffice` with the new mutating `create_incident_note`), `FIXTURE_CALL_LOG` (JSONL journal shared by every fixture process of the test) is the
//   evidence of what reached a server. Slow reads and a failing server use the fixture's fault schedule. `MCP_ACCESS_TABLE` per test maps the test's owners to servers.
// - Two instances in one process (INT-3 rows C and E; every other row runs one instance) are two `createRuntime` + `createAgents` pairs over two pools to the same database. The second instance is the "restarted server": it has its own MCP processes and reads everything
//   else from the database; "lease expired" is the harness `expireLease`, a held handler of the first instance is the zombie.
// - Isolation (project convention, no truncate): a unique owner `newUser()` per test and a unique definition name per test (definitions are registered before `start()` into the test's own catalog); each test reads only its own tree. `fileParallelism: false`.
// - No sleeps for ordering and no latency assertions: tests synchronise on latches the double and the fixture wait on, and on rows. "Status within 5 s" (NFR-01) is asserted as: the status read right after the command returns, while the call is still held; the 5 s figure
//   belongs to the runtime part's on-demand script.
// - Support to write alongside (test/support): agentsHarness.ts (database + runtime + agents, scripted double, fixture config, second instance, `expireLease`), scriptedModel.ts (scenarios, latches, recorded inputs), fixtureLog.ts (read and filter the call log).
//
// Budget: Integration 4 of 3 (base 3, extended by one under the integration-e2e-testing rule). Core: INT-1, INT-2, INT-3. Extra: INT-4.
//   INT-4 unique defect: an `agents` operation that reads `agent_sessions`, `agent_messages` or `agent_tool_calls` by id (history, list, restart, confirmations) before, or without, the runtime owner check - the runtime's own INT-4 covers only the `runtime_*`
//   tables and cannot see these three. CLAUDE.md lists isolation first and NFR-06 asks one two-user test per access point.
//
// E2E: 0 of 1-2 - the file `agent-platform-agents.e2e-spec.ts` is deliberately not generated. The one thing only a dead process proves - the step commit boundary - is runtime E2E-1, which already kills the runtime at every commit point with a generic handler.
//   What is specific to agents after a loss (a call in `sending` gets outcome `unknown`, an open read call runs once more, the pending message is in the history once) is a property of the agent handler reading the lost-attempt flag; an in-process zombie plus a lease
//   expiry (INT-3 row E, the technique of runtime INT-3 row A) reaches exactly that branch with the same inputs a real kill leaves. A child-process row here would repeat the kill matrix for the same defect. The journeys a user notices first (chat starts an agent, the
//   report comes back as the chat's next turn, confirmation in the conversation) cross `chat` and `web` and belong to those parts' E2E.
//
// Proven elsewhere (not in this file; the plan reads this to avoid a second test for an AC already proven):
// - unit, packages/agents/src, one table-driven file per rule (literal rows, no database):
//     * model resolution - launch model, then definition model, then AGENT_DEFAULT_MODEL, then UNKNOWN_MODEL for a model without a price - AC-04.1, AC-04.2, AC-04.3, DC-2, UC-E8 (the chosen model reaching the provider call is wired by INT-1 row A)
//     * the tool-call gate rule - `tool_not_in_definition`, `no_access`, `depth_limit`, `not_allowed` (list and count), `unknown_agent`, `invalid_arguments`, and "allowed" - AC-03.1, AC-10.2, AC-10.3, DC-6, UC-E4 rule rows; the boundary half (the refused call never
//       reaches the server, never creates a task) is INT-3 row A and INT-1 row D
//     * the turn counter - counts model calls since the task, not the compaction call; resets when the agent finishes a turn (report, failure, stop, interrupt without text) and, for a root session, on each delivered employee message - DC-1 (the effect on a real run is INT-1 row C)
//     * the end-of-turn decision - text without calls ends the turn; with unfinished children the child waits; with `finalAgent` set a text without that agent's report is refused - KD-2, DC-3, DC-4, Invariant 4 (the wiring is INT-1 rows A and D)
//     * the agent status derivation (State Transitions table, MC-3 labels) - `working`, `awaiting_confirmation`, `interrupted`, `completed`, `failed`, `stopped`, including "interrupted from a pending `interrupt` message before the step takes it" - KD-3
//     * history to provider messages - the single place of Invariant 3 (a delivered message after the last result of its answer and before the next answer; a call is never separated from its result), `<data>` envelope with delimiter escaping, fork reference
//       (history up to `throughSeq` plus the task), compaction summary replaces older entries for the model while `history` still returns all; this is also the property test: FOR ALL histories with open calls and delivered messages in any interleaving, the provider
//       messages never put a message between a call and its result (SHRINK: fewest entries) - AC-07.1, AC-07.2 (assembly half), AC-25.1 and AC-27.1 (assembly half)
//     * MCP result to outcome - `success`, `empty`, `tool_error`, `transport_failure`, and the read-only classification by `readOnlyHint` (absent means mutating) - AC-13.1 (outcome rows), KD-4
//     * `parseAgentsConfig` and the catalog check in `start()` - unknown server in the access table, no servers file, duplicate definition name, unknown tool or agent reference, unpriced model: one table, each row a startup error naming the variable or the name
// - runtime INT-1..INT-5 and E2E-1 (list above): everything about steps, inbox, fence, stop closure, owner check of `runtime_*`, ledger and restarts.
// - not automated: AgentView does not carry tokens or cost (AC-13.2: a type shape; the chosen model in the view is a unit row of the status/view mapping and the ledger row is INT-1 row A); the zod validation of `start_agent` arguments (library; the gate row
//   `invalid_arguments` is in the unit table); `AGENT_TOOL_RESULT_MAX_BYTES` truncation (one unit row if the plan wants it, no AC); the Haiku quality risk (a manual run after the `chat` part, per the Design Doc risk list).
//
// AC -> proving test:
// - AC-01.2 (agent share): INT-3 row E
// - AC-02.1: INT-1 row A (ledger row per model call, with the session's task id and the chosen model)
// - AC-03.1, AC-10.2, AC-11.3: unit gate table + INT-3 row A (boundary); AC-03.2: INT-1 row C; DC-1: unit turn counter + INT-1 row C
// - AC-04.1..AC-04.3, DC-2: unit model table (+ INT-1 row A wiring)
// - AC-05.1..AC-05.3, AC-06.1, AC-06.2, AC-10.1, DC-3: INT-1 row A; AC-06.3: INT-2 row B (stopped) and INT-1 row C (failed with a reason)
// - AC-07.1..AC-07.3: INT-1 row B; AC-09.1, AC-09.2: INT-1 row C; DC-4: INT-1 row D
// - AC-08.1, AC-08.2: INT-2 row A; AC-08.3, AC-08.4: INT-2 row B; NFR-01 (status inside the command): INT-2 rows A, B
// - AC-10.3: unit gate table (+ the refused start creates no task: INT-1 row D); AC-11.1: INT-3 row A; AC-11.2: INT-3 row F
// - AC-12.1, AC-12.2, NFR-07: INT-3 row B; AC-12.3, AC-12.5: INT-3 row C; AC-12.4: INT-3 row D; DC-5: INT-3 row E; DC-6: unit gate table + INT-3 row A
// - AC-13.1: INT-3 (rows A, B, E, F read the call record: time, tool, arguments, outcome, one row per call) over the unit outcome table; AC-13.3, NFR-06: INT-4
// - AC-25.1, AC-27.1: INT-1 row E (the wiring) over the unit assembly table; NFR-04 in the agent's share: INT-1 row B (order in history) and the runtime INT-2

import { randomUUID } from 'node:crypto';
import { type AgentTurnMessage, GENERAL_PURPOSE } from '@agent-os/agents';
import type { LogRecord } from '@agent-os/common';
import { createLatch, createScriptedModel, inputLines, type ScriptedToolCall } from '@agent-os/agents/testing';
import { crashOn, createFixtureFiles, fixtureCallsOf, holdCall } from '@agent-os/mcp-fixture';
import { describe, expect, it } from 'vitest';
import {
  type AgentsHarness,
  BACKOFFICE_SERVER,
  type ChildNotice,
  childNoticesOf,
  closeAll,
  createAgentsHarness,
  eventsOf,
  expireLease,
  historyLines,
  historyOf,
  historyRowVersionsOf,
  LOGS_SERVER,
  ledgerRowsOf,
  TEST_MODEL_CHOSEN,
  testDefinition,
  toolCallRowsOf,
  treeRowVersionsOf,
  uniqueName,
  waitFor,
  waitForTaskStatus,
} from './support/agentsHarness.js';
import { newUser } from './support/new-user.js';

/** Bound of one in-process test; the rows settle far sooner. */
const TEST_TIMEOUT_MS = 120_000;

/** Arguments of the fixture's read tool `get_trace` (the `logs` server): two distinct calls of one tool. */
const TRACE_A = { traceId: 'a'.repeat(32) };
const TRACE_B = { traceId: 'b'.repeat(32) };
/** `get_trace` of the `logs` server as the model names it. */
const GET_TRACE = 'mcp__logs__get_trace';
/** The fixture's mutating tool (the `backoffice` server) as the model names it, and its arguments. */
const CREATE_INCIDENT_NOTE = 'mcp__backoffice__create_incident_note';
const INCIDENT_NOTE = { orderId: 'ORD-1001', text: 'Customer charged twice' };
/** A built-in call that needs no server: the agent's descendants. */
const LIST_AGENTS: ScriptedToolCall = { tool: 'list_agents', args: {} };

/** `AGENT_COMPACT_AT_TOKENS` of INT-1 E: far above the default usage of a scripted answer. */
const COMPACT_AT_TOKENS = 5_000;
/** The request that follows the history in a compaction call (`compaction-step.ts`, FR-27). */
const COMPACTION_REQUEST =
  'The conversation above is getting too long. Write a summary of it that replaces it for you from now on. ' +
  'Keep the task, what the employee and other agents asked, every decision made, the facts found with ' +
  'their sources, the agents you started and their results, and what is left to do. ' +
  'Answer with the summary text only; do not call tools.';

/** A `start_agent` call of a scripted answer. */
function startAgent(args: { agent: string; description: string; prompt: string; model?: string }): ScriptedToolCall {
  return { tool: 'start_agent', args };
}

/** Agents the agent started, in the order of its `start_agent` calls. */
async function startedChildrenOf(harness: AgentsHarness, agentId: string): Promise<(string | undefined)[]> {
  const calls = await toolCallRowsOf(harness.db, agentId);
  return calls.flatMap((call) =>
    call.tool === 'start_agent' && call.childTaskId !== null ? [call.childTaskId] : [],
  );
}

/** A parent's end notices as `<status>[ <reason>][ <report>]`. */
function noticeSummaries(notices: readonly ChildNotice[]): string[] {
  return notices.map(({ payload }) =>
    [payload.status, payload.failure?.reason, payload.result?.report]
      .filter((part): part is string => part !== undefined)
      .join(' '),
  );
}

/**
 * What an operation answered, as one line: `answered <value>` or `<error name> <code> <message>`, with the
 * id the caller passed replaced by `<id>`, so the answers for two ids compare as equal when they are.
 */
async function answerOf(work: Promise<unknown>, id: string): Promise<string> {
  try {
    return `answered ${JSON.stringify(await work)}`;
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const { code } = error as Error & { code?: unknown };
    return `${error.name} ${String(code)} ${error.message.replaceAll(id, '<id>')}`;
  }
}

/**
 * An agent's audit rows (AC-13.1) as `<server>/<tool> <state> <outcome>[ <reason>] <timed|untimed>`:
 * `timed` when the row has both its start and its end time. Arguments are compared as objects apart
 * (jsonb does not keep the key order).
 */
async function auditLinesOf(harness: AgentsHarness, agentId: string): Promise<string[]> {
  return (await toolCallRowsOf(harness.db, agentId)).map((call) =>
    [
      call.server === null ? call.tool : `${call.server}/${call.tool}`,
      call.state,
      call.outcome ?? '-',
      ...(call.refusalReason === null ? [] : [call.refusalReason]),
      call.startedAt !== null && call.finishedAt !== null ? 'timed' : 'untimed',
    ].join(' '),
  );
}

/** What the model got as the result of one of its earlier tool calls, as text. */
function toolOutputOf(messages: readonly AgentTurnMessage[], toolCallId: string | undefined): string {
  for (const message of messages) {
    if (message.role !== 'tool') continue;
    const result = message.results.find((candidate) => candidate.toolCallId === toolCallId);
    if (result !== undefined) {
      return typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
    }
  }
  throw new Error(`The model input holds no result of call ${String(toolCallId)}`);
}

/** Log records of one agent's steps with this message, from one harness. */
function stepLogsOf(harness: AgentsHarness, agentId: string, message: string): LogRecord[] {
  return harness.logs.filter((record) => record.message === message && record.fields.taskId === agentId);
}

/** The first answer of a writer (INT-3 B-E): a read call, then the mutating `create_incident_note`. */
const READ_THEN_NOTE = [
  { tool: GET_TRACE, args: TRACE_A },
  { tool: CREATE_INCIDENT_NOTE, args: INCIDENT_NOTE },
] as const satisfies readonly ScriptedToolCall[];

/**
 * Starts a root writer and waits until its step asks the employee to confirm `create_incident_note`;
 * returns the agent and its one open request.
 */
async function startWriterUntilConfirmation(
  harness: AgentsHarness,
  request: { ownerId: string; definition: string; prompt: string },
): Promise<{ agentId: string; decisionId: string }> {
  const { agentId } = await harness.sessions.start({ ...request, description: 'writer' });
  await waitFor(
    () => harness.sessions.get(agentId, request.ownerId),
    (view) => view.status === 'awaiting_confirmation',
    'the confirmation request of the writer',
  );
  const [open] = (await harness.sessions.confirmations(agentId, request.ownerId)).filter((c) => c.status === 'open');
  if (open === undefined) throw new Error('the writer has no confirmation request');
  return { agentId, decisionId: open.decisionId };
}

/** The `task.queued` payload of a task queued again by a `revive` message. */
function isRevive(payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null && (payload as { cause?: unknown }).cause === 'revive';
}

describe('agent-platform / agents - integration (in-process runtime + agents, real Postgres, real MCP fixture, scripted model)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-1  The agent loop: start in the background and report back, a message lands after the tool result, continue, final agent, fork and compaction
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-05.1: "Given беседа, when сотрудник просит выполнить задачу в фоне, then чат сразу сообщает, что агент запущен, и принимает следующее сообщение до того, как агент закончит." (the agent's half: `start_agent` returns the id inside the step)
  // AC-05.2: "Given агент запущен, when открыть его историю, then она начинается с текста задания, и в ней нет сообщений родительской сессии."
  // AC-05.3: "Given из одной беседы запущено несколько агентов, when они работают, then они работают одновременно и не ждут друг друга."
  // AC-06.1: "Given агент сдал отчёт, when родитель свободен, then отчёт начинает его следующий ход: в беседе чат сам отвечает на отчёт, без нового сообщения сотрудника."
  // AC-06.2: "Given агент сдал отчёт, when родитель занят, then отчёт ждёт в очереди родителя и доставляется по FR-07."
  // AC-10.1: "Given агент запустил дочернего, when дочерний сдаёт отчёт, then отчёт получает этот агент, а не беседа."
  // AC-02.1: "Given агент вызвал модель, when вызов закончился, then в журнале есть запись: сессия, агент, модель, входные и выходные токены, стоимость в долларах."
  // AC-07.1: "Given агент ждёт результата инструмента, when сотрудник отправляет ему сообщение, then сообщение появляется в истории сразу после этого результата, и следующий вызов модели его учитывает."
  // AC-07.2: "Given агенту отправлено несколько сообщений подряд, when они доставляются, then порядок в истории совпадает с порядком отправки."
  // AC-07.3: "Given агент отвечает текстом без вызова инструментов, when приходит сообщение, then оно доставляется после конца хода и начинает следующий ход."
  // AC-03.2: "Given агент сделал предельное число ходов, when модель просит ещё один ход, then агент получает статус «сбой» с причиной «исчерпан предел ходов», а родитель — уведомление."
  // AC-09.1: "Given агент в статусе «завершён», «сбой», «остановлен» или «прерван», when ему приходит сообщение, then он снова работает в той же сессии, видит всю прежнюю историю и новое сообщение, а потом сдаёт родителю ещё один отчёт."
  // AC-09.2: "Given агент закончил работу, when сотрудник запускает его с нуля, then появляется новый агент с тем же определением, заданием и родителем, его история начинается с задания, а прежний агент остаётся в списке."
  // DC-3: "Дочерний агент завершается ответом без вызовов только без незаконченных детей; с ними он ждёт их уведомлений."
  // DC-4: "Агент с ограничениями вызывающего не запускает агента вне списка или сверх числа и получает отказ; если задан агент последнего шага, попытка закончить без его отчёта получает отказ, а отчётом сессии становится отчёт этого агента."
  // DC-1: "Предел ходов считает вызовы модели с начала задания, кроме вызова сжатия, и обнуляется, когда агент закончил ход: сдал отчёт, упал, остановлен или прерван без текста; в корневой сессии он обнуляется ещё и с каждым доставленным сообщением сотрудника."
  // AC-25.1: "Given беседа с историей, when чат запускает ответвление, then агент отвечает с учётом разговора до момента запуска, а история беседы не меняется."
  // AC-27.1: "Given история агента подошла к пределу окна модели, when агент делает следующий ход, then ход проходит без ошибки переполнения, а в истории видна отметка сжатия."
  // Invariants 3 and 4: "Доставленное сообщение стоит в истории после всех результатов, записанных тем же шагом, а в сообщениях провайдера — после последнего результата своего ответа и до следующего ответа модели." / "Дочерний агент не завершается, пока у него есть незаконченные дети."
  // Use cases: UC-1, UC-2, UC-4, UC-5, UC-E3, UC-E10, UC-E11. EARS: When / While. Design flows: Flow 1 (a turn), Flow 2 (start in the background and report), Flow 3 (a message to a busy agent), Flow 6 (continue), KD-1, KD-2, KD-7.
  //
  // Catches: (1) a parent that does not get the child's report as its next turn, or gets a grandchild's report instead of its own child's (reports routed to the root), or a child that finishes while its own child still works (DC-3) - the loop's wiring to the runtime
  //   notification, invisible to unit tests of the rules; (2) a message that lands before the result of the call that was running (the provider then sees a message between a call and its result) or out of order - the step that writes results and delivered messages
  //   in the wrong sequence; (3) a turn counter that is not reset on continue, so a continued agent fails again at once, or a failed agent that is not continued in the same session; (4) a refused `start_agent` that still creates a task, or a final-agent
  //   refusal that lets the parent's own text become the session's report; (5) a fork reference off by one entry (the parent's current answer or its pending `start_agent` call leaks into, or is missing from, the child's first input) and a compaction that is
  //   written but never triggered from the previous call's usage; (6) a model call that leaves no ledger row, or one on a model other than the session's chosen one.
  // Not re-checked here: the order, single delivery and wake-up of the inbox (runtime INT-2), the rules of the turn counter, the end-of-turn decision and the history assembly (unit), the cost of a call (runtime INT-5).
  // Behavior: scripted model answers drive tools -> steps commit history, tasks, reports and ledger rows -> the tree's histories read as one coherent conversation, in order, with every report going to its own parent
  // @category: core-functionality
  // @dependency: createRuntime, createAgents (AgentStepHandler, start_agent / message_agent built-ins, history repositories, ModelClient wrapper with ledger write), scripted model double, MCP fixture (`logs` read, delayed), Postgres
  // @complexity: high
  //
  // Verification items (table-driven by scenario; costs and model ids are hardcoded literals):
  // - Row A "background start and report" (UC-1): a root session (no parent) whose script starts two `general-purpose` children in one answer while a slow read call is held on the fixture; child 1 makes one read call and answers with a report; child 2 starts a
  //   grandchild, answers text while the grandchild works, and reports only after the grandchild's report. Then: the root's `start_agent` results are in ONE step and carry two distinct `agentId`s; the children's histories begin with the task text and hold no entry of the
  //   root; the children were working at the same time (a latch both wait on is released only when both are in a model call); child 2 stays `working` after its first text and completes only after the grandchild's report, which child 2 received (the root's history has no
  //   `child_report` of the grandchild); the child reports that arrived during the root's slow call are absent from that step's input, present in the root's next model input, and the free root woke by itself (no employee message sent) and its call sees both reports;
  //   the ledger holds exactly one row per scripted model call, with the session's task id and the model the session was started with - the child started with an explicit `model` is on that model and the others on `AGENT_DEFAULT_MODEL` (literals); `agents.get`
  //   shows the chosen model and no token or cost field.
  // - Row B "a message to a busy agent lands after the tool result" (UC-2): the agent's read call is held on the fixture. `agents.send` twice, then a third message after the first two. Then: the history reads, in order, `tool_result`, `user_message` 1, `user_message` 2,
  //   `user_message` 3, `model_answer`; the model call after the release has all three after the result in its input, in the order sent. Second case in the same row: a root that answered text and waits; one `agents.send` wakes it (status leaves waiting with no other command)
  //   and its next model input begins the turn with that message.
  // - Row C "turn limit, then continue, then restart" (UC-E3, UC-4): a definition with `maxTurns` 2 under a parent; the script always asks for a tool. Then: exactly two model calls, the agent `failed` with `failureReason` `turn_limit`, the parent holds one notification
  //   with that reason. `agents.send` to the failed agent: it works in the SAME session (same `agentId`, history intact and the new message last), gets the full turn limit again (two more model calls), and its report is a SECOND notification to the parent. Then the
  //   finished agent `agents.restart`s: a NEW `agentId` with the same definition, task text, model, limits and parent, its history starts at the task with nothing of the old one, and the old agent is still in `agents.list`; restarting a working agent answers `NOT_FINISHED`.
  // - Row D "caller limits and the final agent" (UC-5): a root session always waits at the end of a turn ("Конец хода"), so the session checked is a CHILD of the root, started with `sessions.start({ parentId: <root>, limits: { agents: { planner: 1, answer: 1 },
  //   finalAgent: 'answer' } })` (plan T6.1). The script starts `planner` twice, then `gatherer` once, then answers text, then starts `answer`, then (after its report) answers text.
  //   Then: the second `planner` and `gatherer` have outcome `refused` with reason `not_allowed` and NO task was created for either (the session's children are the first planner and `answer` only); the first text answer is met by a `notice`
  //   entry and a new turn rather than ending the session; the report its parent (the root) receives is `answer`'s report, not the session's own text; the refused calls appear in the history with the reason.
  // - Row E "fork and compaction" (UC-E10, UC-E11): a root with three exchanges calls `start_agent` with `fork`. Then: the fork's first model input holds the root's three exchanges up to the entry before the answer that contains the `start_agent` call, then the task; the root's
  //   history is unchanged (row versions of its entries before and after) and the fork's own history starts at its task. Second case: a model call whose `usage` input tokens are at `AGENT_COMPACT_AT_TOKENS` (set low for the test); the next step writes a `compaction`
  //   entry and a `compacted` event, the call after it gets the summary instead of the older entries, and `agents.history` still returns every entry in order.
  // - Row F "a message during the last step" (Flow 6 Failure handling, design-runtime v1.2 StepResult): a child holds its last model call on a latch and answers text without calls. When `agents.send` reaches it during that call and the latch opens, then: the child ends
  //   `completed` with its report, the parent holds exactly one `child_finished` of that end, the task is `queued` again with the same id (`task.queued` with cause `revive`), the next step sees the message, and the child's second report is a second notification.
  it('INT-1 A: two children start in one step and work at once, a grandchild reports to its own parent, reports reach a free parent as its next turn and a busy one on the next step, and each model call is one ledger row on the session\'s model', async () => {
    // Given: a root that starts two general-purpose children in one answer, then holds a read call on the fixture;
    // child one reads and reports, child two starts a grandchild and reports after it
    const ownerId = newUser();
    const rootName = uniqueName('coordinator');
    const fixture = createFixtureFiles();
    const rootRead = fixture.latch('root-read');
    fixture.setFaults([holdCall('get_trace', TRACE_A, rootRead)]);
    const bothChildren = createLatch();
    const grandchildHeld = createLatch();
    const model = createScriptedModel();
    const root = model.script({ task: 'Coordinate the two children' }, [
      {
        calls: [
          startAgent({ agent: GENERAL_PURPOSE.name, description: 'child one', prompt: 'Child one task', model: TEST_MODEL_CHOSEN }),
          startAgent({ agent: GENERAL_PURPOSE.name, description: 'child two', prompt: 'Child two task' }),
        ],
      },
      { calls: [{ tool: GET_TRACE, args: TRACE_A }] },
      { text: 'waiting for child two' },
      { text: 'all done' },
    ]);
    const childOne = model.script({ task: 'Child one task' }, [
      { calls: [{ tool: GET_TRACE, args: TRACE_B }], latch: bothChildren },
      { text: 'report of child one' },
    ]);
    const childTwo = model.script({ task: 'Child two task' }, [
      {
        calls: [startAgent({ agent: GENERAL_PURPOSE.name, description: 'grandchild', prompt: 'Grandchild task' })],
        latch: bothChildren,
      },
      { text: 'child two waits for the grandchild' },
      { text: 'report of child two' },
    ]);
    const grandchild = model.script({ task: 'Grandchild task' }, [
      { text: 'report of grandchild', latch: grandchildHeld },
    ]);
    const harness = await createAgentsHarness({
      model,
      fixture,
      access: { [ownerId]: [LOGS_SERVER] },
      definitions: [
        testDefinition(rootName, {
          tools: ['start_agent'],
          mcpServers: [LOGS_SERVER],
          agents: [GENERAL_PURPOSE.name],
        }),
      ],
    });
    try {
      // When: the root runs; its read is held while both children reach their first model call together
      const { agentId: rootId } = await harness.sessions.start({
        ownerId,
        definition: rootName,
        prompt: 'Coordinate the two children',
        description: 'root',
      });
      await waitFor(
        () => fixtureCallsOf(fixture.callLog, { tool: 'get_trace', args: TRACE_A }),
        (calls) => calls.length === 1,
        'the root read call on the fixture',
      );
      await bothChildren.reached(2);
      // Then: both children are inside their first model call at the same time
      expect([childOne.calls.length, childTwo.calls.length]).toEqual([1, 1]);
      bothChildren.open();

      const [childOneId, childTwoId] = await startedChildrenOf(harness, rootId);
      if (childOneId === undefined || childTwoId === undefined) throw new Error('the root started no two children');
      await waitForTaskStatus(harness, childOneId, ownerId, 'completed');
      await grandchildHeld.reached();
      await childTwo.called(2);
      await waitForTaskStatus(harness, childTwoId, ownerId, 'waiting');
      // Then: child two answered text while its grandchild works, and still works
      expect((await harness.sessions.get(childTwoId, ownerId)).status).toBe('working');

      rootRead.release();
      await root.called(3);
      await waitForTaskStatus(harness, rootId, ownerId, 'waiting');
      grandchildHeld.open();
      await waitForTaskStatus(harness, childTwoId, ownerId, 'completed');
      await root.called(4);
      await waitForTaskStatus(harness, rootId, ownerId, 'waiting');

      // Then: both start_agent results came back in one step, with two distinct agent ids
      const rootCalls = await toolCallRowsOf(harness.db, rootId);
      expect(rootCalls.map((call) => `${call.answerSeq} ${call.tool} ${call.outcome}`)).toEqual([
        '2 start_agent success',
        '2 start_agent success',
        '5 get_trace success',
      ]);
      expect(new Set([childOneId, childTwoId]).size).toBe(2);
      expect(inputLines(root.calls[1]?.messages ?? [])).toEqual([
        'user: Coordinate the two children',
        'assistant:  [start_agent, start_agent]',
        'tool: start_agent, start_agent',
      ]);

      // Then: each child's history starts at its task and holds nothing of the root
      expect(historyLines(await historyOf(harness, childOneId, ownerId))).toEqual([
        'task: Child one task',
        'model_answer:  [logs/get_trace]',
        'tool_result: get_trace success',
        'model_answer: report of child one []',
      ]);
      expect(historyLines(await historyOf(harness, childTwoId, ownerId))).toEqual([
        'task: Child two task',
        'model_answer:  [start_agent]',
        'tool_result: start_agent success',
        'model_answer: child two waits for the grandchild []',
        'child_report: grandchild completed',
        'model_answer: report of child two []',
      ]);

      // Then: the grandchild reported to child two, not to the root
      const [grandchildId] = await startedChildrenOf(harness, childTwoId);
      if (grandchildId === undefined) throw new Error('child two started no grandchild');
      const rootHistory = await historyOf(harness, rootId, ownerId);
      expect(
        rootHistory.flatMap((entry) => (entry.kind === 'child_report' ? [entry.content.agentId] : [])),
      ).toEqual([childOneId, childTwoId]);

      // Then: child one's report, sent while the root's read call ran, stands after the read result and
      // reached the root's next model call; child two's report woke the waiting root by itself
      expect(historyLines(rootHistory)).toEqual([
        'task: Coordinate the two children',
        'model_answer:  [start_agent, start_agent]',
        'tool_result: start_agent success',
        'tool_result: start_agent success',
        'model_answer:  [logs/get_trace]',
        'tool_result: get_trace success',
        'child_report: child one completed',
        'model_answer: waiting for child two []',
        'child_report: child two completed',
        'model_answer: all done []',
      ]);
      const thirdInput = inputLines(root.calls[2]?.messages ?? []);
      expect(thirdInput.slice(0, 5)).toEqual([
        'user: Coordinate the two children',
        'assistant:  [start_agent, start_agent]',
        'tool: start_agent, start_agent',
        'assistant:  [mcp__logs__get_trace]',
        'tool: mcp__logs__get_trace',
      ]);
      expect(thirdInput).toHaveLength(6);
      expect(thirdInput[5]).toContain(`<data source="child agent report" author="${childOneId}">`);
      expect(thirdInput[5]).toContain('report of child one');
      const fourthInput = inputLines(root.calls[3]?.messages ?? []);
      expect(fourthInput.at(-2)).toBe('assistant: waiting for child two []');
      expect(fourthInput.at(-1)).toContain(`<data source="child agent report" author="${childTwoId}">`);
      expect(fourthInput.at(-1)).toContain('report of child two');
      expect(root.calls.flatMap((call) => inputLines(call.messages)).join('\n')).not.toContain(grandchildId);

      // Then: one ledger row per model call, with the session's task and the session's model
      expect(model.calls).toHaveLength(10);
      const ledger = (await ledgerRowsOf(harness.db, ownerId)).map((row) => `${row.taskId} ${row.model}`);
      expect(ledger.sort()).toEqual(
        [
          ...Array<string>(4).fill(`${rootId} anthropic/test-default`),
          ...Array<string>(2).fill(`${childOneId} anthropic/test-chosen`),
          ...Array<string>(3).fill(`${childTwoId} anthropic/test-default`),
          `${grandchildId} anthropic/test-default`,
        ].sort(),
      );
      expect(childOne.calls.map((call) => call.model)).toEqual(['anthropic/test-chosen', 'anthropic/test-chosen']);
      expect(grandchild.calls.map((call) => call.model)).toEqual(['anthropic/test-default']);

      // Then: the view shows the chosen model and no token or cost field
      const view = await harness.sessions.get(childOneId, ownerId);
      expect(view.model).toBe('anthropic/test-chosen');
      expect(Object.keys(view).sort()).toEqual([
        'agentId',
        'createdAt',
        'definition',
        'depth',
        'description',
        'failureReason',
        'finishedAt',
        'forkedFrom',
        'model',
        'parentId',
        'rootId',
        'status',
      ]);
    } finally {
      rootRead.release();
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  it('INT-1 B: messages sent to an agent while its read call runs stand in the history after that result in the order sent, the next model call sees them, and a message to a waiting root starts its turn', async () => {
    // Given: a root whose read call is held on the fixture
    const ownerId = newUser();
    const readerName = uniqueName('reader');
    const fixture = createFixtureFiles();
    const held = fixture.latch('read');
    fixture.setFaults([holdCall('get_trace', TRACE_A, held)]);
    const model = createScriptedModel();
    const reader = model.script({ task: 'Read the trace' }, [
      { calls: [{ tool: GET_TRACE, args: TRACE_A }] },
      { text: 'answer after the messages' },
      { text: 'answer to the fourth message' },
    ]);
    const harness = await createAgentsHarness({
      model,
      fixture,
      access: { [ownerId]: [LOGS_SERVER] },
      definitions: [testDefinition(readerName, { mcpServers: [LOGS_SERVER] })],
    });
    try {
      const { agentId } = await harness.sessions.start({
        ownerId,
        definition: readerName,
        prompt: 'Read the trace',
        description: 'reader',
      });
      await waitFor(
        () => fixtureCallsOf(fixture.callLog, { tool: 'get_trace', args: TRACE_A }),
        (calls) => calls.length === 1,
        'the read call on the fixture',
      );

      // When: two messages, then a third, reach the agent while its call runs; the call is released
      await harness.sessions.send({ agentId, ownerId, text: 'first message' });
      await harness.sessions.send({ agentId, ownerId, text: 'second message' });
      await harness.sessions.send({ agentId, ownerId, text: 'third message' });
      held.release();
      await reader.called(2);
      await waitForTaskStatus(harness, agentId, ownerId, 'waiting');

      // Then: the messages stand after the result in the order sent, and the next call sees all three
      expect(historyLines(await historyOf(harness, agentId, ownerId))).toEqual([
        'task: Read the trace',
        'model_answer:  [logs/get_trace]',
        'tool_result: get_trace success',
        'user_message: first message',
        'user_message: second message',
        'user_message: third message',
        'model_answer: answer after the messages []',
      ]);
      expect(inputLines(reader.calls[1]?.messages ?? [])).toEqual([
        'user: Read the trace',
        'assistant:  [mcp__logs__get_trace]',
        'tool: mcp__logs__get_trace',
        'user: first message',
        'user: second message',
        'user: third message',
      ]);

      // When: one message reaches the root waiting after its text answer
      await harness.sessions.send({ agentId, ownerId, text: 'fourth message' });
      await reader.called(3);
      await waitForTaskStatus(harness, agentId, ownerId, 'waiting');

      // Then: the message alone woke it, and its next model input begins the turn with that message
      expect(inputLines(reader.calls[2]?.messages ?? []).slice(-2)).toEqual([
        'assistant: answer after the messages []',
        'user: fourth message',
      ]);
      expect(historyLines(await historyOf(harness, agentId, ownerId)).slice(-2)).toEqual([
        'user_message: fourth message',
        'model_answer: answer to the fourth message []',
      ]);
    } finally {
      held.release();
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  it('INT-1 C: an agent that hits its turn limit fails with turn_limit and tells its parent, is continued by a message in the same session with a full limit, and a finished agent restarts as a new one with the same definition, task, model and parent', async () => {
    // Given: under a parent, an agent with maxTurns 2 whose script always asks for a tool
    const ownerId = newUser();
    const parentName = uniqueName('parent');
    const limitedName = uniqueName('limited');
    const model = createScriptedModel();
    model.script({ task: 'Parent of the limited agent' }, [], { thereafter: { text: 'noted' } });
    const limited = model.script({ task: 'Limited task' }, [
      { calls: [LIST_AGENTS] },
      { calls: [LIST_AGENTS] },
      { calls: [LIST_AGENTS] },
      { text: 'report after the continue' },
      { text: 'report of the restarted agent' },
    ]);
    const harness = await createAgentsHarness({
      model,
      access: {},
      definitions: [
        testDefinition(parentName),
        testDefinition(limitedName, { tools: ['list_agents'], maxTurns: 2 }),
      ],
    });
    try {
      const { agentId: parentId } = await harness.sessions.start({
        ownerId,
        definition: parentName,
        prompt: 'Parent of the limited agent',
        description: 'parent',
      });
      const { agentId } = await harness.sessions.start({
        ownerId,
        parentId,
        definition: limitedName,
        prompt: 'Limited task',
        description: 'limited',
      });

      // When: it runs out of turns
      await waitForTaskStatus(harness, agentId, ownerId, 'failed');

      // Then: exactly two model calls, `failed` with turn_limit, one notice with that reason to the parent
      expect(limited.calls).toHaveLength(2);
      const failed = await harness.sessions.get(agentId, ownerId);
      expect([failed.status, failed.failureReason]).toEqual(['failed', 'turn_limit']);
      expect(noticeSummaries(await childNoticesOf(harness.db, parentId, agentId))).toEqual([
        'failed turn_limit',
      ]);

      // When: a message continues the failed agent
      await harness.sessions.send({ agentId, ownerId, text: 'try again' });
      await waitForTaskStatus(harness, agentId, ownerId, 'completed');

      // Then: the same session, the whole history and the message last, a full limit again (two more calls),
      // and a second notice to the parent
      expect(limited.calls).toHaveLength(4);
      expect(inputLines(limited.calls[2]?.messages ?? [])).toEqual([
        'user: Limited task',
        'assistant:  [list_agents]',
        'tool: list_agents',
        'assistant:  [list_agents]',
        'tool: list_agents',
        'user: [event] failed: turn_limit',
        'user: [event] continued',
        'user: try again',
      ]);
      expect(historyLines(await historyOf(harness, agentId, ownerId))).toEqual([
        'task: Limited task',
        'model_answer:  [list_agents]',
        'tool_result: list_agents empty',
        'model_answer:  [list_agents]',
        'tool_result: list_agents empty',
        'event: failed turn_limit',
        'event: continued',
        'user_message: try again',
        'model_answer:  [list_agents]',
        'tool_result: list_agents empty',
        'model_answer: report after the continue []',
      ]);
      expect(noticeSummaries(await childNoticesOf(harness.db, parentId, agentId))).toEqual([
        'failed turn_limit',
        'completed report after the continue',
      ]);

      // When: the finished agent is restarted
      const { agentId: restartedId } = await harness.sessions.restart({ agentId, ownerId });
      await waitForTaskStatus(harness, restartedId, ownerId, 'completed');

      // Then: a new agent with the same definition, task, model and parent; its history starts anew; the old one stays listed
      expect(restartedId).not.toBe(agentId);
      const restarted = await harness.sessions.get(restartedId, ownerId);
      expect([restarted.definition, restarted.description, restarted.model, restarted.parentId]).toEqual([
        limitedName,
        'limited',
        'anthropic/test-default',
        parentId,
      ]);
      expect(inputLines(limited.calls[4]?.messages ?? [])).toEqual(['user: Limited task']);
      expect(historyLines(await historyOf(harness, restartedId, ownerId))).toEqual([
        'task: Limited task',
        'model_answer: report of the restarted agent []',
      ]);
      const listed = (await harness.sessions.list(parentId, ownerId)).map((view) => view.agentId);
      expect(listed).toEqual(expect.arrayContaining([agentId, restartedId]));

      // Then: an agent that has not finished is not restarted
      await expect(harness.sessions.restart({ agentId: parentId, ownerId })).rejects.toMatchObject({
        code: 'NOT_FINISHED',
      });
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  it('INT-1 D: a start outside the caller limits or over their count is refused without creating a task, a text answer without the final agent\'s report gets a notice, and the final agent\'s report becomes the session\'s report', async () => {
    // Given: a child of the root started with limits { planner x1, answer x1 } and final agent `answer`;
    // its definition alone would also allow `gatherer`
    const ownerId = newUser();
    const rootName = uniqueName('root');
    const coordinatorName = uniqueName('coordinator');
    const plannerName = uniqueName('planner');
    const gathererName = uniqueName('gatherer');
    const answerName = uniqueName('answer');
    const atThirdCall = createLatch();
    const plannerHeld = createLatch();
    const answerHeld = createLatch();
    const model = createScriptedModel();
    model.script({ task: 'Root of the limited session' }, [], { thereafter: { text: 'noted' } });
    const coordinator = model.script({ task: 'Coordinate with limits' }, [
      { calls: [startAgent({ agent: plannerName, description: 'planner', prompt: 'Plan A' })] },
      { calls: [startAgent({ agent: plannerName, description: 'second planner', prompt: 'Plan B' })] },
      {
        calls: [startAgent({ agent: gathererName, description: 'gatherer', prompt: 'Gather' })],
        latch: atThirdCall,
      },
      { text: 'my own summary' },
      { calls: [startAgent({ agent: answerName, description: 'answer', prompt: 'Write the answer' })] },
      { text: 'waiting for the answer' },
      { text: 'session done' },
    ]);
    model.script({ task: 'Plan A' }, [{ text: 'plan ready', latch: plannerHeld }]);
    model.script({ task: 'Write the answer' }, [{ text: 'final answer text', latch: answerHeld }]);
    const harness = await createAgentsHarness({
      model,
      access: {},
      definitions: [
        testDefinition(rootName),
        testDefinition(coordinatorName, {
          tools: ['start_agent'],
          agents: [plannerName, gathererName, answerName],
        }),
        testDefinition(plannerName),
        testDefinition(gathererName),
        testDefinition(answerName),
      ],
    });
    try {
      const { agentId: rootId } = await harness.sessions.start({
        ownerId,
        definition: rootName,
        prompt: 'Root of the limited session',
        description: 'root',
      });
      const { agentId } = await harness.sessions.start({
        ownerId,
        parentId: rootId,
        definition: coordinatorName,
        prompt: 'Coordinate with limits',
        description: 'coordinator',
        limits: { agents: { [plannerName]: 1, [answerName]: 1 }, finalAgent: answerName },
      });

      // When: the planner reports while the session's third call runs; then the answer agent reports
      // while the session waits for it
      await atThirdCall.reached();
      const [plannerId] = await startedChildrenOf(harness, agentId);
      if (plannerId === undefined) throw new Error('the session started no planner');
      plannerHeld.open();
      await waitForTaskStatus(harness, plannerId, ownerId, 'completed');
      atThirdCall.open();
      await answerHeld.reached();
      await coordinator.called(6);
      await waitForTaskStatus(harness, agentId, ownerId, 'waiting');
      answerHeld.open();
      await waitForTaskStatus(harness, agentId, ownerId, 'completed');

      // Then: the second planner and the gatherer are refused with not_allowed and created no task
      const calls = await toolCallRowsOf(harness.db, agentId);
      expect(calls.map((call) => `${call.tool} ${call.outcome} ${call.refusalReason ?? '-'}`)).toEqual([
        'start_agent success -',
        'start_agent refused not_allowed',
        'start_agent refused not_allowed',
        'start_agent success -',
      ]);
      const children = (await harness.sessions.list(rootId, ownerId)).filter((view) => view.parentId === agentId);
      expect(children.map((view) => view.definition).sort()).toEqual([answerName, plannerName].sort());

      // Then: the text without the final agent's report met a notice and a new turn; the refusals are in the history
      expect(historyLines(await historyOf(harness, agentId, ownerId))).toEqual([
        'task: Coordinate with limits',
        'model_answer:  [start_agent]',
        'tool_result: start_agent success',
        'model_answer:  [start_agent]',
        'tool_result: start_agent refused not_allowed',
        'model_answer:  [start_agent]',
        'tool_result: start_agent refused not_allowed',
        'child_report: planner completed',
        'model_answer: my own summary []',
        `notice: You cannot finish: there is no report of agent "${answerName}" yet. The session ends only with a completed report of agent "${answerName}"; start it with start_agent.`,
        'model_answer:  [start_agent]',
        'tool_result: start_agent success',
        'model_answer: waiting for the answer []',
        'child_report: answer completed',
        'model_answer: session done []',
      ]);

      // Then: the parent receives the final agent's report, not the session's own text
      expect(noticeSummaries(await childNoticesOf(harness.db, rootId, agentId))).toEqual([
        'completed final answer text',
      ]);
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  it('INT-1 E: a fork sees the parent\'s history up to its start call and leaves it unchanged, and input tokens at the threshold make the next step a compaction that the model sees and the history keeps', async () => {
    // Given: a root with three exchanges whose third answer starts a fork; a second root whose first call
    // reports input tokens at AGENT_COMPACT_AT_TOKENS
    const ownerId = newUser();
    const forkerName = uniqueName('forker');
    const compactorName = uniqueName('compactor');
    const forkHeld = createLatch();
    const model = createScriptedModel();
    const forker = model.script(
      { task: 'Talk, then fork' },
      [
        { text: 'answer one' },
        { text: 'answer two' },
        {
          text: 'forking now',
          calls: [startAgent({ agent: 'fork', description: 'the fork', prompt: 'Fork task' })],
        },
      ],
      { thereafter: { text: 'noted' } },
    );
    const fork = model.script({ task: 'Fork task' }, [{ text: 'report of the fork', latch: forkHeld }]);
    const compactor = model.script({ agent: compactorName }, [
      { text: 'first answer', usage: { inputTokens: COMPACT_AT_TOKENS } },
      { text: 'summary of the talk' },
      { text: 'answer after compaction' },
    ]);
    const harness = await createAgentsHarness({
      model,
      access: {},
      variables: { AGENT_COMPACT_AT_TOKENS: String(COMPACT_AT_TOKENS) },
      definitions: [testDefinition(forkerName, { tools: ['start_agent'] }), testDefinition(compactorName)],
    });
    try {
      // When: three exchanges, the third answer starting a fork that is held in its first call
      const { agentId: rootId } = await harness.sessions.start({
        ownerId,
        definition: forkerName,
        prompt: 'Talk, then fork',
        description: 'forker',
      });
      await forker.called(1);
      await waitForTaskStatus(harness, rootId, ownerId, 'waiting');
      await harness.sessions.send({ agentId: rootId, ownerId, text: 'question two' });
      await forker.called(2);
      await waitForTaskStatus(harness, rootId, ownerId, 'waiting');
      await harness.sessions.send({ agentId: rootId, ownerId, text: 'question three' });
      await forkHeld.reached();
      const before = await historyRowVersionsOf(harness.db, rootId);
      forkHeld.open();
      const [forkId] = await startedChildrenOf(harness, rootId);
      if (forkId === undefined) throw new Error('the root started no fork');
      await waitForTaskStatus(harness, forkId, ownerId, 'completed');

      // Then: the fork's first input is the root's history through the entry before the answer with the
      // start call, then its task
      expect(inputLines(fork.calls[0]?.messages ?? [])).toEqual([
        'user: Talk, then fork',
        'assistant: answer one []',
        'user: question two',
        'assistant: answer two []',
        'user: question three',
        'user: Fork task',
      ]);
      expect((await harness.sessions.get(forkId, ownerId)).forkedFrom).toEqual({ agentId: rootId, throughSeq: 5 });
      expect(historyLines(await historyOf(harness, forkId, ownerId))).toEqual([
        'task: Fork task',
        'model_answer: report of the fork []',
      ]);

      // Then: the root's history is unchanged by the fork
      const after = await historyRowVersionsOf(harness.db, rootId);
      expect(after.slice(0, before.length)).toEqual(before);
      expect(historyLines(await historyOf(harness, rootId, ownerId)).slice(0, 6)).toEqual([
        'task: Talk, then fork',
        'model_answer: answer one []',
        'user_message: question two',
        'model_answer: answer two []',
        'user_message: question three',
        'model_answer: forking now [start_agent]',
      ]);

      // When: the compacting root answers at the threshold, then gets a message
      const { agentId: compactorId } = await harness.sessions.start({
        ownerId,
        definition: compactorName,
        prompt: 'Compact me',
        description: 'compactor',
      });
      await compactor.called(1);
      await waitForTaskStatus(harness, compactorId, ownerId, 'waiting');
      await harness.sessions.send({ agentId: compactorId, ownerId, text: 'next question' });
      await compactor.called(3);
      await waitForTaskStatus(harness, compactorId, ownerId, 'waiting');

      // Then: the next step was the compaction call, the call after it sees the summary instead of the
      // older entries, and the history keeps every entry in order
      expect(inputLines(compactor.calls[1]?.messages ?? [])).toEqual([
        'user: Compact me',
        'assistant: first answer []',
        `user: ${COMPACTION_REQUEST}`,
      ]);
      expect(inputLines(compactor.calls[2]?.messages ?? [])).toEqual([
        'user: <data source="summary of the earlier history" author="agents">\nsummary of the talk\n</data>',
        'user: [event] compacted',
        'user: next question',
      ]);
      const compactorHistory = await historyOf(harness, compactorId, ownerId);
      expect(historyLines(compactorHistory)).toEqual([
        'task: Compact me',
        'model_answer: first answer []',
        'compaction: summary of the talk',
        'event: compacted',
        'user_message: next question',
        'model_answer: answer after compaction []',
      ]);
      expect(
        compactorHistory.flatMap((entry) => (entry.kind === 'compaction' ? [entry.content.throughSeq] : [])),
      ).toEqual([2]);
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  it('INT-1 F: a revive message that arrives during a child\'s last step finishes the task, notifies the parent once and requeues the task with that message', async () => {
    // Given: a child under a root holds its last model call, which answers text without calls
    const ownerId = newUser();
    const rootName = uniqueName('root');
    const childName = uniqueName('last-step');
    const lastStep = createLatch();
    const model = createScriptedModel();
    model.script({ task: 'Root of the last step' }, [], { thereafter: { text: 'noted' } });
    const child = model.script({ task: 'Last step task' }, [
      { text: 'first report', latch: lastStep },
      { text: 'second report' },
    ]);
    const harness = await createAgentsHarness({
      model,
      access: {},
      definitions: [testDefinition(rootName), testDefinition(childName)],
    });
    try {
      const { agentId: rootId } = await harness.sessions.start({
        ownerId,
        definition: rootName,
        prompt: 'Root of the last step',
        description: 'root',
      });
      const { agentId } = await harness.sessions.start({
        ownerId,
        parentId: rootId,
        definition: childName,
        prompt: 'Last step task',
        description: 'last step',
      });

      // When: a message reaches the child during that call, then the call answers
      await lastStep.reached();
      await harness.sessions.send({ agentId, ownerId, text: 'late message' });
      lastStep.open();
      await child.called(2);
      await waitFor(
        () => childNoticesOf(harness.db, rootId, agentId),
        (notices) => notices.length === 2,
        'the second notice of the child',
      );

      // Then: one notice per end, each with its report
      expect(noticeSummaries(await childNoticesOf(harness.db, rootId, agentId))).toEqual([
        'completed first report',
        'completed second report',
      ]);
      // Then: the task was queued again by the message right after its first end, with the same id
      const events = (await eventsOf(harness.db, agentId))
        .filter((event) => event.type === 'task.completed' || (event.type === 'task.queued' && isRevive(event.payload)))
        .map((event) => (event.type === 'task.queued' ? `${event.type} ${JSON.stringify(event.payload, ['cause', 'from'])}` : event.type));
      expect(events).toEqual([
        'task.completed',
        'task.queued {"cause":"revive","from":"completed"}',
        'task.completed',
      ]);
      // Then: the next step saw the message in the same session
      expect(inputLines(child.calls[1]?.messages ?? [])).toEqual([
        'user: Last step task',
        'assistant: first report []',
        'user: [event] continued',
        'user: late message',
      ]);
      expect(historyLines(await historyOf(harness, agentId, ownerId))).toEqual([
        'task: Last step task',
        'model_answer: first report []',
        'event: continued',
        'user_message: late message',
        'model_answer: second report []',
      ]);
      expect((await harness.sessions.get(agentId, ownerId)).status).toBe('completed');
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2  Interrupt and stop with a call in flight: open calls are closed, the status changes in the command, the tree stops calling the model
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-08.1: "Given агент работает, when сотрудник прерывает его вместе с сообщением, then текущая операция отменяется, незаконченные вызовы инструментов получают в истории результат «прервано пользователем», и агент сразу продолжает с этим сообщением."
  // AC-08.2: "Given агент работает, when сотрудник прерывает его без сообщения, then агент получает статус «прерван» и ждёт следующего сообщения."
  // AC-08.3: "Given агент работает или ждёт, when сотрудник его останавливает, then агент получает статус «остановлен», больше не вызывает ни модель, ни инструменты, а родитель получает уведомление."
  // AC-08.4: "Given у агента есть работающие потомки, when агента останавливают, then потомки тоже получают статус «остановлен»."
  // AC-06.3: "Given агент закончил со статусом «сбой» или «остановлен», when родитель получает уведомление, then в нём есть статус и причина."
  // NFR-01: "Прерывание и остановка меняют статус агента не позже чем через 5 с после команды (p95). Измеряется тестом, где агент ждёт долгого инструмента." (status inside the command here; the figure is the runtime part's script)
  // KD-3 (the contract this row proves): "Шаг, который получил такое сообщение, закрывает все открытые вызовы с исходом «прервано» (вызов в `sending` — «исход неизвестен»), затем ставит текст в историю и вызывает модель, а без текста ставит сессии отметку «прерван» и ждёт."
  // Use cases: UC-E1, UC-E2. EARS: When. Design flows: Flow 4 (interrupt), Flow 7 (stop with descendants), KD-3.
  //
  // Catches: (1) an interrupted agent whose open call stays "requested" forever or is recorded as a success when the slow server finally answers, or whose status reads `working` until the step happens to take the message (KD-3's derived status); (2) an interrupt
  //   with text that does not reach the next model call, or one without text that still calls the model; (3) a call in `sending` (a mutating action already on the wire) shown as "interrupted" instead of "unknown" - claiming a send that may have happened was
  //   cancelled; (4) a stop that leaves the child or grandchild calling the model, an open confirmation still shown as pending, a missing `stopped_with_parent` entry, or a parent that is told twice or not at all - the agent-level reading of the runtime's stop.
  // Not re-checked here: the fence that refuses the cut-off step's late result, the cancelled decision row and the closure of the task tree (runtime INT-3), the status table (unit), `NOT_ACTIVE` for a finished agent (a branch of the operation, trivial).
  // Behavior: command while a call is held -> status changes before the call returns -> the open calls are closed in the history -> the agent continues with the text, waits, or (stop) never calls the model again
  // @category: core-functionality
  // @dependency: createRuntime x1-2, createAgents (interrupt, stop, history, get; step that consumes the interrupt message), scripted model double with call counter, MCP fixture (delayed read, delayed mutating call), Postgres
  // @complexity: high
  //
  // Verification items (table-driven by command):
  // - Row A "interrupt" (UC-E1; two cases): the agent waits for a slow read call held on the fixture. Case 1, `agents.interrupt` with text: `agents.get` read right after the command (call still held) shows `interrupted`; once the step runs, the open call has outcome
  //   `interrupted`, the text stands after it, the next model input has the text, and the slow server's late answer (released afterwards) writes no result and no second row (one `agent_tool_calls` row for the call). Case 2, without text: `interrupted` at once, the history
  //   ends with the `interrupted` event, the model double gets NO further call (counter unchanged) until `agents.send`; the message then clears the mark, the agent continues, and its status is `working`. Case 3, the call is a confirmed mutating one already in
  //   `sending` (held on the fixture): after the interrupt its outcome is `unknown`, not `interrupted`.
  // - Row B "stop of a subtree" (UC-E2): agent R (with a parent P) has child C (waiting on a held read call, with an open confirmation request from a second call) and grandchild G; the row stops R. Then: R, C and G read
  //   `stopped` right after the command; C's open call has outcome `interrupted` and its confirmation is no longer in `confirmations`; `agents.history` of R ends with `stopped`, of C and G with `stopped_with_parent`; the model double's call counter is
  //   unchanged after the command even when the held calls are released and workers run again; R's parent holds exactly one notification with status `stopped`; `agents.stop` on R again returns an empty list.
  it('INT-2 A: interrupting an agent with a call in flight shows interrupted in the command, closes the call, hands the text to the next model call or waits without one, and marks a call already sending as unknown', async () => {
    // Given: three agents of one owner, each with a call held on the fixture: a read call (with text),
    // a read call (without text), and a confirmed create_incident_note already sending
    const ownerId = newUser();
    const readerName = uniqueName('reader');
    const writerName = uniqueName('writer');
    const fixture = createFixtureFiles();
    const readWithText = fixture.latch('read-with-text');
    const readWithoutText = fixture.latch('read-without-text');
    const noteSending = fixture.latch('note-sending');
    fixture.setFaults([
      holdCall('get_trace', TRACE_A, readWithText),
      holdCall('get_trace', TRACE_B, readWithoutText),
      holdCall('create_incident_note', INCIDENT_NOTE, noteSending),
    ]);
    const model = createScriptedModel();
    const withText = model.script({ task: 'Read, then be interrupted with text' }, [
      { calls: [{ tool: GET_TRACE, args: TRACE_A }] },
      { text: 'answer to the interrupt' },
      { text: 'answer after the release' },
    ]);
    const withoutText = model.script({ task: 'Read, then be interrupted without text' }, [
      { calls: [{ tool: GET_TRACE, args: TRACE_B }] },
      { text: 'answer after the message' },
    ]);
    const writer = model.script({ task: 'Write the note, then be interrupted' }, [
      { calls: [{ tool: CREATE_INCIDENT_NOTE, args: INCIDENT_NOTE }] },
    ]);
    const harness = await createAgentsHarness({
      model,
      fixture,
      access: { [ownerId]: [LOGS_SERVER, BACKOFFICE_SERVER] },
      definitions: [
        testDefinition(readerName, { mcpServers: [LOGS_SERVER] }),
        testDefinition(writerName, { mcpServers: [BACKOFFICE_SERVER] }),
      ],
    });
    try {
      // Case 1 - When: the agent is interrupted with text while its read call is held
      const { agentId: firstId } = await harness.sessions.start({
        ownerId,
        definition: readerName,
        prompt: 'Read, then be interrupted with text',
        description: 'interrupted with text',
      });
      await waitFor(
        () => fixtureCallsOf(fixture.callLog, { tool: 'get_trace', args: TRACE_A }),
        (calls) => calls.length === 1,
        'the read call of case 1 on the fixture',
      );
      expect(await harness.sessions.interrupt({ agentId: firstId, ownerId, text: 'stop reading, answer now' })).toBe(
        'interrupted',
      );
      // Then: with text the agent goes on at once (KD-3: «Прерван» only without text)
      expect((await harness.sessions.get(firstId, ownerId)).status).toBe('working');
      await withText.called(2);
      await waitForTaskStatus(harness, firstId, ownerId, 'waiting');

      // Then: the open call is closed as interrupted, the text stands after it, the next model call has it
      expect(historyLines(await historyOf(harness, firstId, ownerId))).toEqual([
        'task: Read, then be interrupted with text',
        'model_answer:  [logs/get_trace]',
        'tool_result: get_trace interrupted',
        'event: interrupted',
        'user_message: stop reading, answer now',
        'model_answer: answer to the interrupt []',
      ]);
      expect(inputLines(withText.calls[1]?.messages ?? [])).toEqual([
        'user: Read, then be interrupted with text',
        'assistant:  [mcp__logs__get_trace]',
        'tool: mcp__logs__get_trace',
        'user: [event] interrupted',
        'user: stop reading, answer now',
      ]);

      // When: the slow server answers late, and a message makes the agent take one more step
      readWithText.release();
      await harness.sessions.send({ agentId: firstId, ownerId, text: 'after the release' });
      await withText.called(3);
      await waitForTaskStatus(harness, firstId, ownerId, 'waiting');

      // Then: the late answer wrote no result and no second row
      const firstCalls = await toolCallRowsOf(harness.db, firstId);
      expect(firstCalls.map((call) => `${call.tool} ${call.state} ${call.outcome}`)).toEqual([
        'get_trace done interrupted',
      ]);
      expect(
        historyLines(await historyOf(harness, firstId, ownerId)).filter((line) => line.startsWith('tool_result')),
      ).toEqual(['tool_result: get_trace interrupted']);

      // Case 2 - When: the agent is interrupted without text while its read call is held
      const { agentId: secondId } = await harness.sessions.start({
        ownerId,
        definition: readerName,
        prompt: 'Read, then be interrupted without text',
        description: 'interrupted without text',
      });
      await waitFor(
        () => fixtureCallsOf(fixture.callLog, { tool: 'get_trace', args: TRACE_B }),
        (calls) => calls.length === 1,
        'the read call of case 2 on the fixture',
      );
      expect(await harness.sessions.interrupt({ agentId: secondId, ownerId })).toBe('interrupted');

      // Then: `interrupted` inside the command, the call closed, the history ends with the event
      expect((await harness.sessions.get(secondId, ownerId)).status).toBe('interrupted');
      await waitFor(
        () => historyOf(harness, secondId, ownerId),
        (entries) => historyLines(entries).at(-1) === 'event: interrupted',
        'the interrupted event of case 2',
      );
      await waitForTaskStatus(harness, secondId, ownerId, 'waiting');
      expect(historyLines(await historyOf(harness, secondId, ownerId))).toEqual([
        'task: Read, then be interrupted without text',
        'model_answer:  [logs/get_trace]',
        'tool_result: get_trace interrupted',
        'event: interrupted',
      ]);
      expect((await harness.sessions.get(secondId, ownerId)).status).toBe('interrupted');

      // Then: the step that took the interrupt called no model: one call until a message comes
      readWithoutText.release();
      expect(withoutText.calls).toHaveLength(1);

      // When: a message reaches the interrupted agent
      await harness.sessions.send({ agentId: secondId, ownerId, text: 'go on' });
      await withoutText.called(2);
      await waitForTaskStatus(harness, secondId, ownerId, 'waiting');

      // Then: the message cleared the mark and the agent continued with it
      expect(withoutText.calls).toHaveLength(2);
      expect(inputLines(withoutText.calls[1]?.messages ?? []).slice(-3)).toEqual([
        'tool: mcp__logs__get_trace',
        'user: [event] interrupted',
        'user: go on',
      ]);
      expect((await harness.sessions.get(secondId, ownerId)).status).toBe('working');

      // Case 3 - When: a confirmed create_incident_note is on the wire (intent `sending`) and the agent is interrupted
      const { agentId: writerId } = await harness.sessions.start({
        ownerId,
        definition: writerName,
        prompt: 'Write the note, then be interrupted',
        description: 'writer',
      });
      await waitFor(
        () => harness.sessions.get(writerId, ownerId),
        (view) => view.status === 'awaiting_confirmation',
        'the confirmation request of case 3',
      );
      const [request] = (await harness.sessions.confirmations(writerId, ownerId)).filter((c) => c.status === 'open');
      if (request === undefined) throw new Error('the writer has no confirmation request');
      expect(
        await harness.sessions.resolveConfirmation({ decisionId: request.decisionId, ownerId, approve: true }),
      ).toBe('resolved');
      await waitFor(
        () => fixtureCallsOf(fixture.callLog, { tool: 'create_incident_note', args: INCIDENT_NOTE }),
        (calls) => calls.length === 1,
        'the confirmed note call on the fixture',
      );
      expect((await toolCallRowsOf(harness.db, writerId)).map((call) => call.state)).toEqual(['sending']);
      expect(await harness.sessions.interrupt({ agentId: writerId, ownerId })).toBe('interrupted');
      await waitFor(
        () => historyOf(harness, writerId, ownerId),
        (entries) => historyLines(entries).at(-1) === 'event: interrupted',
        'the interrupted event of case 3',
      );

      // Then: the call that may have reached the server is unknown, not interrupted, and was sent once
      expect(historyLines(await historyOf(harness, writerId, ownerId))).toEqual([
        'task: Write the note, then be interrupted',
        'model_answer:  [backoffice/create_incident_note]',
        'tool_result: create_incident_note unknown',
        'event: interrupted',
      ]);
      expect((await toolCallRowsOf(harness.db, writerId)).map((call) => `${call.state} ${call.outcome}`)).toEqual([
        'done unknown',
      ]);
      expect(fixtureCallsOf(fixture.callLog, { tool: 'create_incident_note' })).toHaveLength(1);
      expect(writer.calls).toHaveLength(1);
    } finally {
      readWithText.release();
      readWithoutText.release();
      noteSending.release();
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  it('INT-2 B: stopping an agent stops its child and grandchild, closes their calls and confirmations, writes the stop entries, calls the model no more, and tells the parent once', async () => {
    // Given: P (a root) has child R; R holds its model call and has child C; C has a pending confirmation of
    // create_incident_note and an open read call; C has grandchild G whose read call is held on the fixture
    const ownerId = newUser();
    const parentName = uniqueName('parent');
    const stoppedName = uniqueName('stopped');
    const childName = uniqueName('child');
    const grandchildName = uniqueName('grandchild');
    const fixture = createFixtureFiles();
    const grandchildRead = fixture.latch('grandchild-read');
    fixture.setFaults([holdCall('get_trace', TRACE_A, grandchildRead)]);
    const stoppedHeld = createLatch();
    const model = createScriptedModel();
    const parent = model.script({ task: 'Parent of the stopped agent' }, [], { thereafter: { text: 'noted' } });
    const stoppedScript = model.script({ task: 'Agent to stop' }, [{ text: 'never reported', latch: stoppedHeld }]);
    const childScript = model.script({ task: 'Child of the stopped agent' }, [
      {
        calls: [
          { tool: CREATE_INCIDENT_NOTE, args: INCIDENT_NOTE },
          { tool: GET_TRACE, args: TRACE_B },
        ],
      },
    ]);
    const grandchildScript = model.script({ task: 'Grandchild of the stopped agent' }, [
      { calls: [{ tool: GET_TRACE, args: TRACE_A }] },
    ]);
    const harness = await createAgentsHarness({
      model,
      fixture,
      access: { [ownerId]: [LOGS_SERVER, BACKOFFICE_SERVER] },
      definitions: [
        testDefinition(parentName),
        testDefinition(stoppedName),
        testDefinition(childName, { mcpServers: [LOGS_SERVER, BACKOFFICE_SERVER] }),
        testDefinition(grandchildName, { mcpServers: [LOGS_SERVER] }),
      ],
    });
    try {
      const { agentId: parentId } = await harness.sessions.start({
        ownerId,
        definition: parentName,
        prompt: 'Parent of the stopped agent',
        description: 'parent',
      });
      await parent.called(1);
      await waitForTaskStatus(harness, parentId, ownerId, 'waiting');
      const { agentId: stoppedId } = await harness.sessions.start({
        ownerId,
        parentId,
        definition: stoppedName,
        prompt: 'Agent to stop',
        description: 'stopped',
      });
      await stoppedHeld.reached();
      const { agentId: childId } = await harness.sessions.start({
        ownerId,
        parentId: stoppedId,
        definition: childName,
        prompt: 'Child of the stopped agent',
        description: 'child',
      });
      await waitFor(
        () => harness.sessions.get(childId, ownerId),
        (view) => view.status === 'awaiting_confirmation',
        'the confirmation request of the child',
      );
      const { agentId: grandchildId } = await harness.sessions.start({
        ownerId,
        parentId: childId,
        definition: grandchildName,
        prompt: 'Grandchild of the stopped agent',
        description: 'grandchild',
      });
      await waitFor(
        () => fixtureCallsOf(fixture.callLog, { tool: 'get_trace', args: TRACE_A }),
        (calls) => calls.length === 1,
        'the grandchild read call on the fixture',
      );
      expect(
        (await harness.sessions.confirmations(parentId, ownerId)).filter((c) => c.status === 'open').map(
          (request) => `${request.agentId} ${request.server}/${request.tool} ${JSON.stringify(request.args, Object.keys(INCIDENT_NOTE))}`,
        ),
      ).toEqual([`${childId} backoffice/create_incident_note ${JSON.stringify(INCIDENT_NOTE)}`]);

      // When: R is stopped
      const stoppedIds = await harness.sessions.stop({ agentId: stoppedId, ownerId });

      // Then: R, C and G are stopped inside the command and the confirmation is no longer pending
      expect(stoppedIds).toEqual([stoppedId, childId, grandchildId]);
      const statuses = await Promise.all(
        [stoppedId, childId, grandchildId].map(async (id) => (await harness.sessions.get(id, ownerId)).status),
      );
      expect(statuses).toEqual(['stopped', 'stopped', 'stopped']);
      expect((await harness.sessions.confirmations(parentId, ownerId)).filter((c) => c.status === 'open')).toEqual([]);

      // When: the held calls are released and the workers run again (the parent wakes on R's notice)
      stoppedHeld.open();
      grandchildRead.release();
      await parent.called(2);
      await waitForTaskStatus(harness, parentId, ownerId, 'waiting');

      // Then: the stopped tree called the model no more
      expect([stoppedScript.calls.length, childScript.calls.length, grandchildScript.calls.length]).toEqual([1, 1, 1]);

      // Then: R's history ends with `stopped`; C and G show their open calls closed and `stopped_with_parent`
      expect(historyLines(await historyOf(harness, stoppedId, ownerId))).toEqual([
        'task: Agent to stop',
        'event: stopped',
      ]);
      expect(historyLines(await historyOf(harness, childId, ownerId))).toEqual([
        'task: Child of the stopped agent',
        'model_answer:  [backoffice/create_incident_note, logs/get_trace]',
        'tool_result: create_incident_note interrupted',
        'tool_result: get_trace interrupted',
        'event: stopped_with_parent',
      ]);
      expect(historyLines(await historyOf(harness, grandchildId, ownerId))).toEqual([
        'task: Grandchild of the stopped agent',
        'model_answer:  [logs/get_trace]',
        'tool_result: get_trace interrupted',
        'event: stopped_with_parent',
      ]);
      // Then: the confirmed action never reached the server
      expect(fixtureCallsOf(fixture.callLog, { tool: 'create_incident_note' })).toEqual([]);

      // Then: R's parent was told once, with the status `stopped`
      expect(noticeSummaries(await childNoticesOf(harness.db, parentId, stoppedId))).toEqual(['stopped']);

      // Then: stopping R again stops nothing
      expect(await harness.sessions.stop({ agentId: stoppedId, ownerId })).toEqual([]);
    } finally {
      stoppedHeld.open();
      grandchildRead.release();
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  // ---------------------------------------------------------------------------------------------------------------
  // INT-3  The tool gate: nothing refused or unconfirmed reaches an MCP server, and a lost step never repeats a mutating call
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-03.1: "Given в определении агента есть набор инструментов, when модель агента просит инструмент вне набора, then вызов не исполняется, а в историю приходит отказ."
  // AC-11.1: "Given MCP-сервер есть в списке и разрешён сотруднику в таблице доступа, when сервер платформы запущен, then инструменты этого MCP-сервера доступны чату сотрудника и агентам из его бесед."
  // AC-11.2: "Given MCP-сервер недоступен, when агент вызывает его инструмент, then в историю приходит ошибка вызова, а агент и беседа продолжают работать."
  // AC-11.3: "Given MCP-сервер не разрешён сотруднику в таблице доступа, when чат или агент этого сотрудника просит инструмент сервера, then вызов не исполняется, а в историю приходит отказ (как в AC-03.1)."
  // AC-12.1: "Given агент вызывает читающий инструмент, when вызов начинается, then он исполняется без вопроса сотруднику."
  // AC-12.2: "Given агент вызывает изменяющий инструмент, when вызов начинается, then во внешнюю систему ничего не уходит, а сотрудник видит запрос: какой агент, какой инструмент и с какими аргументами."
  // AC-12.3: "Given запрос на действие ждёт, when сотрудник подтверждает, then действие исполняется один раз, и агент продолжает работу."
  // AC-12.4: "Given запрос на действие ждёт, when сотрудник отклоняет, then действие не исполняется, агент получает результат «отклонено пользователем» и продолжает работу."
  // AC-12.5: "Given запрос на действие ждёт, when сервер перезапускают, then запрос по-прежнему ждёт решения, и подтвердить его можно как раньше."
  // AC-01.2 (agent's share): "Given изменяющее действие начато до остановки сервера, when сервер запускается снова, then действие не повторяется само, а в истории агента виден его результат или пометка «исход неизвестен»."
  // AC-13.1: "Given агент вызвал инструмент, when открыть его историю, then в ней есть время, инструмент, аргументы и исход вызова: успех, пустой результат, ошибка инструмента, сбой связи или отказ."
  // NFR-07: "Ни одно изменяющее действие не уходит во внешнюю систему без подтверждения. Для каждого изменяющего инструмента есть тест: без подтверждения MCP-сервер не получает ни одного вызова."
  // DC-5: "После рестарта открытые читающие вызовы исполняются один раз заново, изменяющий вызов с намерением без результата получает исход «исход неизвестен»."
  // DC-6: "Вызов, которому отказано, не доходит до MCP-сервера, а в истории у него исход «отказ» и причина."
  // Invariants 1 and 2: "У каждого вызова ровно одна запись результата, и до неё в истории нет ответа модели новее этого вызова." / "Инструмент с подтверждением не вызывается без записанного решения «подтверждено» и намерения `sending`; вызов в `sending` после потери шага не повторяется."
  // Use cases: UC-3, UC-E4 (boundary row), UC-E5, UC-E6, UC-E9. EARS: When / If-then. Design flow: Flow 5 (mutating MCP action with confirmation), KD-4, KD-5.
  //
  // Catches: (1) a server the employee is not allowed offered to the model or, worse, reached when the model names its tool anyway (the access function checked at list time but not at call time, or the other way round) - the fixture journal shows a call; (2) a mutating
  //   call that reaches the server before the decision, twice after one approval, or at all after a rejection; (3) a step lost between the written intent and the result that executes the mutating call again on the second instance (a duplicate incident note) - the
  //   one defect that must not occur on the external side; (4) an open read call that runs twice or whose result is recorded twice after a lost step, or a pending message delivered twice; (5) an MCP server that fails and takes the agent's step or task down instead of
  //   becoming a `transport_failure` entry; (6) a call without its audit row, or with two (business constraint 3: exactly one row per call).
  // Not re-checked here: the decision row's lifecycle and `ALREADY_RESOLVED` (runtime E2E-1), a decision surviving a restart as a runtime row (runtime E2E-1; row C proves only that agents' `confirmations` and `resolveConfirmation` work over it from another instance), the gate rule's variants (unit),
  //   MCP result to outcome mapping (unit), HTTP transport (out of scope), the confirmation card (web part).
  // Behavior: model asks for a tool -> gate (definition, access table, confirmation) -> the fixture journal shows exactly what reached the server -> the history shows one outcome per call
  // @category: core-functionality
  // @dependency: createRuntime x1-2, createAgents (tool gate, McpClients, ToolAccess, guard intent, confirmations, resolveConfirmation), scripted model double, MCP fixture processes with `FIXTURE_CALL_LOG` and fault schedule, Postgres
  // @complexity: high
  //
  // Verification items (table-driven by row; every row reads the fixture journal and the `agent_tool_calls` rows of its agent):
  // - Row A "refusals reach nothing" (UC-E4 boundary, UC-E5, AC-11.1/11.3): `MCP_ACCESS_TABLE` gives owner U1 `logs` and owner U2 nothing; both run an agent whose definition has `mcpServers` `*`. The script of each asks for `mcp__logs__<read tool>`. Then: U1's model input lists the
  //   `logs` tools and the call succeeds (outcome `success`, one journal entry); U2's model input does not list them, and the scripted forced call is refused: outcome `refused`, reason `no_access`, ZERO journal entries for U2, the refusal in U2's history. A second case in
  //   U1's run: a tool name not in the definition's `tools` gets `tool_not_in_definition` and no journal entry.
  // - Row B "read passes, mutating waits" (UC-3, AC-12.1, AC-12.2, NFR-07): the script calls the read tool, then `create_incident_note`. Then: the read call finishes with no decision requested; before any decision the journal has NO `create_incident_note` entry, the agent reads
  //   `awaiting_confirmation`, and `agents.confirmations(root)` holds exactly one request with the agent, the tool, the server and the arguments; the call record is `awaiting_confirmation`.
  // - Row C "approve, on a second instance" (AC-12.3, AC-12.5): continue from row B: the first instance is stopped (its MCP processes closed) and a second instance is started over the same database; `confirmations` there still lists the request; `resolveConfirmation(approve)`
  //   returns `resolved`. Then: the journal has exactly ONE `create_incident_note` entry with the arguments shown to the employee; the call outcome is `success`, the agent continues and reports.
  // - Row D "reject" (AC-12.4): as row B, `resolveConfirmation(reject)`. Then: the journal has ZERO `create_incident_note` entries; the outcome is `rejected`; the agent's next model input holds the rejection result and the agent continues to its report.
  // - Row E "step lost after the intent" (UC-E6, DC-5, AC-01.2): the agent has an open read call and a confirmed mutating call and a pending employee message; instance A starts the step, the mutating call reaches the fixture (held there by a latch, intent already written, state `sending`), then the lease
  //   expires and instance B takes the step. Then: the mutating call's outcome is `unknown`; the journal has AT MOST ONE `create_incident_note` entry (the zombie's own one) and instance B sent none; the open read call ran once more and has one result and one audit row; the message stands in the history once;
  //   after the latch is released the zombie's late result is not written; the agent finishes with a report.
  // - Row F "server fails" (UC-E5, AC-11.2): the fixture's fault schedule drops the transport (process exit) on the agent's read call. Then: the call outcome is `transport_failure` with a reason in the history, the task is not `failed`, and the agent's next model input holds that result and it reaches its report.
  it('INT-3 A: a call to a server the owner may not use, or a tool outside the definition, is refused with its reason, shows in the history and never reaches the MCP server, while an allowed owner\'s call succeeds', async () => {
    // Given: the access table gives U1 the `logs` server and U2 nothing; both run a definition with every
    // server; U1's answer also names a tool its definition does not have
    const allowedOwner = newUser();
    const deniedOwner = newUser();
    const readerName = uniqueName('reader-of-all-servers');
    const fixture = createFixtureFiles();
    const model = createScriptedModel();
    const allowed = model.script({ task: 'Read as an allowed owner' }, [
      { calls: [{ tool: GET_TRACE, args: TRACE_A }, LIST_AGENTS] },
      { text: 'report of the allowed owner' },
    ]);
    const denied = model.script({ task: 'Read as an owner without servers' }, [
      { calls: [{ tool: GET_TRACE, args: TRACE_B }] },
      { text: 'report of the owner without servers' },
    ]);
    const harness = await createAgentsHarness({
      model,
      fixture,
      access: { [allowedOwner]: [LOGS_SERVER] },
      definitions: [testDefinition(readerName, { mcpServers: ['*'] })],
    });
    try {
      // When: both agents run their scripts
      const { agentId: allowedId } = await harness.sessions.start({
        ownerId: allowedOwner,
        definition: readerName,
        prompt: 'Read as an allowed owner',
        description: 'allowed reader',
      });
      const { agentId: deniedId } = await harness.sessions.start({
        ownerId: deniedOwner,
        definition: readerName,
        prompt: 'Read as an owner without servers',
        description: 'reader without servers',
      });
      await allowed.called(2);
      await denied.called(2);
      await waitForTaskStatus(harness, allowedId, allowedOwner, 'waiting');
      await waitForTaskStatus(harness, deniedId, deniedOwner, 'waiting');

      // Then: U1's model was offered the `logs` tools and its read reached the server once
      expect(allowed.calls[0]?.toolNames).toEqual([
        'mcp__logs__search_logs',
        'mcp__logs__aggregate_logs',
        'mcp__logs__get_trace',
      ]);
      expect(fixtureCallsOf(fixture.callLog, { tool: 'get_trace', args: TRACE_A })).toHaveLength(1);
      expect(await auditLinesOf(harness, allowedId)).toEqual([
        'logs/get_trace done success timed',
        'list_agents done refused tool_not_in_definition timed',
      ]);
      expect(historyLines(await historyOf(harness, allowedId, allowedOwner))).toEqual([
        'task: Read as an allowed owner',
        'model_answer:  [logs/get_trace, list_agents]',
        'tool_result: get_trace success',
        'tool_result: list_agents refused tool_not_in_definition',
        'model_answer: report of the allowed owner []',
      ]);

      // Then: U2's model was offered no server tool; its forced call was refused, is in its history, and
      // nothing of it reached a server (the name is not in its session: `tool_not_in_definition`)
      expect(denied.calls[0]?.toolNames).toEqual([]);
      expect(fixtureCallsOf(fixture.callLog, { tool: 'get_trace', args: TRACE_B })).toEqual([]);
      expect(await auditLinesOf(harness, deniedId)).toEqual([
        'mcp__logs__get_trace done refused tool_not_in_definition timed',
      ]);
      expect((await toolCallRowsOf(harness.db, deniedId)).map((call) => call.args)).toEqual([TRACE_B]);
      expect(historyLines(await historyOf(harness, deniedId, deniedOwner))).toEqual([
        'task: Read as an owner without servers',
        'model_answer:  [mcp__logs__get_trace]',
        'tool_result: mcp__logs__get_trace refused tool_not_in_definition',
        'model_answer: report of the owner without servers []',
      ]);
      expect(toolOutputOf(denied.calls[1]?.messages ?? [], denied.calls[0]?.toolCallIds[0])).toContain(
        '[refused: tool_not_in_definition]',
      );
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  it('INT-3 B: a read call runs without a question while a mutating call sends nothing to the server and shows the employee one request with agent, tool and arguments', async () => {
    // Given: a writer whose one answer calls the read tool, then create_incident_note
    const ownerId = newUser();
    const writerName = uniqueName('writer');
    const fixture = createFixtureFiles();
    const model = createScriptedModel();
    model.script({ task: 'Read, then write the note' }, [{ calls: READ_THEN_NOTE }]);
    const harness = await createAgentsHarness({
      model,
      fixture,
      access: { [ownerId]: [LOGS_SERVER, BACKOFFICE_SERVER] },
      definitions: [testDefinition(writerName, { mcpServers: [LOGS_SERVER, BACKOFFICE_SERVER] })],
    });
    try {
      // When: the agent runs up to the mutating call
      const { agentId } = await startWriterUntilConfirmation(harness, {
        ownerId,
        definition: writerName,
        prompt: 'Read, then write the note',
      });

      // Then: the read reached its server with no question; the mutating call reached nothing
      expect(fixtureCallsOf(fixture.callLog, { tool: 'get_trace', args: TRACE_A })).toHaveLength(1);
      expect(fixtureCallsOf(fixture.callLog, { tool: 'create_incident_note' })).toEqual([]);

      // Then: the employee sees one request - the agent, the tool, its server and the arguments
      expect((await harness.sessions.get(agentId, ownerId)).status).toBe('awaiting_confirmation');
      const requests = (await harness.sessions.confirmations(agentId, ownerId)).filter((c) => c.status === 'open');
      expect(
        requests.map((request) => `${request.agentId} ${request.description} ${request.kind} ${request.server}/${request.tool}`),
      ).toEqual([`${agentId} writer agents.tool_confirmation backoffice/create_incident_note`]);
      expect(requests.map((request) => request.args)).toEqual([INCIDENT_NOTE]);

      // Then: the read call is closed, the mutating one awaits the decision
      expect(await auditLinesOf(harness, agentId)).toEqual([
        'logs/get_trace done success timed',
        'backoffice/create_incident_note awaiting_confirmation - untimed',
      ]);
      expect(historyLines(await historyOf(harness, agentId, ownerId))).toEqual([
        'task: Read, then write the note',
        'model_answer:  [logs/get_trace, backoffice/create_incident_note]',
        'tool_result: get_trace success',
      ]);
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  it('INT-3 C: approving after the server restarted on another instance sends the mutating call exactly once and the agent continues', async () => {
    // Given: a writer awaiting confirmation of create_incident_note on the first instance
    const ownerId = newUser();
    const writerName = uniqueName('writer');
    const fixture = createFixtureFiles();
    const model = createScriptedModel();
    const writer = model.script({ task: 'Write the note across a restart' }, [
      { calls: READ_THEN_NOTE },
      { text: 'report after the note' },
    ]);
    const options = {
      model,
      fixture,
      access: { [ownerId]: [LOGS_SERVER, BACKOFFICE_SERVER] },
      definitions: [testDefinition(writerName, { mcpServers: [LOGS_SERVER, BACKOFFICE_SERVER] })],
    };
    const first = await createAgentsHarness(options);
    let firstOpen = true;
    let second: AgentsHarness | undefined;
    try {
      const { agentId, decisionId } = await startWriterUntilConfirmation(first, {
        ownerId,
        definition: writerName,
        prompt: 'Write the note across a restart',
      });

      // When: the first instance stops (its MCP processes closed) and a second one starts over the same database
      await first.close();
      firstOpen = false;
      second = await createAgentsHarness(options);

      // Then: the request still waits there
      expect((await second.sessions.confirmations(agentId, ownerId)).filter((c) => c.status === 'open').map((open) => open.decisionId)).toEqual([
        decisionId,
      ]);

      // Then: no tool of this part lets the employee edit the arguments; the request stays open
      await expect(
        second.sessions.resolveConfirmation({ decisionId, ownerId, approve: true, args: { ...INCIDENT_NOTE, text: 'edited' } }),
      ).rejects.toMatchObject({ code: 'INVALID_ARGUMENTS' });
      expect((await second.sessions.confirmations(agentId, ownerId)).filter((c) => c.status === 'open').map((open) => open.decisionId)).toEqual([
        decisionId,
      ]);

      // When: the employee approves on the second instance
      expect(await second.sessions.resolveConfirmation({ decisionId, ownerId, approve: true })).toBe('resolved');
      await writer.called(2);
      await waitForTaskStatus(second, agentId, ownerId, 'waiting');

      // Then: the action reached the server exactly once, with the arguments shown to the employee
      expect(fixtureCallsOf(fixture.callLog, { tool: 'create_incident_note' })).toHaveLength(1);
      expect(fixtureCallsOf(fixture.callLog, { tool: 'create_incident_note', args: INCIDENT_NOTE })).toHaveLength(1);
      expect(await auditLinesOf(second, agentId)).toEqual([
        'logs/get_trace done success timed',
        'backoffice/create_incident_note done success timed',
      ]);

      // Then: the agent continued with the result and reported
      expect(historyLines(await historyOf(second, agentId, ownerId))).toEqual([
        'task: Write the note across a restart',
        'model_answer:  [logs/get_trace, backoffice/create_incident_note]',
        'tool_result: get_trace success',
        'tool_result: create_incident_note success',
        'model_answer: report after the note []',
      ]);
      expect(inputLines(writer.calls[1]?.messages ?? [])).toEqual([
        'user: Write the note across a restart',
        'assistant:  [mcp__logs__get_trace, mcp__backoffice__create_incident_note]',
        'tool: mcp__logs__get_trace, mcp__backoffice__create_incident_note',
      ]);

      // Then: a second approval sends nothing more
      expect(await second.sessions.resolveConfirmation({ decisionId, ownerId, approve: true })).toBe(
        'already_resolved',
      );
      expect(fixtureCallsOf(fixture.callLog, { tool: 'create_incident_note' })).toHaveLength(1);
      expect(writer.calls).toHaveLength(2);
    } finally {
      await closeAll([...(firstOpen ? [first] : []), ...(second === undefined ? [] : [second])]);
    }
  }, TEST_TIMEOUT_MS);

  it('INT-3 D: rejecting sends nothing, records the rejection and the agent continues', async () => {
    // Given: a writer awaiting confirmation of create_incident_note
    const ownerId = newUser();
    const writerName = uniqueName('writer');
    const fixture = createFixtureFiles();
    const model = createScriptedModel();
    const writer = model.script({ task: 'Write the note, then be rejected' }, [
      { calls: READ_THEN_NOTE },
      { text: 'report after the rejection' },
    ]);
    const harness = await createAgentsHarness({
      model,
      fixture,
      access: { [ownerId]: [LOGS_SERVER, BACKOFFICE_SERVER] },
      definitions: [testDefinition(writerName, { mcpServers: [LOGS_SERVER, BACKOFFICE_SERVER] })],
    });
    try {
      const { agentId, decisionId } = await startWriterUntilConfirmation(harness, {
        ownerId,
        definition: writerName,
        prompt: 'Write the note, then be rejected',
      });

      // When: the employee rejects the request
      expect(await harness.sessions.resolveConfirmation({ decisionId, ownerId, approve: false })).toBe('resolved');
      await writer.called(2);
      await waitForTaskStatus(harness, agentId, ownerId, 'waiting');

      // Then: nothing reached the server and the call is `rejected`
      expect(fixtureCallsOf(fixture.callLog, { tool: 'create_incident_note' })).toEqual([]);
      expect(await auditLinesOf(harness, agentId)).toEqual([
        'logs/get_trace done success timed',
        'backoffice/create_incident_note done rejected timed',
      ]);

      // Then: the next model call holds the rejection, and the agent went on to its report
      const noteCallId = writer.calls[0]?.toolCallIds[1];
      expect(toolOutputOf(writer.calls[1]?.messages ?? [], noteCallId)).toContain('[rejected]');
      expect(historyLines(await historyOf(harness, agentId, ownerId))).toEqual([
        'task: Write the note, then be rejected',
        'model_answer:  [logs/get_trace, backoffice/create_incident_note]',
        'tool_result: get_trace success',
        'tool_result: create_incident_note rejected',
        'model_answer: report after the rejection []',
      ]);
      expect((await harness.sessions.confirmations(agentId, ownerId)).filter((c) => c.status === 'open')).toEqual([]);
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  it('INT-3 E: a step lost after the intent leaves the mutating call unknown and sent at most once, runs the open read call once more and delivers the message once', async () => {
    // Given: on instance A (one slot, a lease only the test expires, a heartbeat that never comes) a writer
    // whose one answer is create_incident_note, then a read call; the note is held on the fixture
    const ownerId = newUser();
    const writerName = uniqueName('writer');
    const fixture = createFixtureFiles();
    const noteHeld = fixture.latch('note-held');
    fixture.setFaults([holdCall('create_incident_note', INCIDENT_NOTE, noteHeld)]);
    const model = createScriptedModel();
    const writer = model.script({ task: 'Write the note, then lose the step' }, [
      {
        calls: [
          { tool: CREATE_INCIDENT_NOTE, args: INCIDENT_NOTE },
          { tool: GET_TRACE, args: TRACE_A },
        ],
      },
      { text: 'report after the lost step' },
    ]);
    const options = {
      model,
      fixture,
      access: { [ownerId]: [LOGS_SERVER, BACKOFFICE_SERVER] },
      definitions: [testDefinition(writerName, { mcpServers: [LOGS_SERVER, BACKOFFICE_SERVER] })],
    };
    const harnesses: AgentsHarness[] = [];
    try {
      const zombie = await createAgentsHarness({
        ...options,
        zombie: true,
        runtimeConfig: { concurrency: 1, leaseMs: 600_000 },
      });
      harnesses.push(zombie);
      const { agentId, decisionId } = await startWriterUntilConfirmation(zombie, {
        ownerId,
        definition: writerName,
        prompt: 'Write the note, then lose the step',
      });

      // Given: an employee message waits while the call awaits its decision; the approval starts the step
      // on A, whose intent is written and whose note is on the wire
      await zombie.sessions.send({ agentId, ownerId, text: 'message before the loss' });
      expect(await zombie.sessions.resolveConfirmation({ decisionId, ownerId, approve: true })).toBe('resolved');
      await waitFor(
        () => fixtureCallsOf(fixture.callLog, { tool: 'create_incident_note', args: INCIDENT_NOTE }),
        (calls) => calls.length === 1,
        'the confirmed note call on the fixture',
      );
      expect((await toolCallRowsOf(zombie.db, agentId)).map((call) => `${call.tool} ${call.state}`)).toEqual([
        'create_incident_note sending',
        'get_trace requested',
      ]);

      // When: instance B starts, A's lease expires, and B takes the lost step (A's only slot is held)
      const restarted = await createAgentsHarness(options);
      harnesses.push(restarted);
      await expireLease(zombie.db, agentId);
      await writer.called(2);
      await waitForTaskStatus(restarted, agentId, ownerId, 'waiting');

      // Then: B ran the step as one resumed after a loss
      expect(
        stepLogsOf(restarted, agentId, 'step started').some((record) => record.fields.resumedAfterLoss === true),
      ).toBe(true);

      // Then: the mutating call is `unknown` and reached the server once - the zombie's call; B sent none.
      // The open read call ran after the loss once, with one result and one audit row
      expect(fixtureCallsOf(fixture.callLog, { tool: 'create_incident_note' })).toHaveLength(1);
      expect(fixtureCallsOf(fixture.callLog, { tool: 'get_trace', args: TRACE_A })).toHaveLength(1);
      expect(await auditLinesOf(restarted, agentId)).toEqual([
        'backoffice/create_incident_note done unknown timed',
        'logs/get_trace done success timed',
      ]);

      // Then: the message stands in the history once, after the results; the agent reported
      const expectedHistory = [
        'task: Write the note, then lose the step',
        'model_answer:  [backoffice/create_incident_note, logs/get_trace]',
        'tool_result: create_incident_note unknown',
        'tool_result: get_trace success',
        'user_message: message before the loss',
        'model_answer: report after the lost step []',
      ];
      expect(historyLines(await historyOf(restarted, agentId, ownerId))).toEqual(expectedHistory);
      const noteCallId = writer.calls[0]?.toolCallIds[0];
      expect(toolOutputOf(writer.calls[1]?.messages ?? [], noteCallId)).toContain('[unknown]');

      // When: the zombie's held call answers
      noteHeld.release();
      await waitFor(
        () => stepLogsOf(zombie, agentId, 'step result rejected: the attempt is no longer current'),
        (records) => records.length === 1,
        'the zombie step result to be rejected',
      );

      // Then: its late result is not written: the same rows, the same history, still one call on the server
      expect(await auditLinesOf(restarted, agentId)).toEqual([
        'backoffice/create_incident_note done unknown timed',
        'logs/get_trace done success timed',
      ]);
      expect(historyLines(await historyOf(restarted, agentId, ownerId))).toEqual(expectedHistory);
      expect(fixtureCallsOf(fixture.callLog, { tool: 'create_incident_note' })).toHaveLength(1);
      expect(writer.calls).toHaveLength(2);
    } finally {
      noteHeld.release();
      await closeAll(harnesses);
    }
  }, TEST_TIMEOUT_MS);

  it('INT-3 F: a failing MCP server becomes a transport_failure result in the history and the agent carries on', async () => {
    // Given: the `logs` process exits on the agent's first read call; the agent reads again afterwards
    const ownerId = newUser();
    const readerName = uniqueName('reader');
    const fixture = createFixtureFiles();
    fixture.setFaults([crashOn('get_trace', TRACE_A)]);
    const model = createScriptedModel();
    const reader = model.script({ task: 'Read from a failing server' }, [
      { calls: [{ tool: GET_TRACE, args: TRACE_A }] },
      { calls: [{ tool: GET_TRACE, args: TRACE_B }] },
      { text: 'report after the failure' },
    ]);
    const harness = await createAgentsHarness({
      model,
      fixture,
      access: { [ownerId]: [LOGS_SERVER] },
      definitions: [testDefinition(readerName, { mcpServers: [LOGS_SERVER] })],
    });
    try {
      // When: the agent's read call takes its server down
      const { agentId } = await harness.sessions.start({
        ownerId,
        definition: readerName,
        prompt: 'Read from a failing server',
        description: 'reader',
      });
      await reader.called(3);
      await waitForTaskStatus(harness, agentId, ownerId, 'waiting');

      // Then: the call reached the server, which died on it; the call is a transport failure with its reason
      expect(
        fixtureCallsOf(fixture.callLog, { tool: 'get_trace', args: TRACE_A }).map((entry) => entry.mode),
      ).toEqual(['crash_process']);
      expect(await auditLinesOf(harness, agentId)).toEqual([
        'logs/get_trace done transport_failure timed',
        'logs/get_trace done success timed',
      ]);
      expect(
        harness.logs
          .filter((record) => record.message === 'tool call finished' && record.fields.tool === 'get_trace')
          .map((record) => `${String(record.fields.outcome)} ${String(record.fields.reason)}`),
      ).toEqual(['transport_failure connection_lost', 'success null']);

      // Then: the task did not fail; the next model call holds the failure, and the agent went on
      expect((await harness.sessions.get(agentId, ownerId)).status).toBe('working');
      const failedCallId = reader.calls[0]?.toolCallIds[0];
      expect(toolOutputOf(reader.calls[1]?.messages ?? [], failedCallId)).toContain('[transport_failure]');
      expect(historyLines(await historyOf(harness, agentId, ownerId))).toEqual([
        'task: Read from a failing server',
        'model_answer:  [logs/get_trace]',
        'tool_result: get_trace transport_failure',
        'model_answer:  [logs/get_trace]',
        'tool_result: get_trace success',
        'model_answer: report after the failure []',
      ]);
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  // ---------------------------------------------------------------------------------------------------------------
  // INT-4  Isolation: every agents operation answers a foreign owner as for a missing agent
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-13.3: "Given агент принадлежит другому сотруднику, when сотрудник пытается его открыть, написать ему или остановить его, then ответ такой же, как для несуществующего агента."
  // NFR-06: "Изоляция данных пользователей — как в бизнес-ограничении 2 в `.claude/skills/project-context/SKILL.md`: каждая точка доступа к агентам, сессиям и workflow покрыта e2e-тестом с двумя пользователями."
  // Contract Definitions: "Все операции принимают владельца (`ownerId`). Агент чужого владельца отвечает так же, как несуществующий: `AGENT_NOT_FOUND`. Владельца проверяет runtime в каждой операции, которую `agents` вызывает первой."
  // Use case: UC-E7. EARS: If-then. Design flow: Contract Definitions ("Операции агентов"), Security Considerations.
  //
  // Catches: one operation of the part that reads `agent_sessions`, `agent_messages` or `agent_tool_calls` by id before - or without - the runtime owner check: another employee reads an agent's history or its tool arguments, lists a foreign tree, learns of its pending
  //   confirmations, restarts it (copying its definition and task into a new agent) or resolves its confirmation; or answers that differ between "foreign" and "missing" (a leak in itself). `start` with another employee's agent as `parentId` is the same hole.
  // Not re-checked here: the owner check of the `runtime_*` operations (runtime INT-4), authentication and the HTTP edge (the `chat` part's API), the MCP access table (INT-3 row A).
  // Behavior: owner B calls each operation on owner A's agent, tree and confirmation -> the answer equals the answer for an id that exists for nobody -> nothing of A's changed
  // @category: core-functionality
  // @dependency: createRuntime, createAgents (all operations), scripted model double, MCP fixture (one mutating call awaiting confirmation), Postgres
  // @complexity: medium
  //
  // Verification items (table-driven by operation; A has a root, a child, history entries with tool calls, and one open confirmation):
  // - Rows: `get`, `list(rootId)`, `history`, `send`, `interrupt`, `stop`, `restart`, `confirmations(rootId)`, `resolveConfirmation` (approve and reject), and `start` with A's agent as `parentId`.
  // - For each row the same call is made with a random well-formed id that exists for nobody (the "missing" reference). Then: the answers are equal in kind and shape - the same error code (`AGENT_NOT_FOUND`, and `DECISION_NOT_FOUND` for the confirmation), with nothing of A's data
  //   (no definition, task text, argument or count) in the answer or the error message.
  // - After all rows: a row-version snapshot of A's `agent_sessions`, `agent_messages`, `agent_tool_calls` and tasks equals the snapshot before; A's confirmation is still open and A can approve it (the fixture journal then has one call); A's tree reads in full for A.
  it('INT-4: every agents operation called as another owner answers exactly as for a missing agent or decision, leaks nothing of the owner\'s data and changes none of the owner\'s rows', async () => {
    // Given: owner A has a root awaiting confirmation of create_incident_note (history with a tool call)
    // and a completed child; owner B is another employee
    const ownerA = newUser();
    const ownerB = newUser();
    const rootName = uniqueName('owned-root');
    const childName = uniqueName('owned-child');
    const fixture = createFixtureFiles();
    const model = createScriptedModel();
    model.script(
      { task: 'Task of owner A' },
      [{ calls: [{ tool: CREATE_INCIDENT_NOTE, args: INCIDENT_NOTE }] }],
      { thereafter: { text: 'root of A goes on' } },
    );
    model.script({ task: 'Child task of owner A' }, [{ text: 'report of the child of A' }]);
    const harness = await createAgentsHarness({
      model,
      fixture,
      access: { [ownerA]: [BACKOFFICE_SERVER] },
      definitions: [testDefinition(rootName, { mcpServers: [BACKOFFICE_SERVER] }), testDefinition(childName)],
    });
    try {
      const { agentId: rootId } = await harness.sessions.start({
        ownerId: ownerA,
        definition: rootName,
        prompt: 'Task of owner A',
        description: 'root of A',
      });
      await waitFor(
        () => harness.sessions.get(rootId, ownerA),
        (view) => view.status === 'awaiting_confirmation',
        'the confirmation request of A',
      );
      const { agentId: childId } = await harness.sessions.start({
        ownerId: ownerA,
        parentId: rootId,
        definition: childName,
        prompt: 'Child task of owner A',
        description: 'child of A',
      });
      await waitForTaskStatus(harness, childId, ownerA, 'completed');
      const [request] = (await harness.sessions.confirmations(rootId, ownerA)).filter((c) => c.status === 'open');
      if (request === undefined) throw new Error('A has no confirmation request');
      const before = await treeRowVersionsOf(harness.db, [rootId, childId]);

      // When: B calls every operation on A's agent, tree or decision, and on an id that exists for nobody
      const { sessions } = harness;
      const rows: { name: string; foreignId: string; call: (id: string) => Promise<unknown> }[] = [
        { name: 'get', foreignId: childId, call: (id) => sessions.get(id, ownerB) },
        { name: 'list', foreignId: rootId, call: (id) => sessions.list(id, ownerB) },
        { name: 'history', foreignId: rootId, call: (id) => sessions.history({ agentId: id, ownerId: ownerB, limit: 500 }) },
        { name: 'send', foreignId: childId, call: (id) => sessions.send({ agentId: id, ownerId: ownerB, text: 'hello' }) },
        { name: 'interrupt', foreignId: rootId, call: (id) => sessions.interrupt({ agentId: id, ownerId: ownerB, text: 'stop' }) },
        { name: 'stop', foreignId: rootId, call: (id) => sessions.stop({ agentId: id, ownerId: ownerB }) },
        { name: 'restart', foreignId: childId, call: (id) => sessions.restart({ agentId: id, ownerId: ownerB }) },
        { name: 'confirmations', foreignId: rootId, call: (id) => sessions.confirmations(id, ownerB) },
        {
          name: 'resolveConfirmation approve',
          foreignId: request.decisionId,
          call: (id) => sessions.resolveConfirmation({ decisionId: id, ownerId: ownerB, approve: true }),
        },
        {
          name: 'resolveConfirmation reject',
          foreignId: request.decisionId,
          call: (id) => sessions.resolveConfirmation({ decisionId: id, ownerId: ownerB, approve: false }),
        },
        {
          name: 'resolveConfirmation with edited arguments',
          foreignId: request.decisionId,
          call: (id) =>
            sessions.resolveConfirmation({ decisionId: id, ownerId: ownerB, approve: true, args: INCIDENT_NOTE }),
        },
        {
          name: 'start under the agent',
          foreignId: rootId,
          call: (id) =>
            sessions.start({ ownerId: ownerB, parentId: id, definition: childName, prompt: 'Foreign child', description: 'foreign' }),
        },
      ];
      const foreign: string[] = [];
      const missing: string[] = [];
      for (const row of rows) {
        foreign.push(`${row.name}: ${await answerOf(row.call(row.foreignId), row.foreignId)}`);
        const missingId = randomUUID();
        missing.push(`${row.name}: ${await answerOf(row.call(missingId), missingId)}`);
      }

      // Then: each answer to B is the answer for a missing id, with the code of a missing agent or decision
      expect(foreign).toEqual(missing);
      expect(foreign).toEqual([
        'get: AgentsError AGENT_NOT_FOUND Task <id> not found',
        'list: AgentsError AGENT_NOT_FOUND Agent <id> not found',
        'history: AgentsError AGENT_NOT_FOUND Task <id> not found',
        'send: AgentsError AGENT_NOT_FOUND Task <id> not found',
        'interrupt: AgentsError AGENT_NOT_FOUND Task <id> not found',
        'stop: AgentsError AGENT_NOT_FOUND Task <id> not found',
        'restart: AgentsError AGENT_NOT_FOUND Task <id> not found',
        'confirmations: AgentsError AGENT_NOT_FOUND Agent <id> not found',
        'resolveConfirmation approve: RuntimeError DECISION_NOT_FOUND Decision <id> not found',
        'resolveConfirmation reject: RuntimeError DECISION_NOT_FOUND Decision <id> not found',
        'resolveConfirmation with edited arguments: RuntimeError DECISION_NOT_FOUND Decision <id> not found',
        'start under the agent: AgentsError AGENT_NOT_FOUND Task <id> not found',
      ]);

      // Then: none of A's rows changed, and A's confirmation is still open
      expect(await treeRowVersionsOf(harness.db, [rootId, childId])).toEqual(before);
      expect((await harness.sessions.confirmations(rootId, ownerA)).filter((c) => c.status === 'open').map((open) => open.decisionId)).toEqual([
        request.decisionId,
      ]);

      // When: A approves it
      expect(
        await harness.sessions.resolveConfirmation({ decisionId: request.decisionId, ownerId: ownerA, approve: true }),
      ).toBe('resolved');
      await waitFor(
        () => toolCallRowsOf(harness.db, rootId),
        (calls) => calls.every((call) => call.outcome !== null),
        'the note call of A to finish',
      );

      // Then: the action reached the server once, and A's tree reads in full for A
      expect(fixtureCallsOf(fixture.callLog, { tool: 'create_incident_note', args: INCIDENT_NOTE })).toHaveLength(1);
      expect((await toolCallRowsOf(harness.db, rootId)).map((call) => `${call.tool} ${call.outcome}`)).toEqual([
        'create_incident_note success',
      ]);
      expect((await harness.sessions.list(rootId, ownerA)).map((view) => view.agentId).sort()).toEqual(
        [rootId, childId].sort(),
      );
      expect(historyLines(await historyOf(harness, childId, ownerA))).toEqual([
        'task: Child task of owner A',
        'model_answer: report of the child of A []',
      ]);
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);
});
