// chat-shell / web-shell Integration Test — Design Doc: docs/features/chat-shell/design-web-shell.md (v1.9);
//   routes and stream: docs/features/agent-platform/design-web.md (v1.1, KD-1, KD-2)
// File: shell.new-chat.int.test.tsx — Test Strategy, "Integration Tests (I)"
// Generated: 2026-10-30 | Budget Used: 10 skeletons in 7 files (design-mandated: Test Strategy lists 7 integration files; over the 3/5 per-part limit, see generation report), 0/2 E2E (L1 checklist instead)
// Budget after the plan merges: 10 tests in 7 files, all implemented — no it.todo left (plan «Решение по бюджету интеграционных тестов»).
// ROI = (Business Value x Frequency + Legal x 10 + Defect Detection) / 11 (integration cost total, integration-e2e-testing skill)
// Test Type: Integration (Vitest + RTL + MSW 2, jsdom, real assistant-ui runtime over the feed store)
//
// Harness (src/test/): renderWithRuntime(options) from '@/test/render-with-runtime'
//   mounts ChatRuntimeProvider + ChatShell with mocked next/navigation (controlled pathname, router spy) and a test
//   event source for LiveStore (`live`: what the shell opened, frames pushed by the test).
//   MSW server from '@/test/msw-server' (onUnhandledRequest: 'error'); fixtures from '@/test/fixtures'
//   (built from @agent-os/contracts types, pass their schemas).
//   API base URL in tests: NEXT_PUBLIC_API_URL = 'http://api.test' (vitest.config.ts test.env). TZ = 'Europe/Berlin'.
// Mock boundary: network only (MSW) + the live event source + next/navigation (framework boundary). Runtime, stores,
//   adapters, ShellStatus, components — real. Do NOT mock lib/threads/*, lib/feed/*, lib/live/* or @assistant-ui/*.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SendMessageResponse } from '@agent-os/contracts';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  conversationView,
  conversationWithTurns,
  threadList,
  threadSummary,
} from '@/test/fixtures';
import { createTestLiveSource } from '@/test/live-source';
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
  // @dependency: ChatRuntimeProvider, ThreadListAdapter.initialize, AppSidebar, ThreadHistoryList, FeedStore, MSW
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
      http.get(`${API}/api/threads/a/history`, () =>
        HttpResponse.json(conversationWithTurns(threadA, ['Сообщение 1', 'Сообщение 2'])),
      ),
      http.get(`${API}/api/threads/b/history`, () =>
        HttpResponse.json(conversationWithTurns(threadB, ['Сообщение 1', 'Сообщение 2'])),
      ),
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
  //   group-threads-by-date.test.ts; here only the wiring «accepted message → ShellStatus activity → grouping» is asserted.
  // KD-2 (design-web.md): "Первое сообщение новой беседы ждёт `ready` потока с новым `watch` не дольше 1 с", so the first
  //   parts of the answer are not lost.
  // Design sequence: POST /api/threads → onThreadIdChange → history.replaceState → LiveStore.watch('thread:t-1') → `ready`
  //   → POST /api/threads/t-1/messages { text } (202) → GET /api/threads/t-1/history
  // ROI: 9.0 | Business Value: 10 (thread persistence + addressable URL) | Frequency: 9 | Legal: false | Defect Detection: 9
  // ROI (AC-03.3): 7.2 | Business Value: 8 | Frequency: 9 | Legal: false | Defect Detection: 7 (local activity + grouping)
  // Behavior: on / type + Enter → POST /api/threads (201 {id:'t-1'}) while no source watches t-1 → the store opens the source
  //   `/api/events?watch=thread%3At-1` → the test sends `ready` → POST /api/threads/t-1/messages with { text: 'Составь план' };
  //   the re-read shows the answer «Готово.»; window.history.replaceState called with '/chat/t-1'; router.push / router.replace
  //   not called; existing thread updated today 09:00 → after the send at 12:00 «Сегодня» first link = «Новая беседа»,
  //   aria-current="page"; tab title «Новая беседа — Agent OS» (UX-04)
  // Fails when: the message is sent before the thread is created or before the stream watches it, carries another id,
  //   the URL changes via push/navigation or is not updated; the new item lands below older ones (grouping by stale server
  //   time only), is not active, or shows an empty title
  // @category: integration
  // @dependency: ChatRuntimeProvider, useThreadFeedRuntime, ThreadListAdapter.initialize, LiveStore (test source), FeedStore,
  //   url-sync, ShellStatus.activityAt, groupThreadsByDate, ThreadHistoryItem, MSW
  // @complexity: high
  it('AC-04.1 + AC-03.3: first send creates the thread, waits for the stream watching it, sends, replaces URL with /chat/t-1 and shows it first in «Сегодня», active, as «Новая беседа»', async () => {
    // Arrange
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-28T12:00:00+01:00'));
    window.history.replaceState(null, '', '/');
    const live = createTestLiveSource();
    const watchUrl = `${API}/api/events?watch=thread%3At-1`;
    const threadT1 = threadSummary({ id: 't-1', title: null, updatedAt: '2026-10-28T11:00:00.000Z' });
    let readySent = false;
    let accepted = false;
    const sourcesAtCreate: string[][] = [];
    const atSend: { openUrl: string | undefined; ready: boolean }[] = [];
    const sendBodies: unknown[] = [];
    server.use(
      http.get(`${API}/api/threads`, () =>
        HttpResponse.json(
          threadList([threadSummary({ id: 'old', title: 'Старая беседа', updatedAt: '2026-10-28T08:00:00.000Z' })]),
        ),
      ),
      http.post(`${API}/api/threads`, () => {
        sourcesAtCreate.push(live.opened.map((source) => source.url));
        return HttpResponse.json(threadT1, { status: 201 });
      }),
      http.post(`${API}/api/threads/t-1/messages`, async ({ request }) => {
        atSend.push({ openUrl: live.current()?.url, ready: readySent });
        sendBodies.push(await request.json());
        accepted = true;
        const body: SendMessageResponse = { messageId: null };
        return HttpResponse.json(body, { status: 202 });
      }),
      http.get(`${API}/api/threads/t-1/history`, () =>
        HttpResponse.json(
          accepted
            ? conversationWithTurns(threadT1, ['Составь план', 'Готово.'])
            : conversationView({
                thread: threadT1,
                chat: { status: 'new', failureReason: null, rootAgentId: null, model: null },
              }),
        ),
      ),
      http.get(`${API}/api/threads/t-1`, () => HttpResponse.json(threadSummary({ id: 't-1', title: null }))),
    );
    const requests = recordRequests();
    const replaceSpy = vi.spyOn(window.history, 'replaceState');
    const user = userEvent.setup();
    const { router, setPathname } = renderWithRuntime({ pathname: '/', pointer: 'fine', liveSource: live });
    const history = screen.getByRole('navigation', { name: 'История бесед' });
    await within(history).findByRole('link', { name: 'Старая беседа' });

    // Act: send; the store opens the stream on the new thread and waits for its `ready`
    await user.type(screen.getByRole('textbox', { name: 'Сообщение' }), 'Составь план');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(live.current()?.url).toBe(watchUrl));
    readySent = true;
    live.emit('ready', {});
    await screen.findByText('Готово.');
    await waitFor(() => expect(replaceSpy).toHaveBeenCalledWith(null, '', '/chat/t-1'));
    setPathname('/chat/t-1');

    // Assert (AC-04.1, KD-2): create → the stream watches the new thread and is ready → send
    expect(requests.filter((entry) => entry.startsWith('POST '))).toEqual([
      'POST /api/threads',
      'POST /api/threads/t-1/messages',
    ]);
    expect(sourcesAtCreate).toHaveLength(1);
    expect(sourcesAtCreate[0]).not.toContain(watchUrl);
    expect(atSend).toEqual([{ openUrl: watchUrl, ready: true }]);
    expect(sendBodies).toEqual([{ text: 'Составь план' }]);
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

