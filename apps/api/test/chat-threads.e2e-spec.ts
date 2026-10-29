// chat-shell / threads-api Integration Test - Design Doc: docs/features/chat-shell/design-threads-api.md (v1.8)
// Generated: 2026-10-28 | Part: threads-api | Test type: integration (HTTP + real Postgres, mock LLMs)
// Scope: POST /api/chat/:agentId accepting only existing own threads (AC-16.1 chosen variant "404"), the
// auto-title step after the assistant reply (FR-17), regenerate after a model error or a client disconnect
// (AC-14.6) and the regenerate/edit history characterization. File name per Design Doc Test Strategy
// ("chat-threads.e2e-spec.ts").
//
// Status: all cases are implemented (AC-16.1, thread ownership on chat, FR-17, AC-14.6, characterization).
//
// Environment: same harness as threads.e2e-spec.ts (test/support/createTestApp, mockModels, seed);
// Postgres from infra/docker-compose.yml; unique `resourceId = 'e2e-' + randomUUID()` per test as `x-user-id`;
// afterAll removes threads of the created resourceIds. Assistant model: MockLanguageModelV3; title model: mock via
// THREAD_TITLE_AGENT override (scenarios: success 'План отпуска на Байкал', throws, delay). No network.
// Polling for the background title: GET /api/threads/:id every 100 ms, up to 10 000 ms.
//
// AC-18.3 ("ChatRequestSchema не изменён; существующие e2e test/app.e2e-spec.ts проходят без правок") is verified by
// running the existing apps/api/test/app.e2e-spec.ts unchanged; no new case is generated for it here.

import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { setTimeout as delay } from 'node:timers/promises';
import {
  ApiErrorSchema,
  ThreadListResponseSchema,
  ThreadMessagesResponseSchema,
  ThreadSummarySchema,
  type HistoryMessage,
} from '@agent-os/contracts';
import { safeValidateUIMessages } from 'ai';
import request from 'supertest';
import { z } from 'zod';
import { createTestApp, type TestApp } from './support/createTestApp.js';
import { closeDb, countMessages } from './support/db.js';
import {
  assistantModel,
  partialTextThenErrorStep,
  partialTextUntilAbortStep,
  textStep,
  titleDelayed,
  titleError,
  titleModel,
  titleSuccess,
  type AssistantStep,
  type TitleModel,
} from './support/mockModels.js';
import { cleanupUsers, newUser, seed } from './support/seed.js';

// Apps started by the current test; afterEach removes their users' threads and closes them.
const started: { testApp: TestApp; users: Set<string> }[] = [];

/** Boots the app with the given scripted assistant replies; `user()` registers a user for cleanup. */
function startApp(...steps: AssistantStep[]) {
  return startAppWith({ steps });
}

/** As `startApp`, with a scripted title model (default: `'Тестовый заголовок'`). */
async function startAppWith(options: {
  steps: AssistantStep[];
  title?: TitleModel;
}) {
  const assistant = assistantModel(...options.steps);
  const testApp = await createTestApp({
    assistantModel: assistant,
    titleModel: options.title,
  });
  const users = new Set<string>();
  started.push({ testApp, users });
  const user = (): string => {
    const id = newUser();
    users.add(id);
    return id;
  };
  return {
    ...testApp,
    assistant,
    http: request(testApp.app.getHttpServer()),
    user,
  };
}

/** The single 404 body for a missing, foreign or deleted thread (Design Doc, finding 7). */
const NOT_FOUND_BODY = {
  message: 'Thread not found',
  error: 'Not Found',
  statusCode: 404,
  errorCode: 'THREAD_NOT_FOUND',
};

/** Ids of the user's threads (GET /api/threads, first page). */
async function listedThreadIds(
  http: ReturnType<typeof request>,
  userId: string,
): Promise<string[]> {
  const res = await http
    .get('/api/threads')
    .set('x-user-id', userId)
    .expect(200);
  return ThreadListResponseSchema.parse(res.body).threads.map(({ id }) => id);
}

/** Messages of GET /api/threads/:id/messages. */
async function threadHistory(
  http: ReturnType<typeof request>,
  userId: string,
  threadId: string,
): Promise<HistoryMessage[]> {
  const res = await http
    .get(`/api/threads/${threadId}/messages`)
    .set('x-user-id', userId)
    .expect(200);
  return ThreadMessagesResponseSchema.parse(res.body).messages;
}

afterEach(async () => {
  for (const { testApp, users } of started.splice(0)) {
    try {
      await cleanupUsers(testApp.memory, users);
    } finally {
      await testApp.app.close();
    }
  }
});

afterAll(async () => {
  await closeDb();
});

/** One seeded thread without messages owned by `resourceId` (POST /api/threads arrives in T3.3). */
async function seedThread(
  memory: TestApp['memory'],
  resourceId: string,
): Promise<string> {
  const { ids } = await seed(memory, {
    resourceId,
    threads: [{ updatedAt: new Date('2026-01-01T10:00:00.000Z') }],
  });
  const id = ids.get(1);
  if (!id) throw new Error('seed returned no thread id');
  return id;
}

/** Creates an untitled thread through POST /api/threads; returns its id. */
async function createThread(
  http: ReturnType<typeof request>,
  userId: string,
): Promise<string> {
  const res = await http
    .post('/api/threads')
    .set('x-user-id', userId)
    .expect(201);
  return ThreadSummarySchema.parse(res.body).id;
}

/** `title` of GET /api/threads/:id. */
async function threadTitle(
  http: ReturnType<typeof request>,
  userId: string,
  threadId: string,
): Promise<string | null> {
  const res = await http
    .get(`/api/threads/${threadId}`)
    .set('x-user-id', userId)
    .expect(200);
  return ThreadSummarySchema.parse(res.body).title;
}

/**
 * Polls `check` every 100 ms until it returns a value other than `undefined`;
 * fails when nothing arrives within `maxMs` (default 10 000 ms, AC-17.1).
 */
async function pollUntil<T>(
  check: () => Promise<T | undefined>,
  maxMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + maxMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline)
      throw new Error(`not reached within ${maxMs} ms`);
    await delay(100);
  }
}

/** Polls GET /api/threads/:id (100 ms, up to 10 000 ms) until the title is set. */
function awaitTitle(
  http: ReturnType<typeof request>,
  userId: string,
  threadId: string,
): Promise<string> {
  return pollUntil(
    async () => (await threadTitle(http, userId, threadId)) ?? undefined,
  );
}

/** A user message as the AI SDK chat transport sends it (client-generated id). */
function clientUserMessage(text: string) {
  return {
    id: `client-${randomUUID()}`,
    role: 'user',
    parts: [{ type: 'text', text }],
  };
}

/**
 * `[role, texts]` of each message, in order; `texts` keeps every `text` part
 * separately, so replies merged into one message stay visible.
 */
function roleAndTexts(messages: HistoryMessage[]): [string, string[]][] {
  return messages.map((message) => [
    message.role,
    message.parts
      .filter((part) => part.type === 'text')
      .map((part) => (typeof part.text === 'string' ? part.text : '')),
  ]);
}

const SseChunkSchema = z.looseObject({
  type: z.string(),
  messageId: z.string().optional(),
  errorText: z.string().optional(),
});

/** UI message stream chunks of an SSE body (`data: {...}` lines; `[DONE]` skipped). */
function sseChunks(sse: string): z.infer<typeof SseChunkSchema>[] {
  return sse
    .split('\n')
    .filter((line) => line.startsWith('data: ') && line !== 'data: [DONE]')
    .map((line) => SseChunkSchema.parse(JSON.parse(line.slice(6))));
}

/**
 * Sends a chat request over a real socket and drops the connection as soon as
 * the SSE body contains `marker` — a client network drop mid-reply.
 * Returns the SSE text received before the drop.
 */
async function chatAndDisconnect(options: {
  baseUrl: string;
  userId: string;
  body: object;
  marker: string;
}): Promise<string> {
  const connection = new AbortController();
  const res = await fetch(`${options.baseUrl}/api/chat/assistant`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-user-id': options.userId,
    },
    body: JSON.stringify(options.body),
    signal: connection.signal,
  });
  expect(res.status).toBe(200);
  if (!res.body) throw new Error('chat response has no body');
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let received = '';
  while (!received.includes(options.marker)) {
    const { done, value } = await reader.read();
    if (done)
      throw new Error(`SSE ended before ${options.marker}: ${received}`);
    received += value;
  }
  reader.releaseLock();
  connection.abort();
  return received;
}

/** Resolves `'settled'` when `promise` resolves within `ms`, otherwise `'timed out'`. */
function settlesWithin(promise: Promise<unknown>, ms: number) {
  return Promise.race([
    promise.then(() => 'settled' as const),
    delay(ms, 'timed out' as const, { ref: false }),
  ]);
}

/**
 * Polls the thread's `mastra_messages` row count every 100 ms until it stays
 * unchanged for `stableMs`; fails when it does not settle within `maxMs`.
 */
async function settledMessageCount(
  threadId: string,
  { stableMs = 1_000, maxMs = 5_000 } = {},
): Promise<number> {
  const deadline = Date.now() + maxMs;
  let count = await countMessages(threadId);
  let stableSince = Date.now();
  while (Date.now() - stableSince < stableMs) {
    if (Date.now() > deadline) {
      throw new Error(`row count did not settle within ${maxMs} ms (${count})`);
    }
    await delay(100);
    const next = await countMessages(threadId);
    if (next !== count) {
      count = next;
      stableSince = Date.now();
    }
  }
  return count;
}

describe('POST /api/chat/:agentId with threads (integration, real Postgres)', () => {
  // ---------------------------------------------------------------------------
  // AC-16.1 chosen variant: no resurrection of a deleted thread
  // ---------------------------------------------------------------------------
  // AC-16.1: "When пользователь удалил свою беседу (DELETE -> 204), the system shall ... отвечать 404 THREAD_NOT_FOUND на
  //   POST /api/chat/:agentId с этим id, не создавая беседу (выбран вариант «404», PRD п. 5, UXRD E-8/UXQ-2)."
  // EARS: When -> event-driven
  // ROI: 8.6 | Business Value: 10 (deleted data must not reappear) | Frequency: 6 | Defect detection: 10
  // Behavior: delete thread -> chat with its id -> getOwnedThread rejects before agent.stream -> 404, nothing created
  // Primary failure mode: Mastra implicitly re-creates the thread on agent.stream (silent resurrection).
  // @category: core-functionality
  // @dependency: ChatController, ThreadsService.getOwnedThread, Mastra agent 'assistant', Memory, PostgresStore
  // @complexity: medium
  describe('AC-16.1 deleted thread', () => {
    it('AC-16.1: chat into a deleted thread answers 404 THREAD_NOT_FOUND before streaming and does not recreate it', async () => {
      // Arrange: a created thread with one exchange, then deleted.
      const t = await startApp(textStep('Привет!'));
      const user = t.user();
      const threadId = await createThread(t.http, user);
      await t.http
        .post('/api/chat/assistant')
        .set('x-user-id', user)
        .send({ id: threadId, messages: [clientUserMessage('Привет')] })
        .expect(200);
      await t.http
        .delete(`/api/threads/${threadId}`)
        .set('x-user-id', user)
        .expect(204);
      const modelCallsBefore = t.assistant.doStreamCalls.length;

      // Act: chat into the deleted thread.
      const res = await t.http
        .post('/api/chat/assistant')
        .set('x-user-id', user)
        .send({ id: threadId, messages: [clientUserMessage('Снова привет')] });

      // Assert: 404 JSON before any SSE; the thread is not resurrected; the model is not called.
      expect(res.status).toBe(404);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
      expect(ApiErrorSchema.parse(res.body)).toEqual(NOT_FOUND_BODY);
      expect(await listedThreadIds(t.http, user)).not.toContain(threadId);
      expect(
        await t.memory.getThreadById({ threadId, resourceId: user }),
      ).toBeNull();
      expect(t.assistant.doStreamCalls).toHaveLength(modelCallsBefore);
    });
  });

  // ---------------------------------------------------------------------------
  // Chat accepts only an existing own thread (Design Element 1)
  // ---------------------------------------------------------------------------
  // Contract: "POST /api/chat/:agentId ... 404 THREAD_NOT_FOUND (новое)"; Test Strategy: "Чужая беседа -> 404 (было 500);
  //   несуществующий клиентский id -> 404; своя -> 200 SSE, сообщения сохранены."
  // EARS: If-then -> branch (own / foreign / unknown)
  // ROI: 8.3 | Business Value: 10 (security + main chat path) | Frequency: 10 | Defect detection: 8
  // Behavior: thread lookup by (id, resourceId) before streaming -> own: 200 SSE + persisted; foreign/unknown: 404
  // Primary failure mode: foreign thread is written to (IDOR) or a client-generated id silently creates a thread.
  // @category: core-functionality
  // @dependency: SessionGuard, ChatController, ThreadsService.getOwnedThread, Memory, PostgresStore
  // @complexity: medium
  describe('thread ownership on chat', () => {
    it('own thread: 200 SSE and both messages are persisted', async () => {
      // Arrange: a created thread; the assistant answers 'Привет! Чем помочь?'.
      const t = await startApp(textStep('Привет! Чем помочь?'));
      const user = t.user();
      const threadId = await createThread(t.http, user);

      // Act
      const res = await t.http
        .post('/api/chat/assistant')
        .set('x-user-id', user)
        .send({ id: threadId, messages: [clientUserMessage('Привет')] });

      // Assert: an SSE stream that completed; both messages are stored.
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/event-stream/);
      expect(sseChunks(res.text).map((chunk) => chunk.type)).toContain(
        'finish',
      );
      expect(roleAndTexts(await threadHistory(t.http, user, threadId))).toEqual(
        [
          ['user', ['Привет']],
          ['assistant', ['Привет! Чем помочь?']],
        ],
      );
    });

    it('foreign thread and unknown client id both answer 404 THREAD_NOT_FOUND and nothing is written', async () => {
      // Arrange: user A owns a thread; user B has none; an unknown client-generated id.
      const t = await startApp();
      const userA = t.user();
      const userB = t.user();
      const threadA = await createThread(t.http, userA);
      const unknownId = `client-${randomUUID()}`;
      const chatAsB = (id: string, text: string) =>
        t.http
          .post('/api/chat/assistant')
          .set('x-user-id', userB)
          .send({ id, messages: [clientUserMessage(text)] });

      // Act
      const foreign = await chatAsB(threadA, 'Чужое');
      const unknown = await chatAsB(unknownId, 'Новое');

      // Assert: the same 404 body for both (foreign was 500 before); nothing written or created.
      expect(foreign.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(foreign.headers['content-type']).toMatch(/^application\/json/);
      expect(unknown.headers['content-type']).toMatch(/^application\/json/);
      expect(ApiErrorSchema.parse(foreign.body)).toEqual(NOT_FOUND_BODY);
      expect(ApiErrorSchema.parse(unknown.body)).toEqual(NOT_FOUND_BODY);
      expect(await threadHistory(t.http, userA, threadA)).toEqual([]);
      expect(await countMessages(threadA)).toBe(0);
      expect(await listedThreadIds(t.http, userB)).toEqual([]);
      expect(
        await t.memory.getThreadById({
          threadId: unknownId,
          resourceId: userB,
        }),
      ).toBeNull();
      expect(t.assistant.doStreamCalls).toHaveLength(0);
    });

    // Risk: an id longer than ThreadIdSchema's 255 characters passes ChatDto and reaches storage lookups.
    it.each(['id', 'threadId'])(
      'rejects a 256-character body %s with 400 before streaming',
      async (field) => {
        const t = await startApp();
        const user = t.user();

        const res = await t.http
          .post('/api/chat/assistant')
          .set('x-user-id', user)
          .send({
            [field]: 'x'.repeat(256),
            messages: [clientUserMessage('Привет')],
          });

        expect(res.status).toBe(400);
        expect(t.assistant.doStreamCalls).toHaveLength(0);
      },
    );
  });

  // ---------------------------------------------------------------------------
  // FR-17 Auto-title
  // ---------------------------------------------------------------------------
  describe('auto-title after the assistant reply', () => {
    // AC-17.1: "When завершился ответ ассистента в беседе с пустым заголовком, the system shall не позднее 10 с записать
    //   заголовок длиной 1…80 символов без кавычек и переводов строк, сгенерированный по первому сообщению пользователя
    //   на его языке (PRD FR-17)."
    // EARS: When -> event-driven
    // ROI: 7.5 | Business Value: 8 | Frequency: 10 (every new thread) | Defect detection: 7
    // Behavior: stream finishes -> onFinish -> ThreadTitleService.schedule reads first stored user message -> writes title
    // Primary failure mode: title never written (onFinish not wired / recall before persistence) or source text is not
    //   the first stored user message.
    // @category: core-functionality
    // @dependency: ChatController onFinish, ThreadTitleService, THREAD_TITLE_AGENT (mock), ThreadWriteLock, Memory
    // @complexity: high
    // Note: language and quality on a real model are verified manually (metric No. 7), not here.
    it('AC-17.1: an untitled thread gets the generated title within 10 s from the first user message', async () => {
      // Arrange: an untitled thread; the title mock answers 'План отпуска на Байкал'.
      const t = await startAppWith({
        steps: [textStep('Вот план')],
        title: titleModel(titleSuccess('План отпуска на Байкал')),
      });
      const user = t.user();
      const threadId = await createThread(t.http, user);
      expect(await threadTitle(t.http, user, threadId)).toBeNull();

      // Act: one exchange (supertest reads the stream to its end), then poll the title.
      await t.http
        .post('/api/chat/assistant')
        .set('x-user-id', user)
        .send({
          id: threadId,
          messages: [
            clientUserMessage('Помоги составить план отпуска на Байкал в июле'),
          ],
        })
        .expect(200);
      const title = await awaitTitle(t.http, user, threadId);

      // Assert
      expect(title).toBe('План отпуска на Байкал');
      expect(title.length).toBeLessThanOrEqual(80);
      expect(title).not.toContain('\n');
      expect(title).not.toMatch(/^["'«]|["'»]$/);
      expect(title).not.toBe('Помоги составить план отпуска на Байкал в июле');
      expect(t.titleModel.prompts).toHaveLength(1);
      expect(t.titleModel.prompts[0]).toContain(
        'Помоги составить план отпуска на Байкал в июле',
      );
    }, 20_000);

    // AC-17.2: "If у беседы уже есть непустой заголовок (ручной или ранее сгенерированный), then the system shall не
    //   запускать генерацию; if ручное переименование пришло во время генерации, then сгенерированный заголовок не
    //   записывается."
    // EARS: If-then -> branch. This case covers the first branch on real Postgres; the race branch is unit-tested
    //   (thread-title.service.spec.ts, deferred promise + shared ThreadWriteLock) per Design Doc Test Strategy.
    // ROI: 6.4 | Business Value: 8 (user intent must win) | Frequency: 5 | Defect detection: 7
    // Behavior: manual title set -> next reply -> generation skipped -> manual title kept
    // Primary failure mode: auto-title overwrites a manual rename.
    // @category: core-functionality
    // @dependency: ThreadsService.rename, ThreadTitleService, THREAD_TITLE_AGENT (mock)
    // @complexity: medium
    it('AC-17.2: a manually titled thread keeps its title and the title model is not called', async () => {
      // Arrange: a thread renamed by hand; a fresh title mock (no calls yet).
      const t = await startAppWith({ steps: [textStep('Сводка готова')] });
      const user = t.user();
      const threadId = await createThread(t.http, user);
      await t.http
        .patch(`/api/threads/${threadId}`)
        .set('x-user-id', user)
        .send({ title: 'Отчёт Q3' })
        .expect(200);

      // Act: one exchange, then time for any background work.
      await t.http
        .post('/api/chat/assistant')
        .set('x-user-id', user)
        .send({ id: threadId, messages: [clientUserMessage('Сделай сводку')] })
        .expect(200);
      await delay(1_000);

      // Assert
      expect(await threadTitle(t.http, user, threadId)).toBe('Отчёт Q3');
      expect(t.titleModel.prompts).toHaveLength(0);
    });

    // AC-17.3: "If генерация упала или превысила таймаут, then the system shall оставить заголовок пустым (title: null в
    //   API), записать предупреждение в лог с threadId и причиной, при этом ответ ассистента и сообщения уже сохранены
    //   и не затронуты; если заголовок всё ещё пуст, генерация повторяется после следующего ответа ассистента."
    // EARS: If-then -> branch (failure, then retry)
    // ROI: 6.9 | Business Value: 8 (reply must not be affected) | Frequency: 3 | Defect detection: 9
    // Behavior: title model throws -> error swallowed + warn log -> reply and messages intact, title null ->
    //   next reply retries using the first stored message (not body.messages)
    // Primary failure mode: title error breaks the stream or is not retried; retry uses body.messages and titles
    //   the thread from the latest message instead of the first.
    // @category: edge-case
    // @dependency: ChatController onFinish, ThreadTitleService, THREAD_TITLE_AGENT (mock), Logger, Memory
    // @complexity: high
    it('AC-17.3: a failing title model leaves title null and logs a warning; the next reply retries from the first stored message', async () => {
      // Arrange: an untitled thread; the title mock throws; Logger.warn is observed.
      const title = titleModel(titleError('mock title failure'));
      const t = await startAppWith({
        steps: [textStep('Готово'), textStep('Возьмите тёплую куртку')],
        title,
      });
      const user = t.user();
      const threadId = await createThread(t.http, user);
      const warn = vi.spyOn(Logger.prototype, 'warn');
      const firstText = 'Помоги составить план отпуска на Байкал в июле';
      const chat = (text: string) =>
        t.http
          .post('/api/chat/assistant')
          .set('x-user-id', user)
          .send({ id: threadId, messages: [clientUserMessage(text)] })
          .expect(200);
      const history = async () => {
        const res = await t.http
          .get(`/api/threads/${threadId}/messages`)
          .set('x-user-id', user)
          .expect(200);
        return ThreadMessagesResponseSchema.parse(res.body).messages;
      };
      const failureWarning = () =>
        warn.mock.calls
          .map(([message]: unknown[]) => message)
          .find(
            (message): message is string =>
              typeof message === 'string' &&
              message.startsWith(`Title generation failed thread=${threadId}`),
          );

      try {
        // Act 1: the reply succeeds; the title attempt fails in the background.
        const first = await chat(firstText);
        // The warning is logged once the failed title call settled (so the mock was called).
        const warning = await pollUntil(() =>
          Promise.resolve(failureWarning()),
        );

        // Assert 1: the reply and messages are intact, the title stays null, the warning has no PII.
        expect(sseChunks(first.text).map((chunk) => chunk.type)).toContain(
          'finish',
        );
        expect(roleAndTexts(await history())).toEqual([
          ['user', [firstText]],
          ['assistant', ['Готово']],
        ]);
        expect(title.prompts.length).toBeGreaterThanOrEqual(1);
        expect(await threadTitle(t.http, user, threadId)).toBeNull();
        expect(warning).toBe(
          `Title generation failed thread=${threadId} reason=Error`,
        );
        expect(warning).not.toContain('mock title failure');
        expect(warning).not.toContain(firstText);

        // Act 2: the title model recovers; the next request carries ONLY the new message.
        title.use(titleSuccess('План отпуска на Байкал'));
        const callsBeforeRetry = title.prompts.length;
        await chat('А что взять с собой?');
        const retried = await awaitTitle(t.http, user, threadId);

        // Assert 2: the retry titled the thread from the first stored message.
        expect(retried).toBe('План отпуска на Байкал');
        expect(title.prompts).toHaveLength(callsBeforeRetry + 1);
        const retryPrompt = title.prompts[callsBeforeRetry];
        expect(retryPrompt).toContain(firstText);
        expect(retryPrompt).not.toContain('А что взять с собой?');
        expect(await history()).toHaveLength(4);
      } finally {
        warn.mockRestore();
      }
    }, 30_000);

    // AC-17.2 race branch + Integration Verification Points (additional e2e outside the skeleton).
    // Defect caught (the unit test with a shared ThreadWriteLock cannot see it): on the real Mastra storage the
    //   background write does not re-check the empty title under ThreadWriteLock, so a rename that landed while
    //   the title model was still answering is overwritten by the generated title.
    // EARS: If-then -> branch (rename during generation)
    // @category: edge-case
    // @dependency: ChatController onFinish, ThreadTitleService, ThreadsService.rename, ThreadWriteLock, Memory
    // @complexity: high
    it('manual rename while title generation is pending wins', async () => {
      // Arrange: the title mock answers 'Сгенерированный' after 1 500 ms; an untitled seeded thread.
      const t = await startAppWith({
        steps: [textStep('Ответ')],
        title: titleModel(titleDelayed('Сгенерированный', 1_500)),
      });
      const user = t.user();
      const threadId = await seedThread(t.memory, user);

      // Act: one exchange; while the title call is pending, rename by hand.
      await t.http
        .post('/api/chat/assistant')
        .set('x-user-id', user)
        .send({ id: threadId, messages: [clientUserMessage('Вопрос')] })
        .expect(200);
      await pollUntil(() =>
        Promise.resolve(t.titleModel.prompts.length > 0 ? true : undefined),
      );
      const titleCalledAt = Date.now();
      await t.http
        .patch(`/api/threads/${threadId}`)
        .set('x-user-id', user)
        .send({ title: 'Ручной' })
        .expect(200);
      const renamedAt = Date.now();
      // The rename must land while the 1 500 ms generation is still pending, otherwise the test passes vacuously.
      expect(renamedAt - titleCalledAt).toBeLessThan(1_500);

      // Assert: the manual title survives the end of the delayed generation.
      await delay(renamedAt + 2_000 - Date.now());
      expect(await threadTitle(t.http, user, threadId)).toBe('Ручной');
      expect(t.titleModel.prompts).toHaveLength(1);
    }, 20_000);
  });

  // ---------------------------------------------------------------------------
  // AC-14.6 (Verification, Certainty: low; gate G3) - additional e2e outside the skeleton
  // ---------------------------------------------------------------------------
  // AC-14.6: "When ответ ассистента завершился ошибкой модели посреди стрима и пользователь перегенерировал его
  //   (повторная отправка того же сообщения пользователя - тот же id, без последнего ответа ассистента), the system
  //   shall вернуть в GET /api/threads/:threadId/messages после этого сообщения пользователя ровно одно сообщение
  //   ассистента, содержащее только текст перегенерированного ответа; сообщение пользователя не дублируется, текст
  //   неудавшейся попытки не возвращается."
  // Defect caught (no unit sees it): the regenerated reply is merged with the failed partial one, or messages are
  //   duplicated, on the real Mastra write path to Postgres.
  // Step 1 also pins the stored state after a model error without regeneration (DD "Контракт для web-shell", п. 6).
  // EARS: When -> event-driven
  // ROI: 7.8 | Business Value: 9 (duplicated or merged replies corrupt the history) | Frequency: 4 | Defect detection: 9
  // Behavior: submit -> model error mid-stream -> partial reply stored -> regenerate (same user message id) ->
  //   discard the tail -> one assistant reply with only the new text
  // @category: core-functionality
  // @dependency: ChatController, ThreadsService (discard the tail), toAISdkMessages, Memory, PostgresStore
  // @complexity: high
  describe('AC-14.6 regenerate after a model error (Certainty: low)', () => {
    it('AC-14.6: regenerating a reply that failed mid-stream leaves exactly one assistant reply after the user message', async () => {
      // Arrange: model call 1 streams 'Частичный' and then a stream error; call 2 answers 'Ответ 2'.
      const t = await startApp(
        partialTextThenErrorStep('Частичный'),
        textStep('Ответ 2'),
      );
      const user = t.user();
      const threadId = await seedThread(t.memory, user);
      const question = clientUserMessage('Вопрос');
      const chat = (body: object) =>
        t.http
          .post('/api/chat/assistant')
          .set('x-user-id', user)
          .send({ id: threadId, ...body })
          .expect(200);
      const historyResponse = () =>
        t.http
          .get(`/api/threads/${threadId}/messages`)
          .set('x-user-id', user)
          .expect(200);
      const history = async () =>
        ThreadMessagesResponseSchema.parse((await historyResponse()).body)
          .messages;

      // Act 1: submit — the reply fails mid-stream.
      const failed = sseChunks(
        (await chat({ trigger: 'submit-message', messages: [question] })).text,
      );
      const afterError = await history();
      const rowsAfterError = await countMessages(threadId);

      // Assert 1: the stream reported the error; the stored state after a model
      // error without regeneration is pinned (characterization): the user message
      // and the partial assistant reply (same id as in the SSE `start` chunk).
      expect(failed).toContainEqual({
        type: 'error',
        errorText: 'Agent error',
      });
      expect(roleAndTexts(afterError)).toEqual([
        ['user', ['Вопрос']],
        ['assistant', ['Частичный']],
      ]);
      const failedReplyId = afterError[1].id;
      expect(failed[0]).toEqual({ type: 'start', messageId: failedReplyId });
      expect(rowsAfterError).toBe(2);
      // AC-14.5 (b): the model error part is dropped; the raw error text is not returned.
      expect(afterError[1].parts.map((part) => part.type)).toEqual(['text']);
      expect(
        (await safeValidateUIMessages({ messages: afterError })).success,
      ).toBe(true);
      const afterErrorBody = (await historyResponse()).text;
      expect(afterErrorBody).not.toContain('mock stream failure');

      // Act 2: regenerate — the same user message, without the failed reply.
      await chat({
        trigger: 'regenerate-message',
        messageId: failedReplyId,
        messages: [question],
      });

      // Assert 2 (AC-14.6, gate G3): exactly one assistant reply with only the new text.
      expect(roleAndTexts(await history())).toEqual([
        ['user', ['Вопрос']],
        ['assistant', ['Ответ 2']],
      ]);
      expect(await countMessages(threadId)).toBe(2);
    });
  });

  // AC-14.6, variant "network drop" (Certainty: low; gate G3) - additional e2e outside the skeleton.
  // Defect caught (neither unit nor the model-error case sees it): after the stream is cancelled by
  //   res.on('close'), the stored state is one "discard the tail" cannot handle (the partial reply is
  //   written after the resend, or the user message is missing), so the regenerate leaves two replies.
  // EARS: When -> event-driven
  // ROI: 7.2 | Business Value: 9 (same as the model-error case) | Frequency: 3 | Defect detection: 9
  // Behavior: submit -> client drops the connection after the partial text -> model call aborted ->
  //   stored state settles (pinned) -> regenerate -> one assistant reply with only the new text
  // @category: edge-case
  // @dependency: ChatController (res.on('close') -> abortSignal), ThreadsService (discard the tail), Memory, PostgresStore
  // @complexity: high
  describe('AC-14.6 regenerate after a client disconnect (Certainty: low)', () => {
    it('AC-14.6 (network drop): regenerating a reply cut off by a client disconnect leaves exactly one assistant reply after the user message', async () => {
      // Arrange: model call 1 streams 'Частичный' and hangs until its abortSignal fires; call 2 answers 'Ответ 2'.
      const cutOff = partialTextUntilAbortStep('Частичный');
      const t = await startApp(cutOff.step, textStep('Ответ 2'));
      const user = t.user();
      const threadId = await seedThread(t.memory, user);
      const question = clientUserMessage('Вопрос');
      await t.app.listen(0, '127.0.0.1');
      const baseUrl = await t.app.getUrl();
      const history = async () => {
        const res = await t.http
          .get(`/api/threads/${threadId}/messages`)
          .set('x-user-id', user)
          .expect(200);
        return ThreadMessagesResponseSchema.parse(res.body).messages;
      };

      // Act 1: submit, then drop the connection after the partial text arrived.
      await chatAndDisconnect({
        baseUrl,
        userId: user,
        body: { id: threadId, trigger: 'submit-message', messages: [question] },
        marker: '"delta":"Частичный"',
      });
      // The server passed the disconnect to the model call (deterministic signal; gate G3 otherwise).
      expect(await settlesWithin(cutOff.aborted, 5_000)).toBe('settled');
      const rowsAfterDrop = await settledMessageCount(threadId);
      const afterDrop = await history();

      // Assert 1 (characterization): the stored state after the drop is the user
      // message and the partial reply - the state "discard the tail" must remove.
      expect(rowsAfterDrop).toBe(2);
      expect(roleAndTexts(afterDrop)).toEqual([
        ['user', ['Вопрос']],
        ['assistant', ['Частичный']],
      ]);
      const cutOffReply = afterDrop[1];

      // Act 2: regenerate — the same user message, without the cut-off reply.
      await t.http
        .post('/api/chat/assistant')
        .set('x-user-id', user)
        .send({
          id: threadId,
          trigger: 'regenerate-message',
          messageId: cutOffReply.id,
          messages: [question],
        })
        .expect(200);

      // Assert (AC-14.6, gate G3): exactly one assistant reply with only the new text.
      expect(roleAndTexts(await history())).toEqual([
        ['user', ['Вопрос']],
        ['assistant', ['Ответ 2']],
      ]);
      expect(await countMessages(threadId)).toBe(2);
    }, 20_000);
  });

  // ---------------------------------------------------------------------------
  // Verification Strategy, Certainty: low (not an AC) - characterization, run at plan step 3
  // ---------------------------------------------------------------------------
  // "История после regenerate/edit в assistant-ui: не остаются ли в mastra_messages реплики отброшенной ветки."
  // Outcome is recorded either way (limitation or follow-up task); the test pins the observed behaviour.
  // Related AC: AC-14.6 - branch (a) shows "discard the tail" also applies to a successful reply.
  // ROI: 4.6 | Business Value: 7 | Frequency: 4 | Defect detection: 6
  // Behavior: regenerate-style request (messages without the last assistant reply) -> stored history inspected
  // Primary failure mode: discarded-branch replies silently appear in /messages (affects AC-02.3 / AC-14.1).
  // @category: integration
  // @dependency: ChatController, Memory, PostgresStore, toAISdkMessages
  // @complexity: medium
  describe('Verification: regenerate/edit history (Certainty: low)', () => {
    it('characterizes /messages after a regenerate-style and an edit-style resend', async () => {
      // Arrange (adapted: seed instead of POST /api/threads, which arrives in T3.3).
      // Bodies mirror the AI SDK chat transport: client message ids, `trigger`, `messageId`.
      const t = await startApp(
        textStep('Ответ 1'),
        textStep('Ответ 2'),
        textStep('Ответ 3'),
      );
      const user = t.user();
      const threadId = await seedThread(t.memory, user);
      const question = clientUserMessage('Вопрос');
      const chat = (body: object) =>
        t.http
          .post('/api/chat/assistant')
          .set('x-user-id', user)
          .send({ id: threadId, ...body })
          .expect(200);
      const history = async () => {
        const res = await t.http
          .get(`/api/threads/${threadId}/messages`)
          .set('x-user-id', user)
          .expect(200);
        return ThreadMessagesResponseSchema.parse(res.body).messages;
      };
      await chat({ trigger: 'submit-message', messages: [question] });
      const [, firstReply] = await history();

      // Act (a): regenerate — the same user message, without the last assistant reply.
      await chat({
        trigger: 'regenerate-message',
        messageId: firstReply.id,
        messages: [question],
      });
      const afterRegenerate = await history();
      const rowsAfterRegenerate = await countMessages(threadId);

      // Act (b): edit — the user message replaced by an edited one (new client id).
      await chat({
        trigger: 'submit-message',
        messages: [clientUserMessage('Вопрос (изменён)')],
      });
      const afterEdit = await history();
      const rowsAfterEdit = await countMessages(threadId);

      // Assert: observed behaviour, pinned as literals.
      // (a) "Discard the tail" (AC-14.6) also applies to a successful reply: 'Ответ 1'
      //   is deleted and 'Ответ 2' is the only reply after the resent user message.
      expect(roleAndTexts(afterRegenerate)).toEqual([
        ['user', ['Вопрос']],
        ['assistant', ['Ответ 2']],
      ]);
      expect(rowsAfterRegenerate).toBe(2);
      // (b) An edit is an ordinary send (new id): nothing is deleted, the edited
      //   message and its reply are appended after the previous branch.
      expect(roleAndTexts(afterEdit)).toEqual([
        ['user', ['Вопрос']],
        ['assistant', ['Ответ 2']],
        ['user', ['Вопрос (изменён)']],
        ['assistant', ['Ответ 3']],
      ]);
      expect(rowsAfterEdit).toBe(4);
    });
  });
});
