// chat-shell / web-shell Integration Test — Design Doc: docs/features/chat-shell/design-web-shell.md (v1.5)
// File: shell.deleted-thread.int.test.tsx — Test Strategy, "Integration Tests (I)"
// Generated: 2026-10-30 | Budget Used: 14 skeletons in 7 files (design-mandated: Test Strategy lists 7 integration files; over the 3/5 per-part limit, see generation report), 0/2 E2E (L1 checklist instead)
// Budget after the plan merges: 10 it.todo in 7 files (plan «Решение по бюджету интеграционных тестов»).
// ROI = (Business Value x Frequency + Legal x 10 + Defect Detection) / 11 (integration cost total, integration-e2e-testing skill)
// Test Type: Integration (Vitest + RTL + MSW 2, jsdom, real assistant-ui runtime)
//
// Harness (src/test/): renderWithRuntime(options) from '@/test/render-with-runtime'
//   mounts ChatRuntimeProvider + ChatShell with mocked next/navigation (controlled pathname, router spy).
//   MSW server from '@/test/msw-server' (onUnhandledRequest: 'error'); fixtures from '@/test/fixtures'.
//   API base URL in tests: NEXT_PUBLIC_API_URL = 'http://api.test' (vitest.config.ts test.env). TZ = 'Europe/Berlin'.
// Mock boundary: network only (MSW) + next/navigation (framework boundary). Runtime, adapters,
//   ShellStatus, handleChatError, components — real. Do NOT mock lib/threads/* or @assistant-ui/*.
// Imports for implementation (added when the case is filled; an it.todo case imports nothing):
//   import { screen, within } from '@testing-library/react';
//   import { http, HttpResponse } from 'msw';
//   import { server } from '@/test/msw-server';
//   import { renderWithRuntime } from '@/test/render-with-runtime';
//   import { threadSummary } from '@/test/fixtures';
import { describe, it } from 'vitest';

describe('Shell: sending into a thread deleted elsewhere (AC-08.5e, UXRD E-8 / TH-07 "Deleted while open")', () => {
  // AC-08.5e: "If отправка получила 404 THREAD_NOT_FOUND (беседу удалили в другой вкладке), then the system shall
  //   оставить ленту видимой, показать под сообщением пользователя вместо блока ошибки уведомление «Беседа удалена» /
  //   «Её удалили в другой вкладке или окне.» с кнопкой «Новый чат» и без «Перегенерировать» и скрыть композер."
  // Traces: PRD FR-06 / AC-16.1 (deleted thread does not "resurrect"); design Element 2 (slot ThreadComponents.DeletedNotice,
  //   rendered by MessageError instead of the TH-08 block; Thread hides the composer when the slot is set);
  //   design Error Handling row "Отправка в удалённую беседу".
  // EARS: If-then (404 THREAD_NOT_FOUND branch of POST /api/chat/assistant; other failures = TH-08, covered by
  //   message-error.test.tsx and shell.message-error.int.test.tsx)
  // ROI: 2.1 | Business Value: 7 (user text not lost, no zombie thread) | Frequency: 2 (multi-tab only) | Legal: false | Defect Detection: 9 (onError classification of a body-less APICallError is easy to break on ai / @assistant-ui upgrades)
  // Behavior: /chat/a open with history → send "Ещё вопрос" → POST /api/chat/assistant 404 { errorCode: 'THREAD_NOT_FOUND' }
  //   → under the user message an inline notice «Беседа удалена» + «Новый чат» (no TH-08 block, no «Перегенерировать»);
  //   composer hidden; feed stays; no assistant stub row
  // Primary failure mode: the 404 is shown as the generic TH-08 block (or its English server text) instead of the notice,
  //   the composer stays enabled, the user message disappears, or a silent POST /api/threads resurrects the thread
  // @category: edge-case
  // @dependency: ChatRuntimeProvider.handleChatError, ShellStatus (deleted), Thread (composer hidden), MessageError + DeletedNotice slot, MSW
  // @complexity: high
  it.todo('AC-08.5e: 404 THREAD_NOT_FOUND on send shows the inline «Беседа удалена» notice instead of the error block, hides the composer, keeps the feed' /*
    Arrange:
      - GET /api/threads → 200 { threads: [threadSummary({ id: 'a', title: 'Беседа A' })], nextCursor: null }
      - GET /api/threads/a/messages → 200 { messages: [user "Первый вопрос", assistant "Первый ответ"] }
      - POST /api/chat/assistant → 404 JSON { statusCode: 404, message: 'Thread not found', errorCode: 'THREAD_NOT_FOUND' } (no SSE; handler records the call)
      - POST /api/threads handler counts calls (must stay 0)
      - const { router, setPathname } = renderWithRuntime({ pathname: '/chat/a', pointer: 'fine' })
      - await screen.findByText('Первый ответ')
    Act:
      - type "Ещё вопрос" into textbox "Сообщение"; press Enter
      - await screen.findByText('Беседа удалена')
    Assert (notice, in place of the TH-08 block):
      - text "Её удалили в другой вкладке или окне." visible
      - the notice follows the user message "Ещё вопрос" in document order (compareDocumentPosition FOLLOWING)
      - heading role absent for «Беседа удалена» (inline notice, not a screen: queryByRole('heading', { name: 'Беседа удалена' }) === null)
      - button "Новый чат" inside the notice container has accessible description "Её удалили в другой вкладке или окне." (aria-describedby)
      - queryAllByRole('button', { name: 'Перегенерировать' }).length === 0
      - text "Не удалось получить ответ" (regex) absent; text "Thread not found" absent
    Assert (feed and composer):
      - queryByRole('textbox', { name: 'Сообщение' }) === null (composer hidden)
      - "Первый вопрос", "Первый ответ", "Ещё вопрос" visible
      - container.querySelectorAll('[data-role="assistant"]').length === 1 (only the restored "Первый ответ"; no stub row for the failed reply)
      - getAllByRole('button', { name: 'Копировать' }).length === 3 (two user messages + the restored reply; none for the stub)
    Assert (no resurrection):
      - POST /api/chat/assistant called exactly once; POST /api/threads call count === 0
    Act 2 (continuation of the same test):
      - click button "Новый чат" inside the notice
    Assert 2:
      - router.push called with '/'; after setPathname('/'): text "Чем могу помочь?" visible and textbox "Сообщение" present
  */);
});
