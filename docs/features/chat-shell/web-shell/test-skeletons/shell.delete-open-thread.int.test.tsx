// chat-shell / web-shell Integration Test — Design Doc: docs/features/chat-shell/design-web-shell.md (v1.2)
// File: shell.delete-open-thread.int.test.tsx — Test Strategy, "Integration Tests (I)"
// Generated: 2026-10-28 | Budget Used: 6/3 integration files (design-mandated, see generation report), 0/2 E2E (L1 checklist instead)
// Test Type: Integration (Vitest + RTL + MSW 2, jsdom, real assistant-ui runtime)
//
// Harness (planned, src/test/): renderWithRuntime(options) from '@/test/render-with-runtime'
//   mounts ChatRuntimeProvider + ChatShell with mocked next/navigation (controlled pathname, router spy).
//   options.pointer: 'fine' | 'coarse' drives the matchMedia('(pointer: fine)') polyfill from src/test/setup.ts.
//   MSW server from '@/test/msw-server' (onUnhandledRequest: 'error'); fixtures from '@/test/fixtures'.
//   API base URL in tests: NEXT_PUBLIC_API_URL = 'http://api.test' (vitest.config.ts test.env). TZ = 'Europe/Berlin'.
// Mock boundary: network only (MSW) + next/navigation (framework boundary). Runtime, adapters,
//   ShellStatus, url-sync, components, sonner Toaster — real. Do NOT mock lib/threads/* or @assistant-ui/*.
// Planned imports for implementation (not imported yet: modules do not exist before the plan runs):
//   import { screen, within, waitFor } from '@testing-library/react';
//   import { http, HttpResponse } from 'msw';
//   import { server } from '@/test/msw-server';
//   import { renderWithRuntime } from '@/test/render-with-runtime';
//   import { threadSummary } from '@/test/fixtures';
import { describe, it } from 'vitest';

describe('Shell: deleting the open thread (FR-06, AC-06.2)', () => {
  // AC-06.2: "When подтверждено удаление открытой беседы, the system shall убрать её из списка, заменить URL на /
  //   (без новой записи истории), показать приветствие, фокус — по правилу указателя."
  // EARS: When (event: delete confirmed for the open thread); pointer rule = If-then branch → split into two tests
  // ROI: 7.6 | Business Value: 8 (destructive action must land the user somewhere sane) | Frequency: 4 | Legal: false | Defect Detection: 9 (url-sync must replace, not push)
  // Behavior: /chat/a open → «⋯» → «Удалить» → confirm «Удалить» in alertdialog → DELETE /api/threads/a (204)
  //   → link a gone, router.replace('/') (not push), after pathname '/' → «Чем могу помочь?», toast «Беседа удалена», focus on composer
  // Fails when: URL stays /chat/a, router.push adds a history entry (Back returns to the deleted thread), the list keeps a, or focus is lost
  // @category: core-functionality
  // @dependency: ThreadHistoryItem, DeleteThreadDialog, ThreadListAdapter.delete, url-sync (syncUrlWithThread), focusAfterNewChat, sonner, MSW
  // @complexity: high
  it.todo('AC-06.2 (pointer: fine): deleting the open thread removes it, replaces URL with /, shows welcome, focuses the composer' /*
    Arrange:
      - GET /api/threads → 200 { threads: [threadSummary({ id: 'a', title: 'Беседа A' }), threadSummary({ id: 'b', title: 'Беседа B' })], nextCursor: null }
      - GET /api/threads/a/messages → 200 { messages: [user "Вопрос", assistant "Ответ"] }
      - DELETE /api/threads/a → 204 (handler records the call)
      - const { router, setPathname } = renderWithRuntime({ pathname: '/chat/a', pointer: 'fine' })
      - const historyLengthBefore = window.history.length
      - await screen.findByText('Ответ')
    Act:
      - click button "Действия с беседой «Беседа A»"; click menuitem "Удалить"
      - within alertdialog "Удалить беседу?": click button "Удалить"
      - when router.replace was called with '/': setPathname('/')
    Assert:
      - DELETE /api/threads/a called exactly once
      - queryByRole('link', { name: 'Беседа A' }) === null; link "Беседа B" still present
      - router.replace called with '/'; router.push not called; window.history.length === historyLengthBefore
      - getByText('Чем могу помочь?') visible
      - toast text "Беседа удалена" visible
      - document.activeElement === getByRole('textbox', { name: 'Сообщение' })
  */);

  // AC-06.2 / AC-03.1 pointer rule, coarse branch: "фокус … иначе на h1 шапки (HD-03) без всплытия клавиатуры."
  // ROI: 6.0 | Business Value: 6 (mobile keyboard must not pop up) | Frequency: 4 | Legal: false | Defect Detection: 7
  // Behavior: same flow with pointer 'coarse' → focus lands on header h1 (sr-only «Новый чат», tabindex=-1), not the composer
  // Fails when: focusAfterNewChat ignores the pointer type after deletion
  // @category: ux
  // @dependency: focusAfterNewChat, ChatHeader (HD-03), url-sync, MSW
  // @complexity: medium
  it.todo('AC-06.2 (pointer: coarse): after deleting the open thread focus goes to the header h1, not the composer' /*
    Arrange:
      - same handlers as the previous test
      - renderWithRuntime({ pathname: '/chat/a', pointer: 'coarse' })
    Act:
      - «⋯» → «Удалить» → confirm «Удалить»; setPathname('/') after router.replace('/')
    Assert:
      - document.activeElement is heading level 1 named "Новый чат" (header HD-03, data-shell-focus="page-title")
      - document.activeElement !== textbox "Сообщение"
      - getByText('Чем могу помочь?') visible
  */);
});
