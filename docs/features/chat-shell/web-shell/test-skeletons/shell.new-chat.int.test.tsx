// chat-shell / web-shell Integration Test — Design Doc: docs/features/chat-shell/design-web-shell.md (v1.5)
// File: shell.new-chat.int.test.tsx — Test Strategy, "Integration Tests (I)"
// Generated: 2026-10-30 | Budget Used: 14 skeletons in 7 files (design-mandated: Test Strategy lists 7 integration files; over the 3/5 per-part limit, see generation report), 0/2 E2E (L1 checklist instead)
// ROI = (Business Value x Frequency + Legal x 10 + Defect Detection) / 11 (integration cost total, integration-e2e-testing skill)
// Test Type: Integration (Vitest + RTL + MSW 2, jsdom, real assistant-ui runtime)
//
// Harness (planned, src/test/): renderWithRuntime(options) from '@/test/render-with-runtime'
//   mounts ChatRuntimeProvider + ChatShell with mocked next/navigation (controlled pathname, router spy).
//   MSW server from '@/test/msw-server' (onUnhandledRequest: 'error'); fixtures from '@/test/fixtures'
//   (built from @agent-os/contracts types, pass ThreadSummarySchema / ThreadListResponseSchema).
//   API base URL in tests: NEXT_PUBLIC_API_URL = 'http://api.test' (vitest.config.ts test.env). TZ = 'Europe/Berlin'.
// Mock boundary: network only (MSW) + next/navigation (framework boundary). Runtime, adapters,
//   ShellStatus, components — real. Do NOT mock lib/threads/* or @assistant-ui/*.
// Planned imports for implementation (not imported yet: modules do not exist before the plan runs):
//   import { screen, within, waitFor } from '@testing-library/react';
//   import { http, HttpResponse } from 'msw';
//   import { server } from '@/test/msw-server';
//   import { renderWithRuntime } from '@/test/render-with-runtime';
//   import { threadSummary, historyMessages, sseFromChunks } from '@/test/fixtures';
import { describe, it } from 'vitest';

describe('Shell: new chat lifecycle (FR-03, FR-04, AC-03.2 / AC-03.3 / AC-04.1)', () => {
  // AC-03.2: "If пользователь открыл «Новый чат» и ушёл в другую беседу, ничего не отправив, then the system
  //   shall не создавать беседу и не показывать её в списке (запросов POST /api/threads нет)."
  // EARS: If-then (no-send branch; the send branch is the next two tests)
  // ROI: 7.2 | Business Value: 8 (no junk empty threads in history) | Frequency: 9 | Legal: false | Defect Detection: 7
  // Behavior: on /chat/a click «Новый чат» → / welcome → click link of thread b → zero POST /api/threads, list unchanged
  // Fails when: «Новый чат» eagerly creates a server thread, or a local empty thread leaks into the list
  // @category: core-functionality
  // @dependency: ChatRuntimeProvider, ThreadListAdapter.initialize, AppSidebar, ThreadHistoryList, MSW
  // @complexity: medium
  it.todo('AC-03.2: «Новый чат» then leaving without sending creates no thread and no list item' /*
    Arrange:
      - vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-28T12:00:00+01:00'))
      - GET /api/threads → 200 { threads: [threadSummary({ id: 'a', title: 'Беседа A' }), threadSummary({ id: 'b', title: 'Беседа B' })], nextCursor: null }
      - GET /api/threads/a/messages and /api/threads/b/messages → 200 { messages: historyMessages(2) }
      - POST /api/threads handler counts calls (must stay 0)
      - const { router, setPathname } = renderWithRuntime({ pathname: '/chat/a', pointer: 'fine' })
    Act:
      - click button "Новый чат" → expect router.push('/') → setPathname('/')
      - await screen.findByText('Чем могу помочь?')
      - click link "Беседа B" → setPathname('/chat/b')
    Assert:
      - POST /api/threads call count === 0
      - links inside nav "История бесед": exactly ["Беседа A", "Беседа B"] (2 links, none named "Новая беседа")
      - link "Беседа B" has aria-current="page"
  */);

  // AC-04.1: "When первое сообщение отправлено с /, the system shall заменить URL на /chat/<id> (id из POST /api/threads)
  //   без перезагрузки и без нового запроса страницы."
  // Design sequence: POST /api/threads → onThreadIdChange → history.replaceState → POST /api/chat/assistant { id }
  // ROI: 9.0 | Business Value: 10 (thread persistence + addressable URL) | Frequency: 9 | Legal: false | Defect Detection: 9
  // Behavior: on / type + Enter → POST /api/threads (201 {id:'t-1'}) precedes POST /api/chat/assistant with body.id='t-1';
  //   window.history.replaceState called with '/chat/t-1'; router.push / router.replace not called
  // Fails when: chat request is sent before initialize, carries a local id, URL changes via push/navigation, or URL not updated
  // @category: integration
  // @dependency: ChatRuntimeProvider, AssistantChatTransport, ThreadListAdapter.initialize, url-sync, MSW (SSE v7)
  // @complexity: high
  it.todo('AC-04.1: first send creates the thread, streams with its id and replaces URL with /chat/t-1' /*
    Arrange:
      - GET /api/threads → 200 { threads: [], nextCursor: null }
      - POST /api/threads → 201 threadSummary({ id: 't-1', title: null })
      - POST /api/chat/assistant → SSE v7 from chunk fixture, assistant text "Готово."
      - GET /api/threads/t-1 → 200 threadSummary({ id: 't-1', title: null })  (title poll FR-20; keeps MSW strict mode quiet)
      - const replaceSpy = vi.spyOn(window.history, 'replaceState')
      - const { router } = renderWithRuntime({ pathname: '/', pointer: 'fine' })
    Act:
      - type "Составь план" into textbox "Сообщение"; press Enter
      - await screen.findByText('Готово.')
    Assert:
      - request order: ['POST /api/threads', 'POST /api/chat/assistant'] (recorded via server.events 'request:start')
      - JSON body of POST /api/chat/assistant: body.id === 't-1'; last item of body.messages has role 'user' and text "Составь план"
      - replaceSpy called with (null, '', '/chat/t-1')
      - router.push not called; router.replace not called
  */);

  // AC-03.3: "When отправлено первое сообщение нового чата, the system shall сразу показать новую беседу первой
  //   в «Сегодня», активной, с «Новая беседа»."
  // ROI: 7.2 | Business Value: 8 | Frequency: 9 | Legal: false | Defect Detection: 7 (ThreadActivityTracker + grouping by local activity)
  // Behavior: existing thread updated today 09:00 → first send at 12:00 → «Сегодня» first link = «Новая беседа», aria-current="page"
  // Fails when: new item lands below older ones (grouping by stale server time only), is not active, or shows an empty title
  // @category: core-functionality
  // @dependency: ThreadActivityTracker, ShellStatus.activityAt, groupThreadsByDate, ThreadHistoryItem, MSW
  // @complexity: high
  it.todo('AC-03.3: the new thread appears first in «Сегодня», active, titled «Новая беседа»' /*
    Arrange:
      - vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-28T12:00:00+01:00'))
      - GET /api/threads → 200 { threads: [threadSummary({ id: 'old', title: 'Старая беседа', updatedAt: '2026-10-28T08:00:00.000Z' })], nextCursor: null }
      - POST /api/threads → 201 threadSummary({ id: 't-1', title: null, updatedAt: '2026-10-28T11:00:00.000Z' })
      - POST /api/chat/assistant → SSE v7 fixture ("Готово.")
      - GET /api/threads/t-1 → 200 threadSummary({ id: 't-1', title: null })
      - const { setPathname } = renderWithRuntime({ pathname: '/', pointer: 'fine' })
    Act:
      - type "Привет" into textbox "Сообщение"; press Enter; after replaceState → setPathname('/chat/t-1')
    Assert:
      - group heading h2 "Сегодня"; its first link has accessible name starting with "Новая беседа" and href "/chat/t-1"
      - that link has aria-current="page"; link "Старая беседа" is second and has no aria-current
      - no group headings "Вчера" / "Предыдущие 7 дней" / "Старше"
  */);
});
