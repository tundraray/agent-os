import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { threadList, threadSummary } from '@/test/fixtures';
import { server } from '@/test/msw-server';
import { createShellStatusStore } from './shell-status-store';
import { createHistoryAdapterFactory } from './thread-history-adapter';
import { createThreadListAdapter, type OperationNotifier } from './thread-list-adapter';
import { threadsApiClient } from './threads-api-client';
import { ThreadsApiError } from './threads-api-error';

const API = 'http://api.test';
const FIXTURE_DATE = new Date('2026-10-28T10:00:00.000Z');

function setup() {
  const status = createShellStatusStore();
  const notify = {
    renameFailed: vi.fn<OperationNotifier['renameFailed']>(),
    deleted: vi.fn<OperationNotifier['deleted']>(),
    deleteFailed: vi.fn<OperationNotifier['deleteFailed']>(),
  };
  const history = createHistoryAdapterFactory({ api: threadsApiClient, status });
  const adapter = createThreadListAdapter({ api: threadsApiClient, status, notify, history });
  return { adapter, status, notify };
}

describe('thread list adapter', () => {
  beforeEach(() => {
    // Failure paths log a classification line; the content is checked elsewhere.
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  describe('list', () => {
    it('maps ThreadSummary to remote metadata and nextCursor null to undefined', async () => {
      server.use(
        http.get(`${API}/api/threads`, () =>
          HttpResponse.json(
            threadList([threadSummary({ id: 'a', title: 'Первая' }), threadSummary({ id: 'b', title: null })]),
          ),
        ),
      );
      const { adapter } = setup();

      const page = await adapter.list();

      expect(page).toEqual({
        threads: [
          { status: 'regular', remoteId: 'a', title: 'Первая', lastMessageAt: FIXTURE_DATE },
          { status: 'regular', remoteId: 'b', title: undefined, lastMessageAt: FIXTURE_DATE },
        ],
        nextCursor: undefined,
      });
    });

    it('list({ after }) requests ?cursor=after and passes nextCursor through', async () => {
      const searches: string[] = [];
      server.use(
        http.get(`${API}/api/threads`, ({ request }) => {
          searches.push(new URL(request.url).search);
          return HttpResponse.json(threadList([threadSummary({ id: 'c' })], 'cursor-3'));
        }),
      );
      const { adapter } = setup();

      const page = await adapter.list({ after: 'cursor-2' });

      expect(searches).toEqual(['?cursor=cursor-2']);
      expect(page.nextCursor).toBe('cursor-3');
    });

    it('a failed next page sets loadMoreFailed; the next successful page clears it', async () => {
      server.use(http.get(`${API}/api/threads`, () => HttpResponse.json({}, { status: 500 }), { once: true }));
      const { adapter, status } = setup();

      await expect(adapter.list({ after: 'cursor-2' })).rejects.toMatchObject({ kind: 'http', status: 500 });
      expect(status.getState().loadMoreFailed).toBe(true);

      server.use(http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([]))));
      await adapter.list({ after: 'cursor-2' });
      expect(status.getState().loadMoreFailed).toBe(false);
    });

    it('a failed first page rejects without setting loadMoreFailed', async () => {
      server.use(http.get(`${API}/api/threads`, () => HttpResponse.json({}, { status: 500 })));
      const { adapter, status } = setup();

      await expect(adapter.list()).rejects.toBeInstanceOf(ThreadsApiError);
      expect(status.getState().loadMoreFailed).toBe(false);
    });
  });

  it("initialize marks the new thread's history ready by the time remoteId is returned", async () => {
    server.use(http.post(`${API}/api/threads`, () => HttpResponse.json(threadSummary({ id: 'n1', title: null }))));
    const { adapter, status } = setup();

    const statusAtResolve = await adapter
      .initialize('local-1')
      .then(({ remoteId }) => ({ remoteId, history: status.getState().history[remoteId] }));

    expect(statusAtResolve).toEqual({ remoteId: 'n1', history: 'ready' });
  });

  it('fetch maps the thread to remote metadata', async () => {
    server.use(http.get(`${API}/api/threads/a`, () => HttpResponse.json(threadSummary({ id: 'a', title: 'Первая' }))));
    const { adapter } = setup();

    await expect(adapter.fetch('a')).resolves.toEqual({
      status: 'regular',
      remoteId: 'a',
      title: 'Первая',
      lastMessageAt: FIXTURE_DATE,
    });
  });

  describe('rename', () => {
    it('PATCH 500 notifies renameFailed and rejects so the runtime rolls back', async () => {
      server.use(http.patch(`${API}/api/threads/a`, () => HttpResponse.json({}, { status: 500 })));
      const { adapter, notify } = setup();

      await expect(adapter.rename('a', 'Новое')).rejects.toMatchObject({ kind: 'http', status: 500 });
      expect(notify.renameFailed).toHaveBeenCalledOnce();
    });

    it('PATCH 200 resolves without a notification', async () => {
      server.use(
        http.patch(`${API}/api/threads/a`, () => HttpResponse.json(threadSummary({ id: 'a', title: 'Новое' }))),
      );
      const { adapter, notify } = setup();

      await expect(adapter.rename('a', 'Новое')).resolves.toBeUndefined();
      expect(notify.renameFailed).not.toHaveBeenCalled();
    });
  });

  describe('delete', () => {
    it('DELETE 404 counts as success: resolves, notifies deleted, forgets the statuses', async () => {
      server.use(http.delete(`${API}/api/threads/a`, () => HttpResponse.json({}, { status: 404 })));
      const { adapter, notify, status } = setup();
      status.getState().setHistory('a', 'ready');

      await expect(adapter.delete('a')).resolves.toBeUndefined();

      expect(notify.deleted).toHaveBeenCalledOnce();
      expect(notify.deleteFailed).not.toHaveBeenCalled();
      expect(status.getState().history).toEqual({});
    });

    it('DELETE 500 notifies deleteFailed, rejects and keeps the statuses', async () => {
      server.use(http.delete(`${API}/api/threads/a`, () => HttpResponse.json({}, { status: 500 })));
      const { adapter, notify, status } = setup();
      status.getState().setHistory('a', 'ready');

      await expect(adapter.delete('a')).rejects.toMatchObject({ kind: 'http', status: 500 });

      expect(notify.deleteFailed).toHaveBeenCalledOnce();
      expect(notify.deleted).not.toHaveBeenCalled();
      expect(status.getState().history).toEqual({ a: 'ready' });
    });
  });

  it('archive is rejected: the shell has no archive UI', async () => {
    const { adapter } = setup();

    await expect(adapter.archive('a')).rejects.toThrow('Archive is not supported');
  });
});
