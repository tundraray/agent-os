// chat-shell / web-shell Integration Test — Design Doc: docs/features/chat-shell/design-web-shell.md (v1.10)
// File: shell.deleted-thread.int.test.tsx — Test Strategy, "Integration Tests (I)"
// Generated: 2026-10-30 | Budget Used: 10 skeletons in 7 files (design-mandated: Test Strategy lists 7 integration files; over the 3/5 per-part limit, see generation report), 0/2 E2E (L1 checklist instead)
// Budget after the plan merges: 10 tests in 7 files, all implemented — no it.todo left (plan «Решение по бюджету интеграционных тестов»).
// ROI = (Business Value x Frequency + Legal x 10 + Defect Detection) / 11 (integration cost total, integration-e2e-testing skill)
// Test Type: Integration (Vitest + RTL + MSW 2, jsdom, real assistant-ui runtime)
//
// Harness (src/test/): renderWithRuntime(options) from '@/test/render-with-runtime'
//   mounts ChatRuntimeProvider + ChatShell with mocked next/navigation (controlled pathname, router spy).
//   MSW server from '@/test/msw-server' (onUnhandledRequest: 'error'); fixtures from '@/test/fixtures'.
//   API base URL in tests: NEXT_PUBLIC_API_URL = 'http://api.test' (vitest.config.ts test.env). TZ = 'Europe/Berlin'.
// Mock boundary: network only (MSW) + next/navigation (framework boundary). Runtime, adapters,
//   ShellStatus, handleChatError, components — real. Do NOT mock lib/threads/* or @assistant-ui/*.
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { historyMessages, threadList, threadSummary } from '@/test/fixtures';
import { server } from '@/test/msw-server';
import { renderWithRuntime } from '@/test/render-with-runtime';

const API = 'http://api.test';

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
  it('AC-08.5e: 404 THREAD_NOT_FOUND on send shows the inline «Беседа удалена» notice instead of the error block, hides the composer, keeps the feed', async () => {
    // Arrange
    let chatCalls = 0;
    let createCalls = 0;
    server.use(
      http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([threadSummary({ id: 'a', title: 'Беседа A' })]))),
      http.get(`${API}/api/threads/a`, () => HttpResponse.json(threadSummary({ id: 'a', title: 'Беседа A' }))),
      http.get(`${API}/api/threads/a/messages`, () =>
        HttpResponse.json({
          messages: historyMessages([
            { role: 'user', text: 'Первый вопрос' },
            { role: 'assistant', text: 'Первый ответ' },
          ]),
        }),
      ),
      http.post(`${API}/api/chat/assistant`, () => {
        chatCalls += 1;
        return HttpResponse.json(
          { statusCode: 404, message: 'Thread not found', error: 'Not Found', errorCode: 'THREAD_NOT_FOUND' },
          { status: 404 },
        );
      }),
      http.post(`${API}/api/threads`, () => {
        createCalls += 1;
        return HttpResponse.json(threadSummary({ id: 'resurrected', title: null }), { status: 201 });
      }),
    );
    // handleChatError logs the failure; keep the test output clean.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    const { container, router, setPathname } = renderWithRuntime({ pathname: '/chat/a', pointer: 'fine' });
    await screen.findByText('Первый ответ');

    // Act
    await user.type(screen.getByRole('textbox', { name: 'Сообщение' }), 'Ещё вопрос{Enter}');
    const title = await screen.findByText('Беседа удалена');

    // Assert (notice, in place of the TH-08 block)
    const reason = screen.getByText('Её удалили в другой вкладке или окне.');
    expect(screen.getByText('Ещё вопрос').compareDocumentPosition(title)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    // An inline notice in the feed, not a screen: h2 under the header's h1 (design ThreadNotice `deleted`).
    // h2 per DD v1.10 §ThreadNotice (skeleton expected no heading)
    expect(screen.queryByRole('heading', { level: 1, name: 'Беседа удалена' })).toBeNull();
    expect(screen.getByRole('heading', { level: 2, name: 'Беседа удалена' })).toBe(title);
    expect(screen.getByRole('alert')).toBe(reason);
    const notice = title.closest<HTMLElement>('section');
    if (notice === null) throw new Error('«Беседа удалена» is not inside its notice section');
    const newChat = within(notice).getByRole('button', { name: 'Новый чат' });
    expect(newChat).toHaveAccessibleDescription('Её удалили в другой вкладке или окне.');
    expect(screen.queryAllByRole('button', { name: 'Перегенерировать' })).toHaveLength(0);
    expect(container).not.toHaveTextContent(/Не удалось получить ответ/);
    expect(container).not.toHaveTextContent('Thread not found');
    expect(container.querySelector('[data-slot="message-error"]')).toBeNull();

    // Assert (feed and composer)
    expect(screen.queryByRole('textbox', { name: 'Сообщение' })).toBeNull();
    for (const text of ['Первый вопрос', 'Первый ответ', 'Ещё вопрос']) {
      expect(screen.getByText(text)).toBeInTheDocument();
    }
    // The failed reply has no row: only the restored reply renders content and a footer.
    expect(container.querySelectorAll('[data-slot="aui_assistant-message-content"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-slot="aui_assistant-message-footer"]')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Копировать' })).toHaveLength(3);
    // Focus was in the composer that is now hidden: it moves to «Новый чат» (UXRD 7.4).
    expect(newChat).toHaveFocus();

    // Assert (no resurrection)
    expect(chatCalls).toBe(1);
    expect(createCalls).toBe(0);

    // Act 2
    await user.click(newChat);

    // Assert 2
    expect(router.push).toHaveBeenCalledWith('/');
    setPathname('/');
    expect(await screen.findByText('Чем могу помочь?')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Сообщение' })).toBeInTheDocument();
  });
});
