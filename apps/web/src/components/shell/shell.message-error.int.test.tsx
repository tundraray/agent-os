// chat-shell / web-shell Integration Test — Design Doc: docs/features/chat-shell/design-web-shell.md (v1.10)
// File: shell.message-error.int.test.tsx — Test Strategy, "Integration Tests (I)" (new in v1.3, AC-08.5b)
// Generated: 2026-10-30 | Budget Used: 10 skeletons in 7 files (design-mandated: Test Strategy lists 7 integration files; over the 3/5 per-part limit, see generation report), 0/2 E2E (L1 checklist instead)
// Budget after the plan merges: 10 tests in 7 files, all implemented — no it.todo left (plan «Решение по бюджету интеграционных тестов»).
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
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import { assistantTextChunks, historyMessages, sseFromChunks, threadList, threadSummary } from '@/test/fixtures';
import { server } from '@/test/msw-server';
import { renderWithRuntime } from '@/test/render-with-runtime';

const API = 'http://api.test';

/** The `messages` and `trigger` of a chat request body. */
function chatRequestOf(body: unknown): { lastMessage: unknown; trigger: unknown } {
  if (typeof body !== 'object' || body === null) return { lastMessage: undefined, trigger: undefined };
  const messages = 'messages' in body && Array.isArray(body.messages) ? body.messages : [];
  return { lastMessage: messages.at(-1), trigger: 'trigger' in body ? body.trigger : undefined };
}

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
  it('AC-08.5b: after an errored reply, sending a new message removes the error block and button from the old reply and keeps its partial text', async () => {
    // Arrange
    const chatBodies: unknown[] = [];
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
      http.post(`${API}/api/chat/assistant`, async ({ request }) => {
        chatBodies.push(await request.json());
        if (chatBodies.length === 1) {
          return sseFromChunks([
            { type: 'start', messageId: 'm-err' },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'Частичный' },
            { type: 'error', errorText: 'Agent error' },
          ]);
        }
        return sseFromChunks(assistantTextChunks('Ответ 2', 'm-ok'));
      }),
    );
    // handleChatError logs the failure; keep the test output clean.
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    const { container } = renderWithRuntime({ pathname: '/chat/a', pointer: 'fine' });
    await screen.findByText('Первый ответ');

    // Act 1
    await user.type(screen.getByRole('textbox', { name: 'Сообщение' }), 'Вопрос{Enter}');
    const alert = await screen.findByRole('alert');

    // Assert 1: the error state, so the later absence is meaningful
    expect(alert).toHaveTextContent('Не удалось получить ответ. Попробуйте перегенерировать.');
    const block = alert.closest<HTMLElement>('[data-slot="message-error"]');
    if (block === null) throw new Error('the alert is not inside [data-slot="message-error"]');
    expect(block).toContainElement(screen.getByRole('button', { name: 'Перегенерировать' }));
    expect(screen.getByText('Частичный')).toBeInTheDocument();
    expect(container).not.toHaveTextContent('Agent error');
    expect(container.querySelectorAll('[data-slot="message-error"]')).toHaveLength(1);

    // Act 2
    await user.type(screen.getByRole('textbox', { name: 'Сообщение' }), 'Второй вопрос{Enter}');
    await screen.findByText('Ответ 2');

    // Assert 2
    expect(chatBodies).toHaveLength(2);
    const second = chatRequestOf(chatBodies[1]);
    expect(second.lastMessage).toMatchObject({ role: 'user', parts: [{ type: 'text', text: 'Второй вопрос' }] });
    expect(second.trigger).not.toBe('regenerate-message');
    await waitFor(() => expect(container.querySelectorAll('[data-slot="message-error"]')).toHaveLength(0));
    expect(screen.queryAllByRole('button', { name: 'Перегенерировать' })).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText('Частичный')).toBeInTheDocument();
    const feed = Array.from(container.querySelectorAll<HTMLElement>('[data-role="user"], [data-role="assistant"]')).map(
      (root) => root.textContent ?? '',
    );
    expect(feed.map((text) => text.replace('Копировать', '').trim())).toEqual([
      'Первый вопрос',
      'Первый ответ',
      'Вопрос',
      'Частичный',
      'Второй вопрос',
      'Ответ 2',
    ]);
  });
});
