// chat-shell / web-shell Integration Test — Design Doc: docs/features/chat-shell/design-web-shell.md (v1.9)
// File: shell.list.int.test.tsx — Test Strategy, "Integration Tests (I)"
// Generated: 2026-10-30 | Budget Used: 10 skeletons in 7 files (design-mandated: Test Strategy lists 7 integration files; over the 3/5 per-part limit, see generation report), 0/2 E2E (L1 checklist instead)
// Budget after the plan merges: 10 tests in 7 files, all implemented — no it.todo left (plan «Решение по бюджету интеграционных тестов»).
// ROI = (Business Value x Frequency + Legal x 10 + Defect Detection) / 11 (integration cost total, integration-e2e-testing skill)
// Test Type: Integration (Vitest + RTL + MSW 2, jsdom, real assistant-ui runtime)
//
// Harness (src/test/): renderWithRuntime(options) from '@/test/render-with-runtime'
//   mounts ChatRuntimeProvider + ChatShell with mocked next/navigation (controlled pathname, router spy).
//   MSW server from '@/test/msw-server' (onUnhandledRequest: 'error'); fixtures from '@/test/fixtures'
//   (built from @agent-os/contracts types, pass ThreadSummarySchema / ThreadListResponseSchema).
//   API base URL in tests: NEXT_PUBLIC_API_URL = 'http://api.test' (vitest.config.ts test.env).
// Mock boundary: network only (MSW) + next/navigation (framework boundary). Runtime, adapters,
//   ShellStatus, components — real. Do NOT mock lib/threads/* or @assistant-ui/*.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { assistantTextChunks, sseFromChunks, threadList, threadSummary } from '@/test/fixtures';
import { server } from '@/test/msw-server';
import { renderWithRuntime } from '@/test/render-with-runtime';

const API = 'http://api.test';

afterEach(() => {
  vi.useRealTimers();
});

describe('Shell: thread list errors (FR-01, AC-01.5 / AC-01.7)', () => {
  // AC-01.7: "If ответ GET /api/threads не проходит ThreadListResponseSchema, then the system shall
  //   перевести список в состояние AC-01.5, а композер и «Новый чат» останутся работоспособны."
  // AC-01.5: "If запрос первой страницы завершился ошибкой, then the system shall показать
  //   «Не удалось загрузить беседы» и «Повторить», нажатие которой перезапрашивает первую страницу."
  //   The «Повторить» branch is merged into this test: the same list-error scenario continues after the composer check.
  //   The button's look and its onRetry call are covered by the component test thread-history-list.test.tsx.
  // EARS: If-then (branch: invalid payload path; valid path covered by shell.new-chat / C tests), then the retry branch of AC-01.5
  // ROI: 2.3 | Business Value: 8 (shell must stay usable when list fails) | Frequency: 2 (rare) | Legal: false | Defect Detection: 9 (library swallows errors; adapter must map to loadError)
  // ROI (AC-01.5 retry): 2.0 | Business Value: 7 | Frequency: 2 | Legal: false | Defect Detection: 8 (retry must call threads.reload, not no-op)
  // Behavior: GET /api/threads → 200 with body failing schema → sidebar SB-09 Error in role="alert";
  //   composer still accepts input and first send creates a new thread;
  //   click «Повторить» → second GET /api/threads (no cursor) → 200 → list rendered
  // Fails when: the adapter passes the invalid payload through / throws into the React tree / blocks the composer;
  //   «Повторить» does not re-request page 1, requests with a cursor, or the error state persists after success
  // @category: core-functionality
  // @dependency: ThreadListAdapter, threads-api-client, ShellStatus, AppSidebar, ThreadHistoryList, Thread (composer), MSW
  // @complexity: high
  it('AC-01.7 + AC-01.5: invalid list payload shows the sidebar error while the composer still sends a new chat; «Повторить» re-requests page 1 and renders the list', async () => {
    // Arrange
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-28T12:00:00+01:00'));
    const listUrls: URL[] = [];
    server.use(
      http.get(`${API}/api/threads`, ({ request }) => {
        listUrls.push(new URL(request.url));
        if (listUrls.length === 1) return HttpResponse.json({ threads: [{ id: 42 }], nextCursor: 'x' });
        return HttpResponse.json(
          threadList([
            threadSummary({ id: 't-new', title: null, updatedAt: '2026-10-28T11:00:00.000Z' }),
            threadSummary({ id: 'a', title: 'План релиза', updatedAt: '2026-10-28T10:00:00.000Z' }),
          ]),
        );
      }),
      http.post(`${API}/api/threads`, () =>
        HttpResponse.json(threadSummary({ id: 't-new', title: null }), { status: 201 }),
      ),
      http.post(`${API}/api/chat/assistant`, () => sseFromChunks(assistantTextChunks('Привет!'))),
      http.get(`${API}/api/threads/t-new`, () => HttpResponse.json(threadSummary({ id: 't-new', title: null }))),
    );
    const posts: { path: string; body: unknown }[] = [];
    const recordPost = async ({ request }: { request: Request }) => {
      if (request.method !== 'POST') return;
      const text = await request.clone().text();
      posts.push({ path: new URL(request.url).pathname, body: text === '' ? undefined : JSON.parse(text) });
    };
    server.events.on('request:start', recordPost);
    onTestFinished(() => {
      server.events.removeListener('request:start', recordPost);
    });
    const user = userEvent.setup();
    renderWithRuntime({ pathname: '/', pointer: 'fine' });
    expect(screen.getByRole('status', { name: 'Загружаем беседы…' })).toBeInTheDocument();

    // Act 1: the list fails, the composer sends a new chat
    await screen.findByRole('alert');
    await user.type(screen.getByRole('textbox', { name: 'Сообщение' }), 'Привет');
    await user.keyboard('{Enter}');
    await screen.findByText('Привет!');

    // Assert 1 (AC-01.7)
    const history = screen.getByRole('navigation', { name: 'История бесед' });
    const alert = within(history).getByRole('alert');
    expect(alert).toHaveTextContent('Не удалось загрузить беседы');
    const retry = within(history).getByRole('button', { name: 'Повторить' });
    expect(alert).not.toContainElement(retry);
    expect(screen.queryByRole('status', { name: 'Загружаем беседы…' })).toBeNull();
    for (const button of screen.getAllByRole('button', { name: 'Новый чат' })) expect(button).toBeEnabled();
    await waitFor(() => expect(posts.map((post) => post.path)).toEqual(['/api/threads', '/api/chat/assistant']));
    expect(posts[1].body).toMatchObject({ id: 't-new' });
    expect(screen.getByText('Привет')).toBeInTheDocument();
    expect(screen.getByText('Привет!')).toBeInTheDocument();

    // Act 2 (AC-01.5 retry)
    await user.click(retry);
    const link = await within(history).findByRole('link', { name: 'План релиза' });

    // Assert 2
    expect(listUrls).toHaveLength(2);
    expect(listUrls[1].searchParams.has('cursor')).toBe(false);
    expect(within(history).getByRole('heading', { level: 2, name: 'Сегодня' })).toBeInTheDocument();
    expect(link).toHaveAttribute('href', '/chat/a');
    expect(screen.queryByText('Не удалось загрузить беседы')).toBeNull();
  });
});
