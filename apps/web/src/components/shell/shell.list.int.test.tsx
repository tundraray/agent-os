// chat-shell / web-shell Integration Test — Design Doc: docs/features/chat-shell/design-web-shell.md (v1.5)
// File: shell.list.int.test.tsx — Test Strategy, "Integration Tests (I)"
// Generated: 2026-10-30 | Budget Used: 14 skeletons in 7 files (design-mandated: Test Strategy lists 7 integration files; over the 3/5 per-part limit, see generation report), 0/2 E2E (L1 checklist instead)
// Budget after the plan merges: 10 it.todo in 7 files (plan «Решение по бюджету интеграционных тестов»).
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
// Imports for implementation (added when the case is filled; an it.todo case imports nothing):
//   import { screen, within, waitFor } from '@testing-library/react';
//   import { http, HttpResponse } from 'msw';
//   import { server } from '@/test/msw-server';
//   import { renderWithRuntime } from '@/test/render-with-runtime';
//   import { threadSummary, sseFromChunks, assistantTextChunks } from '@/test/fixtures';
import { describe, it } from 'vitest';

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
  it.todo('AC-01.7 + AC-01.5: invalid list payload shows the sidebar error while the composer still sends a new chat; «Повторить» re-requests page 1 and renders the list' /*
    Arrange:
      - vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-28T12:00:00+01:00'))  (TZ Europe/Berlin)
      - server.use: GET http://api.test/api/threads (handler with a call counter; records each request URL):
          call 1 → 200 JSON { threads: [{ id: 42 }], nextCursor: 'x' } (id is a number → fails ThreadListResponseSchema)
          call 2 → 200 { threads: [threadSummary({ id: 't-new', title: null, updatedAt: '2026-10-28T11:00:00.000Z' }),
                                   threadSummary({ id: 'a', title: 'План релиза', updatedAt: '2026-10-28T10:00:00.000Z' })], nextCursor: null }
            (the thread created by the send is on the server by now)
      - server.use: POST http://api.test/api/threads → 201 threadSummary({ id: 't-new', title: null })
      - server.use: POST http://api.test/api/chat/assistant → SSE v7 fixture with assistant text "Привет!"
      - server.use: GET http://api.test/api/threads/t-new → 200 threadSummary({ id: 't-new', title: null })
        (title poll FR-20; keeps MSW strict mode quiet)
      - renderWithRuntime({ pathname: '/', pointer: 'fine' })
    Act 1:
      - await screen.findByRole('alert')
      - type "Привет" into textbox named "Сообщение", press Enter
      - await screen.findByText('Привет!')
    Assert 1 (AC-01.7):
      - within(nav "История бесед"): getByRole('alert') has text "Не удалось загрузить беседы"
      - button "Повторить" is present (outside the alert element)
      - no element with role="status" named "Загружаем беседы…" remains
      - button "Новый чат" is enabled
      - exactly 1 request POST /api/threads, then 1 request POST /api/chat/assistant whose JSON body.id === 't-new'
      - the feed shows "Привет" (user message) and "Привет!" (assistant reply)
    Act 2 (AC-01.5 retry):
      - click button "Повторить"
      - await screen.findByRole('link', { name: 'План релиза' })
    Assert 2:
      - GET /api/threads called exactly 2 times; second request URL has no "cursor" query param
      - heading (h2) "Сегодня" visible; link "План релиза" with href "/chat/a"
      - text "Не удалось загрузить беседы" no longer in the document
  */);
});
