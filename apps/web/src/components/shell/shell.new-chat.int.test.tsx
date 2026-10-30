// chat-shell / web-shell Integration Test — Design Doc: docs/features/chat-shell/design-web-shell.md (v1.9)
// File: shell.new-chat.int.test.tsx — Test Strategy, "Integration Tests (I)"
// Generated: 2026-10-30 | Budget Used: 10 skeletons in 7 files (design-mandated: Test Strategy lists 7 integration files; over the 3/5 per-part limit, see generation report), 0/2 E2E (L1 checklist instead)
// Budget after the plan merges: 10 tests in 7 files, all implemented — no it.todo left (plan «Решение по бюджету интеграционных тестов»).
// ROI = (Business Value x Frequency + Legal x 10 + Defect Detection) / 11 (integration cost total, integration-e2e-testing skill)
// Test Type: Integration (Vitest + RTL + MSW 2, jsdom, real assistant-ui runtime)
//
// Harness (src/test/): renderWithRuntime(options) from '@/test/render-with-runtime'
//   mounts ChatRuntimeProvider + ChatShell with mocked next/navigation (controlled pathname, router spy).
//   MSW server from '@/test/msw-server' (onUnhandledRequest: 'error'); fixtures from '@/test/fixtures'
//   (built from @agent-os/contracts types, pass ThreadSummarySchema / ThreadListResponseSchema).
//   API base URL in tests: NEXT_PUBLIC_API_URL = 'http://api.test' (vitest.config.ts test.env). TZ = 'Europe/Berlin'.
// Mock boundary: network only (MSW) + next/navigation (framework boundary). Runtime, adapters,
//   ShellStatus, components — real. Do NOT mock lib/threads/* or @assistant-ui/*.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { assistantTextChunks, historyMessages, sseFromChunks, threadList, threadSummary } from '@/test/fixtures';
import { server } from '@/test/msw-server';
import { renderWithRuntime } from '@/test/render-with-runtime';

const API = 'http://api.test';

/** Records `METHOD /path` of every request the shell sends, in order. */
function recordRequests(): string[] {
  const requests: string[] = [];
  const record = ({ request }: { request: Request }) => {
    requests.push(`${request.method} ${new URL(request.url).pathname}`);
  };
  server.events.on('request:start', record);
  onTestFinished(() => {
    server.events.removeListener('request:start', record);
  });
  return requests;
}

afterEach(() => {
  vi.useRealTimers();
  window.history.replaceState(null, '', '/');
});

describe('Shell: new chat lifecycle (FR-03, FR-04, AC-03.2 / AC-03.3 / AC-04.1)', () => {
  // AC-03.2: "If пользователь открыл «Новый чат» и ушёл в другую беседу, ничего не отправив, then the system
  //   shall не создавать беседу и не показывать её в списке (запросов POST /api/threads нет)."
  // EARS: If-then (no-send branch; the send branch is the next test)
  // ROI: 7.2 | Business Value: 8 (no junk empty threads in history) | Frequency: 9 | Legal: false | Defect Detection: 7
  // Behavior: on /chat/a click «Новый чат» → / welcome → click link of thread b → zero POST /api/threads, list unchanged;
  //   the tab title follows the route (UX-04: «Новый чат — Agent OS», then «Беседа B — Agent OS»)
  // Fails when: «Новый чат» eagerly creates a server thread, or a local empty thread leaks into the list
  // @category: core-functionality
  // @dependency: ChatRuntimeProvider, ThreadListAdapter.initialize, AppSidebar, ThreadHistoryList, MSW
  // @complexity: medium
  it('AC-03.2: «Новый чат» then leaving without sending creates no thread and no list item', async () => {
    // Arrange
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-28T12:00:00+01:00'));
    const threadA = threadSummary({ id: 'a', title: 'Беседа A' });
    const threadB = threadSummary({ id: 'b', title: 'Беседа B' });
    let createCalls = 0;
    server.use(
      http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([threadA, threadB]))),
      http.get(`${API}/api/threads/a`, () => HttpResponse.json(threadA)),
      http.get(`${API}/api/threads/b`, () => HttpResponse.json(threadB)),
      http.get(`${API}/api/threads/a/messages`, () => HttpResponse.json({ messages: historyMessages(2) })),
      http.get(`${API}/api/threads/b/messages`, () => HttpResponse.json({ messages: historyMessages(2) })),
      http.post(`${API}/api/threads`, () => {
        createCalls += 1;
        return HttpResponse.json(threadSummary({ id: 'unexpected', title: null }), { status: 201 });
      }),
    );
    const user = userEvent.setup();
    const { router, setPathname } = renderWithRuntime({ pathname: '/chat/a', pointer: 'fine' });
    const history = screen.getByRole('navigation', { name: 'История бесед' });
    const linkA = await within(history).findByRole('link', { name: 'Беседа A' });
    await waitFor(() => expect(linkA).toHaveAttribute('aria-current', 'page'));
    await screen.findByText('Сообщение 2');

    // Act: «Новый чат» (SB-03) → the router goes to /
    const sidebarNewChat = screen
      .getAllByRole('button', { name: 'Новый чат' })
      .find((button) => button.closest('[data-slot="sidebar"]') !== null);
    if (sidebarNewChat === undefined) throw new Error('SB-03 «Новый чат» is not rendered');
    await user.click(sidebarNewChat);
    expect(router.push).toHaveBeenCalledWith('/');
    setPathname('/');
    await screen.findByText('Чем могу помочь?');
    await waitFor(() => expect(document.title).toBe('Новый чат — Agent OS'));

    // Act: leave for thread b without sending
    const leaveLink = within(history).getByRole('link', { name: 'Беседа B' });
    leaveLink.addEventListener('click', (event) => event.preventDefault());
    await user.click(leaveLink);
    setPathname('/chat/b');

    // Assert
    const linkB = within(history).getByRole('link', { name: 'Беседа B' });
    await waitFor(() => expect(linkB).toHaveAttribute('aria-current', 'page'));
    expect(createCalls).toBe(0);
    expect(within(history).getAllByRole('link').map((link) => link.textContent)).toEqual(['Беседа A', 'Беседа B']);
    expect(within(history).queryByText('Новая беседа')).toBeNull();
    await waitFor(() => expect(document.title).toBe('Беседа B — Agent OS'));
  });

  // AC-04.1: "When первое сообщение отправлено с /, the system shall заменить URL на /chat/<id> (id из POST /api/threads)
  //   без перезагрузки и без нового запроса страницы."
  // AC-03.3 (merged into this test: the same first send): "When отправлено первое сообщение нового чата, the system shall сразу
  //   показать новую беседу первой в «Сегодня», активной, с «Новая беседа»." The sorting rule itself is proven by the unit
  //   group-threads-by-date.test.ts; here only the wiring ThreadActivityTracker → grouping is asserted.
  // Design sequence: POST /api/threads → onThreadIdChange → history.replaceState → POST /api/chat/assistant { id }
  // ROI: 9.0 | Business Value: 10 (thread persistence + addressable URL) | Frequency: 9 | Legal: false | Defect Detection: 9
  // ROI (AC-03.3): 7.2 | Business Value: 8 | Frequency: 9 | Legal: false | Defect Detection: 7 (ThreadActivityTracker + grouping by local activity)
  // Behavior: on / type + Enter → POST /api/threads (201 {id:'t-1'}) precedes POST /api/chat/assistant with body.id='t-1';
  //   window.history.replaceState called with '/chat/t-1'; router.push / router.replace not called;
  //   existing thread updated today 09:00 → after the send at 12:00 «Сегодня» first link = «Новая беседа», aria-current="page";
  //   tab title «Новая беседа — Agent OS» (UX-04)
  // Fails when: chat request is sent before initialize, carries a local id, URL changes via push/navigation, or URL not updated;
  //   the new item lands below older ones (grouping by stale server time only), is not active, or shows an empty title
  // @category: integration
  // @dependency: ChatRuntimeProvider, AssistantChatTransport, ThreadListAdapter.initialize, url-sync, ThreadActivityTracker,
  //   ShellStatus.activityAt, groupThreadsByDate, ThreadHistoryItem, MSW (SSE v7)
  // @complexity: high
  it('AC-04.1 + AC-03.3: first send creates the thread, streams with its id, replaces URL with /chat/t-1 and shows it first in «Сегодня», active, as «Новая беседа»', async () => {
    // Arrange
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-28T12:00:00+01:00'));
    window.history.replaceState(null, '', '/');
    server.use(
      http.get(`${API}/api/threads`, () =>
        HttpResponse.json(
          threadList([threadSummary({ id: 'old', title: 'Старая беседа', updatedAt: '2026-10-28T08:00:00.000Z' })]),
        ),
      ),
      http.post(`${API}/api/threads`, () =>
        HttpResponse.json(threadSummary({ id: 't-1', title: null, updatedAt: '2026-10-28T11:00:00.000Z' }), {
          status: 201,
        }),
      ),
      http.post(`${API}/api/chat/assistant`, () => sseFromChunks(assistantTextChunks('Готово.'))),
      http.get(`${API}/api/threads/t-1`, () => HttpResponse.json(threadSummary({ id: 't-1', title: null }))),
    );
    const requests = recordRequests();
    const chatBodies: unknown[] = [];
    const recordChatBody = async ({ request }: { request: Request }) => {
      if (request.method === 'POST' && new URL(request.url).pathname === '/api/chat/assistant') {
        chatBodies.push(await request.clone().json());
      }
    };
    server.events.on('request:start', recordChatBody);
    onTestFinished(() => {
      server.events.removeListener('request:start', recordChatBody);
    });
    const replaceSpy = vi.spyOn(window.history, 'replaceState');
    const user = userEvent.setup();
    const { router, setPathname } = renderWithRuntime({ pathname: '/', pointer: 'fine' });
    const history = screen.getByRole('navigation', { name: 'История бесед' });
    await within(history).findByRole('link', { name: 'Старая беседа' });

    // Act
    await user.type(screen.getByRole('textbox', { name: 'Сообщение' }), 'Составь план');
    await user.keyboard('{Enter}');
    await screen.findByText('Готово.');
    await waitFor(() => expect(replaceSpy).toHaveBeenCalledWith(null, '', '/chat/t-1'));
    setPathname('/chat/t-1');

    // Assert (AC-04.1)
    expect(requests.filter((entry) => entry.startsWith('POST '))).toEqual([
      'POST /api/threads',
      'POST /api/chat/assistant',
    ]);
    expect(chatBodies).toHaveLength(1);
    expect(chatBodies[0]).toMatchObject({ id: 't-1' });
    expect(chatBodies[0]).toHaveProperty('messages');
    const sent = chatBodies[0];
    const messages = typeof sent === 'object' && sent !== null && 'messages' in sent ? sent.messages : undefined;
    expect(Array.isArray(messages) ? messages.at(-1) : undefined).toMatchObject({
      role: 'user',
      parts: [{ type: 'text', text: 'Составь план' }],
    });
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();

    // Assert (AC-03.3)
    const today = within(history).getByRole('heading', { level: 2, name: 'Сегодня' });
    const todayList = within(history).getByRole('list', { name: 'Сегодня' });
    await waitFor(() => expect(within(todayList).getAllByRole('link')[0]).toHaveAttribute('href', '/chat/t-1'));
    const [first, second] = within(todayList).getAllByRole('link');
    expect(today).toBeInTheDocument();
    expect(first.textContent).toMatch(/^Новая беседа/);
    expect(first).toHaveAttribute('aria-current', 'page');
    expect(second).toHaveTextContent('Старая беседа');
    expect(second).not.toHaveAttribute('aria-current');
    for (const label of ['Вчера', 'Предыдущие 7 дней', 'Старше']) {
      expect(within(history).queryByRole('heading', { level: 2, name: label })).toBeNull();
    }
    await waitFor(() => expect(document.title).toBe('Новая беседа — Agent OS'));
  });
});
