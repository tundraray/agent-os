// chat-shell / web-shell Integration Test — Design Doc: docs/features/chat-shell/design-web-shell.md (v1.5)
// File: shell.delete-open-thread.int.test.tsx — Test Strategy, "Integration Tests (I)"
// Generated: 2026-10-30 | Budget Used: 14 skeletons in 7 files (design-mandated: Test Strategy lists 7 integration files; over the 3/5 per-part limit, see generation report), 0/2 E2E (L1 checklist instead)
// ROI = (Business Value x Frequency + Legal x 10 + Defect Detection) / 11 (integration cost total, integration-e2e-testing skill)
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
  // EARS: When (event: delete confirmed for the open thread). The pointer rule is a pure rule proven once by focus.test.ts (U) and
  //   AC-03.1 (C); this skeleton proves only that the delete path is wired to it, so the two pointer types are table rows of ONE test.
  // ROI: 3.7 | Business Value: 8 (destructive action must land the user somewhere sane) | Frequency: 4 | Legal: false | Defect Detection: 9 (url-sync must replace, not push)
  // Behavior: /chat/a open → «⋯» → «Удалить» → confirm «Удалить» in the alertdialog → DELETE /api/threads/a (204)
  //   → link a gone, router.replace('/') (not push), after pathname '/' → «Чем могу помочь?», toast «Беседа удалена»,
  //   focus by pointer type
  // Primary failure mode: URL stays /chat/a, router.push adds a history entry (Back returns to the deleted thread), the list
  //   keeps the thread, or focus falls to <body> (or the composer on a touch device, popping up the keyboard)
  // @category: core-functionality
  // @dependency: ThreadHistoryItem, DeleteThreadDialog, ThreadListAdapter.delete, url-sync (syncUrlWithThread), focusAfterNewChat, ChatHeader (HD-03), sonner, MSW
  // @complexity: high
  // Table rows (implement with it.each):
  //   | pointer  | expected document.activeElement                                                                |
  //   | 'fine'   | textbox "Сообщение" (composer)                                                                 |
  //   | 'coarse' | heading level 1 named "Новый чат" (header HD-03, sr-only, data-shell-focus="page-title"); not the composer |
  it.todo('AC-06.2: deleting the open thread removes it, replaces the URL with /, shows the welcome and moves focus by pointer type (rows: fine → composer, coarse → header h1)' /*
    Arrange (per row):
      - GET /api/threads → 200 { threads: [threadSummary({ id: 'a', title: 'Беседа A' }), threadSummary({ id: 'b', title: 'Беседа B' })], nextCursor: null }
      - GET /api/threads/a/messages → 200 { messages: [user "Вопрос", assistant "Ответ"] }
      - DELETE /api/threads/a → 204 (handler records the call)
      - const { router, setPathname } = renderWithRuntime({ pathname: '/chat/a', pointer: <row.pointer> })
      - const historyLengthBefore = window.history.length
      - await screen.findByText('Ответ')
    Act:
      - click button "Действия с беседой «Беседа A»"; click menuitem "Удалить"
      - within alertdialog "Удалить беседу?": click button "Удалить"
      - when router.replace was called with '/': setPathname('/')
    Assert (both rows):
      - DELETE /api/threads/a called exactly once
      - queryByRole('link', { name: 'Беседа A' }) === null; link "Беседа B" still present
      - router.replace called with '/'; router.push not called; window.history.length === historyLengthBefore
      - getByText('Чем могу помочь?') visible
      - toast text "Беседа удалена" visible
    Assert (per row):
      - fine: document.activeElement === getByRole('textbox', { name: 'Сообщение' })
      - coarse: document.activeElement is heading level 1 named "Новый чат"; document.activeElement !== textbox "Сообщение"
  */);
});
