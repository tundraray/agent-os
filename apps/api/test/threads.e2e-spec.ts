// agent-platform / chat - the former conversation routes over `chat_conversations`
// Design Doc: docs/features/agent-platform/design-chat.md (v1.2), Contract «Беседы» (the former list, create,
// rename and delete keep their routes and shapes) and «Не меняется»; AC-14.3 (list, rename, delete).
// Rewritten from the Mastra-based `threads.e2e-spec.ts` (work plan T6.4): the data is created through the API
// (`POST /threads`, `PATCH /threads/:id`) one request after another, so the rows get their own `updatedAt`.
// Removed from the former file: the `/messages` history cases (the route is gone) and «Ownership isolation»
// (proved by INT-4 of `agent-platform-chat.int.e2e-spec.ts`). INT-3 A of that file asserts the move to the top
// on a send and the 404 of the conversation's new routes after a delete; this file keeps the pages, renames,
// cursors and the former routes' 404s.
//
// Harness: one `createTestApp()` per file (no runtime workers: no case here sends a message), real Postgres
// (`pnpm db:up`), real SessionGuard; every case uses its own `newUser()` owner, so rows of one case never meet
// another's. Response bodies are parsed with the `@agent-os/contracts` schemas.

import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { ThreadSummarySchema, type ThreadListResponse, type ThreadSummary } from '@agent-os/contracts';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { type ChatApi, chatApi, expectBody, expectError } from './support/api.js';
import { createTestApp, type TestApp } from './support/createTestApp.js';
import { newUser } from './support/new-user.js';

/** Creating 120 conversations one by one plus a page walk exceeds the default 5 s. */
const BULK_TEST_TIMEOUT_MS = 60_000;

const NOT_FOUND_BODY = {
  statusCode: 404,
  message: 'Thread not found',
  error: 'Not Found',
  errorCode: 'THREAD_NOT_FOUND',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

let harness: TestApp;

beforeAll(async () => {
  harness = await createTestApp();
});

afterAll(async () => {
  if (harness !== undefined) await harness.close();
});

/** The API as a fresh employee. */
function asNewUser(): ChatApi {
  return chatApi(harness.app, newUser());
}

/** Creates `count` conversations one request after another. */
async function createConversations(api: ChatApi, count: number): Promise<ThreadSummary[]> {
  const created: ThreadSummary[] = [];
  for (let index = 0; index < count; index += 1) created.push(await api.createThread());
  return created;
}

/**
 * The ids in the list order of the contract — `updatedAt` descending, then `id` descending — computed from
 * the summaries the creates returned, independently of the list route.
 */
function listOrder(summaries: readonly ThreadSummary[]): string[] {
  return summaries
    .toSorted((a, b) =>
      a.updatedAt !== b.updatedAt ? (a.updatedAt < b.updatedAt ? 1 : -1) : a.id < b.id ? 1 : -1,
    )
    .map((summary) => summary.id);
}

type Page = { ids: string[]; nextCursor: string | null };

function pageOf(response: ThreadListResponse): Page {
  return { ids: response.threads.map((thread) => thread.id), nextCursor: response.nextCursor };
}

/** Follows `nextCursor` from `cursor` until null; bounded, so a cursor loop fails instead of hanging. */
async function walkFrom(api: ChatApi, cursor: string | null, pages: Page[]): Promise<Page[]> {
  let next = cursor;
  while (next !== null && pages.length < 10) {
    const page = pageOf(await api.listThreads(next));
    pages.push(page);
    next = page.nextCursor;
  }
  return pages;
}

describe('agent-platform / chat - the former conversation routes over chat_conversations (real AppModule + real Postgres)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // GET /threads - pages, cursor, owner header
  // ---------------------------------------------------------------------------------------------------------------
  describe('GET /threads', () => {
    // AC-14.3 (list), former AC-13.2: 120 conversations walk as 6 pages of 20 with no duplicates, nextCursor null at the end.
    // Catches: a duplicate or skipped conversation at a page boundary of the SQL keyset page; a non-null cursor after the last page.
    it('pages 120 conversations as 6 pages of 20 in the list order with no duplicates and nextCursor null at the end', async () => {
      const api = asNewUser();
      const expected = listOrder(await createConversations(api, 120));

      const first = pageOf(await api.listThreads());
      const pages = await walkFrom(api, first.nextCursor, [first]);

      expect(pages).toHaveLength(6);
      expect(pages.map((page) => page.ids.length)).toEqual([20, 20, 20, 20, 20, 20]);
      for (const page of pages.slice(0, 5)) expect(page.nextCursor).not.toBeNull();
      expect(pages[5]?.nextCursor).toBeNull();
      const union = pages.flatMap((page) => page.ids);
      expect(new Set(union).size).toBe(120);
      expect(union).toEqual(expected);
    }, BULK_TEST_TIMEOUT_MS);

    // AC-14.3 (list), former AC-13.2a: a delete and a rename between pages 2 and 3.
    // Catches: a positional (offset) cursor that skips a conversation after a delete, or a renamed (raised) conversation
    //   returned again on a later page of the same walk.
    it('continues after the cursor when a page-1 conversation is deleted and a page-5 one is renamed to the top between pages 2 and 3', async () => {
      const api = asNewUser();
      const expected = listOrder(await createConversations(api, 120));
      const deletedId = expected[4];
      const raisedId = expected[84];
      if (deletedId === undefined || raisedId === undefined) throw new Error('fewer than 120 conversations');

      const pages = [pageOf(await api.listThreads())];
      pages.push(pageOf(await api.listThreads(pages[0]?.nextCursor ?? undefined)));
      await api.deleteThread(deletedId);
      await api.renameThread(raisedId, 'Поднятая');
      await walkFrom(api, pages[1]?.nextCursor ?? null, pages);

      expect(pages).toHaveLength(6);
      expect(pages[0]?.ids).toContain(deletedId);
      const later = pages.slice(2).flatMap((page) => page.ids);
      expect(later).toEqual(expected.slice(40).filter((id) => id !== raisedId));
      expect(later).toHaveLength(79);
      const union = pages.flatMap((page) => page.ids);
      expect(union).toHaveLength(119);
      expect(new Set(union).size).toBe(119);
      expect(union).not.toContain(raisedId);
      expect(pages[5]?.ids).toHaveLength(19);
      expect(pages[5]?.nextCursor).toBeNull();
      expect((await api.listThreads()).threads[0]).toMatchObject({ id: raisedId, title: 'Поднятая' });
    }, BULK_TEST_TIMEOUT_MS);

    // Contract «Беседы»: GET /threads -> 400 INVALID_CURSOR for a cursor that does not decode.
    // Catches: an unparsable cursor that reaches the SQL page and answers 500.
    it('rejects an unparsable cursor with 400 INVALID_CURSOR', async () => {
      const api = asNewUser();

      const body = await expectError(api.raw('get', '/threads?cursor=not-a-cursor'), 400);

      expect(body).toEqual({
        statusCode: 400,
        message: 'Invalid cursor',
        error: 'Bad Request',
        errorCode: 'INVALID_CURSOR',
      });
    });

    // ThreadListQuerySchema caps the cursor at 512 characters; the pipe checks it before decoding.
    // Catches: an oversized cursor decoded (INVALID_CURSOR or 500) instead of refused by the query schema.
    it('rejects a 513-character cursor with 400 VALIDATION_FAILED', async () => {
      const api = asNewUser();

      const body = await expectError(api.raw('get', `/threads?cursor=${'a'.repeat(513)}`), 400);

      expect(body.errorCode).toBe('VALIDATION_FAILED');
      expect(body.message).toEqual([expect.stringContaining('cursor')]);
    });

    // design-self-check.md KD-3: no sign-in issues a `system:` owner, so the dev header may not claim one.
    // Catches: SessionGuard dropped from the threads controller or the reserved prefix check removed.
    it('rejects a reserved system: user id in the dev header with 401', async () => {
      const response = await chatApi(harness.app, 'system:self-check').raw('get', '/threads');

      expect(response.status).toBe(401);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // Production guard on every /threads route
  // ---------------------------------------------------------------------------------------------------------------
  // Former AC-13.3: "While NODE_ENV=production, the system shall отвечать 401 на любой из маршрутов /api/threads*."
  // Catches: a route of the threads controller reachable without SessionGuard.
  it('answers 401 on every /threads route when NODE_ENV=production', async () => {
    // The app's ConfigService is the instance SessionGuard reads.
    const config = harness.app.get(ConfigService);
    const realGet = config.get.bind(config);
    const getSpy = vi
      .spyOn(config, 'get')
      .mockImplementation((key: string) => (key === 'NODE_ENV' ? 'production' : realGet(key)));
    const api = asNewUser();
    const id = randomUUID();

    try {
      const responses = await Promise.all([
        api.raw('get', '/threads'),
        api.raw('post', '/threads'),
        api.raw('get', `/threads/${id}`),
        api.raw('patch', `/threads/${id}`, { title: 'x' }),
        api.raw('delete', `/threads/${id}`),
        api.raw('get', `/threads/${id}/history`),
        api.raw('get', `/threads/${id}/agents`),
        api.raw('post', `/threads/${id}/messages`, { text: 'x' }),
        api.raw('post', `/threads/${id}/interrupt`),
      ]);

      expect(responses.map((response) => response.status)).toEqual([401, 401, 401, 401, 401, 401, 401, 401, 401]);
    } finally {
      getSpy.mockRestore();
    }
  });

  // ---------------------------------------------------------------------------------------------------------------
  // POST /threads
  // ---------------------------------------------------------------------------------------------------------------
  // Contract «Беседы»: "POST /threads -> 201, title: null, id формата UUID, появляется в списке первой."
  // Catches: a client-provided id honoured, a default title instead of null, the new conversation not first in the list.
  it('creates a conversation with a server UUID and title null that is listed first', async () => {
    const api = asNewUser();
    const older = await api.createThread();

    const body = await expectBody(api.raw('post', '/threads', { id: 'client-id' }), 201, ThreadSummarySchema);

    expect(body.title).toBeNull();
    expect(body.id).toMatch(UUID);
    expect(body.id).not.toBe('client-id');
    expect(body.createdAt).toBe(body.updatedAt);
    expect((await api.listThreads()).threads.map((thread) => thread.id)).toEqual([body.id, older.id]);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // PATCH /threads/:id
  // ---------------------------------------------------------------------------------------------------------------
  describe('PATCH /threads/:id', () => {
    // AC-14.3 (rename), former AC-15.1: the title is trimmed, returned, listed, and 200 characters is accepted.
    // Catches: an untrimmed title persisted, a response that differs from the list, the 200-character boundary refused.
    it('saves the trimmed title, returns it in the response and the list, and accepts 200 characters', async () => {
      const api = asNewUser();
      const { id } = await api.createThread();

      const renamed = await api.renameThread(id, '  Отчёт Q3  ');

      expect(renamed).toMatchObject({ id, title: 'Отчёт Q3' });
      expect((await api.listThreads()).threads.find((thread) => thread.id === id)?.title).toBe('Отчёт Q3');
      expect((await api.renameThread(id, 'a'.repeat(200))).title).toHaveLength(200);
    });

    // AC-14.3 (rename), former AC-15.2: missing, empty, whitespace-only and 201-character titles.
    // Catches: a whitespace-only or 201-character title accepted, or the conversation changed despite the 400.
    it('rejects missing, empty, whitespace-only and 201-character titles with 400 VALIDATION_FAILED and leaves the title unchanged', async () => {
      const api = asNewUser();
      const { id } = await api.createThread();
      await api.renameThread(id, 'Исходный');

      for (const invalid of [{}, { title: '' }, { title: '   ' }, { title: 'a'.repeat(201) }]) {
        const body = await expectError(api.raw('patch', `/threads/${id}`, invalid), 400);
        expect(body.errorCode).toBe('VALIDATION_FAILED');
        expect(body.message).toEqual([expect.stringContaining('title')]);
      }

      expect((await api.getThread(id)).title).toBe('Исходный');
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // DELETE /threads/:id
  // ---------------------------------------------------------------------------------------------------------------
  // AC-14.3 (delete), former AC-16.1/AC-16.3: the deleted conversation leaves the list, its former routes answer 404
  // and a second DELETE is 404 (not 500).
  // Catches: a delete that leaves the row listed or readable, a rename that resurrects it, a second DELETE that answers 500.
  it('removes the conversation from the list, answers 404 on GET and PATCH, and a second DELETE is 404', async () => {
    const api = asNewUser();
    const kept = await api.createThread();
    const { id } = await api.createThread();

    const deleted = await api.raw('delete', `/threads/${id}`);

    expect(deleted.status).toBe(204);
    expect(deleted.text).toBe('');
    expect((await api.listThreads()).threads.map((thread) => thread.id)).toEqual([kept.id]);
    expect(await expectError(api.raw('get', `/threads/${id}`), 404)).toEqual(NOT_FOUND_BODY);
    expect(await expectError(api.raw('patch', `/threads/${id}`, { title: 'Снова' }), 404)).toEqual(NOT_FOUND_BODY);
    expect(await expectError(api.raw('delete', `/threads/${id}`), 404)).toEqual(NOT_FOUND_BODY);
    expect((await api.listThreads()).threads.map((thread) => thread.id)).toEqual([kept.id]);
  });
});
