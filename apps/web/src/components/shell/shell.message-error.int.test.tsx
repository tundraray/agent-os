// chat-shell / web-shell Integration Test — Design Doc: docs/features/chat-shell/design-web-shell.md (v1.5)
// File: shell.message-error.int.test.tsx — Test Strategy, "Integration Tests (I)" (new in v1.3, AC-08.5b)
// Generated: 2026-10-30 | Budget Used: 14 skeletons in 7 files (design-mandated: Test Strategy lists 7 integration files; over the 3/5 per-part limit, see generation report), 0/2 E2E (L1 checklist instead)
// Budget after the plan merges: 10 it.todo in 7 files (plan «Решение по бюджету интеграционных тестов»).
// ROI = (Business Value x Frequency + Legal x 10 + Defect Detection) / 11 (integration cost total, integration-e2e-testing skill)
// Test Type: Integration (Vitest + RTL + MSW 2, jsdom, REAL useChatRuntime / AI SDK Chat — not useLocalRuntime)
//
// Why integration and not the component test: message-error.test.tsx runs Thread on useLocalRuntime, where the error is a
//   property of the message. In the real useChatRuntime the error is chat-wide state (`chat.error`), shown only on the LAST
//   message and reset by the next send (design "Action bar и ошибки в ленте", «Только последний ответ»). Only the real runtime
//   can turn red when that assumption breaks after an @assistant-ui / ai upgrade.
//
// Harness (src/test/): renderWithRuntime(options) from '@/test/render-with-runtime'
//   mounts ChatRuntimeProvider + ChatShell with mocked next/navigation (controlled pathname, router spy).
//   MSW server from '@/test/msw-server' (onUnhandledRequest: 'error'); fixtures from '@/test/fixtures'
//   (sseFromChunks builds SSE v7 from a chunk list; a chunk { type: 'error', errorText } ends the stream with a model error).
//   API base URL in tests: NEXT_PUBLIC_API_URL = 'http://api.test' (vitest.config.ts test.env). TZ = 'Europe/Berlin'.
//   Config flag regenerateAfterError stays at its shipped value (true).
// Mock boundary: network only (MSW) + next/navigation (framework boundary). Runtime, adapters,
//   ShellStatus, MessageError, components — real. Do NOT mock lib/threads/*, lib/config.ts or @assistant-ui/*.
// Imports for implementation (added when the case is filled; an it.todo case imports nothing):
//   import { screen, within, waitFor } from '@testing-library/react';
//   import { http, HttpResponse } from 'msw';
//   import { server } from '@/test/msw-server';
//   import { renderWithRuntime } from '@/test/render-with-runtime';
//   import { threadSummary, sseFromChunks } from '@/test/fixtures';
import { describe, it } from 'vitest';

describe('Shell: an errored reply loses its error block once the user sends a new message (AC-08.5b)', () => {
  // AC-08.5b (first sentence): "When после ответа с ошибкой пользователь отправил новое сообщение, the system shall убрать
  //   у упавшего ответа блок ошибки целиком вместе с кнопкой и показывать только его частичный текст, если он был, — как после F5."
  // (Second sentence — return to the thread in the same tab shows the block again — depends on how long backgroundThreads
  //   keeps the thread body mounted, the same class of property as AC-02.6; proven by L1-10, not by jsdom.)
  // Related: AC-08.5 (block text), AC-08.5a (button inside the block, last reply only); both are component-level (message-error.test.tsx).
  // EARS: When (event: new user message after a failed reply)
  // ROI: 3.7 | Business Value: 8 (a stale «Перегенерировать» on an old reply would re-run the wrong turn) | Frequency: 4 | Legal: false | Defect Detection: 9 (rests on a runtime assumption: chat.error is reset by the next send)
  // Behavior: /chat/a with one restored exchange → send "Вопрос" → 1st POST /api/chat/assistant streams "Частичный" then a model error
  //   → block «Не удалось получить ответ. Попробуйте перегенерировать.» with «Перегенерировать» under that reply
  //   → send "Второй вопрос" → 2nd POST answers "Ответ 2" → the first reply shows only "Частичный": no block, no button
  // Primary failure mode: the error block / «Перегенерировать» stays on the old reply after the next send (regenerating it
  //   would target the wrong message), or the partial text is removed together with the block
  // @category: core-functionality
  // @dependency: ChatRuntimeProvider, AssistantChatTransport, useChatRuntime (real), MessageError, ThreadMessage list, MSW (SSE v7)
  // @complexity: high
  it.todo('AC-08.5b: after an errored reply, sending a new message removes the error block and button from the old reply and keeps its partial text' /*
    Arrange:
      - GET /api/threads → 200 { threads: [threadSummary({ id: 'a', title: 'Беседа A' })], nextCursor: null }
      - GET /api/threads/a/messages → 200 { messages: [user "Первый вопрос", assistant "Первый ответ"] }
      - POST /api/chat/assistant (handler with a call counter; records each JSON body):
          call 1 → SSE v7 from chunks [ start { messageId: 'm-err' }, text-start, text-delta "Частичный", { type: 'error', errorText: 'Agent error' } ]
          call 2 → SSE v7 from chunks [ start { messageId: 'm-ok' }, text-start, text-delta "Ответ 2", text-end, finish ]
      - renderWithRuntime({ pathname: '/chat/a', pointer: 'fine' })
      - await screen.findByText('Первый ответ')
    Act 1:
      - type "Вопрос" into textbox "Сообщение"; press Enter
      - const alert = await screen.findByRole('alert')
    Assert 1 (error state, so the later absence is meaningful):
      - alert has text "Не удалось получить ответ. Попробуйте перегенерировать."
      - button "Перегенерировать" is inside alert.closest('[data-slot="message-error"]')
      - text "Частичный" visible; text "Agent error" absent
      - the restored reply "Первый ответ" has no block: exactly 1 element with [data-slot="message-error"] in the feed
    Act 2:
      - type "Второй вопрос" into textbox "Сообщение"; press Enter
      - await screen.findByText('Ответ 2')
    Assert 2:
      - POST /api/chat/assistant called exactly 2 times; call 2 body.messages: last item role 'user' with text "Второй вопрос";
        body.trigger !== 'regenerate-message' (a new send, not a regeneration)
      - container.querySelectorAll('[data-slot="message-error"]').length === 0
      - queryAllByRole('button', { name: 'Перегенерировать' }).length === 0 (not on any reply in the feed)
      - queryByRole('alert') === null
      - text "Частичный" still visible (partial text of the failed reply is kept, as after F5); "Ответ 2" visible
      - feed order: "Вопрос", "Частичный", "Второй вопрос", "Ответ 2"
  */);
});
