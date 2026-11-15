// chat-shell / web-shell Integration Test — Design Doc: docs/features/chat-shell/design-web-shell.md (v1.9)
// File: shell.delete-open-thread.int.test.tsx — Test Strategy, "Integration Tests (I)"
// Generated: 2026-10-30 | Budget Used: 10 skeletons in 7 files (design-mandated: Test Strategy lists 7 integration files; over the 3/5 per-part limit, see generation report), 0/2 E2E (L1 checklist instead)
// Budget after the plan merges: 10 tests in 7 files, all implemented — no it.todo left (plan «Решение по бюджету интеграционных тестов»).
// ROI = (Business Value x Frequency + Legal x 10 + Defect Detection) / 11 (integration cost total, integration-e2e-testing skill)
// Test Type: Integration (Vitest + RTL + MSW 2, jsdom, real assistant-ui runtime over the feed store)
//
// Harness (src/test/): renderWithRuntime(options) from '@/test/render-with-runtime'
//   mounts ChatRuntimeProvider + ChatShell with mocked next/navigation (controlled pathname, router spy) and a test
//   event source for LiveStore.
//   options.pointer: 'fine' | 'coarse' drives the matchMedia('(pointer: fine)') polyfill from src/test/setup.ts.
//   MSW server from '@/test/msw-server' (onUnhandledRequest: 'error'); fixtures from '@/test/fixtures'.
//   API base URL in tests: NEXT_PUBLIC_API_URL = 'http://api.test' (vitest.config.ts test.env). TZ = 'Europe/Berlin'.
// Mock boundary: network only (MSW) + the live event source + next/navigation (framework boundary). Runtime, stores,
//   adapters, ShellStatus, url-sync, components, sonner Toaster — real. Do NOT mock lib/threads/*, lib/feed/*, lib/live/*
//   or @assistant-ui/*.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { toast } from 'sonner';
import { afterEach, describe, expect, it } from 'vitest';
import { conversationWithTurns, threadList, threadSummary } from '@/test/fixtures';
import { server } from '@/test/msw-server';
import { renderWithRuntime } from '@/test/render-with-runtime';
import type { TestMedia } from '@/test/setup';

const API = 'http://api.test';

afterEach(() => {
  window.history.replaceState(null, '', '/');
  // sonner keeps its toasts in a module store: a row's «Беседа удалена» must not reach the next row's Toaster.
  toast.dismiss();
});

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
  it.each<{ pointer: TestMedia['pointer']; focused: string }>([
    { pointer: 'fine', focused: 'composer' },
    { pointer: 'coarse', focused: 'header h1' },
  ])(
    'AC-06.2: deleting the open thread removes it, replaces the URL with /, shows the welcome and moves focus by pointer type ($pointer → $focused)',
    async ({ pointer }) => {
      // Arrange
      const deleteCalls: string[] = [];
      server.use(
        http.get(`${API}/api/threads`, () =>
          HttpResponse.json(
            threadList([threadSummary({ id: 'a', title: 'Беседа A' }), threadSummary({ id: 'b', title: 'Беседа B' })]),
          ),
        ),
        http.get(`${API}/api/threads/a`, () => HttpResponse.json(threadSummary({ id: 'a', title: 'Беседа A' }))),
        http.get(`${API}/api/threads/a/history`, () =>
          HttpResponse.json(conversationWithTurns(threadSummary({ id: 'a', title: 'Беседа A' }), ['Вопрос', 'Ответ'])),
        ),
        http.delete(`${API}/api/threads/:id`, ({ params }) => {
          deleteCalls.push(String(params.id));
          return new HttpResponse(null, { status: 204 });
        }),
      );
      // The browser address bar as a load of /chat/a leaves it; the mocked router never touches window.location.
      window.history.replaceState(null, '', '/chat/a');
      const user = userEvent.setup();
      const { router, setPathname } = renderWithRuntime({ pathname: '/chat/a', pointer });
      const historyLengthBefore = window.history.length;
      const history = screen.getByRole('navigation', { name: 'История бесед' });
      await waitFor(() =>
        expect(within(history).getByRole('link', { name: 'Беседа A' })).toHaveAttribute('aria-current', 'page'),
      );
      await screen.findByText('Ответ');

      // Act
      await user.click(within(history).getByRole('button', { name: 'Действия с беседой «Беседа A»' }));
      await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Удалить' }));
      const dialog = await screen.findByRole('alertdialog', { name: 'Удалить беседу?' });
      await user.click(within(dialog).getByRole('button', { name: 'Удалить' }));
      await waitFor(() => expect(router.replace).toHaveBeenCalledWith('/'));
      setPathname('/');

      // Assert
      await waitFor(() => expect(deleteCalls).toEqual(['a']));
      await waitFor(() => expect(within(history).queryByRole('link', { name: 'Беседа A' })).toBeNull());
      expect(within(history).getByRole('link', { name: 'Беседа B' })).toBeInTheDocument();
      expect(router.push).not.toHaveBeenCalled();
      expect(window.history.length).toBe(historyLengthBefore);
      expect(await screen.findByText('Чем могу помочь?')).toBeVisible();
      expect(await screen.findByText('Беседа удалена')).toBeVisible();
      const composer = screen.getByRole('textbox', { name: 'Сообщение' });
      if (pointer === 'fine') {
        await waitFor(() => expect(composer).toHaveFocus());
      } else {
        await waitFor(() => expect(screen.getByRole('heading', { level: 1, name: 'Новый чат' })).toHaveFocus());
        expect(composer).not.toHaveFocus();
      }
      expect(deleteCalls).toEqual(['a']);
    },
  );
});
