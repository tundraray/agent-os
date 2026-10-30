// chat-shell / web-shell Integration Test — Design Doc: docs/features/chat-shell/design-web-shell.md (v1.5)
// File: shell.open-thread.int.test.tsx — Test Strategy, "Integration Tests (I)"
// Generated: 2026-10-30 | Budget Used: 14 skeletons in 7 files (design-mandated: Test Strategy lists 7 integration files; over the 3/5 per-part limit, see generation report), 0/2 E2E (L1 checklist instead)
// ROI = (Business Value x Frequency + Legal x 10 + Defect Detection) / 11 (integration cost total, integration-e2e-testing skill)
// Test Type: Integration (Vitest + RTL + MSW 2, jsdom, real assistant-ui runtime)
//
// Harness (planned, src/test/): renderWithRuntime(options) from '@/test/render-with-runtime'
//   mounts ChatRuntimeProvider + ChatShell with mocked next/navigation (controlled pathname, router spy).
//   MSW server from '@/test/msw-server' (onUnhandledRequest: 'error'); fixtures from '@/test/fixtures'
//   (built from @agent-os/contracts types, pass ThreadSummarySchema / ThreadMessagesResponseSchema).
//   API base URL in tests: NEXT_PUBLIC_API_URL = 'http://api.test' (vitest.config.ts test.env). TZ = 'Europe/Berlin'.
//   deferred(): controllable promise used to hold an MSW response (design: "управляемый deferred").
// Mock boundary: network only (MSW) + next/navigation (framework boundary). Runtime, adapters,
//   ShellStatus, components — real. Do NOT mock lib/threads/* or @assistant-ui/*.
// Planned imports for implementation (not imported yet: modules do not exist before the plan runs):
//   import { screen, within, waitFor } from '@testing-library/react';
//   import { http, HttpResponse } from 'msw';
//   import { server } from '@/test/msw-server';
//   import { renderWithRuntime } from '@/test/render-with-runtime';
//   import { threadSummary, historyMessages, deferred } from '@/test/fixtures';
import { describe, it } from 'vitest';

describe('Shell: opening a thread by URL (FR-02, FR-04, AC-02.2 / AC-02.5 / AC-04.3)', () => {
  // AC-02.2: "While история загружается (или ещё разрешается беседа по прямой ссылке), the system shall показывать
  //   скелетон ленты, а не приветствие."
  // EARS: While (state: thread not yet resolved)
  // ROI: 5.8 | Business Value: 7 (no misleading empty chat) | Frequency: 8 | Legal: false | Defect Detection: 8
  // Behavior: pathname /chat/x, x not in page 1, GET /api/threads/x held by a deferred → skeleton
  //   (role="status" «Загружаем беседу…»), never «Чем могу помочь?»; after release → messages
  // Fails when: resolveMainView returns 'thread' while switching (welcome flashes for a direct link)
  // @category: core-functionality
  // @dependency: resolveMainView, MainView, ThreadListAdapter.fetch, ThreadHistoryAdapter, MSW
  // @complexity: medium
  it.todo('AC-02.2: a direct link shows the feed skeleton, not the welcome, while the thread is resolving' /*
    Arrange:
      - GET /api/threads → 200 { threads: [], nextCursor: null }
      - const fetchGate = deferred(); GET /api/threads/x → await fetchGate.promise → 200 threadSummary({ id: 'x', title: 'Отчёт' })
      - GET /api/threads/x/messages → 200 { messages: [user "Вопрос", assistant "Ответ"] }
      - renderWithRuntime({ pathname: '/chat/x' })
    Act:
      - wait until GET /api/threads/x is pending (server.events 'request:start'); inspect DOM; then fetchGate.resolve()
    Assert:
      - while pending: getByRole('status', { name: 'Загружаем беседу…' }) present; queryByText('Чем могу помочь?') === null
        (skeleton appears after 150 ms — advance timers / use findByRole)
      - after resolve: getByText('Вопрос') and getByText('Ответ') visible; queryByText('Чем могу помочь?') === null
  */);

  // AC-02.2 rule 4 (F5 case; also backs AC-04.2): list slower than history — welcome must never flash.
  // ROI: 5.9 | Business Value: 7 | Frequency: 8 (every F5 on a thread) | Legal: false | Defect Detection: 9 (race from review I001)
  // Behavior: pathname /chat/x, x is in page 1; /messages answers immediately, GET /api/threads held by a deferred;
  //   MutationObserver records any appearance of «Чем могу помочь?» → record stays empty; feed shows messages
  // Fails when: the view is resolved as 'thread' before history status is 'ready' for the URL thread (F5 flashes welcome)
  // @category: edge-case
  // @dependency: resolveMainView (rule 4), ShellStatus.history, ThreadHistoryAdapter, MSW
  // @complexity: high
  it.todo('AC-02.2 (F5): the welcome never appears when the list resolves after the history' /*
    Arrange:
      - const listGate = deferred(); GET /api/threads → await listGate.promise → 200 { threads: [threadSummary({ id: 'x', title: 'Отчёт' })], nextCursor: null }
      - GET /api/threads/x → 200 threadSummary({ id: 'x', title: 'Отчёт' })
      - GET /api/threads/x/messages → 200 immediately { messages: [user "Вопрос", assistant "Ответ"] }
      - const seenWelcome: string[] = []; MutationObserver on the render container (subtree, childList, characterData)
        pushes a record whenever container.textContent includes 'Чем могу помочь?'
      - renderWithRuntime({ pathname: '/chat/x' })
    Act:
      - await the /messages response; then listGate.resolve(); await screen.findByText('Ответ')
    Assert:
      - seenWelcome.length === 0
      - getByText('Вопрос'), getByText('Ответ') visible
      - sidebar link "Отчёт" has aria-current="page"
  */);

  // AC-04.3: "If /chat/<id> чужой или несуществующей беседы, then the system shall показать TH-06 «Беседа не найдена»
  //   с «Новый чат», фокус на h1 экрана."
  // EARS: If-then (404 branch; the 200 branch is covered by the tests above)
  // ROI: 3.0 | Business Value: 8 (no data leak, clear dead end) | Frequency: 3 | Legal: false | Defect Detection: 9
  // Behavior: GET /api/threads/does-not-exist → 404 THREAD_NOT_FOUND → focused h1 «Беседа не найдена» + «Новый чат»; no composer
  // Fails when: 404 shows the welcome/empty feed, the server message leaks into UI, or focus stays on body
  // @category: core-functionality
  // @dependency: ThreadListAdapter.fetch (switchError), ThreadNotice, MainView, MSW
  // @complexity: medium
  it.todo('AC-04.3: an unknown thread id shows «Беседа не найдена» with focus on its h1' /*
    Arrange:
      - GET /api/threads → 200 { threads: [], nextCursor: null }
      - GET /api/threads/does-not-exist → 404 { statusCode: 404, message: 'Thread not found', errorCode: 'THREAD_NOT_FOUND' }
      - renderWithRuntime({ pathname: '/chat/does-not-exist' })
    Act:
      - await screen.findByRole('heading', { level: 1, name: 'Беседа не найдена' })
    Assert:
      - text "Возможно, её удалили или ссылка указана неверно." visible
      - button "Новый чат" inside the notice
      - document.activeElement is the h1 "Беседа не найдена"
      - queryByRole('textbox', { name: 'Сообщение' }) === null
      - text "Thread not found" absent
  */);

  // AC-02.5: "If ответ GET /api/threads/:id/messages не проходит ThreadMessagesResponseSchema или safeValidateUIMessages,
  //   then the system shall показать TH-07 с «Повторить» и «Новый чат», а сайдбар и шапка останутся работоспособны."
  // EARS: If-then (invalid branch → retry → valid branch)
  // ROI: 2.4 | Business Value: 8 | Frequency: 2 | Legal: false | Defect Detection: 10 (library swallows history errors; only ShellStatus surfaces them)
  // Behavior: /messages call 1 → 200 invalid body → TH-07; click «Повторить» → call 2 → valid → messages rendered
  // Fails when: invalid history renders the welcome (swallowed error), «Повторить» does not re-request, or the sidebar breaks
  // @category: core-functionality
  // @dependency: ThreadHistoryAdapter, RetryGate, ShellStatus, ThreadNotice, ShellActions.retryHistory, MSW
  // @complexity: high
  it.todo('AC-02.5: invalid history shows «Не удалось загрузить беседу»; «Повторить» loads the messages' /*
    Arrange:
      - GET /api/threads → 200 { threads: [threadSummary({ id: 'x', title: 'Отчёт' })], nextCursor: null }
      - GET /api/threads/x/messages → call 1: 200 { messages: [{ id: 'm1', role: 'robot', parts: [] }] } (fails schema);
                                       call 2: 200 { messages: [user "Вопрос", assistant "Ответ"] }
      - renderWithRuntime({ pathname: '/chat/x' })
    Act:
      - await screen.findByRole('heading', { level: 1, name: 'Не удалось загрузить беседу' })
      - click button "Повторить"
    Assert (before retry):
      - text "Проверьте подключение и попробуйте ещё раз." visible; buttons "Повторить" and "Новый чат" present
      - queryByText('Чем могу помочь?') === null
      - sidebar link "Отчёт" still present
    Assert (after retry):
      - GET /api/threads/x/messages called exactly 2 times
      - getByText('Вопрос'), getByText('Ответ') visible; heading "Не удалось загрузить беседу" gone
  */);
});
