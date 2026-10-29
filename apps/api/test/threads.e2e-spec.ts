// chat-shell / threads-api Integration Test - Design Doc: docs/features/chat-shell/design-threads-api.md (v1.4)
// Generated: 2026-10-28 | Part: threads-api | Test type: integration (HTTP + real Postgres, mock LLMs)
// File name follows the Design Doc Test Strategy ("threads.e2e-spec.ts"); picked up by vitest.config.e2e.ts
// (include '**/*.e2e-spec.ts') and run with `pnpm --filter api test:e2e`.
//
// Implemented cases + remaining `it.todo` for later tasks. Implement each todo following its Arrange/Act/Assert
// comments when its task lands. Do not convert a todo into a passing stub.
//
// Environment (Design Doc "Integration / E2E Tests"):
// - Postgres from infra/docker-compose.yml (`pnpm db:up`, postgres:16), DATABASE_URL from apps/api/.env.
// - No separate test DB: isolation by a unique `resourceId = 'e2e-' + randomUUID()` per test (sent as `x-user-id`).
// - afterAll removes the threads of every resourceId created in this file via ThreadsService / Memory.
// - Harness in test/support/ (to be created with the implementation):
//   createTestApp({ assistantModel, titleModel }) -> AppModule with MASTRA overridden (agent 'assistant',
//   Memory({ options: { lastMessages: 20 } }), PostgresStore(DATABASE_URL), MockLanguageModelV4) and
//   THREAD_TITLE_AGENT overridden with a mock model; configureApp(app); requests go to /api/...
//   mockModels.ts -> stream scenarios (text; reasoning + 2 tools, one throws; model error), title model scenarios.
//   seed.ts -> N threads with explicit updatedAt and M format-2 messages via Memory.saveThread / saveMessages.
// - No network: assistant and title models are mocks. SessionGuard is real (different `x-user-id` headers).
// - Response bodies are validated with the zod schemas from @agent-os/contracts
//   (ThreadListResponseSchema, ThreadSummarySchema, ThreadMessagesResponseSchema, ApiErrorSchema).

import { randomUUID } from 'node:crypto';
import {
  ApiErrorSchema,
  ThreadMessagesResponseSchema,
  ThreadSummarySchema,
  type HistoryMessage,
} from '@agent-os/contracts';
import {
  parseJsonEventStream,
  readUIMessageStream,
  safeValidateUIMessages,
  uiMessageChunkSchema,
  type UIMessage,
  type UIMessageChunk,
} from 'ai';
import request from 'supertest';
import { createTestApp, type TestApp } from './support/createTestApp.js';
import {
  assistantModel,
  reasoningWithToolsSteps,
  textStep,
  type AssistantStep,
} from './support/mockModels.js';
import { closeDb, rawMessageContents } from './support/db.js';
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

afterAll(async () => {
  await closeDb();
});

afterEach(async () => {
  for (const { testApp, users } of started.splice(0)) {
    try {
      await cleanupUsers(testApp.memory, users);
    } finally {
      await testApp.app.close();
    }
  }
});

/** One seeded thread without messages owned by `resourceId` (POST /api/threads arrives in T3.3). */
async function seedThread(
  memory: TestApp['memory'],
  resourceId: string,
  title?: string,
): Promise<string> {
  const { ids } = await seed(memory, {
    resourceId,
    threads: [{ updatedAt: new Date('2026-01-01T10:00:00.000Z'), title }],
  });
  const id = ids.get(1);
  if (!id) throw new Error('seed returned no thread id');
  return id;
}

function userMessage(text: string) {
  return { role: 'user', parts: [{ type: 'text', text }] };
}

/** Concatenated `text` of the message's text parts. */
function textOf(message: HistoryMessage): string {
  return message.parts
    .filter((part) => part.type === 'text')
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('');
}

/**
 * The assistant `UIMessage` the client assembles from the SSE body of
 * `POST /api/chat/:agentId` (what the user saw live), via `readUIMessageStream`.
 */
async function liveMessageFrom(sse: string): Promise<UIMessage> {
  const body = new Response(sse).body;
  if (!body) throw new Error('chat response has no body');
  const parsed = parseJsonEventStream({
    stream: body,
    schema: uiMessageChunkSchema,
  });
  type ParsedChunk = typeof parsed extends ReadableStream<infer R> ? R : never;
  const chunks = parsed.pipeThrough(
    new TransformStream<ParsedChunk, UIMessageChunk>({
      transform(result, controller) {
        if (!result.success) throw result.error;
        controller.enqueue(result.value);
      },
    }),
  );
  let last: UIMessage | undefined;
  for await (const message of readUIMessageStream({ stream: chunks })) {
    last = message;
  }
  if (!last) throw new Error('SSE stream produced no UIMessage');
  return last;
}

/** Recursively drops every `providerMetadata` field (excluded by Output Comparison). */
function withoutProviderMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutProviderMetadata);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== 'providerMetadata')
      .map(([key, field]) => [key, withoutProviderMetadata(field)]),
  );
}

/** `type` of every part except `step-start`, in order. */
function partTypes(message: HistoryMessage | UIMessage): string[] {
  return message.parts
    .map((part) => part.type)
    .filter((type) => type !== 'step-start');
}

/** Fields of a part excluded by Output Comparison besides `providerMetadata`. */
function withoutExcludedFields(part: object): object {
  const type = 'type' in part ? part.type : undefined;
  return Object.fromEntries(
    Object.entries(part).filter(
      ([key]) =>
        !(type === 'reasoning' && key === 'id') &&
        !(type === 'text' && key === 'state'),
    ),
  );
}

/**
 * Output Comparison normalisation (Design Doc): `id`, `role` and the parts
 * without `step-start`, every `providerMetadata` field removed, `id` of
 * `reasoning` parts and `state` of `text` parts removed; all other fields kept
 * for a field-by-field comparison.
 */
function comparable(message: HistoryMessage | UIMessage): unknown {
  return withoutProviderMetadata({
    id: message.id,
    role: message.role,
    parts: message.parts
      .filter((part) => part.type !== 'step-start')
      .map(withoutExcludedFields),
  });
}

const NOT_FOUND_BODY = {
  message: 'Thread not found',
  error: 'Not Found',
  statusCode: 404,
  errorCode: 'THREAD_NOT_FOUND',
};

describe('Threads API (integration, real Postgres)', () => {
  // ---------------------------------------------------------------------------
  // FR-13 List of threads
  // ---------------------------------------------------------------------------
  describe('GET /api/threads', () => {
    // AC-13.1: "When пользователь A запрашивает GET /api/threads, the system shall вернуть только беседы с
    //   resourceId = A, отсортированные по updatedAt по убыванию (при равенстве — по id по убыванию)."
    // EARS: When -> event-driven
    // ROI: 8.8 | Business Value: 9 (core sidebar + IDOR) | Frequency: 10 | Defect detection: 7
    // Behavior: A requests the list -> SQL filter by resourceId + ordering -> exactly A's 3 threads, newest first
    // Primary failure mode: list leaks B's threads (missing resourceId filter) or returns wrong order.
    // @category: core-functionality
    // @dependency: SessionGuard, ThreadsController, ThreadsService, Memory, PostgresStore
    // @complexity: medium
    it.todo(
      "AC-13.1: returns only the caller's 3 threads ordered by updatedAt DESC",
      () => {
        // Arrange: userA = 'e2e-'+uuid, userB = 'e2e-'+uuid.
        //   seed A: 'a-1' (updatedAt 2026-01-01T10:00:00.000Z), 'a-2' (2026-01-03T10:00:00.000Z), 'a-3' (2026-01-02T10:00:00.000Z)
        //   seed B: 'b-1' (2026-01-05T10:00:00.000Z), 'b-2' (2026-01-04T10:00:00.000Z)
        //   (prefix ids with a per-test suffix to stay unique across runs)
        // Act: GET /api/threads with x-user-id: userA
        // Assert: 200; body passes ThreadListResponseSchema;
        //   threads.map(t => t.id) toEqual ['a-2', 'a-3', 'a-1'] (literal order); no 'b-*' id present;
        //   nextCursor === null
      },
    );

    // AC-13.2: "When у пользователя 120 бесед и он последовательно запрашивает страницы, передавая nextCursor
    //   предыдущего ответа, the system shall вернуть 6 страниц по 20 бесед, объединение которых содержит все 120 id
    //   без повторов; на последней странице nextCursor = null."
    // EARS: When -> event-driven
    // ROI: 8.4 | Business Value: 9 | Frequency: 8 (users with > 20 threads) | Defect detection: 9 (off-by-one, dupes)
    // Behavior: walk pages by nextCursor -> keyset pagination -> 6x20 unique ids, last nextCursor null
    // Primary failure mode: duplicate or skipped thread at a page boundary; non-null cursor after the last page.
    // @category: core-functionality
    // @dependency: ThreadsService.list, thread-cursor, PostgresStore
    // @complexity: medium
    it.todo(
      'AC-13.2: 120 threads are returned as 6 pages of 20 with no duplicates and nextCursor null at the end',
      () => {
        // Arrange: user = 'e2e-'+uuid; seed 120 threads 't-001'..'t-120' with distinct updatedAt
        //   (t-001 newest, each next 1 minute older)
        // Act: GET /api/threads (no cursor), then GET /api/threads?cursor=<nextCursor> until nextCursor === null
        // Assert: exactly 6 requests; each page threads.length === 20;
        //   page 1 ids === 't-001'..'t-020', page 6 ids === 't-101'..'t-120' (literal);
        //   union of ids has size 120 and equals the seeded set; pages 1..5 nextCursor is a non-empty string;
        //   page 6 nextCursor === null
      },
    );

    // AC-13.2a: "If между запросами страниц беседа была удалена или поднялась в начало списка, then the system shall
    //   продолжить выдачу со следующей за курсором позиции; беседа, поднятая или созданная во время обхода, не
    //   возвращается в последующих страницах этого обхода; каждая другая беседа, существовавшая к началу обхода и ещё
    //   не выданная, возвращается ровно один раз (удалённая — не возвращается); ни одна беседа не возвращается дважды."
    // EARS: If-then -> branch (mutation during traversal)
    // ROI: 7.9 | Business Value: 8 (sidebar consistency, D-11) | Frequency: 7 (rename/auto-title during scroll) | Defect detection: 10
    // Behavior: delete + raise between pages 2 and 3 -> cursor continues from position -> no dupes, raised thread excluded
    // Primary failure mode: the raised thread is returned again on a later page (duplicate), or a thread is skipped
    //   because the cursor is positional (offset) rather than keyset.
    // @category: edge-case
    // @dependency: ThreadsService.list, ThreadsService.delete, ThreadsService.rename, thread-cursor, PostgresStore
    // @complexity: high
    it.todo(
      'AC-13.2a: deleting a page-1 thread and raising a page-5 thread between pages 2 and 3 yields 119 unique ids with no duplicates',
      () => {
        // Arrange: user = 'e2e-'+uuid; seed 120 threads 't-001'..'t-120' (t-001 newest, distinct updatedAt).
        //   deletedId = 't-005' (page 1), raisedId = 't-085' (page 5, positions 81..100)
        // Act: page1 = GET /api/threads; page2 = GET ?cursor=page1.nextCursor;
        //   DELETE /api/threads/t-005 (204); PATCH /api/threads/t-085 { title: 'Поднятая' } (200, updatedAt = now());
        //   page3..page6 = GET ?cursor=<previous nextCursor> until nextCursor === null
        // Assert (literal):
        //   - exactly 6 pages in the traversal
        //   - raisedId 't-085' is absent from pages 3..6
        //   - union of ids of pages 1..6 has size 119 = all 120 except 't-085'; no id appears twice
        //   - deletedId 't-005' appears only on page 1 (served before deletion) and not on pages 3..6
        //   - pages 3..6 together contain exactly 79 ids = original positions 41..120 minus 't-085'
        //   - page 6 has 19 items and nextCursor === null
        //   - a fresh GET /api/threads (no cursor) returns 't-085' as threads[0] with title 'Поднятая'
      },
    );

    // Contract error (Contract Definitions: GET /api/threads -> 400 INVALID_CURSOR); supports AC-13.2 cursor handling.
    // ROI: 3.5 | Business Value: 4 | Frequency: 2 | Defect detection: 6
    // Behavior: tampered cursor -> decodeThreadCursor rejects -> 400 INVALID_CURSOR (not 500)
    // Primary failure mode: unparsable cursor reaches storage and returns 500.
    // @category: edge-case
    // @dependency: ZodValidationPipe, thread-cursor
    // @complexity: low
    it.todo('rejects an unparsable cursor with 400 INVALID_CURSOR', () => {
      // Arrange: user = 'e2e-'+uuid
      // Act: GET /api/threads?cursor=not-a-cursor
      // Assert: 400; body passes ApiErrorSchema; body.errorCode === 'INVALID_CURSOR'
    });
  });

  // ---------------------------------------------------------------------------
  // AC-13.3 Production guard on all six routes
  // ---------------------------------------------------------------------------
  // AC-13.3: "While NODE_ENV=production, the system shall отвечать 401 на любой из шести маршрутов /api/threads*."
  // EARS: While -> state condition
  // ROI: 6.5 | Business Value: 8 (security) | Frequency: 5 | Legal/security: n/a | Defect detection: 7
  // Behavior: app in production mode -> SessionGuard -> 401 on every threads route
  // Primary failure mode: a route is added without @UseGuards(SessionGuard) and is reachable unauthenticated.
  // @category: core-functionality
  // @dependency: SessionGuard, ConfigService (NODE_ENV override), ThreadsController
  // @complexity: low
  describe('AC-13.3 production mode', () => {
    it.todo(
      'AC-13.3: every /api/threads* route answers 401 when NODE_ENV=production',
      () => {
        // Arrange: createTestApp with ConfigService overridden so get('NODE_ENV') === 'production';
        //   request header x-user-id: 'e2e-'+uuid (must be ignored)
        // Act: for each route:
        //   GET /api/threads, POST /api/threads, GET /api/threads/any-id, GET /api/threads/any-id/messages,
        //   PATCH /api/threads/any-id { title: 'x' }, DELETE /api/threads/any-id
        // Assert: each response status === 401 (6 of 6)
      },
    );
  });

  // ---------------------------------------------------------------------------
  // POST /api/threads (explicit creation, Design Element 1; precondition of AC-16.1)
  // ---------------------------------------------------------------------------
  // Design Doc Test Strategy: "POST /api/threads -> 201, title: null, id формата UUID, появляется в списке первой."
  // ROI: 8.2 | Business Value: 9 (only way to create a thread) | Frequency: 10 | Defect detection: 6
  // Behavior: create -> server UUID + empty title -> appears first in the list
  // Primary failure mode: client-provided id is honoured, or the new thread is not first in the list.
  // @category: core-functionality
  // @dependency: ThreadsController, ThreadsService.create, PostgresStore
  // @complexity: low
  describe('POST /api/threads', () => {
    it.todo(
      'creates a thread with a server UUID and title null that is listed first',
      () => {
        // Arrange: user = 'e2e-'+uuid; seed one older thread 'old-1' (updatedAt 2026-01-01T00:00:00.000Z)
        // Act: POST /api/threads with body { id: 'client-id' } (body must be ignored)
        // Assert: 201; body passes ThreadSummarySchema; body.title === null;
        //   body.id matches /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/ and !== 'client-id';
        //   body.createdAt === body.updatedAt; GET /api/threads -> threads[0].id === body.id, threads[1].id === 'old-1'
      },
    );
  });

  // ---------------------------------------------------------------------------
  // FR-14 Messages of a thread
  // ---------------------------------------------------------------------------
  describe('GET /api/threads/:threadId/messages', () => {
    // AC-14.1: "When запрошены GET /api/threads/:threadId/messages своей беседы из 12 сообщений, записанных через
    //   POST /api/chat/:agentId, the system shall вернуть все 12 в хронологическом порядке как AI SDK v7 UIMessage
    //   (роль, части text, reasoning с state: "done", tool-<name> с input, output или errorText и state), проходящие
    //   safeValidateUIMessages из ai."
    // EARS: When -> event-driven
    // ROI: 8.5 | Business Value: 10 (history restore, core of FR-02/FR-14) | Frequency: 9 | Defect detection: 9
    // Behavior: 6 chat exchanges via POST /api/chat -> Memory persists -> recall + toAISdkMessages(v7) -> 12 UIMessages
    // Primary failure mode: reasoning or tool parts lost/reshaped in conversion; wrong order; lastMessages(20) cap applied.
    // @category: core-functionality
    // @dependency: ChatController, Mastra agent 'assistant' (MockLanguageModelV4), Memory, PostgresStore, toAISdkMessages
    // @complexity: high
    it('AC-14.1: returns all 12 messages oldest-first as valid v7 UIMessages with reasoning and tool parts', async () => {
      // Arrange (adapted: seed instead of POST /api/threads, which arrives in T3.3).
      // Exchange 3 is the "reasoning + tools" scenario (two model calls), the rest are plain text.
      const prompts = [
        'Вопрос 1',
        'Вопрос 2',
        'Какая погода в Казани?',
        'Вопрос 4',
        'Вопрос 5',
        'Вопрос 6',
      ];
      const t = await startApp(
        textStep('Ответ 1'),
        textStep('Ответ 2'),
        ...reasoningWithToolsSteps({
          reasoning: 'Нужно узнать погоду и проверить второй инструмент.',
          city: 'Казань',
          finalText: 'В Казани солнечно, +21.',
        }),
        textStep('Ответ 4'),
        textStep('Ответ 5'),
        textStep('Ответ 6'),
      );
      const user = t.user();
      const threadId = await seedThread(t.memory, user);
      for (const prompt of prompts) {
        await t.http
          .post('/api/chat/assistant')
          .set('x-user-id', user)
          .send({ id: threadId, messages: [userMessage(prompt)] })
          .expect(200);
      }

      // Act
      const res = await t.http
        .get(`/api/threads/${threadId}/messages`)
        .set('x-user-id', user);

      // Assert
      expect(res.status).toBe(200);
      const { messages } = ThreadMessagesResponseSchema.parse(res.body);
      expect(messages).toHaveLength(12);
      expect(messages.map((m) => m.role)).toEqual([
        'user',
        'assistant',
        'user',
        'assistant',
        'user',
        'assistant',
        'user',
        'assistant',
        'user',
        'assistant',
        'user',
        'assistant',
      ]);
      expect(messages.filter((m) => m.role === 'user').map(textOf)).toEqual(
        prompts,
      );
      expect(
        messages.filter((m) => m.role === 'assistant').map(textOf),
      ).toEqual([
        'Ответ 1',
        'Ответ 2',
        'В Казани солнечно, +21.',
        'Ответ 4',
        'Ответ 5',
        'Ответ 6',
      ]);
      expect((await safeValidateUIMessages({ messages })).success).toBe(true);
      const toolsReply = messages[5].parts;
      expect(toolsReply).toContainEqual(
        expect.objectContaining({
          type: 'reasoning',
          state: 'done',
          text: 'Нужно узнать погоду и проверить второй инструмент.',
        }),
      );
      expect(toolsReply).toContainEqual(
        expect.objectContaining({
          type: 'tool-getWeather',
          state: 'output-available',
          input: { city: 'Казань' },
          output: { city: 'Казань', temperatureC: 21, conditions: 'sunny' },
        }),
      );
      expect(toolsReply).toContainEqual(
        expect.objectContaining({
          type: 'tool-failing',
          state: 'output-error',
          input: {},
          errorText: 'Agent error',
        }),
      );
      expect(new Set(messages.map((m) => m.id)).size).toBe(12);
    });

    // Additional case outside the skeleton (work plan T2.2, failure mode "empty input").
    it('returns { messages: [] } for an existing thread without messages', async () => {
      // Arrange
      const t = await startApp();
      const user = t.user();
      const threadId = await seedThread(t.memory, user);

      // Act
      const res = await t.http
        .get(`/api/threads/${threadId}/messages`)
        .set('x-user-id', user);

      // Assert
      expect(res.status).toBe(200);
      expect(ThreadMessagesResponseSchema.parse(res.body)).toEqual({
        messages: [],
      });
    });

    // Verification Strategy (b) "живой стрим <-> история" (Output Comparison); supports AC-14.1 / PRD FR-14 "без потери"
    // and AC-14.5 (tool errorText masked identically in the stream and the history; raw text stays in storage only).
    // ROI: 6.9 | Business Value: 9 | Frequency: 9 | Defect detection: 8 (catches silent data loss vs live stream)
    // Behavior: SSE response read with readUIMessageStream -> compared field-by-field to /messages entry
    // Primary failure mode: history differs from what the user saw live (beyond step-start, providerMetadata,
    //   reasoning.id, text.state), or the raw tool error text leaks through the history.
    // @category: integration
    // @dependency: ChatController (SSE), toAISdkStream, toAISdkMessages
    // @complexity: high
    it('AC-14.1/AC-14.5 (output comparison): history equals the live v7 stream under the Output Comparison rule', async () => {
      // Arrange (adapted: seed instead of POST /api/threads, which arrives in T3.3).
      const t = await startApp(
        ...reasoningWithToolsSteps({
          reasoning: 'Нужно узнать погоду и проверить второй инструмент.',
          city: 'Казань',
          finalText: 'В Казани солнечно, +21.',
        }),
      );
      const user = t.user();
      const threadId = await seedThread(t.memory, user);

      // Act
      const chat = await t.http
        .post('/api/chat/assistant')
        .set('x-user-id', user)
        .send({
          id: threadId,
          messages: [userMessage('Какая погода в Казани?')],
        })
        .expect(200);
      const live = await liveMessageFrom(chat.text);
      const res = await t.http
        .get(`/api/threads/${threadId}/messages`)
        .set('x-user-id', user)
        .expect(200);

      // Assert
      const { messages } = ThreadMessagesResponseSchema.parse(res.body);
      expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
      expect(partTypes(live)).toEqual([
        'reasoning',
        'tool-getWeather',
        'tool-failing',
        'text',
      ]);
      expect(partTypes(messages[1])).toEqual(partTypes(live));
      expect(comparable(messages[1])).toEqual(comparable(live));
      const failingPart = (message: HistoryMessage | UIMessage) =>
        message.parts.find((part) => part.type === 'tool-failing');
      expect(failingPart(live)).toMatchObject({ errorText: 'Agent error' });
      expect(failingPart(messages[1])).toMatchObject({
        errorText: 'Agent error',
      });
      // The raw tool error stays in storage only: the history masks it, it is not lost.
      const stored = (await rawMessageContents(threadId)).join('\n');
      expect(stored).toContain('"errorText":"boom"');
      expect(res.text).not.toContain('boom');
    });
  });

  // ---------------------------------------------------------------------------
  // FR-15 Rename
  // ---------------------------------------------------------------------------
  describe('PATCH /api/threads/:threadId', () => {
    // AC-15.1: "When PATCH /api/threads/:threadId с title, у которого после обрезки пробелов 1…200 символов, the system
    //   shall сохранить обрезанный заголовок, вернуть ThreadSummary с ним, и последующий список вернёт его же."
    // EARS: When -> event-driven
    // ROI: 7.1 | Business Value: 7 | Frequency: 6 | Defect detection: 7
    // Behavior: PATCH padded title -> trim -> persisted -> response and list show trimmed title
    // Primary failure mode: untrimmed title persisted, or response differs from what the list returns.
    // @category: core-functionality
    // @dependency: ZodValidationPipe, ThreadsService.rename, ThreadWriteLock, PostgresStore
    // @complexity: low
    it.todo(
      'AC-15.1: saves the trimmed title and returns it in the response and the list',
      () => {
        // Arrange: user = 'e2e-'+uuid; POST /api/threads -> threadId
        // Act: PATCH /api/threads/:threadId { title: '  Отчёт Q3  ' }
        // Assert: 200; body passes ThreadSummarySchema; body.title === 'Отчёт Q3';
        //   GET /api/threads -> thread with id threadId has title 'Отчёт Q3';
        //   PATCH with title 'a'.repeat(200) -> 200 and title.length === 200 (upper boundary accepted)
      },
    );

    // AC-15.2: "If title отсутствует, пустой, состоит из пробелов или длиннее 200 символов после обрезки, then the system
    //   shall ответить 400 VALIDATION_FAILED с описанием ошибки и не менять беседу."
    // EARS: If-then -> branch (each invalid input)
    // ROI: 5.6 | Business Value: 6 | Frequency: 3 | Defect detection: 8 (boundary 200/201)
    // Behavior: invalid title -> ZodValidationPipe -> 400 VALIDATION_FAILED, title unchanged
    // Primary failure mode: whitespace-only or 201-char title accepted, or thread modified despite 400.
    // @category: edge-case
    // @dependency: ZodValidationPipe, RenameThreadRequestSchema
    // @complexity: low
    it.todo(
      'AC-15.2: missing, empty, whitespace-only and 201-char titles are rejected with 400 VALIDATION_FAILED and the title is unchanged',
      () => {
        // Arrange: user = 'e2e-'+uuid; POST /api/threads -> threadId; PATCH { title: 'Исходный' } -> 200
        // Act: PATCH /api/threads/:threadId with each body: {}, { title: '' }, { title: '   ' }, { title: 'a'.repeat(201) }
        // Assert: each -> 400; body passes ApiErrorSchema; body.errorCode === 'VALIDATION_FAILED';
        //   body.message is a non-empty string[] mentioning 'title';
        //   afterwards GET /api/threads/:threadId -> title === 'Исходный'
      },
    );
  });

  // ---------------------------------------------------------------------------
  // FR-16 Delete
  // ---------------------------------------------------------------------------
  describe('DELETE /api/threads/:threadId', () => {
    // AC-16.1 (threads part): "When пользователь удалил свою беседу (DELETE -> 204), the system shall не возвращать её
    //   в списке, отвечать 404 на GET /api/threads/:id, GET /api/threads/:id/messages ..."
    //   (the POST /api/chat/:agentId branch of AC-16.1 is in chat-threads.e2e-spec.ts)
    // AC-16.3: "When беседа удаляется повторно, the system shall ответить 404 (не 500)."
    // EARS: When -> event-driven
    // ROI: 8.0 | Business Value: 9 (data deletion, privacy) | Frequency: 7 | Defect detection: 9 (cascade to messages)
    // Behavior: DELETE -> PostgresStore.deleteThread (thread + messages, one transaction) -> gone everywhere
    // Primary failure mode: messages left orphaned in mastra_messages; or second DELETE returns 500.
    // @category: core-functionality
    // @dependency: ThreadsService.delete, PostgresStore, pg client on DATABASE_URL
    // @complexity: medium
    it.todo(
      'AC-16.1/AC-16.3: deleted thread disappears from the list, its routes answer 404, its messages are gone and a second DELETE is 404',
      () => {
        // Arrange: user = 'e2e-'+uuid; POST /api/threads -> threadId; one exchange via POST /api/chat/assistant
        //   (2 messages stored); seed a second thread 'keep-1' for the same user
        // Act: DELETE /api/threads/:threadId
        // Assert: 204 with empty body;
        //   GET /api/threads -> ids do not contain threadId and contain 'keep-1';
        //   GET /api/threads/:threadId -> 404, errorCode 'THREAD_NOT_FOUND';
        //   GET /api/threads/:threadId/messages -> 404, errorCode 'THREAD_NOT_FOUND';
        //   pg: SELECT count(*) FROM mastra_messages WHERE thread_id = $1 [threadId] -> 0;
        //   second DELETE /api/threads/:threadId -> 404, errorCode 'THREAD_NOT_FOUND' (not 500)
      },
    );
  });

  // ---------------------------------------------------------------------------
  // Ownership / IDOR: AC-14.2, AC-14.3, AC-15.3, AC-16.2 (PRD NFR "Нет IDOR": two x-user-id for every endpoint)
  // ---------------------------------------------------------------------------
  // AC-14.2: "If беседа принадлежит другому пользователю, then the system shall ответить 404 THREAD_NOT_FOUND."
  // AC-14.3: "If беседы с таким id нет, then the system shall ответить 404 THREAD_NOT_FOUND (тело идентично AC-14.2)."
  // AC-15.3: "If беседа чужая или отсутствует, then the system shall ответить 404 THREAD_NOT_FOUND, заголовок не изменится."
  // AC-16.2: "If беседа чужая, then the system shall ответить 404 и не удалять её."
  // EARS: If-then -> branch (foreign vs missing must be indistinguishable)
  // ROI: 9.0 | Business Value: 10 (security, data isolation) | Frequency: 9 (guards every request) | Defect detection: 9
  // Behavior: B targets A's thread -> getOwnedThread (resourceId SQL filter) -> 404 identical to a missing id; A's data intact
  // Primary failure mode: a route calls recall/updateThread/deleteThread without the ownership check (IDOR),
  //   or the foreign-thread body differs from the missing-thread body (existence leak).
  // @category: core-functionality
  // @dependency: SessionGuard, ThreadsService.getOwnedThread, PostgresStore
  // @complexity: medium
  describe('Ownership isolation (IDOR)', () => {
    // Shared Arrange for each case (per test, no shared state): userA, userB = 'e2e-'+uuid;
    //   A: POST /api/threads -> threadA; PATCH { title: 'Секрет A' }; one chat exchange (2 messages);
    //   missingId = 'e2e-missing-' + uuid

    it('AC-14.2/AC-14.3: GET /api/threads/:id and /messages of a foreign thread answer the same 404 body as a missing id', async () => {
      // Arrange (adapted: seed with title 'Секрет A' instead of POST + PATCH /api/threads, which arrive in T3.3/T3.4)
      const t = await startApp(textStep('Ответ A'));
      const userA = t.user();
      const userB = t.user();
      const threadA = await seedThread(t.memory, userA, 'Секрет A');
      await t.http
        .post('/api/chat/assistant')
        .set('x-user-id', userA)
        .send({ id: threadA, messages: [userMessage('Привет от A')] })
        .expect(200);
      const missingId = `e2e-missing-${randomUUID()}`;

      // Act
      const asB = (path: string) => t.http.get(path).set('x-user-id', userB);
      const foreignThread = await asB(`/api/threads/${threadA}`);
      const foreignMessages = await asB(`/api/threads/${threadA}/messages`);
      const missingThread = await asB(`/api/threads/${missingId}`);
      const missingMessages = await asB(`/api/threads/${missingId}/messages`);

      // Assert
      for (const res of [
        foreignThread,
        foreignMessages,
        missingThread,
        missingMessages,
      ]) {
        expect(res.status).toBe(404);
        expect(ApiErrorSchema.parse(res.body)).toEqual(NOT_FOUND_BODY);
        expect(res.text).not.toContain('Секрет A');
      }
      expect(foreignThread.text).toBe(missingThread.text);
      expect(foreignMessages.text).toBe(missingMessages.text);

      // Act (owner check): A's thread is intact and still readable by its owner.
      const ownThread = await t.http
        .get(`/api/threads/${threadA}`)
        .set('x-user-id', userA)
        .expect(200);
      expect(ThreadSummarySchema.parse(ownThread.body)).toMatchObject({
        id: threadA,
        title: 'Секрет A',
      });
      const ownMessages = await t.http
        .get(`/api/threads/${threadA}/messages`)
        .set('x-user-id', userA)
        .expect(200);
      expect(
        ThreadMessagesResponseSchema.parse(ownMessages.body).messages,
      ).toHaveLength(2);
    });

    it.todo(
      'AC-15.3: PATCH of a foreign or missing thread answers 404 THREAD_NOT_FOUND and the title is unchanged',
      () => {
        // Act: as B: PATCH /api/threads/{threadA} { title: 'Взлом' }; PATCH /api/threads/{missingId} { title: 'Взлом' }
        // Assert: both 404 with identical bodies, errorCode 'THREAD_NOT_FOUND';
        //   as A: GET /api/threads/{threadA} -> title === 'Секрет A'
      },
    );

    it.todo(
      'AC-16.2: DELETE of a foreign thread answers 404 and the thread and its messages remain',
      () => {
        // Act: as B: DELETE /api/threads/{threadA}; DELETE /api/threads/{missingId}
        // Assert: both 404 with identical bodies, errorCode 'THREAD_NOT_FOUND';
        //   as A: GET /api/threads/{threadA} -> 200; GET /api/threads/{threadA}/messages -> messages.length === 2;
        //   as B: GET /api/threads -> threads === []
      },
    );
  });
});
