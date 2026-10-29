// chat-shell / web-shell Integration Test — Design Doc: docs/features/chat-shell/design-web-shell.md (v1.2)
// File: shell.deleted-thread.int.test.tsx — Test Strategy, "Integration Tests (I)"
// Generated: 2026-10-28 | Budget Used: 6/3 integration files (design-mandated, see generation report), 0/2 E2E (L1 checklist instead)
// Test Type: Integration (Vitest + RTL + MSW 2, jsdom, real assistant-ui runtime)
//
// Harness (planned, src/test/): renderWithRuntime(options) from '@/test/render-with-runtime'
//   mounts ChatRuntimeProvider + ChatShell with mocked next/navigation (controlled pathname, router spy).
//   MSW server from '@/test/msw-server' (onUnhandledRequest: 'error'); fixtures from '@/test/fixtures'.
//   API base URL in tests: NEXT_PUBLIC_API_URL = 'http://api.test' (vitest.config.ts test.env). TZ = 'Europe/Berlin'.
// Mock boundary: network only (MSW) + next/navigation (framework boundary). Runtime, adapters,
//   ShellStatus, components — real. Do NOT mock lib/threads/* or @assistant-ui/*.
// Planned imports for implementation (not imported yet: modules do not exist before the plan runs):
//   import { screen, within } from '@testing-library/react';
//   import { http, HttpResponse } from 'msw';
//   import { server } from '@/test/msw-server';
//   import { renderWithRuntime } from '@/test/render-with-runtime';
//   import { threadSummary } from '@/test/fixtures';
import { describe, it } from 'vitest';

describe('Shell: sending into a thread deleted elsewhere (E-8, FR-06 / AC-16.1 consumer side)', () => {
  // E-8 (UXRD 4.10, design Element 2 "ComposerReplacement"): "при 404 THREAD_NOT_FOUND от чата показать «Беседа удалена»
  //   с «Новый чат», а набранное сообщение остаётся видимым в ленте."
  // Traces: PRD FR-06 / AC-16.1 (deleted thread does not "resurrect"); design Error Handling row "Отправка в удалённую беседу".
  // EARS: If-then (404 THREAD_NOT_FOUND branch of POST /api/chat/assistant)
  // ROI: 6.6 | Business Value: 7 (user text not lost, no zombie thread) | Frequency: 1 (multi-tab only) | Legal: false | Defect Detection: 9 (APICallError mapping is easy to break on ai upgrades)
  // Behavior: /chat/a open with history → send "Ещё вопрос" → POST /api/chat/assistant 404 { errorCode: 'THREAD_NOT_FOUND' }
  //   → composer replaced by h2 «Беседа удалена» + «Новый чат»; user message stays in the feed
  // Fails when: 404 shows the generic model error (TH-08) or English responseBody, the composer remains, or the user message disappears
  // @category: edge-case
  // @dependency: ChatRuntimeProvider.handleChatError, ShellStatus (deleted), Thread ComposerReplacement, ThreadNotice(DeletedNotice), MSW
  // @complexity: high
  it.todo('E-8: 404 THREAD_NOT_FOUND on send replaces the composer with «Беседа удалена» and keeps the user message' /*
    Arrange:
      - GET /api/threads → 200 { threads: [threadSummary({ id: 'a', title: 'Беседа A' })], nextCursor: null }
      - GET /api/threads/a/messages → 200 { messages: [user "Первый вопрос", assistant "Первый ответ"] }
      - POST /api/chat/assistant → 404 JSON { statusCode: 404, message: 'Thread not found', errorCode: 'THREAD_NOT_FOUND' }
      - renderWithRuntime({ pathname: '/chat/a', pointer: 'fine' })
      - await screen.findByText('Первый ответ')
    Act:
      - type "Ещё вопрос" into textbox "Сообщение"; press Enter
      - await screen.findByRole('heading', { level: 2, name: 'Беседа удалена' })
    Assert:
      - text "Её удалили в другой вкладке или окне." visible; button "Новый чат" inside the notice
      - queryByRole('textbox', { name: 'Сообщение' }) === null (composer replaced)
      - getByText('Ещё вопрос') visible in the feed; "Первый вопрос" and "Первый ответ" still visible
      - text "Thread not found" absent; text "Не удалось получить ответ. Попробуйте перегенерировать." absent
      - POST /api/threads not called (no silent new thread)
  */);
});
