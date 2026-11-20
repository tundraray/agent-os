// tool-result-reading / core Integration Tests - work plan: docs/features/tool-result-reading/core/20261120-feature-tool-result-reading-core.md (Phase 3; requirements R-1..R-4 in its Snapshot, no Design Doc)
// Test type: Integration (in-process `createRuntime` + `createAgents` over real Postgres, real MCP fixture process, scripted model), in the style of `code-execution.int.e2e-spec.ts`.
// Tests are written with their phase and run once, at the end of the part (Phase 5; project rule "Tests only at the end").
//
// Environment: the harness of test/support (`agentsHarness.ts`); the model is the scripted double, which records the input of every call (the assertion surface for
// "the next model call sees X"); the stored results are read from `agent_tool_results` through the harness's pool; the settings row is read, never changed.
// The secret is a value of the fixture's answer the process remembers (`rememberSecret`) before any agent call, as the provider registry does with a key.
//
// Proven elsewhere (not repeated here):
// - unit, packages/agents/src/tools/large-result.spec.ts: the wrapper wording, the preview cut, the line split, page and search arithmetic, the error cut (R-1..R-3 rules)
// - code-execution.int.e2e-spec.ts INT-1 row A: `readResult` through the wrapper's callId and the second page from code; INT-3 row C: `readResult` of a foreign session or owner
//
// Requirement -> proving test:
// - R-1, R-3 (the model gets the wrapper, not the body; a short result whole), R-2 (pages join into the stored text, search with line numbers), R-4 (`readResult` gives the
//   whole value), secrets: INT-1
// - R-2 isolation (another session's and another owner's callId read as a missing one): INT-2

import { Buffer } from 'node:buffer';
import type { AgentHistoryEntry, AgentTurnMessage } from '@agent-os/agents';
import { createScriptedModel, type ScriptedAnswer } from '@agent-os/agents/testing';
import { rememberSecret } from '@agent-os/common';
import { agentToolResultSettings, agentToolResults, createDatabase } from '@agent-os/db';
import { createFixtureFiles, FIXTURE_SHARED_TOKEN, startFixtureProcess } from '@agent-os/mcp-fixture';
import { eq } from 'drizzle-orm';
import { beforeAll, describe, expect, it } from 'vitest';
import { McpClient } from '../src/mcp/mcp-client.js';
import { RESULT_NOT_FOUND } from '../src/tools/large-result.js';
import {
  type AgentsHarness,
  createAgentsHarness,
  historyLines,
  historyOf,
  testRecord,
  toolOutputOf,
  waitFor,
  waitForTaskStatus,
} from './support/agentsHarness.js';
import { databaseUrl } from './support/database-url.js';
import { ONE_RECORD, runCode, SEARCH_LOGS, toolCallIdOf, WINDOW } from './support/logs-reader.js';
import { LOGS_SERVER } from './support/mcp-servers.js';
import { newUser } from './support/new-user.js';

/** Bound of one in-process test; the rows settle far sooner. */
const TEST_TIMEOUT_MS = 120_000;

/** A line of a stored text ends at this many characters when it has no line break (the plan's line rule). */
const LINE_CHARS = 2_000;

/** What the masker writes in place of a secret. */
const REDACTED = '[redacted]';

/** The answer of a reading tool to a callId that is missing or not the caller's. */
const NOT_FOUND = RESULT_NOT_FOUND;

/** The search of INT-1, in a case the fixture's data does not use: the search ignores case. */
const PATTERN = 'Payment-API';

/** The settings row, read once before the tests. */
interface Settings {
  readonly storeFromChars: number;
  readonly previewChars: number;
  readonly readMaxTokens: number;
}

/** What the fixture answers the two direct calls with, as the platform stores them (the secret masked). */
interface Expected {
  readonly settings: Settings;
  /** The 32-hex `traceId` of the window's first record, remembered as a secret. */
  readonly secret: string;
  /** The stored text of `search_logs` on {@link WINDOW}. */
  readonly bigText: string;
  /** The stored text of `search_logs` on {@link ONE_RECORD}. */
  readonly smallText: string;
  /** The records of the answer on {@link WINDOW}. */
  readonly bigRecords: number;
}

/** The text of a data envelope as the model reads it. */
function escaped(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/** The tokens of a text by the platform's estimate: UTF-8 bytes / 4, rounded up. */
function tokensOf(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / 4);
}

/** The text and the value the fixture answers `search_logs` with `args`, asked over its shared-token path. */
async function fixtureAnswer(url: string, args: Readonly<Record<string, unknown>>) {
  const response = await new McpClient().callTool({
    url,
    auth: { mode: 'shared', token: async () => FIXTURE_SHARED_TOKEN },
    timeoutMs: 30_000,
    request: { name: 'search_logs', arguments: args },
  });
  if (response.kind !== 'result') throw new Error(`The fixture did not answer search_logs: ${response.kind}`);
  const [block] = response.result.content;
  if (block?.type !== 'text') throw new Error('The fixture answered search_logs without a text block');
  const value = response.result.structuredContent as { records: { traceId: string }[] };
  return { text: block.text, value };
}

/** Reads the settings row and the two answers, remembers the secret and checks what the tests rely on. */
async function prepare(): Promise<Expected> {
  const database = createDatabase({ connectionString: databaseUrl(), poolMax: 1 });
  let settings: Settings | undefined;
  try {
    [settings] = await database.db
      .select({
        storeFromChars: agentToolResultSettings.storeFromChars,
        previewChars: agentToolResultSettings.previewChars,
        readMaxTokens: agentToolResultSettings.readMaxTokens,
      })
      .from(agentToolResultSettings);
  } finally {
    await database.close();
  }
  if (settings === undefined) throw new Error('agent_tool_result_settings has no row');

  const fixture = await startFixtureProcess(createFixtureFiles('tool-result-reading'));
  try {
    const big = await fixtureAnswer(fixture.sharedUrl('logs'), WINDOW);
    const small = await fixtureAnswer(fixture.sharedUrl('logs'), ONE_RECORD);
    const secret = big.value.records[0]?.traceId;
    if (secret === undefined) throw new Error('The window has no record');
    rememberSecret(secret);
    const expected: Expected = {
      settings,
      secret,
      bigText: big.text.replaceAll(secret, REDACTED),
      smallText: small.text.replaceAll(secret, REDACTED),
      bigRecords: big.value.records.length,
    };
    // Preconditions: the big answer goes by reference and needs more than one page, its secret falls inside the
    // preview; the small one comes whole and is one line; both are JSON on one line
    expect(expected.bigText.length).toBeGreaterThan(settings.storeFromChars);
    expect(tokensOf(expected.bigText)).toBeGreaterThan(settings.readMaxTokens);
    expect(expected.bigText.indexOf(REDACTED) + REDACTED.length).toBeLessThanOrEqual(settings.previewChars);
    expect(expected.smallText.length).toBeLessThanOrEqual(Math.min(settings.storeFromChars, LINE_CHARS));
    expect([expected.bigText.includes('\n'), expected.smallText.includes('\n')]).toEqual([false, false]);
    return expected;
  } finally {
    await fixture.stop();
  }
}

/** The stored rows of an agent's calls, by `callId`. */
async function storedRowsOf(harness: AgentsHarness, agentId: string) {
  const rows = await harness.db
    .select({ callId: agentToolResults.callId, text: agentToolResults.text, value: agentToolResults.value })
    .from(agentToolResults)
    .where(eq(agentToolResults.taskId, agentId));
  return new Map(rows.map((row) => [row.callId, row]));
}

/** The history entry of one tool call's result. */
function resultOf(history: readonly AgentHistoryEntry[], callId: string) {
  const entry = history.find((candidate) => candidate.kind === 'tool_result' && candidate.content.callId === callId);
  if (entry?.kind !== 'tool_result') throw new Error(`The history holds no result of call ${callId}`);
  return entry.content;
}

/** The model's own answers in its input, in order. */
function answersIn(messages: readonly AgentTurnMessage[]) {
  return messages.flatMap((message) => (message.role === 'assistant' ? [message] : []));
}

/** Waits until the agent's history ends with the model's answer `text` and the agent waits. */
async function untilAnswered(harness: AgentsHarness, agentId: string, ownerId: string, text: string): Promise<void> {
  await waitFor(
    () => historyOf(harness, agentId, ownerId),
    (history) => {
      const last = history.at(-1);
      return last?.kind === 'model_answer' && last.content.text === text;
    },
    `the last answer "${text}" of agent ${agentId}`,
  );
  await waitForTaskStatus(harness, agentId, ownerId, 'waiting');
}

/** A `read_tool_result` call of a scripted answer. */
function readCall(callId: string, offset: number) {
  return { tool: 'read_tool_result', args: { callId, offset } };
}

/** A `search_tool_result` call of a scripted answer. */
function searchCall(callId: string, pattern: string) {
  return { tool: 'search_tool_result', args: { callId, pattern } };
}

/** The script of INT-1's `run_code`: the stored value by callId, its record count and the first record's trace. */
function valueScript(callId: string): string {
  return [
    `const value = await readResult(${JSON.stringify(callId)});`,
    'return { records: value.records.length, firstTrace: value.records[0].traceId };',
  ].join('\n');
}

let expected: Expected;

beforeAll(async () => {
  expected = await prepare();
}, TEST_TIMEOUT_MS);

describe('INT-1: a large result - the wrapper, the pages, the search, readResult, the mask', () => {
  // R-1: "Успешный результат MCP-вызова длиннее порога хранится целиком в `agent_tool_results`; модель получает обёртку: ... размер, `callId` для чтения, превью начала ..."
  // R-2: "`read_tool_result` — страница сохранённого результата по строкам ... с баннером «partial view ...; do not answer from this page alone». `search_tool_result` — строки с подстрокой и их номера, с пределом."
  // R-4: "`readResult(callId)` в `run_code` отдаёт полное значение без предела из той же таблицы ... строку `agent_tool_results` по-прежнему получает каждый успешный и пустой прямой MCP-вызов"
  // Secrets (plan decision): every MCP text the model gets, and the stored `text` and `value`, pass the masker.
  // Behavior: one answer calls `search_logs` on WINDOW (about 120 KB) and on one record -> the next input holds the wrapper and the short answer whole; the model reads the
  //   short one and the long one page by page from the banners' offsets, searches the long one, reads it in a script, and answers
  // Catches: the body reaching the model input; a short result wrapped or not stored; a line lost or repeated at a page seam; a page past the token bound; search lines with
  //   wrong numbers; `readResult` getting a cut value; a known secret reaching the model, a page, the search, the store or the log; a reading tool's answer stored as a result
  it('INT-1: R-1 the model gets the wrapper, reads every page, searches and reads the value, and no known secret gets through', async () => {
    // Given: an employee whose agent reads the payment logs; the scripted model follows the stored result to its end
    const ownerId = newUser();
    const prompt = 'Read the large payment log page';
    const done = 'Прочитано целиком';
    const model = createScriptedModel();
    const next = (messages: readonly AgentTurnMessage[]): ScriptedAnswer => {
      const answers = answersIn(messages);
      const [first] = answers;
      if (first === undefined) return { calls: [{ tool: SEARCH_LOGS, args: WINDOW }, { tool: SEARCH_LOGS, args: ONE_RECORD }] };
      const [big, small] = first.toolCalls.map((call) => call.toolCallId);
      if (big === undefined || small === undefined) throw new Error('the first answer made no two calls');
      if (answers.length === 1) return { calls: [readCall(small, 1), readCall(big, 1)] };
      const last = answers.at(-1)?.toolCalls.at(-1);
      if (last?.toolName === 'read_tool_result') {
        const nextPage = /next page at offset (\d+)\./.exec(toolOutputOf(messages, last.toolCallId));
        return { calls: [nextPage === null ? searchCall(big, PATTERN) : readCall(big, Number(nextPage[1]))] };
      }
      if (last?.toolName === 'search_tool_result') return { calls: [runCode('Полный результат', valueScript(big))] };
      return { text: done };
    };
    const script = model.script({ task: prompt }, [], { thereafter: next });
    const harness = await createAgentsHarness({
      model,
      access: { [ownerId]: [LOGS_SERVER] },
      root: testRecord('reader', { servers: [LOGS_SERVER], maxTurns: 60 }),
    });
    try {
      // When: the agent works to the end of its turn
      const { agentId } = await harness.sessions.start({ ownerId, prompt, description: 'reader' });
      await untilAnswered(harness, agentId, ownerId, done);
      const bigId = toolCallIdOf(script, 0, 0);
      const smallId = toolCallIdOf(script, 0, 1);
      const { settings, secret, bigText, smallText } = expected;

      // Then: the store holds the whole masked text of both direct calls and nothing else - no reading tool's answer (R-1, R-4)
      const rows = await storedRowsOf(harness, agentId);
      expect([...rows.keys()].sort()).toEqual([bigId, smallId].sort());
      expect(rows.get(bigId)?.text).toBe(bigText);
      expect(rows.get(smallId)?.text).toBe(smallText);

      // Then: the next model input holds the wrapper of the long answer - its size, its callId, the preview of its start, the
      // way to read it - and nothing past the preview; the short answer whole (R-1, R-3)
      const seen = script.calls[1]?.messages ?? [];
      const wrapper = toolOutputOf(seen, bigId);
      expect(wrapper.startsWith(
        `<data source="tool search_logs" author="${LOGS_SERVER}">\n` +
          `[stored result] Output too large: ${bigText.length} characters. The full output is stored under callId &quot;${bigId}&quot;.\n` +
          `Preview (first ${settings.previewChars} characters):\n${escaped(bigText.slice(0, settings.previewChars))}\n[end of preview]\n`,
      )).toBe(true);
      expect(wrapper).toContain(`read_tool_result (callId &quot;${bigId}&quot;`);
      expect(wrapper).toContain(`readResult(&quot;${bigId}&quot;)`);
      expect(wrapper).toContain('read the whole content in sequential parts');
      expect(wrapper).not.toContain(escaped(bigText.slice(-200)));
      expect(wrapper).not.toContain('totalMatched');
      expect(toolOutputOf(seen, smallId)).toBe(`<data source="tool search_logs" author="${LOGS_SERVER}">\n${escaped(smallText)}\n</data>`);

      // Then: the short result reads as one last page (R-2, R-4)
      const history = await historyOf(harness, agentId, ownerId);
      const smallRead = toolCallIdOf(script, 1, 0);
      expect(resultOf(history, smallRead).text).toBe(`[lines 1-1 of 1: end of the stored result.]\n${smallText}`);

      // Then: following the banners, the pages' bodies join into exactly the stored text; each page but the last says
      // not to answer from it alone, each stays within the token bound (R-2)
      const lastInput = script.calls.at(-1)?.messages ?? [];
      const bigReads = answersIn(lastInput)
        .flatMap((answer) => answer.toolCalls)
        .filter((call) => call.toolName === 'read_tool_result' && (call.args as { callId?: string }).callId === bigId);
      const pages = bigReads.map((call) => {
        const text = resultOf(history, call.toolCallId).text ?? '';
        const lineBreak = text.indexOf('\n');
        return { offset: (call.args as { offset: number }).offset, banner: text.slice(0, lineBreak), body: text.slice(lineBreak + 1) };
      });
      const totalLines = Math.ceil(bigText.length / LINE_CHARS);
      expect(pages.length).toBeGreaterThan(1);
      expect(pages.map((page) => page.body).join('')).toBe(bigText);
      pages.forEach((page, index) => {
        const lastLine = page.offset + Math.ceil(page.body.length / LINE_CHARS) - 1;
        expect(page.banner).toBe(
          index === pages.length - 1
            ? `[lines ${page.offset}-${totalLines} of ${totalLines}: end of the stored result.]`
            : `[partial view: lines ${page.offset}-${lastLine} of ${totalLines}; next page at offset ${lastLine + 1}. Do not answer from this page alone.]`,
        );
        expect(tokensOf(page.body)).toBeLessThanOrEqual(settings.readMaxTokens);
      });
      expect(pages[0]?.offset).toBe(1);

      // Then: the search gives the matching lines with their numbers: each shown line is that line of the stored text and
      // holds the pattern in any case; the header counts every matching line (R-2)
      const searchId = toolCallIdOf(script, pages.length + 1);
      const [header = '', ...found] = (resultOf(history, searchId).text ?? '').split('\n');
      const lineOf = (number: number) => bigText.slice((number - 1) * LINE_CHARS, number * LINE_CHARS);
      const matching = Array.from({ length: totalLines }, (_, index) => index + 1).filter((number) =>
        lineOf(number).toLowerCase().includes(PATTERN.toLowerCase()),
      );
      expect(found.length).toBeGreaterThan(0);
      expect(header).toMatch(new RegExp(`^\\[${found.length} of ${matching.length} matching lines(; refine the pattern to see the rest)?\\]$`));
      expect(found).toEqual(matching.slice(0, found.length).map((number) => `${number}: ${lineOf(number)}`));

      // Then: a script reads the whole stored value by the callId: every record, the secret masked in it too (R-4)
      const runId = toolCallIdOf(script, pages.length + 2);
      expect(resultOf(history, runId).text).toBe(JSON.stringify({ records: expected.bigRecords, firstTrace: REDACTED }));
      expect(historyLines(history).at(-1)).toBe(`model_answer: ${done} []`);

      // Then: the known secret reached no model input, no page, no search answer, no stored text or value and no log
      // record; the wrapper's preview and the pages carry the mask in its place
      expect(wrapper).toContain(REDACTED);
      expect(pages.some((page) => page.body.includes(REDACTED))).toBe(true);
      expect(JSON.stringify(model.calls)).not.toContain(secret);
      expect(JSON.stringify(history)).not.toContain(secret);
      expect(JSON.stringify([...rows.values()])).not.toContain(secret);
      expect(JSON.stringify(harness.logs)).not.toContain(secret);

      // Then: the log has a record of each read and of the search, with counts and no pattern
      const readLogs = harness.logs.filter((record) => record.message === 'stored result read');
      expect(readLogs.map((record) => [record.fields.callId, record.fields.found])).toEqual([
        [smallId, true],
        ...pages.map(() => [bigId, true]),
      ]);
      const searchLogs = harness.logs.filter((record) => record.message === 'stored result searched');
      expect(searchLogs.map((record) => [record.fields.callId, record.fields.found, record.fields.matches, record.fields.shown])).toEqual([
        [bigId, true, matching.length, found.length],
      ]);
      expect(JSON.stringify(harness.logs)).not.toContain(PATTERN);
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);
});

describe('INT-2: a callId that is not the caller\'s reads as a missing one', () => {
  // R-2: "Оба сверяют сессию и владельца, как `findForRun`: чужой результат неотличим от несуществующего."
  // Behavior: employee A's first agent stores a large result; A's second agent and employee B's agent read and search it by its callId and by an invented one
  //   -> all four answers of each agent are the same `tool_error` "результат не найден"
  // Catches: another session's or another employee's stored result readable by its callId; an answer that differs between "foreign" and "missing" and so confirms the id
  it('INT-2: R-2 read_tool_result and search_tool_result answer a foreign session, a foreign owner and an invented callId alike', async () => {
    // Given: A's first agent read the window directly, so its large result is stored under its callId
    const employeeA = newUser();
    const employeeB = newUser();
    const model = createScriptedModel();
    const storing = model.script({ task: 'A stores a large result' }, [
      { calls: [{ tool: SEARCH_LOGS, args: WINDOW }] },
      { text: 'A прочитал' },
    ]);
    const probe = () => {
      const foreign = toolCallIdOf(storing, 0);
      return {
        calls: [
          readCall(foreign, 1),
          searchCall(foreign, 'payment'),
          readCall('call-invented', 1),
          searchCall('call-invented', 'payment'),
        ],
      };
    };
    const probes = {
      otherSession: model.script({ task: 'A reads from another session' }, [probe, { text: 'другая сессия' }]),
      otherOwner: model.script({ task: 'B reads what A stored' }, [probe, { text: 'другой сотрудник' }]),
    };
    const harness = await createAgentsHarness({
      model,
      access: { [employeeA]: [LOGS_SERVER], [employeeB]: [LOGS_SERVER] },
      root: testRecord('reader', { servers: [LOGS_SERVER] }),
    });
    const start = async (ownerId: string, prompt: string) =>
      (await harness.sessions.start({ ownerId, prompt, description: 'reader' })).agentId;
    try {
      const storingId = await start(employeeA, 'A stores a large result');
      await untilAnswered(harness, storingId, employeeA, 'A прочитал');
      const foreign = toolCallIdOf(storing, 0);
      expect([...(await storedRowsOf(harness, storingId)).keys()]).toEqual([foreign]);

      // When: A's second agent and B's agent read and search by that callId and by an invented one
      const readers = [
        { ownerId: employeeA, script: probes.otherSession, agentId: await start(employeeA, 'A reads from another session'), done: 'другая сессия' },
        { ownerId: employeeB, script: probes.otherOwner, agentId: await start(employeeB, 'B reads what A stored'), done: 'другой сотрудник' },
      ];
      for (const reader of readers) await untilAnswered(harness, reader.agentId, reader.ownerId, reader.done);

      // Then: each agent's model got the same answer for the foreign callId as for the invented one: `tool_error`, "результат не найден"
      const missingRead = `<data source="tool read_tool_result" author="agents">\n[tool_error]\n${NOT_FOUND}\n</data>`;
      const missingSearch = `<data source="tool search_tool_result" author="agents">\n[tool_error]\n${NOT_FOUND}\n</data>`;
      for (const reader of readers) {
        const seen = reader.script.calls[1]?.messages ?? [];
        expect([0, 1, 2, 3].map((position) => toolOutputOf(seen, toolCallIdOf(reader.script, 0, position)))).toEqual([
          missingRead,
          missingSearch,
          missingRead,
          missingSearch,
        ]);
        expect(historyLines(await historyOf(harness, reader.agentId, reader.ownerId)).slice(2, 6)).toEqual([
          'tool_result: read_tool_result tool_error',
          'tool_result: search_tool_result tool_error',
          'tool_result: read_tool_result tool_error',
          'tool_result: search_tool_result tool_error',
        ]);
      }

      // Then: every lookup of the two agents found nothing, and nothing of theirs was stored
      const lookups = harness.logs.filter(
        (record) => record.message === 'stored result read' || record.message === 'stored result searched',
      );
      expect(lookups.map((record) => record.fields.found)).toEqual(Array.from({ length: 8 }, () => false));
      for (const reader of readers) expect((await storedRowsOf(harness, reader.agentId)).size).toBe(0);
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);
});
