// chat-shell / threads-api Integration Test - Design Doc: docs/features/chat-shell/design-threads-api.md (v1.8)
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
  ThreadListResponseSchema,
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
import { ConfigService } from '@nestjs/config';
import request from 'supertest';
import { createTestApp, type TestApp } from './support/createTestApp.js';
import {
  assistantModel,
  reasoningWithToolsSteps,
  textStep,
  type AssistantStep,
} from './support/mockModels.js';
import { closeDb, countMessages, rawMessageContents } from './support/db.js';
import {
  cleanupUsers,
  descendingDates,
  newUser,
  seed,
  seededThreadId,
} from './support/seed.js';

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

/** One seeded thread without messages owned by `resourceId`, updatedAt 2026-01-01T10:00:00.000Z. */
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

/**
 * Ownership shared Arrange: `userId` creates a thread via POST, renames it to
 * 'Секрет A' via PATCH and has one chat exchange (2 messages). Needs an app
 * started with one scripted assistant reply.
 */
async function createOwnedThread(
  t: Awaited<ReturnType<typeof startApp>>,
  userId: string,
): Promise<string> {
  const created = await t.http
    .post('/api/threads')
    .set('x-user-id', userId)
    .expect(201);
  const threadId = ThreadSummarySchema.parse(created.body).id;
  await t.http
    .patch(`/api/threads/${threadId}`)
    .set('x-user-id', userId)
    .send({ title: 'Секрет A' })
    .expect(200);
  await t.http
    .post('/api/chat/assistant')
    .set('x-user-id', userId)
    .send({ id: threadId, messages: [userMessage('Привет от A')] })
    .expect(200);
  return threadId;
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
    it("AC-13.1: returns only the caller's 3 threads ordered by updatedAt DESC", async () => {
      // Arrange (adapted: seed ids are `${prefix}-t-<n>`; a-1..a-3 = A's t-001..t-003, b-1..b-2 = B's t-001..t-002)
      const t = await startApp();
      const userA = t.user();
      const userB = t.user();
      const a = await seed(t.memory, {
        resourceId: userA,
        threads: [
          { updatedAt: new Date('2026-01-01T10:00:00.000Z') },
          { updatedAt: new Date('2026-01-03T10:00:00.000Z') },
          { updatedAt: new Date('2026-01-02T10:00:00.000Z') },
        ],
      });
      const b = await seed(t.memory, {
        resourceId: userB,
        threads: [
          { updatedAt: new Date('2026-01-05T10:00:00.000Z') },
          { updatedAt: new Date('2026-01-04T10:00:00.000Z') },
        ],
      });

      // Act
      const res = await t.http.get('/api/threads').set('x-user-id', userA);

      // Assert
      expect(res.status).toBe(200);
      const body = ThreadListResponseSchema.parse(res.body);
      expect(body.threads.map((thread) => thread.id)).toEqual([
        seededThreadId(a.prefix, 2),
        seededThreadId(a.prefix, 3),
        seededThreadId(a.prefix, 1),
      ]);
      expect(res.text).not.toContain(b.prefix);
      expect(body.nextCursor).toBeNull();
    });

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
    it('AC-13.2: 120 threads are returned as 6 pages of 20 with no duplicates and nextCursor null at the end', async () => {
      // Arrange: 120 threads `${prefix}-t-001`..`-t-120`, t-001 newest, each next 1 minute older
      const t = await startApp();
      const user = t.user();
      const { prefix } = await seed(t.memory, {
        resourceId: user,
        threads: descendingDates(120, new Date('2026-03-01T12:00:00.000Z')).map(
          (updatedAt) => ({ updatedAt }),
        ),
      });
      const idsFrom = (from: number, to: number) =>
        Array.from({ length: to - from + 1 }, (_, i) =>
          seededThreadId(prefix, from + i),
        );

      // Act: follow nextCursor until null (bounded, so a cursor loop fails instead of hanging)
      const pages: { ids: string[]; nextCursor: string | null }[] = [];
      let cursor: string | null = null;
      do {
        const req = t.http.get('/api/threads').set('x-user-id', user);
        const res = await (cursor === null ? req : req.query({ cursor }));
        expect(res.status).toBe(200);
        const body = ThreadListResponseSchema.parse(res.body);
        pages.push({
          ids: body.threads.map((thread) => thread.id),
          nextCursor: body.nextCursor,
        });
        cursor = body.nextCursor;
      } while (cursor !== null && pages.length < 10);

      // Assert
      expect(pages).toHaveLength(6);
      expect(pages.map((p) => p.ids.length)).toEqual([20, 20, 20, 20, 20, 20]);
      expect(pages[0].ids).toEqual(idsFrom(1, 20));
      expect(pages[5].ids).toEqual(idsFrom(101, 120));
      for (const p of pages.slice(0, 5)) {
        expect(p.nextCursor).not.toBeNull();
        expect(p.nextCursor).not.toBe('');
      }
      expect(pages[5].nextCursor).toBeNull();
      const union = pages.flatMap((p) => p.ids);
      expect(new Set(union).size).toBe(120);
      expect(union).toEqual(idsFrom(1, 120));
    }, 60_000);

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
    it('AC-13.2a: deleting a page-1 thread and raising a page-5 thread between pages 2 and 3 yields 119 unique ids with no duplicates', async () => {
      // Arrange (adapted: ids are `${prefix}-t-<n>`): 120 threads, t-001 newest, each next 1 minute older;
      //   deletedId = t-005 (page 1), raisedId = t-085 (page 5, positions 81..100)
      const t = await startApp();
      const user = t.user();
      const { prefix } = await seed(t.memory, {
        resourceId: user,
        threads: descendingDates(120, new Date('2026-03-01T12:00:00.000Z')).map(
          (updatedAt) => ({ updatedAt }),
        ),
      });
      const deletedId = seededThreadId(prefix, 5);
      const raisedId = seededThreadId(prefix, 85);
      const getPage = async (cursor: string | null) => {
        const req = t.http.get('/api/threads').set('x-user-id', user);
        const res = await (cursor === null ? req : req.query({ cursor }));
        expect(res.status).toBe(200);
        const body = ThreadListResponseSchema.parse(res.body);
        return {
          ids: body.threads.map((thread) => thread.id),
          nextCursor: body.nextCursor,
        };
      };

      // Act: pages 1-2, then delete + raise, then follow nextCursor until null (bounded)
      const pages = [await getPage(null)];
      pages.push(await getPage(pages[0].nextCursor));
      await t.http
        .delete(`/api/threads/${deletedId}`)
        .set('x-user-id', user)
        .expect(204);
      await t.http
        .patch(`/api/threads/${raisedId}`)
        .set('x-user-id', user)
        .send({ title: 'Поднятая' })
        .expect(200);
      let cursor = pages[1].nextCursor;
      while (cursor !== null && pages.length < 10) {
        const page = await getPage(cursor);
        pages.push(page);
        cursor = page.nextCursor;
      }

      // Assert
      expect(pages).toHaveLength(6);
      const later = pages.slice(2).flatMap((p) => p.ids);
      expect(later).not.toContain(raisedId);
      expect(later).not.toContain(deletedId);
      expect(pages[0].ids).toContain(deletedId);
      const union = pages.flatMap((p) => p.ids);
      expect(union).toHaveLength(119);
      expect(new Set(union).size).toBe(119);
      expect(union).not.toContain(raisedId);
      const remaining = Array.from({ length: 80 }, (_, i) =>
        seededThreadId(prefix, 41 + i),
      ).filter((id) => id !== raisedId);
      expect(later).toHaveLength(79);
      expect(later).toEqual(remaining);
      expect(pages[5].ids).toHaveLength(19);
      expect(pages[5].nextCursor).toBeNull();
      const fresh = await t.http
        .get('/api/threads')
        .set('x-user-id', user)
        .expect(200);
      expect(
        ThreadListResponseSchema.parse(fresh.body).threads[0],
      ).toMatchObject({ id: raisedId, title: 'Поднятая' });
    }, 60_000);

    // Contract error (Contract Definitions: GET /api/threads -> 400 INVALID_CURSOR); supports AC-13.2 cursor handling.
    // ROI: 3.5 | Business Value: 4 | Frequency: 2 | Defect detection: 6
    // Behavior: tampered cursor -> decodeThreadCursor rejects -> 400 INVALID_CURSOR (not 500)
    // Primary failure mode: unparsable cursor reaches storage and returns 500.
    // @category: edge-case
    // @dependency: ZodValidationPipe, thread-cursor
    // @complexity: low
    it('rejects an unparsable cursor with 400 INVALID_CURSOR', async () => {
      // Arrange
      const t = await startApp();
      const user = t.user();

      // Act
      const res = await t.http
        .get('/api/threads')
        .query({ cursor: 'not-a-cursor' })
        .set('x-user-id', user);

      // Assert
      expect(res.status).toBe(400);
      expect(ApiErrorSchema.parse(res.body)).toEqual({
        statusCode: 400,
        message: 'Invalid cursor',
        error: 'Bad Request',
        errorCode: 'INVALID_CURSOR',
      });
    });

    // Additional case outside the skeleton (work plan T3.1, failure mode "invalid option"):
    // ThreadListQuerySchema caps the cursor at 512 characters, checked by the pipe before decoding.
    // Behavior: 513-char cursor -> pipe rejects before decode -> 400 VALIDATION_FAILED (not INVALID_CURSOR)
    // @category: edge-case
    // @dependency: ZodValidationPipe, ThreadListQuerySchema
    // @complexity: low
    it('rejects a 513-character cursor with 400 VALIDATION_FAILED', async () => {
      // Arrange
      const t = await startApp();
      const user = t.user();

      // Act
      const res = await t.http
        .get('/api/threads')
        .query({ cursor: 'a'.repeat(513) })
        .set('x-user-id', user);

      // Assert
      expect(res.status).toBe(400);
      const body = ApiErrorSchema.parse(res.body);
      expect(body.errorCode).toBe('VALIDATION_FAILED');
      expect(body.message).toEqual([expect.stringContaining('cursor')]);
    });

    // design-self-check.md KD-3: `system:self-check` owns the self-check program's investigations and no sign-in
    // issues it, so the dev header may not claim a `system:` owner.
    // @category: edge-case
    // @dependency: SessionGuard
    // @complexity: low
    it('rejects a reserved system: user id in the dev header with 401', async () => {
      const t = await startApp();

      const res = await t.http
        .get('/api/threads')
        .set('x-user-id', 'system:self-check');

      expect(res.status).toBe(401);
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
    it('AC-13.3: every /api/threads* route answers 401 when NODE_ENV=production', async () => {
      // Arrange (adapted: the app's ConfigService is spied on instead of overridden in createTestApp,
      //   which has no config option; SessionGuard reads this same instance)
      const t = await startApp();
      const config = t.app.get(ConfigService);
      const realGet = config.get.bind(config);
      const getSpy = vi
        .spyOn(config, 'get')
        .mockImplementation((key: string) =>
          key === 'NODE_ENV' ? 'production' : realGet(key),
        );
      const user = t.user();

      try {
        // Act
        const responses = await Promise.all([
          t.http.get('/api/threads').set('x-user-id', user),
          t.http.post('/api/threads').set('x-user-id', user),
          t.http.get('/api/threads/any-id').set('x-user-id', user),
          t.http.get('/api/threads/any-id/messages').set('x-user-id', user),
          t.http
            .patch('/api/threads/any-id')
            .set('x-user-id', user)
            .send({ title: 'x' }),
          t.http.delete('/api/threads/any-id').set('x-user-id', user),
        ]);

        // Assert: 6 of 6
        expect(responses.map((res) => res.status)).toEqual([
          401, 401, 401, 401, 401, 401,
        ]);
      } finally {
        getSpy.mockRestore();
      }
    });
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
    it('creates a thread with a server UUID and title null that is listed first', async () => {
      // Arrange (adapted: the older thread is seeded with a prefixed id instead of 'old-1')
      const t = await startApp();
      const user = t.user();
      const oldId = await seedThread(t.memory, user);

      // Act
      const res = await t.http
        .post('/api/threads')
        .set('x-user-id', user)
        .send({ id: 'client-id' });

      // Assert
      expect(res.status).toBe(201);
      const body = ThreadSummarySchema.parse(res.body);
      expect(body.title).toBeNull();
      expect(body.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(body.id).not.toBe('client-id');
      expect(body.createdAt).toBe(body.updatedAt);
      const list = await t.http
        .get('/api/threads')
        .set('x-user-id', user)
        .expect(200);
      expect(
        ThreadListResponseSchema.parse(list.body).threads.map((th) => th.id),
      ).toEqual([body.id, oldId]);
    });
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
    it('AC-15.1: saves the trimmed title and returns it in the response and the list, and accepts the 200-character boundary', async () => {
      // Arrange
      const t = await startApp();
      const user = t.user();
      const created = await t.http
        .post('/api/threads')
        .set('x-user-id', user)
        .expect(201);
      const threadId = ThreadSummarySchema.parse(created.body).id;

      // Act
      const res = await t.http
        .patch(`/api/threads/${threadId}`)
        .set('x-user-id', user)
        .send({ title: '  Отчёт Q3  ' });

      // Assert
      expect(res.status).toBe(200);
      expect(ThreadSummarySchema.parse(res.body)).toMatchObject({
        id: threadId,
        title: 'Отчёт Q3',
      });
      const list = await t.http
        .get('/api/threads')
        .set('x-user-id', user)
        .expect(200);
      expect(
        ThreadListResponseSchema.parse(list.body).threads.find(
          (thread) => thread.id === threadId,
        )?.title,
      ).toBe('Отчёт Q3');
      const longest = await t.http
        .patch(`/api/threads/${threadId}`)
        .set('x-user-id', user)
        .send({ title: 'a'.repeat(200) });
      expect(longest.status).toBe(200);
      expect(ThreadSummarySchema.parse(longest.body).title).toHaveLength(200);
    });

    // AC-15.2: "If title отсутствует, пустой, состоит из пробелов или длиннее 200 символов после обрезки, then the system
    //   shall ответить 400 VALIDATION_FAILED с описанием ошибки и не менять беседу."
    // EARS: If-then -> branch (each invalid input)
    // ROI: 5.6 | Business Value: 6 | Frequency: 3 | Defect detection: 8 (boundary 200/201)
    // Behavior: invalid title -> ZodValidationPipe -> 400 VALIDATION_FAILED, title unchanged
    // Primary failure mode: whitespace-only or 201-char title accepted, or thread modified despite 400.
    // @category: edge-case
    // @dependency: ZodValidationPipe, RenameThreadRequestSchema
    // @complexity: low
    it('AC-15.2: missing, empty, whitespace-only and 201-char titles are rejected with 400 VALIDATION_FAILED and the title is unchanged', async () => {
      // Arrange
      const t = await startApp();
      const user = t.user();
      const created = await t.http
        .post('/api/threads')
        .set('x-user-id', user)
        .expect(201);
      const threadId = ThreadSummarySchema.parse(created.body).id;
      await t.http
        .patch(`/api/threads/${threadId}`)
        .set('x-user-id', user)
        .send({ title: 'Исходный' })
        .expect(200);
      const invalidBodies = [
        {},
        { title: '' },
        { title: '   ' },
        { title: 'a'.repeat(201) },
      ];

      // Act
      const responses = [];
      for (const invalid of invalidBodies) {
        responses.push(
          await t.http
            .patch(`/api/threads/${threadId}`)
            .set('x-user-id', user)
            .send(invalid),
        );
      }

      // Assert
      for (const res of responses) {
        expect(res.status).toBe(400);
        const body = ApiErrorSchema.parse(res.body);
        expect(body.errorCode).toBe('VALIDATION_FAILED');
        expect(body.message).toEqual([expect.stringContaining('title')]);
      }
      const after = await t.http
        .get(`/api/threads/${threadId}`)
        .set('x-user-id', user)
        .expect(200);
      expect(ThreadSummarySchema.parse(after.body).title).toBe('Исходный');
    });
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
    it('AC-16.1/AC-16.3: deleted thread disappears from the list, its routes answer 404, its messages are gone and a second DELETE is 404', async () => {
      // Arrange (adapted: the kept thread is seeded with a prefixed id instead of 'keep-1')
      const t = await startApp(textStep('Ответ'));
      const user = t.user();
      const created = await t.http
        .post('/api/threads')
        .set('x-user-id', user)
        .expect(201);
      const threadId = ThreadSummarySchema.parse(created.body).id;
      await t.http
        .post('/api/chat/assistant')
        .set('x-user-id', user)
        .send({ id: threadId, messages: [userMessage('Привет')] })
        .expect(200);
      const keepId = await seedThread(t.memory, user);
      // precondition: messages exist, so count = 0 below is not vacuous
      expect(await countMessages(threadId)).toBe(2);

      // Act
      const res = await t.http
        .delete(`/api/threads/${threadId}`)
        .set('x-user-id', user);

      // Assert
      expect(res.status).toBe(204);
      expect(res.text).toBe('');
      const list = await t.http
        .get('/api/threads')
        .set('x-user-id', user)
        .expect(200);
      expect(
        ThreadListResponseSchema.parse(list.body).threads.map((th) => th.id),
      ).toEqual([keepId]);
      for (const path of [
        `/api/threads/${threadId}`,
        `/api/threads/${threadId}/messages`,
      ]) {
        const gone = await t.http.get(path).set('x-user-id', user);
        expect(gone.status).toBe(404);
        expect(ApiErrorSchema.parse(gone.body)).toEqual(NOT_FOUND_BODY);
      }
      expect(await countMessages(threadId)).toBe(0);
      const second = await t.http
        .delete(`/api/threads/${threadId}`)
        .set('x-user-id', user);
      expect(second.status).toBe(404);
      expect(ApiErrorSchema.parse(second.body)).toEqual(NOT_FOUND_BODY);
    });
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
    //   A: POST /api/threads -> threadA; PATCH { title: 'Секрет A' }; one chat exchange (2 messages)
    //   — createOwnedThread() (AC-15.3, AC-16.2); AC-14.2/AC-14.3 seeds the same titled thread instead;
    //   missingId = 'e2e-missing-' + uuid

    it('AC-14.2/AC-14.3: GET /api/threads/:id and /messages of a foreign thread answer the same 404 body as a missing id', async () => {
      // Arrange (adapted: seed with title 'Секрет A' instead of POST + PATCH /api/threads; same resulting state)
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

    it('AC-15.3: PATCH of a foreign or missing thread answers 404 THREAD_NOT_FOUND and the title is unchanged', async () => {
      // Arrange
      const t = await startApp(textStep('Ответ A'));
      const userA = t.user();
      const userB = t.user();
      const threadA = await createOwnedThread(t, userA);
      const missingId = `e2e-missing-${randomUUID()}`;

      // Act
      const asB = (path: string) =>
        t.http.patch(path).set('x-user-id', userB).send({ title: 'Взлом' });
      const foreign = await asB(`/api/threads/${threadA}`);
      const missing = await asB(`/api/threads/${missingId}`);

      // Assert
      for (const res of [foreign, missing]) {
        expect(res.status).toBe(404);
        expect(ApiErrorSchema.parse(res.body)).toEqual(NOT_FOUND_BODY);
      }
      expect(foreign.text).toBe(missing.text);
      const own = await t.http
        .get(`/api/threads/${threadA}`)
        .set('x-user-id', userA)
        .expect(200);
      expect(ThreadSummarySchema.parse(own.body).title).toBe('Секрет A');
    });

    it('AC-16.2: DELETE of a foreign thread answers 404 and the thread and its messages remain', async () => {
      // Arrange
      const t = await startApp(textStep('Ответ A'));
      const userA = t.user();
      const userB = t.user();
      const threadA = await createOwnedThread(t, userA);
      const missingId = `e2e-missing-${randomUUID()}`;

      // Act
      const foreign = await t.http
        .delete(`/api/threads/${threadA}`)
        .set('x-user-id', userB);
      const missing = await t.http
        .delete(`/api/threads/${missingId}`)
        .set('x-user-id', userB);

      // Assert
      for (const res of [foreign, missing]) {
        expect(res.status).toBe(404);
        expect(ApiErrorSchema.parse(res.body)).toEqual(NOT_FOUND_BODY);
      }
      expect(foreign.text).toBe(missing.text);
      const ownThread = await t.http
        .get(`/api/threads/${threadA}`)
        .set('x-user-id', userA)
        .expect(200);
      expect(ThreadSummarySchema.parse(ownThread.body).title).toBe('Секрет A');
      const ownMessages = await t.http
        .get(`/api/threads/${threadA}/messages`)
        .set('x-user-id', userA)
        .expect(200);
      expect(
        ThreadMessagesResponseSchema.parse(ownMessages.body).messages,
      ).toHaveLength(2);
      expect(await countMessages(threadA)).toBe(2);
      const listB = await t.http
        .get('/api/threads')
        .set('x-user-id', userB)
        .expect(200);
      expect(ThreadListResponseSchema.parse(listB.body).threads).toEqual([]);
    });
  });
});
