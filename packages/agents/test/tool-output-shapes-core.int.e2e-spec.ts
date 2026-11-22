// tool-output-shapes / core - agents-package integration tests (in-process `RuntimeModule` + `createAgents` over real Postgres, real MCP fixture process, scripted model)
// Design Doc: docs/features/tool-output-shapes/design-core.md (v1.0), Test Strategy UC-3, UC-4 (KD-1, KD-2, KD-5, KD-6, DC-1, DC-4)
// PRD: docs/features/tool-output-shapes/prd.md (AC-01.1, AC-03.1, AC-03.2 after the refresh, AC-04.1, AC-05.1)
// Generated: 2026-11-21 | Part: core (single part) | Test type: Integration (no E2E file: see "Budget")
// Implementation timing: written alongside the slice each test names - INT-1 with the stored `outputSchema`, the shape text in `mcpToolsOf` and the fixture shapes;
//   INT-2 with the same slice (it is the guard of KD-5, so it stays green as long as nobody hands the shape to the SDK client).
//
// File name follows the repo convention of the `agents` package (`<feature>-<part>.int.e2e-spec.ts` under packages/agents/test, picked up by `vitest.config.e2e.ts`,
// run with `pnpm --filter @agent-os/agents test:e2e`, never in the default `vitest run`). The comments above each test are its rows' specification.
// Tests are written with their tasks and run once, at the end of the part (project rule "Tests only at the end").
//
// Harness (follows custom-agents-runtime.int.e2e-spec.ts and code-execution.int.e2e-spec.ts, support/agentsHarness.ts):
//   real Postgres, real `RuntimeModule` and `createAgents`; the scripted `ModelClient` of `@agent-os/agents/testing` is the only model double and records every call;
//   the MCP fixture process is the real one, its three sources registered through the registry under the run's names (`LOGS_SERVER`, `BACKOFFICE_SERVER`, `TRACKER_SERVER`
//   of support/mcp-servers.ts) - `createAgentsHarness({ mcpServers: ['logs', 'backoffice', 'tracker'], ... })`, because the harness registers `logs` and `backoffice` only by
//   default and `search_tickets` lives on `tracker`. Registration goes through `registerFixtureServers`, which re-reads `tools/list` (the registry's `listChecked`),
//   so the stored list of the test's servers carries the fixture's shapes: that is "the administrator refreshed the tools" (AC-03.2, second half).
//   Isolation: a unique owner `newUser()` per test with access to the three servers (`access: { [ownerId]: [...] }`), a root record `testRecord('reader', { servers: [...] })`,
//   its own `createFixtureFiles(...)`; no sleeps, the scripted model's `called(n)` and `waitForTaskStatus` order the steps.
//
// INT-1 reads the descriptions the provider got from `RecordedModelCall.toolDescriptions` of `packages/agents/src/testing.ts` (Design Doc UC-3: "the description is read
//   from the recorded model call").
//
// Budget: Integration 2 of 3 (INT-1, INT-2). E2E 0 of 1-2: the only user-visible journey of this part is the owner's rerun of tasks 2 and 3 on Haiku (PRD, Success
//   Criteria), which is a paid manual check, not a CI test; UC-3 and UC-4 already cover the platform side of that journey end to end (description reaches the model,
//   a script reading it is not broken by a mismatching answer).
//
// Proven elsewhere (not in this file; the plan reads this to avoid a second test for an AC already proven):
// - unit, packages/agents/src, ONE table-driven test of the pure shape-text function and the description builder (UC-1, UC-2; per pure-decision.md, not skeletoned here):
//   nested object with array and `string | null`, optional field, `enum`, array root, recursive `$ref`, unknown keyword, shape over the limit, tool without shape,
//   an old stored list item without `outputSchema` - AC-02.1, AC-02.2, AC-03.1 (rule), AC-03.2 (before the refresh), DC-1, DC-2 (repeat build gives the same text), DC-3
// - unit (existing), packages/agents/src/agent/tool-declaration.spec.ts: agents started by other agents and deep agent subagents build their set through the same `toolsFor`
//   - AC-01.2; and the model step and the compaction step get their definitions from that one call - DC-2 (second half)
// - existing, apps/api MCP servers panel test: the tool view is compared as a whole and has no shape - DC-4
// - by construction (KD-6): each fixture tool's result passes its strict zod result schema before it is sent, so a shape that diverges from a real answer fails at the
//   first call of that tool in any integration test; no separate test of "shape equals answer" (AC-05.1, second half)
// - not automated: the owner's rerun of tasks 2 and 3 on Haiku (PRD, Success Criteria).
//
// acProof: see the JSON of the generation report; the table below is the same mapping.
// AC -> proving test:
// - AC-01.1, AC-03.1 (wiring), AC-03.2 (after the refresh), AC-05.1: INT-1
// - AC-04.1: INT-2
// - AC-01.2, AC-02.1, AC-02.2, AC-03.2 (before the refresh): unit, as listed above

import { argsHash, createFixtureFiles, fixtureCallsOf } from '@agent-os/mcp-fixture';
import { createScriptedModel } from '@agent-os/agents/testing';
import { describe, expect, it } from 'vitest';
import {
  codeCallRowsOf,
  createAgentsHarness,
  historyLines,
  historyOf,
  testRecord,
  toolCallRowsOf,
  toolOutputOf,
  waitForTaskStatus,
} from './support/agentsHarness';
import { runCode, toolCallIdOf } from './support/logs-reader';
import { BACKOFFICE_SERVER, LOGS_SERVER, TRACKER_SERVER } from './support/mcp-servers';
import { newUser } from './support/new-user';

/** Bound of one in-process test; the rows settle far sooner. */
const TEST_TIMEOUT_MS = 120_000;

/** The heading and the truncation mark of the shape block, copied from `src/mcp/tool-shape.ts`. */
const SHAPE_HEADER = 'Result structure (structuredContent):';
const SHAPE_TRUNCATED = '(result structure truncated)';
/** `TOOL_SHAPE_LIMIT` of `src/mcp/tool-shape.ts` (design-core.md, KD-3). */
const SHAPE_LIMIT = 1_500;

/** A fixture tool with a declared shape: its server, its own description and fragments its shape text must hold. */
interface ShapedTool {
  readonly server: string;
  readonly tool: string;
  readonly description: string;
  readonly shapeFragments: readonly string[];
}

/** The four fixture tools that declare a shape (design-core.md, «Список инструментов фикстуры»). */
const SHAPED_TOOLS: readonly ShapedTool[] = [
  {
    server: TRACKER_SERVER,
    tool: 'search_tickets',
    description:
      'Search tracker tickets with optional status (open, closed), team and assignee filters. ' +
      'Each ticket has id, title, team, assignee, status, createdAt and closedAt (null while open). ' +
      'Returns up to pageSize tickets in creation order; pass nextCursor back as cursor for the next page.',
    shapeFragments: [
      'snapshot: string',
      'tickets: { ',
      'id: string',
      'status: "open" | "closed"',
      'closedAt: string | null',
      '}[]',
      'totalMatched: integer',
      'totalRelation: "eq"',
      'nextCursor: string | null',
    ],
  },
  {
    server: BACKOFFICE_SERVER,
    tool: 'search_orders',
    description:
      'Search back-office orders created in [from, to) with optional status (paid, failed) and paymentMethod filters. ' +
      'Returns up to pageSize orders in time order; pass nextCursor back as cursor for the next page.',
    shapeFragments: [
      'snapshot: string',
      'orders: { ',
      'orderId: string',
      'amount: number',
      'currency: "EUR"',
      '}[]',
      'totalMatched: integer',
      'totalRelation: "eq"',
      'nextCursor: string | null',
    ],
  },
  {
    server: BACKOFFICE_SERVER,
    tool: 'get_order',
    description:
      'Get one back-office order (orderId: ord- and 8 lowercase hex characters) with its payments, ' +
      'each with its status, failure reason and the traceId of its payment logs.',
    shapeFragments: [
      'snapshot: string',
      'order: { ',
      'orderId: string',
      'payments: { ',
      'traceId: string',
      'failureReason: "provider_timeout" | null',
      '}[]',
      '} | null',
    ],
  },
  {
    server: LOGS_SERVER,
    tool: 'get_trace',
    description: 'Get every log record of one trace (traceId: 32 lowercase hex characters) in time order.',
    shapeFragments: ['snapshot: string', 'records: { ', 'ts: string', 'traceId: string', '}[]', 'totalMatched: integer'],
  },
];

/** `search_logs` of the fixture: no declared shape. */
const SEARCH_LOGS_DESCRIPTION =
  'Search payment logs in [from, to) with optional service, level, event and status filters. ' +
  'Returns up to pageSize records in time order; pass nextCursor back as cursor for the next page.';

/** `search_tickets` as the model and a script name it. */
const SEARCH_TICKETS = `mcp__${TRACKER_SERVER}__search_tickets`;
/** The arguments of both calls of INT-2: a short page of open tickets. */
const TICKETS_ARGS = { status: 'open', pageSize: 3 } as const;
/** What the fixture's `contract_violation` puts in place of the list (`applyResultFault`). */
const FAULT_TEXT = 'fixture fault: tickets is not a list';

describe('tool-output-shapes / core - the model sees the declared shapes, and a mismatching answer is not a failure', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-1: the descriptions the provider receives carry the fixture's shapes after the server description, and a tool without a shape is unchanged
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-01.1 "Given сервер объявил форму у инструмента, а администратор подключил сервер или обновил его инструменты, when агент сотрудника с правом на этот инструмент делает
  //   шаг, then описание инструмента, которое получает модель, содержит после описания от сервера форму результата: имена полей ответа, их типы и вложенность."
  //   AC-03.1 "Given сервер не объявил форму у инструмента, when модель получает описание этого инструмента, then оно такое же, как до фичи."
  //   AC-03.2 (second half) "... после того как администратор обновил инструменты сервера, их формы видны, как в AC-01.1."
  //   AC-05.1 "Given серверы фикстуры подключены и их инструменты обновлены, when агент получает описания инструментов, then у четырёх названных инструментов есть формы, совпадающие
  //   с тем, что эти инструменты реально возвращают, а хотя бы у одного инструмента фикстуры формы нет."
  // Behavior: the three fixture servers are registered through the registry (their `tools/list` is read again and stored with `outputSchema`) -> an employee's agent with access to
  //   all three makes its first step on the scripted model -> the recorded model call lists the tools with their descriptions -> `search_tickets`, `search_orders`, `get_order`
  //   and `get_trace` descriptions start with the fixture's own description unchanged, then an empty line and the shape block with that tool's top-level field names
  //   (`tickets`, `orders`, `order`, `snapshot`, ... - read the literal field names from the zod result schema of each tool in packages/mcp-fixture/src/tools), the nesting of
  //   the list item, and `null` for the fields the fixture documents as nullable (`nextCursor`, `order`, `closedAt`); `search_logs` (and `aggregate_logs`, `create_incident_note`)
  //   description equals the fixture's description literal, byte for byte, with no shape block.
  // Rows (one test, one scripted model call, literal expected values; assertions per tool name `mcp__<server>__<tool>`):
  //   A. four tools with a shape: description = `<fixture description>` + `\n\n` + block that contains the literal field names and `| null` where the shape allows null.
  //   B. a tool without a shape (`search_logs`) in the same call: description === the fixture's description (AC-03.1; `create_incident_note` and `aggregate_logs` are the same rule,
  //      one tool is enough to prove the wiring).
  //   C. the block of every shaped tool is within the limit (length <= 1 500 including the heading) and has no truncation mark: the fixture's shapes are not expected to be cut
  //      (design Risks: "формы фикстуры обрезки не ждут"). One loop over the four descriptions, not a separate test.
  // Catches: the shape stored by `toMcpTool` but dropped before `mcpToolsOf` (or the reverse: `toMcpTool` not copying `outputSchema`, so a refreshed server still reads as shapeless);
  //   the block appended to a tool that has no shape, or the server description altered/cut when a block is appended; a fixture tool that forgot to declare its shape or declares it
  //   for a tool that should stay without one (FR-03 has no tool to test against); a shape lost on the registry path from `tools/list` to the model's definitions - none of these is
  //   visible to the unit table, which starts from an already-stored shape.
  // @category: core-functionality
  // @dependency: McpRegistry.listChecked, McpClient (tools/list), toMcpTool, storedMcpTools, mcpToolsOf in createToolRegistry, the shape-text function, ScriptedModel (recorded call with tool descriptions), MCP fixture (logs, backoffice, tracker), Postgres
  // @complexity: medium
  it('INT-1: after the fixture servers are registered, the model call carries the shape block after the server description for search_tickets, search_orders, get_order and get_trace, and search_logs keeps its description unchanged', async () => {
    // Given: the three fixture servers registered through the registry (their `tools/list` read and stored), and an
    // employee whose agent may use all three
    const prompt = 'Look at the tools you have';
    const ownerId = newUser();
    const servers = [LOGS_SERVER, BACKOFFICE_SERVER, TRACKER_SERVER];
    const model = createScriptedModel();
    const script = model.script({ task: prompt }, [{ text: 'Инструменты на месте' }]);
    const harness = await createAgentsHarness({
      model,
      fixture: createFixtureFiles('tool-output-shapes'),
      mcpServers: ['logs', 'backoffice', 'tracker'],
      access: { [ownerId]: servers },
      root: testRecord('reader', { servers }),
    });
    try {
      // When: the agent makes its first step
      const { agentId } = await harness.sessions.start({ ownerId, prompt, description: 'reader' });
      await script.called(1);
      await waitForTaskStatus(harness, agentId, ownerId, 'waiting');
      const descriptions = script.calls[0]?.toolDescriptions ?? {};

      for (const { server, tool, description, shapeFragments } of SHAPED_TOOLS) {
        const seen = descriptions[`mcp__${server}__${tool}`];
        // Then (A): the server's description unchanged, an empty line, then the shape block with the tool's fields,
        // their nesting and `| null` where the shape allows it (AC-01.1, AC-03.2 after the refresh, AC-05.1)
        expect(seen?.startsWith(`${description}\n\n${SHAPE_HEADER}\n`), `${tool} description`).toBe(true);
        for (const fragment of shapeFragments) expect(seen, tool).toContain(fragment);
        // Then (C): the fixture's block is whole and within the limit
        const block = seen?.slice(description.length + 2) ?? '';
        expect(block.length, `${tool} block length`).toBeLessThanOrEqual(SHAPE_LIMIT);
        expect(block, tool).not.toContain(SHAPE_TRUNCATED);
      }

      // Then (B): a tool without a shape keeps the server's description byte for byte (AC-03.1, AC-05.1)
      expect(descriptions[`mcp__${LOGS_SERVER}__search_logs`]).toBe(SEARCH_LOGS_DESCRIPTION);
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2: an answer that does not match the declared shape is returned as is, directly and through callTool
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-04.1 "Given инструмент с формой вернул ответ, который ей не соответствует (нет поля, лишнее поле, другой тип или только текст), when инструмент вызван напрямую или через
  //   `callTool`, then агент получает этот ответ так же, как от инструмента без формы, а запись аудита несёт тот же класс исхода."
  //   Design: UC-4, KD-5 (the platform never hands the declared shape to the SDK client; the SDK would turn a mismatch into a `ProtocolError`, i.e. a transport failure).
  // Behavior: `search_tickets` is registered with its shape; the fixture is set to `contract_violation` for it (`fixture.setFaults([{ tool: 'search_tickets', argsHash: <hash of the
  //   call's args, see `argsHash` in packages/mcp-fixture/src/test-support.ts>, occurrences: 'all', mode: 'contract_violation' }])` - the fixture changes the answer AFTER the
  //   strict result check, so `tickets` arrives as the text `fixture fault: tickets is not a list`) -> the scripted agent calls the tool directly, then calls `run_code` whose
  //   script does `callTool("mcp__${TRACKER_SERVER}__search_tickets", <same args>)` and returns the result -> both calls end `success`, the model's next input holds the
  //   server's answer as is, the script's returned value is the server's `structuredContent` as is (the wrong-typed `tickets`), and the audit rows (the direct call's tool row and the
  //   run's from-code row in `codeCallRowsOf`) carry outcome `success`.
  // Rows (one scenario, two calls; literal expected values):
  //   A. direct call: history line `tool_result: search_tickets success`; the tool output the model saw contains the fault text `fixture fault: tickets is not a list`; audit
  //      row of the call: `search_tickets done success`.
  //   B. call from code: the `run_code` result is `success` and its value contains the same fault text (not a `tool_error`, not a transport failure); the from-code audit row
  //      is `<TRACKER_SERVER>/search_tickets success`.
  //   The "same class as without a shape" half is the literal `success`: the same fault on a tool without a shape ends `success` today (`toOutcome` reads no shape), so a second
  //   run on `search_logs` would restate it and is not written.
  // Catches: a future change that reuses one MCP client between `tools/list` and `tools/call`, asks for the list before the call, or passes `outputSchema` to the SDK - the SDK then
  //   validates the answer, a wrong-typed `tickets` becomes a `ProtocolError`, and the platform classifies it as a transport failure (outcome other than `success`, the script gets an
  //   error instead of the server's answer). Only this test (real SDK, real server, real shape in the stored list) turns red; the unit table and the audit tests never see the SDK.
  // @category: edge-case
  // @dependency: McpClient.callTool (real @modelcontextprotocol/client), toOutcome, scriptValueOf, run_code tool, CodeRunner (real process), ToolRunner.callFromCode, tool calls in `agent_messages`, MCP fixture (tracker, fault schedule), ScriptedModel, Postgres
  // @complexity: medium
  it('INT-2: AC-04.1 a search_tickets answer that does not match its declared shape is returned as is and ends success, both from a direct call and from callTool in run_code', async () => {
    // Given: `search_tickets` registered with its shape, and the fixture set to answer every call with these
    // arguments with `tickets` as text (after its strict result check)
    const prompt = 'Count the open tickets';
    const ownerId = newUser();
    const fixture = createFixtureFiles('tool-output-shapes');
    fixture.setFaults([
      { tool: 'search_tickets', argsHash: argsHash(TICKETS_ARGS), occurrences: 'all', mode: 'contract_violation' },
    ]);
    const model = createScriptedModel();
    const script = model.script({ task: prompt }, [
      { calls: [{ tool: SEARCH_TICKETS, args: TICKETS_ARGS }] },
      {
        calls: [
          runCode('Открытые тикеты', `return await callTool("${SEARCH_TICKETS}", ${JSON.stringify(TICKETS_ARGS)});`),
        ],
      },
      { text: 'Тикеты прочитаны' },
    ]);
    const harness = await createAgentsHarness({
      model,
      fixture,
      mcpServers: ['tracker'],
      access: { [ownerId]: [TRACKER_SERVER] },
      root: testRecord('reader', { servers: [TRACKER_SERVER] }),
    });
    try {
      // When: the agent calls the tool directly, then from a read script, and ends its turn
      const { agentId } = await harness.sessions.start({ ownerId, prompt, description: 'reader' });
      await script.called(3);
      await waitForTaskStatus(harness, agentId, ownerId, 'waiting');
      const directCallId = toolCallIdOf(script, 0);
      const runCallId = toolCallIdOf(script, 1);

      // Then: both calls reached the server and got the mismatching answer
      expect(
        fixtureCallsOf(fixture.callLog, { tool: 'search_tickets', args: TICKETS_ARGS }).map((call) => call.mode),
      ).toEqual(['contract_violation', 'contract_violation']);

      // Then (A): the direct call ended success and the model saw the server's answer as is
      const history = await historyOf(harness, agentId, ownerId);
      expect(historyLines(history)).toEqual([
        `task: ${prompt}`,
        `model_answer:  [${TRACKER_SERVER}/search_tickets]`,
        'tool_result: search_tickets success',
        'model_answer:  [run_code]',
        'tool_result: run_code success',
        'model_answer: Тикеты прочитаны []',
      ]);
      expect(toolOutputOf(script.calls[1]?.messages ?? [], directCallId)).toContain(FAULT_TEXT);
      expect((await toolCallRowsOf(harness.db, agentId)).map((row) => `${row.tool} ${row.state} ${row.outcome}`)).toEqual([
        'search_tickets done success',
        'run_code done success',
      ]);

      // Then (B): the script got the server's structuredContent as is (not a tool error, not a transport failure),
      // and the call from code is audited success
      const runEntry = history.find((entry) => entry.kind === 'tool_result' && entry.content.callId === runCallId);
      const returned = JSON.parse(runEntry?.kind === 'tool_result' ? (runEntry.content.text ?? '') : '') as unknown;
      expect(returned).toMatchObject({ tickets: FAULT_TEXT });
      const codeRows = await codeCallRowsOf(harness.db, agentId, runCallId);
      expect(codeRows.map((row) => `${row.server}/${row.tool} ${row.outcome}`)).toEqual([
        `${TRACKER_SERVER}/search_tickets success`,
      ]);
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);
});
