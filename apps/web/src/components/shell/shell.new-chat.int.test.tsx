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
//   Page address in tests: jsdom url 'http://api.test' (vitest.config.ts); relative `/api/...` requests resolve against it. TZ = 'Europe/Berlin'.
// Mock boundary: network only (MSW) + the live event source + next/navigation (framework boundary). Runtime, stores,
//   adapters, ShellStatus, components — real. Do NOT mock lib/threads/*, lib/feed/*, lib/live/* or @assistant-ui/*.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SendMessageResponse } from '@agent-os/contracts';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  conversationWithTurns,
  fixtureId,
  recordSummary,
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
      http.get(`${API}/api/threads`, () =>
        HttpResponse.json(threadList([threadA, threadB])),
      ),
      http.get(`${API}/api/threads/a`, () => HttpResponse.json(threadA)),
      http.get(`${API}/api/threads/b`, () => HttpResponse.json(threadB)),
      http.get(`${API}/api/threads/a/history`, () =>
        HttpResponse.json(
          conversationWithTurns(threadA, ['Сообщение 1', 'Сообщение 2']),
        ),
      ),
      http.get(`${API}/api/threads/b/history`, () =>
        HttpResponse.json(
          conversationWithTurns(threadB, ['Сообщение 1', 'Сообщение 2']),
        ),
      ),
      http.post(`${API}/api/threads`, () => {
        createCalls += 1;
        return HttpResponse.json(
          threadSummary({ id: 'unexpected', title: null }),
          { status: 201 },
        );
      }),
    );
    const user = userEvent.setup();
    const { router, setPathname } = renderWithRuntime({
      pathname: '/chat/a',
      pointer: 'fine',
    });
    const history = screen.getByRole('navigation', { name: 'История бесед' });
    const linkA = await within(history).findByRole('link', {
      name: 'Беседа A',
    });
    await waitFor(() => expect(linkA).toHaveAttribute('aria-current', 'page'));
    await screen.findByText('Сообщение 2');

    // Act: «Новый чат» (SB-03) → the router goes to /
    const sidebarNewChat = screen
      .getAllByRole('button', { name: 'Новый чат' })
      .find((button) => button.closest('[data-slot="sidebar"]') !== null);
    if (sidebarNewChat === undefined)
      throw new Error('SB-03 «Новый чат» is not rendered');
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
    expect(
      within(history)
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Беседа A', 'Беседа B']);
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
    const threadT1 = threadSummary({
      id: 't-1',
      title: null,
      updatedAt: '2026-10-28T11:00:00.000Z',
    });
    let readySent = false;
    let accepted = false;
    const sourcesAtCreate: string[][] = [];
    const atSend: { openUrl: string | undefined; ready: boolean }[] = [];
    const sendBodies: unknown[] = [];
    server.use(
      http.get(`${API}/api/threads`, () =>
        HttpResponse.json(
          threadList([
            threadSummary({
              id: 'old',
              title: 'Старая беседа',
              updatedAt: '2026-10-28T08:00:00.000Z',
            }),
          ]),
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
        // Before its first message the conversation does not exist: a read is 404, as on the server.
        accepted
          ? HttpResponse.json(
              conversationWithTurns(threadT1, ['Составь план', 'Готово.']),
            )
          : HttpResponse.json(
              {
                statusCode: 404,
                message: 'Thread not found',
                errorCode: 'THREAD_NOT_FOUND',
              },
              { status: 404 },
            ),
      ),
      http.get(`${API}/api/threads/t-1`, () =>
        HttpResponse.json(threadSummary({ id: 't-1', title: null })),
      ),
    );
    const requests = recordRequests();
    const replaceSpy = vi.spyOn(window.history, 'replaceState');
    const user = userEvent.setup();
    const { router, setPathname } = renderWithRuntime({
      pathname: '/',
      pointer: 'fine',
      liveSource: live,
    });
    const history = screen.getByRole('navigation', { name: 'История бесед' });
    await within(history).findByRole('link', { name: 'Старая беседа' });

    // Act: send; the store opens the stream on the new thread and waits for its `ready`
    await user.type(
      screen.getByRole('textbox', { name: 'Сообщение' }),
      'Составь план',
    );
    await user.keyboard('{Enter}');
    await waitFor(() => expect(live.current()?.url).toBe(watchUrl));
    readySent = true;
    live.emit('ready', {});
    await screen.findByText('Готово.');
    await waitFor(() =>
      expect(replaceSpy).toHaveBeenCalledWith(null, '', '/chat/t-1'),
    );
    setPathname('/chat/t-1');

    // Assert (AC-04.1, KD-2): create → the stream watches the new thread and is ready → send
    expect(requests.filter((entry) => entry.startsWith('POST '))).toEqual([
      'POST /api/threads',
      'POST /api/threads/t-1/messages',
    ]);
    expect(sourcesAtCreate).toHaveLength(1);
    expect(sourcesAtCreate[0]).not.toContain(watchUrl);
    expect(atSend).toEqual([{ openUrl: watchUrl, ready: true }]);
    expect(sendBodies).toEqual([
      { text: 'Составь план', sendKey: expect.any(String) },
    ]);
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();

    // Assert (AC-03.3)
    const today = within(history).getByRole('heading', {
      level: 2,
      name: 'Сегодня',
    });
    const todayList = within(history).getByRole('list', { name: 'Сегодня' });
    await waitFor(() =>
      expect(within(todayList).getAllByRole('link')[0]).toHaveAttribute(
        'href',
        '/chat/t-1',
      ),
    );
    const [first, second] = within(todayList).getAllByRole('link');
    expect(today).toBeInTheDocument();
    expect(first.textContent).toMatch(/^Новая беседа/);
    expect(first).toHaveAttribute('aria-current', 'page');
    expect(second).toHaveTextContent('Старая беседа');
    expect(second).not.toHaveAttribute('aria-current');
    for (const label of ['Вчера', 'Предыдущие 7 дней', 'Старше']) {
      expect(
        within(history).queryByRole('heading', { level: 2, name: label }),
      ).toBeNull();
    }
    await waitFor(() => expect(document.title).toBe('Новая беседа — Agent OS'));
  });

  // Defect: the conversation is created (POST /api/threads) before its first message is sent; when the server refused
  //   that message (409 `START_REFUSED`), the empty conversation stayed in the list.
  // Behavior: on / type + Enter → POST /api/threads (t-1) → POST /api/threads/t-1/messages answers 409 → DELETE /api/threads/t-1;
  //   the row is gone, no «Беседа удалена» toast, the URL goes back to / (router.replace), the new-chat composer holds the text
  //   with the refusal under it; sending again creates a conversation again (t-2).
  // Fails when: the empty conversation stays in the list, the cleanup shows the delete toast, the text or the notice is lost
  //   with the removed conversation, or the list item cannot create a conversation a second time
  // @category: core-functionality
  // @dependency: useThreadFeedRuntime, ThreadListAdapter (initialize, markEmpty, delete), FeedStore.sendFailure,
  //   ShellStatus.newThreadSendFailure, Composer, url-sync, MSW
  // @complexity: high
  it('a refused first message removes the conversation just created, without a toast, and keeps the text and the refusal on the new chat', async () => {
    // Arrange: every first message is refused
    const TEXT = 'Составь план';
    const REFUSAL = 'Модель Haiku вам недоступна — чат не запустился';
    const live = createTestLiveSource();
    let created = 0;
    const deleteCalls: string[] = [];
    server.use(
      http.get(`${API}/api/threads`, () =>
        HttpResponse.json(
          threadList([threadSummary({ id: 'old', title: 'Старая беседа' })]),
        ),
      ),
      http.post(`${API}/api/threads`, () => {
        created += 1;
        return HttpResponse.json(
          threadSummary({ id: `t-${created}`, title: null }),
          { status: 201 },
        );
      }),
      http.get(`${API}/api/threads/:id`, ({ params }) =>
        HttpResponse.json(
          threadSummary({ id: String(params.id), title: null }),
        ),
      ),
      http.post(`${API}/api/threads/:id/messages`, () =>
        HttpResponse.json(
          {
            statusCode: 409,
            message: 'Start refused',
            errorCode: 'START_REFUSED',
            reason: 'model_not_allowed',
            model: 'anthropic/claude-haiku-5-5',
          },
          { status: 409 },
        ),
      ),
      http.delete(`${API}/api/threads/:id`, ({ params }) => {
        deleteCalls.push(String(params.id));
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const user = userEvent.setup();
    const { router, setPathname } = renderWithRuntime({
      pathname: '/',
      pointer: 'fine',
      liveSource: live,
    });
    const history = screen.getByRole('navigation', { name: 'История бесед' });
    await within(history).findByRole('link', { name: 'Старая беседа' });
    const composer = (): HTMLElement =>
      screen.getByRole('textbox', { name: 'Сообщение' });
    /**
     * Sends what the field holds as the first message of conversation `id`, which is refused. The pathname follows the
     * URL as Next does: `/chat/<id>` once the conversation is created, back to `/` once the shell leaves it.
     */
    const sendRefusedFirstMessage = async (id: string): Promise<void> => {
      const watchUrl = `${API}/api/events?watch=thread%3A${id}`;
      router.replace.mockClear();
      await user.click(composer());
      await user.keyboard('{Enter}');
      await waitFor(() => expect(live.current()?.url).toBe(watchUrl));
      setPathname(`/chat/${id}`);
      await waitFor(() => expect(live.current()?.url).toBe(watchUrl));
      live.emit('ready', {});
      await waitFor(() => expect(deleteCalls).toContain(id));
      await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'));
      setPathname('/');
    };

    // Act: the first message of a new conversation is refused
    await user.type(composer(), TEXT);
    await sendRefusedFirstMessage('t-1');

    // Assert: the empty conversation is gone without a toast; the new chat keeps the text and the refusal
    await waitFor(() =>
      expect(
        within(history)
          .getAllByRole('link')
          .map((link) => link.textContent),
      ).toEqual(['Старая беседа']),
    );
    expect(await screen.findByText(REFUSAL)).toBeVisible();
    await waitFor(() => expect(composer()).toHaveValue(TEXT));
    expect(screen.getByText('Чем могу помочь?')).toBeVisible();
    expect(screen.queryByText('Беседа удалена')).toBeNull();
    expect(router.push).not.toHaveBeenCalled();

    // Act + Assert: sending again creates a conversation again, and it is removed the same way
    await sendRefusedFirstMessage('t-2');
    expect(deleteCalls).toEqual(['t-1', 't-2']);
    await waitFor(() => expect(composer()).toHaveValue(TEXT));
    expect(screen.getByText(REFUSAL)).toBeVisible();
    expect(screen.queryByText('Беседа удалена')).toBeNull();
  });

  // Composer «+»: an agent chosen from the menu becomes the chip of this conversation's composer, without leaving it.
  // Fails when: the menu does not offer the library's usable records, or the choice does not reach the composer's chip.
  it('an agent chosen from the composer «+» menu shows as the chip of the new chat', async () => {
    // Arrange
    server.use(
      http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([]))),
      http.get(`${API}/api/library`, () =>
        HttpResponse.json([recordSummary({ id: fixtureId(10) })]),
      ),
    );
    const user = userEvent.setup();
    const { router } = renderWithRuntime({ pathname: '/', pointer: 'fine' });

    // Act
    await user.click(await screen.findByRole('button', { name: 'Добавить' }));
    await user.click(
      await screen.findByRole('menuitem', { name: /Разбор логов/ }),
    );

    // Assert
    expect(
      await screen.findByRole('group', { name: 'Разбор логов' }),
    ).toBeVisible();
    expect(router.push).not.toHaveBeenCalled();
  });

  // improvements UC-9: AC-13.1 (design-web.md KD-7; UXRD IM-12). Catches: Enter in the open `@` list sending the message
  //   instead of choosing, a choice that leaves `@раз` in the text, or a chip that does not reach the send.
  it('UC-9: `@раз` and Enter put the same chip as «+», remove `@раз`, and the send carries the record id', async () => {
    // Arrange
    const RECORD = fixtureId(10);
    const thread = threadSummary({ id: 'a', title: 'Беседа A' });
    const sendBodies: unknown[] = [];
    server.use(
      http.get(`${API}/api/threads`, () =>
        HttpResponse.json(threadList([thread])),
      ),
      http.get(`${API}/api/threads/a`, () => HttpResponse.json(thread)),
      http.get(`${API}/api/threads/a/history`, () =>
        HttpResponse.json(conversationWithTurns(thread, ['Привет', 'Готово.'])),
      ),
      http.get(`${API}/api/library`, () =>
        HttpResponse.json([
          recordSummary({ id: RECORD }),
          recordSummary({ id: fixtureId(11), name: 'Сводка смены' }),
        ]),
      ),
      http.post(`${API}/api/threads/a/messages`, async ({ request }) => {
        sendBodies.push(await request.json());
        return HttpResponse.json(
          { messageId: null } satisfies SendMessageResponse,
          {
            status: 202,
          },
        );
      }),
    );
    const user = userEvent.setup();
    renderWithRuntime({ pathname: '/chat/a', pointer: 'fine' });
    await screen.findByText('Готово.');
    const field = screen.getByRole('textbox', { name: 'Сообщение' });

    // Act: `@раз` narrows the list to «Разбор логов»; Enter chooses it
    await user.type(field, 'Собери статус @раз');
    const list = await screen.findByRole('listbox', { name: 'Агенты' });
    expect(
      within(list)
        .getAllByRole('option')
        .map((option) => option.textContent),
    ).toEqual([expect.stringMatching(/^Разбор логов/)]);
    expect(field).toHaveAttribute('role', 'combobox');
    await user.keyboard('{Enter}');

    // Assert: the chip of «+», `@раз` removed, nothing sent yet
    expect(
      await screen.findByRole('group', { name: 'Разбор логов' }),
    ).toBeVisible();
    expect(field).toHaveValue('Собери статус ');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(sendBodies).toEqual([]);

    // Act + Assert: the send carries this record
    await user.type(field, 'по логам{Enter}');
    await waitFor(() =>
      expect(sendBodies).toEqual([
        {
          text: 'Собери статус по логам',
          recordId: RECORD,
          sendKey: expect.any(String),
        },
      ]),
    );
  });
});
