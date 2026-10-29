// chat-shell / web-shell Integration Test — Design Doc: docs/features/chat-shell/design-web-shell.md (v1.2)
// File: shell.list.int.test.tsx — Test Strategy, "Integration Tests (I)"
// Generated: 2026-10-28 | Budget Used: 6/3 integration files (design-mandated, see generation report), 0/2 E2E (L1 checklist instead)
// Test Type: Integration (Vitest + RTL + MSW 2, jsdom, real assistant-ui runtime)
//
// Harness (planned, src/test/): renderWithRuntime(options) from '@/test/render-with-runtime'
//   mounts ChatRuntimeProvider + ChatShell with mocked next/navigation (controlled pathname, router spy).
//   MSW server from '@/test/msw-server' (onUnhandledRequest: 'error'); fixtures from '@/test/fixtures'
//   (built from @agent-os/contracts types, pass ThreadSummarySchema / ThreadListResponseSchema).
//   API base URL in tests: NEXT_PUBLIC_API_URL = 'http://api.test' (vitest.config.ts test.env).
// Mock boundary: network only (MSW) + next/navigation (framework boundary). Runtime, adapters,
//   ShellStatus, components — real. Do NOT mock lib/threads/* or @assistant-ui/*.
// Planned imports for implementation (not imported yet: modules do not exist before the plan runs):
//   import { screen, within, waitFor } from '@testing-library/react';
//   import { http, HttpResponse } from 'msw';
//   import { server } from '@/test/msw-server';
//   import { renderWithRuntime } from '@/test/render-with-runtime';
//   import { threadSummary, sseFromChunks } from '@/test/fixtures';
import { describe, it } from 'vitest';

describe('Shell: thread list errors (FR-01, AC-01.5 / AC-01.7)', () => {
  // AC-01.7: "If ответ GET /api/threads не проходит ThreadListResponseSchema, then the system shall
  //   перевести список в состояние AC-01.5, а композер и «Новый чат» останутся работоспособны."
  // AC-01.5: "If запрос первой страницы завершился ошибкой, then the system shall показать
  //   «Не удалось загрузить беседы» и «Повторить», нажатие которой перезапрашивает первую страницу."
  // EARS: If-then (branch: invalid payload path; valid path covered by shell.new-chat / C tests)
  // ROI: 7.5 | Business Value: 8 (shell must stay usable when list fails) | Frequency: 2 (rare) | Legal: false | Defect Detection: 9 (library swallows errors; adapter must map to loadError)
  // Behavior: GET /api/threads → 200 with body failing schema → sidebar SB-09 Error in role="alert";
  //   composer still accepts input and first send creates a new thread
  // Fails when: the adapter passes the invalid payload through / throws into the React tree / blocks the composer
  // @category: core-functionality
  // @dependency: ThreadListAdapter, threads-api-client, ShellStatus, AppSidebar, ThreadHistoryList, Thread (composer), MSW
  // @complexity: high
  it.todo('AC-01.7: invalid list payload shows sidebar error while composer still sends a new chat' /*
    Arrange:
      - server.use: GET http://api.test/api/threads → 200 JSON { threads: [{ id: 42 }], nextCursor: 'x' }
        (id is a number → fails ThreadListResponseSchema)
      - server.use: POST http://api.test/api/threads → 201 threadSummary({ id: 't-new', title: null })
      - server.use: POST http://api.test/api/chat/assistant → SSE v7 fixture with assistant text "Привет!"
      - renderWithRuntime({ pathname: '/', pointer: 'fine' })
    Act:
      - await screen.findByRole('alert')
      - type "Привет" into textbox named "Сообщение", press Enter
    Assert:
      - within(nav "История бесед"): getByRole('alert') has text "Не удалось загрузить беседы"
      - button "Повторить" is present (outside the alert element)
      - no element with role="status" named "Загружаем беседы…" remains
      - button "Новый чат" is enabled
      - exactly 1 request POST /api/threads, then 1 request POST /api/chat/assistant whose JSON body.id === 't-new'
      - the feed shows "Привет" (user message) and "Привет!" (assistant reply)
  */);

  // AC-01.5 (retry branch): "…нажатие которой перезапрашивает первую страницу."
  // ROI: 7.2 | Business Value: 7 | Frequency: 2 | Legal: false | Defect Detection: 8 (retry must call threads.reload, not no-op)
  // Behavior: first GET /api/threads → 500; click «Повторить» → second GET /api/threads (no cursor) → 200 → list rendered
  // Fails when: «Повторить» does not re-request page 1, requests with a cursor, or error state persists after success
  // @category: core-functionality
  // @dependency: ThreadListAdapter, ThreadHistoryList, MSW
  // @complexity: medium
  it.todo('AC-01.5: «Повторить» after a failed first page re-requests page 1 and renders the list' /*
    Arrange:
      - vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-28T12:00:00+01:00'))  (TZ Europe/Berlin)
      - server.use: GET /api/threads → first call 500 { statusCode: 500, message: 'Internal server error' }, second call 200
        { threads: [threadSummary({ id: 'a', title: 'План релиза', updatedAt: '2026-10-28T10:00:00.000Z' })], nextCursor: null }
      - renderWithRuntime({ pathname: '/' })
    Act:
      - await screen.findByText('Не удалось загрузить беседы'); click button "Повторить"
    Assert:
      - GET /api/threads called exactly 2 times; second request URL has no "cursor" query param
      - heading (h2) "Сегодня" visible; link "План релиза" with href "/chat/a"
      - text "Не удалось загрузить беседы" no longer in the document
  */);
});
