// schedules-search-memory / conversation-search - API integration (real AppModule + real Postgres + MCP fixture process, workers on,
//   scripted model)
// Design Doc: docs/features/schedules-search-memory/design-conversation-search.md, Test Strategy UC-1 (everything is found, once, in order)
//   and UC-2 (only your own and only the living).
// Budget: 2 integration (API) of the part's 4; web: conversation-search-thread / conversation-search-sidebar
//
// Harness (as create-and-test-fork.int.e2e-spec.ts): one `createTestApp({ workers: true, mcpServers: ['logs'] })`, `seedSuperAdmin` +
//   `createEmployee` for Anna and Boris. The history is written by the scripted model through the ordinary chat, so the write paths of
//   KD-1 are the real ones. A stored tool result comes only from a successful direct MCP call: the sub-agent calls `search_logs` of the
//   fixture twice, once oversized (fixture fault `oversize`, stored with a wrapper in `messages`) and once short (stored in both places
//   alike). The fixture has no «timeout payment-service»; the searched word is the service name every record of the filtered query
//   carries, within the first 100 000 characters. Mock boundary: the model double only. CI runs on a clean database: every case writes
//   its own rows.
//
// Not repeated here: the rules of the query text beyond one boundary row, the cursor codec (`thread-cursor.ts`), the web side (UC-3,
//   UC-4), the 1 s budget (UC-5, `test:verify`).

import { randomUUID } from 'node:crypto';
import type { ScriptedToolCall } from '@agent-os/agents/testing';
import {
  ConversationSearchResponseSchema,
  type ConversationMatch,
  type ConversationSearchResponse,
  type ConversationView,
  type HistoryEntry,
} from '@agent-os/contracts';
import { waitFor } from '@agent-os/db/testing';
import { argsHash } from '@agent-os/mcp-fixture';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  allowRole,
  HAIKU_TEST_PRICES,
  removeRunRows,
  runModel,
  type RunRole,
  useRunModels,
} from './support/access';
import { type ChatApi, chatApi, expectBody, expectError } from './support/api';
import { createTestApp, type TestApp } from './support/createTestApp';
import { BUILTIN, pointBuiltinsAt } from './support/library';
import { LOGS_SERVER } from './support/mcp-servers';
import {
  createEmployee,
  seedSuperAdmin,
  type Session,
} from './support/session';

const TEST_TIMEOUT_MS = 180_000;
const MODEL = runModel('haiku-search');
/** Cyrillic: a title without a Cyrillic letter is dropped for a Russian first message (`normalizeGeneratedTitle`). */
const GENERATED_TITLE = 'Заголовок беседы';
const GENERAL_PURPOSE = BUILTIN.generalPurpose;

const SEARCH_LOGS = `mcp__${LOGS_SERVER}__search_logs`;
/** Every record of these queries names the service, so the word is in both stored results. */
const SERVICE = 'provider-adapter';
const LONG_LOGS = {
  from: '2000-01-01T00:00:00Z',
  to: '2100-01-01T00:00:00Z',
  service: SERVICE,
  pageSize: 20,
};
const SHORT_LOGS = { ...LONG_LOGS, pageSize: 3 };
/** Above the default store threshold of 50 000 characters, below the searched 100 000. */
const OVERSIZED_BYTES = 60_000;
/** A word of 21 messages: one more than a page. */
const QUARTERLY = 'квартальный';

let harness: TestApp;
let admin: Session;
let role: RunRole;
let restoreModels: (() => Promise<void>) | undefined;
let restoreBuiltins: (() => Promise<void>) | undefined;
const madeUsers: string[] = [];

async function employee(): Promise<Session> {
  const session = await createEmployee(harness.app, admin);
  madeUsers.push(session.id);
  await role.add(session);
  return session;
}

function search(api: ChatApi, q: string, cursor?: string) {
  const query = new URLSearchParams({ q });
  if (cursor !== undefined) query.set('cursor', cursor);
  return api.raw('get', `/search?${query.toString()}`);
}

function found(
  api: ChatApi,
  q: string,
  cursor?: string,
): Promise<ConversationSearchResponse> {
  return expectBody(
    search(api, q, cursor),
    200,
    ConversationSearchResponseSchema,
  );
}

/** Every page of a query, in order. */
async function allFound(
  api: ChatApi,
  q: string,
): Promise<ConversationMatch[][]> {
  const pages: ConversationMatch[][] = [];
  let cursor: string | undefined;
  do {
    const page = await found(api, q, cursor);
    pages.push(page.matches);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return pages;
}

/** The marked words of a text. */
function marked(
  text: string,
  marks: ConversationMatch['titleMarks'],
): string[] {
  return marks.map(({ start, end }) => text.slice(start, end));
}

function startAgent(description: string, prompt: string): ScriptedToolCall {
  return {
    tool: 'start_agent',
    args: { agent: GENERAL_PURPOSE.name, description, prompt },
  };
}

/** Waits until the chat is free and its last entry is the answer `text`. */
function untilAnswered(
  api: ChatApi,
  threadId: string,
  text: string,
): Promise<ConversationView> {
  return waitFor(
    () => api.history(threadId),
    (view) => {
      const last = view.entries.at(-1);
      return (
        view.chat.status === 'idle' &&
        last?.kind === 'model_answer' &&
        last.content.text === text
      );
    },
    `the answer "${text}"`,
  );
}

/** Sends `text` and waits for the scripted `answer`. */
async function ask(
  api: ChatApi,
  threadId: string,
  text: string,
  answer: string,
): Promise<ConversationView> {
  harness.model.script({ task: text }, [{ text: answer }]);
  await api.send(threadId, text);
  return untilAnswered(api, threadId, answer);
}

/** A new conversation whose first message gets `answer`; waits for its generated title. */
async function conversation(
  api: ChatApi,
  text: string,
  answer: string,
): Promise<string> {
  const { id } = await api.createThread();
  await ask(api, id, text, answer);
  await waitFor(
    () => api.getThread(id),
    (thread) => thread.title === GENERATED_TITLE,
    'the generated title',
  );
  return id;
}

/**
 * A conversation of `count` messages with `word` (the first is its `task`); returns it and the seqs of those entries.
 * `tag` keeps the texts unique in the suite: the scripted model finds a script by the task text.
 */
async function wordy(
  api: ChatApi,
  word: string,
  count: number,
  tag: string,
): Promise<{ threadId: string; seqs: number[] }> {
  const threadId = await conversation(
    api,
    `${word} план 1 ${tag}`,
    'Принято 1.',
  );
  let view = await api.history(threadId);
  for (let n = 2; n <= count; n++) {
    view = await ask(
      api,
      threadId,
      `${word} план ${n} ${tag}`,
      `Принято ${n}.`,
    );
  }
  const seqs = view.entries
    .filter((entry) => entry.kind === 'task' || entry.kind === 'user_message')
    .map((entry) => entry.seq);
  expect(seqs).toHaveLength(count);
  return { threadId, seqs };
}

/**
 * A conversation whose chat starts a general sub-agent with `prompt`; the sub-agent reads the logs (the calls given) and
 * reports, the chat answers the report. Returns the conversation, the sub-agent and its stored results' call ids.
 */
async function withSubagent(
  api: ChatApi,
  text: string,
  prompt: string,
  logCalls: Record<string, unknown>[],
): Promise<{ threadId: string; agentId: string; callIds: string[] }> {
  harness.model.script({ task: text }, [
    { calls: [startAgent('Разбор логов', prompt)] },
    { text: 'Разбор запущен.' },
    { text: 'Разбор готов.' },
  ]);
  harness.model.script({ task: prompt }, [
    ...logCalls.map((args) => ({ calls: [{ tool: SEARCH_LOGS, args }] })),
    { text: 'Логи разобраны.' },
  ]);
  const { id: threadId } = await api.createThread();
  await api.send(threadId, text);
  await untilAnswered(api, threadId, 'Разбор готов.');
  const [agent] = await api.threadAgents(threadId);
  if (agent === undefined) throw new Error('no sub-agent');
  const page = await api.agentPage(agent.agentId);
  const callIds = page.entries
    .filter(
      (entry): entry is Extract<HistoryEntry, { kind: 'tool_result' }> =>
        entry.kind === 'tool_result' && entry.content.tool === 'search_logs',
    )
    .map((entry) => {
      expect(entry.content.outcome).toBe('success');
      return entry.content.callId;
    });
  expect(callIds).toHaveLength(logCalls.length);
  return { threadId, agentId: agent.agentId, callIds };
}

describe('Conversation search: everything is found, once, in order (UC-1); only your own and only the living (UC-2)', () => {
  beforeAll(async () => {
    harness = await createTestApp({
      workers: true,
      mcpServers: ['logs'],
      faults: () => [
        {
          tool: 'search_logs',
          argsHash: argsHash(LONG_LOGS),
          occurrences: 'all',
          mode: 'oversize',
          bytes: OVERSIZED_BYTES,
        },
      ],
    });
    harness.model.completeText({ text: GENERATED_TITLE });
    admin = await seedSuperAdmin(
      harness.app,
      `e2e-search-admin-${randomUUID().slice(0, 8)}`,
    );
    madeUsers.push(admin.id);
    restoreModels = await useRunModels(harness.app, admin, {
      chat: { id: MODEL, ...HAIKU_TEST_PRICES },
    });
    restoreBuiltins = await pointBuiltinsAt(harness.app, admin, MODEL);
    role = await allowRole(harness.app, admin, {
      name: 'search',
      models: [MODEL],
      servers: [LOGS_SERVER],
    });
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (harness === undefined) return;
    try {
      try {
        await restoreBuiltins?.();
        await restoreModels?.();
      } finally {
        await removeRunRows(harness.pool, {
          models: [MODEL],
          roles: role === undefined ? [] : [role.id],
          users: madeUsers,
        });
      }
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  // AC-12.1, AC-12.2, AC-12.3 (API: an empty list), AC-15.1, DC-1, DC-2 (the short boundary and stop words only), DC-3, KD-2, KD-3,
  //   NFR-02 (every search runs right after the write).
  // Catches: a stored result found twice (its wrapper in `messages` and its row in `tool_results`); a word form or a word start not found;
  //   words joined by OR instead of AND; a sub-agent's report found again in the chat's start_agent result; a row repeated or skipped at
  //   the cursor; a stop-word-only query failing instead of answering an empty page.
  it(
    'UC-1: Anna finds a tool result once, a title-only word, a word form and a second page in order; a bad or empty query answers 400 or an empty list',
    async () => {
      const api = chatApi(harness.app, await employee());

      // A sub-agent «Разбор логов» stores a long and a short result of the logs
      const logs = await withSubagent(
        api,
        'Разберись с логами платежей',
        'Прочитай логи адаптера',
        [LONG_LOGS, SHORT_LOGS],
      );
      const results = await found(api, SERVICE);
      expect(results.nextCursor).toBeNull();
      expect(results.matches).toHaveLength(logs.callIds.length);
      expect(new Set(results.matches.map((match) => match.callId))).toEqual(
        new Set(logs.callIds),
      );
      for (const match of results.matches) {
        expect(match).toMatchObject({
          threadId: logs.threadId,
          place: 'tool_result',
          agent: { agentId: logs.agentId, name: GENERAL_PURPOSE.name },
          tool: 'search_logs',
          seq: null,
          titleMarks: [],
        });
        expect(match.snippet?.text).toContain(SERVICE);
        expect(marked(match.snippet!.text, match.snippet!.marks)).toContain(
          'provider',
        );
      }

      // A word start finds the word (KD-2 prefix)
      const byStart = await found(api, 'provi');
      expect(new Set(byStart.matches.map((match) => match.callId))).toEqual(
        new Set(logs.callIds),
      );

      // A word only in the sub-agent's report: once, in its own conversation, not in the chat's start_agent result (KD-3)
      const report = await found(api, 'разобраны');
      expect(report.matches).toHaveLength(1);
      expect(report.matches[0]).toMatchObject({
        threadId: logs.threadId,
        place: 'message',
        agent: { agentId: logs.agentId },
      });

      // A word only in a conversation's title
      const titled = await conversation(api, 'Сверим счета', 'Сверим.');
      await api.renameThread(titled, 'Сверка дебиторки');
      const inTitle = await found(api, 'дебиторка');
      expect(inTitle.matches).toHaveLength(1);
      expect(inTitle.matches[0]).toMatchObject({
        threadId: titled,
        title: 'Сверка дебиторки',
        place: 'title',
        agent: null,
        snippet: null,
      });
      expect(
        marked('Сверка дебиторки', inTitle.matches[0]!.titleMarks),
      ).toEqual(['дебиторки']);

      // Two words, each only in another text: no text holds both, nothing is found (KD-2 AND)
      expect((await found(api, `${SERVICE} дебиторка`)).matches).toEqual([]);

      // Another form of a word
      const reports = await conversation(api, 'Отчёты по выручке', 'Готово.');
      const byForm = await found(api, 'отчёт');
      expect(byForm.matches).toHaveLength(1);
      expect(byForm.matches[0]).toMatchObject({
        threadId: reports,
        place: 'message',
        seq: 1,
        callId: null,
        tool: null,
      });
      const snippet = byForm.matches[0]!.snippet!;
      expect(snippet.text).toBe('Отчёты по выручке');
      expect(marked(snippet.text, snippet.marks)).toEqual(['Отчёты']);

      // 21 messages: 20 newest, then the last one, no repeats
      const quarterly = await wordy(api, QUARTERLY, 21, 'альфа');
      const pages = await allFound(api, QUARTERLY);
      expect(pages.map((page) => page.length)).toEqual([20, 1]);
      const matches = pages.flat();
      expect(
        matches.every((match) => match.threadId === quarterly.threadId),
      ).toBe(true);
      expect(matches.map((match) => match.seq)).toEqual(
        quarterly.seqs.toSorted((a, b) => b - a),
      );

      // Nothing, only stop words, one character
      expect((await found(api, 'несуществующееслово')).matches).toEqual([]);
      expect(await found(api, 'по и')).toEqual({
        matches: [],
        nextCursor: null,
      });
      const tooShort = await expectError(search(api, ' a '), 400);
      expect(tooShort.errorCode).toBe('VALIDATION_FAILED');
    },
    TEST_TIMEOUT_MS,
  );

  // AC-14.1, AC-14.2, DC-5.
  // Catches: the owner filter missing (another employee's rows on the page); a deleted conversation, its sub-agent or its stored result
  //   still found; a foreign cursor opening the other owner's rows.
  it(
    'UC-2: Anna never sees Boris, a deleted conversation and its sub-agents vanish, and a foreign or invented cursor never opens foreign rows',
    async () => {
      const anna = chatApi(harness.app, await employee());
      const boris = chatApi(harness.app, await employee());

      // Anna: a conversation with the word, a sub-agent with it in its task, and a stored result
      const doomed = await withSubagent(
        anna,
        `${QUARTERLY} разбор платежей`,
        `${QUARTERLY} разбор логов адаптера`,
        [SHORT_LOGS],
      );
      const beforeDelete = (await allFound(anna, QUARTERLY)).flat();
      expect(beforeDelete).toHaveLength(2);
      expect(
        new Set(beforeDelete.map((match) => match.agent?.agentId ?? null)),
      ).toEqual(new Set([doomed.agentId, null]));
      expect((await found(anna, SERVICE)).matches).toHaveLength(1);

      // Anna: more than a page of the word; Boris: one conversation with it
      const kept = await wordy(anna, QUARTERLY, 21, 'бета');
      const borisThread = await conversation(
        boris,
        `${QUARTERLY} бюджет Бориса`,
        'Принято.',
      );

      // When: Anna deletes the conversation with the sub-agent
      await anna.deleteThread(doomed.threadId);

      // Then: Anna sees only her living conversation, nothing of the deleted tree
      const annaPages = await allFound(anna, QUARTERLY);
      expect(annaPages.map((page) => page.length)).toEqual([20, 1]);
      expect(new Set(annaPages.flat().map((match) => match.threadId))).toEqual(
        new Set([kept.threadId]),
      );
      expect(annaPages.flat().every((match) => match.agent === null)).toBe(
        true,
      );
      expect((await found(anna, SERVICE)).matches).toEqual([]);

      // Then: Boris sees only his own, with and without Anna's cursor
      const borisFirst = await found(boris, QUARTERLY);
      expect(borisFirst.matches.map((match) => match.threadId)).toEqual([
        borisThread,
      ]);
      const annaCursor = (await found(anna, QUARTERLY)).nextCursor;
      expect(annaCursor).not.toBeNull();
      const borisByAnnaCursor = await found(boris, QUARTERLY, annaCursor!);
      expect(
        borisByAnnaCursor.matches.every(
          (match) => match.threadId === borisThread,
        ),
      ).toBe(true);

      // Then: an invented cursor is refused
      const invented = await expectError(
        search(boris, QUARTERLY, 'not-a-cursor'),
        400,
      );
      expect(invented.errorCode).toBe('INVALID_CURSOR');
    },
    TEST_TIMEOUT_MS,
  );
});
