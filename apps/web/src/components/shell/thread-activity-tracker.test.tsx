import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { assistantTextChunks, deferred, historyMessages, sseFromChunks, threadList, threadSummary } from '@/test/fixtures';
import { server } from '@/test/msw-server';
import { renderWithRuntime } from '@/test/render-with-runtime';

const API = 'http://api.test';

afterEach(() => {
  vi.useRealTimers();
});

/** Link names of the group headed by `label` inside the sidebar list. */
function groupLinks(history: HTMLElement, label: string): string[] {
  const list = within(history).getByRole('list', { name: label });
  return within(list)
    .getAllByRole('link')
    .map((link) => link.textContent ?? '');
}

// Behavior: existing thread + reply started → lifted to top of «Сегодня» (D-11)
describe('ThreadActivityTracker — lifting an existing thread when a reply starts (D-11, AC-03.3 mechanism)', () => {
  it('a reply in a thread from «Предыдущие 7 дней» lifts it to the top of «Сегодня» while the reply runs', async () => {
    // Arrange: today 12:00 local; «Свежая» updated today 09:00, «Старая» three days ago
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-28T12:00:00+01:00'));
    const old = threadSummary({ id: 'old', title: 'Старая беседа', updatedAt: '2026-10-25T09:00:00.000Z' });
    const fresh = threadSummary({ id: 'fresh', title: 'Свежая беседа', updatedAt: '2026-10-28T08:00:00.000Z' });
    const replyGate = deferred();
    const replyStarted = deferred();
    server.use(
      http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([fresh, old]))),
      http.get(`${API}/api/threads/old`, () => HttpResponse.json(old)),
      http.get(`${API}/api/threads/old/messages`, () => HttpResponse.json({ messages: historyMessages(2) })),
      http.post(`${API}/api/chat/assistant`, async () => {
        replyStarted.resolve();
        await replyGate.promise;
        return sseFromChunks(assistantTextChunks('Готово.'));
      }),
    );
    const user = userEvent.setup();
    renderWithRuntime({ pathname: '/chat/old', pointer: 'fine' });
    const history = screen.getByRole('navigation', { name: 'История бесед' });
    await within(history).findByRole('link', { name: 'Старая беседа' });
    await screen.findByText('Сообщение 2');
    expect(groupLinks(history, 'Сегодня')).toEqual(['Свежая беседа']);
    expect(groupLinks(history, 'Предыдущие 7 дней')).toEqual(['Старая беседа']);

    // Act: send in «Старая беседа»; the reply is held, so the thread stays running
    await user.type(screen.getByRole('textbox', { name: 'Сообщение' }), 'Продолжим');
    await user.keyboard('{Enter}');
    await replyStarted.promise;

    // Assert: lifted to the top of «Сегодня» while running; its old group is gone
    await waitFor(() => expect(groupLinks(history, 'Сегодня')).toEqual(['Старая беседа', 'Свежая беседа']));
    expect(within(history).queryByRole('heading', { level: 2, name: 'Предыдущие 7 дней' })).toBeNull();

    // The reply finishes; the lift stays until the list reloads
    replyGate.resolve();
    await screen.findByText('Готово.');
    expect(groupLinks(history, 'Сегодня')).toEqual(['Старая беседа', 'Свежая беседа']);
  });
});
