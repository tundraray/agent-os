// chat-shell / web-shell Integration Test — Design Doc: docs/features/chat-shell/design-web-shell.md (v1.9);
//   routes and stream: docs/features/agent-platform/design-web.md (v1.1, KD-1)
// File: shell.open-thread.int.test.tsx — Test Strategy, "Integration Tests (I)"
// Generated: 2026-10-30 | Budget Used: 10 skeletons in 7 files (design-mandated: Test Strategy lists 7 integration files; over the 3/5 per-part limit, see generation report), 0/2 E2E (L1 checklist instead)
// Budget after the plan merges: 10 tests in 7 files, all implemented — no it.todo left (plan «Решение по бюджету интеграционных тестов»).
// ROI = (Business Value x Frequency + Legal x 10 + Defect Detection) / 11 (integration cost total, integration-e2e-testing skill)
// Test Type: Integration (Vitest + RTL + MSW 2, jsdom, real assistant-ui runtime over the feed store)
//
// Harness (src/test/): renderWithRuntime(options) from '@/test/render-with-runtime'
//   mounts ChatRuntimeProvider + ChatShell with mocked next/navigation (controlled pathname, router spy) and a test
//   event source for LiveStore.
//   MSW server from '@/test/msw-server' (onUnhandledRequest: 'error'); fixtures from '@/test/fixtures'
//   (built from @agent-os/contracts types, pass ThreadSummarySchema / ConversationViewSchema).
//   API base URL in tests: NEXT_PUBLIC_API_URL = 'http://api.test' (vitest.config.ts test.env). TZ = 'Europe/Berlin'.
//   deferred(): controllable promise used to hold an MSW response (design: "управляемый deferred").
// Mock boundary: network only (MSW) + the live event source + next/navigation (framework boundary). Runtime, stores,
//   adapters, ShellStatus, components — real. Do NOT mock lib/threads/*, lib/feed/*, lib/live/* or @assistant-ui/*.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, onTestFinished } from 'vitest';
import { conversationWithTurns, deferred, threadList, threadSummary } from '@/test/fixtures';
import { server } from '@/test/msw-server';
import { renderWithRuntime } from '@/test/render-with-runtime';

const API = 'http://api.test';

describe('Shell: opening a thread by URL (FR-02, FR-04, AC-02.2 / AC-02.5 / AC-04.3)', () => {
  // AC-02.2: "While история загружается (или ещё разрешается беседа по прямой ссылке), the system shall показывать
  //   скелетон ленты, а не приветствие."
  // AC-04.3 (merged into this test: the same deferred on GET /api/threads/x, released with a 404):
  //   "If /chat/<id> чужой или несуществующей беседы, then the system shall показать TH-06 «Беседа не найдена»
  //   с «Новый чат», фокус на h1 экрана." The 404 classification itself is proven by the unit threads-api-client.test.ts.
  // EARS: While (state: thread not yet resolved), then If-then (404 branch; the 200 branch is covered by the F5 and AC-02.5 tests below)
  // ROI: 5.8 | Business Value: 7 (no misleading empty chat) | Frequency: 8 | Legal: false | Defect Detection: 8
  // ROI (AC-04.3): 3.0 | Business Value: 8 (no data leak, clear dead end) | Frequency: 3 | Legal: false | Defect Detection: 9
  // Behavior: pathname /chat/x, x not in page 1, GET /api/threads/x held by a deferred → skeleton
  //   (role="status" «Загружаем беседу…»), never «Чем могу помочь?»; after release with 404 THREAD_NOT_FOUND →
  //   focused h1 «Беседа не найдена» + «Новый чат»; no composer
  // Fails when: resolveMainView returns 'thread' while switching (welcome flashes for a direct link);
  //   the 404 shows the welcome/empty feed, switchError does not reach TH-06, the server message leaks into UI, or focus stays on body
  // @category: core-functionality
  // @dependency: resolveMainView, MainView, ThreadListAdapter.fetch (switchError), ThreadNotice, MSW
  // @complexity: medium
  it('AC-02.2 + AC-04.3: a direct link shows the feed skeleton, not the welcome, while the thread is resolving; a 404 then shows «Беседа не найдена» with focus on its h1', async () => {
    // Arrange
    server.use(http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([]))));
    const fetchGate = deferred();
    const fetchStarted = deferred();
    server.use(
      http.get(`${API}/api/threads/x`, async () => {
        fetchStarted.resolve();
        await fetchGate.promise;
        return HttpResponse.json(
          { statusCode: 404, message: 'Thread not found', errorCode: 'THREAD_NOT_FOUND' },
          { status: 404 },
        );
      }),
    );
    // No handler for GET /api/threads/x/history or any POST: such a request fails the test (onUnhandledRequest: 'error').
    const requests: string[] = [];
    const recordRequest = ({ request }: { request: Request }) => {
      requests.push(`${request.method} ${new URL(request.url).pathname}`);
    };
    server.events.on('request:start', recordRequest);
    onTestFinished(() => {
      server.events.removeListener('request:start', recordRequest);
    });
    const user = userEvent.setup();
    renderWithRuntime({ pathname: '/chat/x' });

    // Act: GET /api/threads/x is held
    await fetchStarted.promise;

    // Assert (while pending, AC-02.2)
    expect(await screen.findByRole('status', { name: 'Загружаем беседу…' })).toBeInTheDocument();
    expect(screen.queryByText('Чем могу помочь?')).toBeNull();

    // Assert (while pending, UXRD 6.17): the composer is visible and editable, sending is blocked
    const composer = screen.getByRole('textbox', { name: 'Сообщение' });
    await user.type(composer, 'Привет');
    expect(composer).toHaveValue('Привет');
    expect(screen.getByRole('button', { name: 'Отправить' })).toBeDisabled();
    await user.keyboard('{Enter}');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(composer).toHaveValue('Привет');
    expect(requests.filter((entry) => entry.startsWith('POST '))).toEqual([]);

    // Act: release the 404
    fetchGate.resolve();
    const heading = await screen.findByRole('heading', { level: 1, name: 'Беседа не найдена' });

    // Assert (after the 404, AC-04.3)
    expect(screen.getByText('Возможно, её удалили или ссылка указана неверно.')).toBeInTheDocument();
    const notice = screen.getByRole('region', { name: 'Беседа не найдена' });
    expect(within(notice).getByRole('button', { name: 'Новый чат' })).toBeInTheDocument();
    await waitFor(() => expect(heading).toHaveFocus());
    expect(screen.queryByRole('textbox', { name: 'Сообщение' })).toBeNull();
    expect(screen.queryByText('Thread not found')).toBeNull();
    expect(screen.queryByText('Чем могу помочь?')).toBeNull();
    expect(screen.queryByRole('status', { name: 'Загружаем беседу…' })).toBeNull();
    // HD-03 on TH-06 (DD State × Display Matrix «TH-06/07: пусто»): neither the loading skeleton nor «Новый чат».
    const pageTitle = screen.getAllByRole('heading', { level: 1 }).find((h) => h !== heading);
    expect(pageTitle).toHaveTextContent('');
    expect(pageTitle).not.toHaveAttribute('aria-busy');
    expect(requests.filter((entry) => entry.startsWith('POST '))).toEqual([]);
  });

  // AC-02.2 rule 4 (F5 case; also backs AC-04.2): list slower than history — welcome must never flash.
  // ROI: 5.9 | Business Value: 7 | Frequency: 8 (every F5 on a thread) | Legal: false | Defect Detection: 9 (race from review I001)
  // Behavior: pathname /chat/x, x is in page 1; GET /api/threads held by a deferred; GET /api/threads/x/history held until
  //   the history load is observed (skeleton on screen), then released before the list. A response sent at once settles in
  //   the same task as the switch and would leave no frame to observe. MutationObserver records any appearance of
  //   «Чем могу помочь?» → record stays empty; the skeleton stays until the messages render.
  // Fails when: the main area leaves the skeleton before the URL thread's messages are in the runtime — the feed store
  //   reports 'ready' to ShellStatus before the runtime has the messages (MainView loading guard). Rule 4 of resolveMainView
  //   is proven by its rows in resolve-main-view.test.ts; here the loading guard also covers it, so removing rule 4
  //   alone leaves this case green.
  // @category: edge-case
  // @dependency: resolveMainView (rule 4), ShellStatus.history, FeedStore, useFeedRuntime, MSW
  // @complexity: high
  it('AC-02.2 (F5): the welcome never appears when the list resolves after the history', async () => {
    // Arrange
    const listGate = deferred();
    const messagesStarted = deferred();
    const messagesGate = deferred();
    server.use(
      http.get(`${API}/api/threads`, async () => {
        await listGate.promise;
        return HttpResponse.json(threadList([threadSummary({ id: 'x', title: 'Отчёт' })]));
      }),
      http.get(`${API}/api/threads/x`, () => HttpResponse.json(threadSummary({ id: 'x', title: 'Отчёт' }))),
      http.get(`${API}/api/threads/x/history`, async () => {
        messagesStarted.resolve();
        await messagesGate.promise;
        return HttpResponse.json(conversationWithTurns(threadSummary({ id: 'x', title: 'Отчёт' }), ['Вопрос', 'Ответ']));
      }),
    );
    const seenWelcome: string[] = [];
    const skeletonGoneEarly: string[] = [];
    const { container } = renderWithRuntime({ pathname: '/chat/x' });
    const record = () => {
      const text = container.textContent ?? '';
      if (text.includes('Чем могу помочь?')) seenWelcome.push(text);
      if (!text.includes('Ответ') && !text.includes('Загружаем беседу…')) skeletonGoneEarly.push(text);
    };
    record();
    const observer = new MutationObserver(record);
    observer.observe(container, { subtree: true, childList: true, characterData: true });
    onTestFinished(() => observer.disconnect());

    // Act: the history load is in flight while the list is held; the history answers first, then the list
    await messagesStarted.promise;
    expect(await screen.findByRole('status', { name: 'Загружаем беседу…' })).toBeInTheDocument();
    messagesGate.resolve();
    await screen.findByText('Ответ');
    listGate.resolve();
    const history = screen.getByRole('navigation', { name: 'История бесед' });
    const link = await within(history).findByRole('link', { name: 'Отчёт' });

    // Assert
    expect(seenWelcome).toEqual([]);
    expect(skeletonGoneEarly).toEqual([]);
    expect(screen.getByText('Вопрос')).toBeInTheDocument();
    expect(screen.getByText('Ответ')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Загружаем беседу…' })).toBeNull();
    await waitFor(() => expect(link).toHaveAttribute('aria-current', 'page'));
  });

  // AC-02.5: "If ответ GET /api/threads/:id/history не проходит ConversationViewSchema,
  //   then the system shall показать TH-07 с «Повторить» и «Новый чат», а сайдбар и шапка останутся работоспособны."
  // EARS: If-then (invalid branch → retry → valid branch)
  // ROI: 2.4 | Business Value: 8 | Frequency: 2 | Legal: false | Defect Detection: 10 (library swallows history errors; only ShellStatus surfaces them)
  // Behavior: /history call 1 → 200 invalid body → TH-07; click «Повторить» → call 2 → valid → messages rendered
  // Fails when: invalid history renders the welcome (swallowed error), «Повторить» does not re-request, or the sidebar breaks
  // @category: core-functionality
  // @dependency: FeedStore (load error), ShellStatus, ThreadNotice, ShellActions.retryHistory, MSW
  // @complexity: high
  it('AC-02.5: invalid history shows «Не удалось загрузить беседу»; «Повторить» loads the messages', async () => {
    // Arrange
    let messageCalls = 0;
    server.use(
      http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([threadSummary({ id: 'x', title: 'Отчёт' })]))),
      // The runtime resolves the URL thread before page 1 arrives.
      http.get(`${API}/api/threads/x`, () => HttpResponse.json(threadSummary({ id: 'x', title: 'Отчёт' }))),
      http.get(`${API}/api/threads/x/history`, () => {
        messageCalls += 1;
        if (messageCalls === 1) return HttpResponse.json({ thread: { id: 'x' }, entries: [{ seq: 1, kind: 'robot' }] });
        return HttpResponse.json(conversationWithTurns(threadSummary({ id: 'x', title: 'Отчёт' }), ['Вопрос', 'Ответ']));
      }),
    );
    const user = userEvent.setup();
    renderWithRuntime({ pathname: '/chat/x' });

    // Act: the invalid history surfaces TH-07
    const heading = await screen.findByRole('heading', { level: 1, name: 'Не удалось загрузить беседу' });

    // Assert (before retry)
    expect(screen.getByText('Проверьте подключение и попробуйте ещё раз.')).toBeInTheDocument();
    const notice = screen.getByRole('region', { name: 'Не удалось загрузить беседу' });
    expect(within(notice).getByRole('button', { name: 'Новый чат' })).toBeInTheDocument();
    const retry = within(notice).getByRole('button', { name: 'Повторить' });
    expect(screen.queryByText('Чем могу помочь?')).toBeNull();
    const history = screen.getByRole('navigation', { name: 'История бесед' });
    expect(within(history).getByRole('link', { name: 'Отчёт' })).toHaveAttribute('href', '/chat/x');

    // Act: retry
    await user.click(retry);
    await screen.findByText('Ответ');

    // Assert (after retry)
    expect(messageCalls).toBe(2);
    expect(screen.getByText('Вопрос')).toBeInTheDocument();
    expect(heading).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Не удалось загрузить беседу' })).toBeNull();
    expect(within(history).getByRole('link', { name: 'Отчёт' })).toBeInTheDocument();
  });
});
