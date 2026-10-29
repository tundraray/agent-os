// chat-shell / threads-api Integration Test - Design Doc: docs/features/chat-shell/design-threads-api.md (v1.8)
// Generated: 2026-10-28 | Part: threads-api | Test type: integration (HTTP + real Postgres, mock LLMs)
// Scope: POST /api/chat/:agentId accepting only existing own threads (AC-16.1 chosen variant "404"), the
// auto-title step after the assistant reply (FR-17), regenerate after a model error or a client disconnect
// (AC-14.6) and the regenerate/edit history characterization. File name per Design Doc Test Strategy
// ("chat-threads.e2e-spec.ts").
//
// Status: the AC-14.6 cases and the characterization are implemented; the AC-16.1, ownership and FR-17 cases
// are still `it.todo` (implemented in later tasks following their Arrange/Act/Assert comments).
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
import { setTimeout as delay } from 'node:timers/promises';
import {
  ThreadMessagesResponseSchema,
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
  type AssistantStep,
} from './support/mockModels.js';
import { cleanupUsers, newUser, seed } from './support/seed.js';

// Apps started by the current test; afterEach removes their users' threads and closes them.
const started: { testApp: TestApp; users: Set<string> }[] = [];

/** Boots the app with the given scripted assistant replies; `user()` registers a user for cleanup. */
async function startApp(...steps: AssistantStep[]) {
  const testApp = await createTestApp({
    assistantModel: assistantModel(...steps),
  });
  const users = new Set<string>();
  started.push({ testApp, users });
  const user = (): string => {
    const id = newUser();
    users.add(id);
    return id;
  };
  return { ...testApp, http: request(testApp.app.getHttpServer()), user };
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
    it.todo(
      'AC-16.1: chat into a deleted thread answers 404 THREAD_NOT_FOUND before streaming and does not recreate it',
      () => {
        // Arrange: user = 'e2e-'+uuid; POST /api/threads -> threadId; one exchange via POST /api/chat/assistant (200);
        //   DELETE /api/threads/:threadId -> 204
        // Act: POST /api/chat/assistant { id: threadId, messages: [{ role: 'user', parts: [{ type: 'text', text: 'Снова привет' }] }] }
        // Assert: 404; content-type is JSON (not text/event-stream); body.errorCode === 'THREAD_NOT_FOUND';
        //   GET /api/threads -> ids do not contain threadId;
        //   memory.getThreadById({ threadId, resourceId: user }) resolves null;
        //   assistant mock model doGenerate/doStream call count unchanged by the 404 request (0 new calls)
      },
    );
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
    it.todo('own thread: 200 SSE and both messages are persisted', () => {
      // Arrange: user = 'e2e-'+uuid; POST /api/threads -> threadId; assistant mock replies 'Привет! Чем помочь?'
      // Act: POST /api/chat/assistant { id: threadId, messages: [user 'Привет'] }
      // Assert: 200; content-type starts with 'text/event-stream'; stream completes;
      //   GET /api/threads/:threadId/messages -> 2 messages: user text 'Привет', assistant text 'Привет! Чем помочь?'
    });

    it.todo(
      'foreign thread and unknown client id both answer 404 THREAD_NOT_FOUND and nothing is written',
      () => {
        // Arrange: userA, userB = 'e2e-'+uuid; as A: POST /api/threads -> threadA; unknownId = 'client-' + uuid
        // Act: as B: POST /api/chat/assistant { id: threadA, messages: [user 'Чужое'] };
        //   as B: POST /api/chat/assistant { id: unknownId, messages: [user 'Новое'] }
        // Assert: both 404 (foreign previously 500) with errorCode 'THREAD_NOT_FOUND' and identical bodies;
        //   as A: GET /api/threads/{threadA}/messages -> messages === [];
        //   as B: GET /api/threads -> threads === []; memory.getThreadById({ threadId: unknownId, resourceId: userB }) -> null
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
    it.todo(
      'AC-17.1: an untitled thread gets the generated title within 10 s from the first user message',
      () => {
        // Arrange: user = 'e2e-'+uuid; POST /api/threads -> threadId (title null);
        //   title mock returns 'План отпуска на Байкал'
        // Act: POST /api/chat/assistant { id: threadId, messages: [user 'Помоги составить план отпуска на Байкал в июле'] };
        //   consume the stream to completion; poll GET /api/threads/:threadId every 100 ms up to 10 000 ms
        // Assert: title === 'План отпуска на Байкал' within 10 000 ms; title.length <= 80; no '\n'; no surrounding quotes;
        //   title !== 'Помоги составить план отпуска на Байкал в июле';
        //   the title mock received a prompt containing the literal 'Помоги составить план отпуска на Байкал в июле'
      },
    );

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
    it.todo(
      'AC-17.2: a manually titled thread keeps its title and the title model is not called',
      () => {
        // Arrange: user = 'e2e-'+uuid; POST /api/threads -> threadId; PATCH { title: 'Отчёт Q3' } -> 200;
        //   reset title mock call count
        // Act: POST /api/chat/assistant { id: threadId, messages: [user 'Сделай сводку'] }; consume the stream;
        //   wait 1 000 ms for any background work
        // Assert: GET /api/threads/:threadId -> title === 'Отчёт Q3'; title mock call count === 0
      },
    );

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
    it.todo(
      'AC-17.3: a failing title model leaves title null and logs a warning; the next reply retries from the first stored message',
      () => {
        // Arrange: user = 'e2e-'+uuid; POST /api/threads -> threadId; title mock throws an Error;
        //   spy on Logger.prototype.warn; assistant mock replies 'Готово'
        // Act 1: POST /api/chat/assistant { id: threadId, messages: [user 'Помоги составить план отпуска на Байкал в июле'] };
        //   consume the stream; wait until the title mock was called once (poll 100 ms, max 10 000 ms)
        // Assert 1: chat status 200 and the stream completed; GET /messages -> 2 messages (user + assistant 'Готово');
        //   GET /api/threads/:threadId -> title === null;
        //   warn called with a string starting 'Title generation failed thread=' + threadId and containing 'reason=';
        //   the warn string contains neither the error message nor the user text
        // Act 2: switch the title mock to success 'План отпуска на Байкал';
        //   POST /api/chat/assistant { id: threadId, messages: [ONLY the new user message 'А что взять с собой?'] }
        //   (no history in body.messages); consume the stream; poll GET /api/threads/:threadId (100 ms, max 10 000 ms)
        // Assert 2: title === 'План отпуска на Байкал';
        //   the title mock's second prompt contains 'Помоги составить план отпуска на Байкал в июле'
        //   and does not contain 'А что взять с собой?'; GET /messages -> 4 messages
      },
    );
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
