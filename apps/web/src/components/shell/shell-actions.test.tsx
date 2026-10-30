// ShellActions.deleteThread: a run in progress on the deleted thread is cancelled before DELETE /api/threads/:id is sent.
// Mock boundary: network only (MSW) + next/navigation (renderWithRuntime). Runtime, adapters and components are real.
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { toast } from 'sonner';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deferred, historyMessages, threadList, threadSummary } from '@/test/fixtures';
import { server } from '@/test/msw-server';
import { renderWithRuntime } from '@/test/render-with-runtime';

const API = 'http://api.test';

afterEach(() => {
  server.events.removeAllListeners();
  window.history.replaceState(null, '', '/');
  toast.dismiss();
});

/**
 * MSW handlers for threads «Беседа A» and «Беседа B» with one restored exchange each, a chat endpoint whose reply is
 * held until the request is aborted or `release` settles, and a 204 DELETE. `log` receives, in order, every request
 * start (via server.events) and the abort of the chat request.
 */
function arrangeServer() {
  const log: string[] = [];
  const chatStarted = deferred();
  const release = deferred();
  server.events.on('request:start', ({ request }) => {
    log.push(`${request.method} ${new URL(request.url).pathname}`);
  });
  const summaries = [threadSummary({ id: 'a', title: 'Беседа A' }), threadSummary({ id: 'b', title: 'Беседа B' })];
  server.use(
    http.get(`${API}/api/threads`, () => HttpResponse.json(threadList(summaries))),
    http.get(`${API}/api/threads/:id`, ({ params }) => {
      const summary = summaries.find((thread) => thread.id === params.id);
      return summary === undefined ? new HttpResponse(null, { status: 404 }) : HttpResponse.json(summary);
    }),
    http.get(`${API}/api/threads/:id/messages`, ({ params }) =>
      HttpResponse.json({
        messages: historyMessages([
          { role: 'user', text: `Вопрос ${String(params.id)}` },
          { role: 'assistant', text: `Ответ ${String(params.id)}` },
        ]),
      }),
    ),
    http.post(`${API}/api/chat/assistant`, async ({ request }) => {
      const aborted = new Promise<void>((resolve) => {
        request.signal.addEventListener('abort', () => {
          log.push('chat aborted');
          resolve();
        });
      });
      chatStarted.resolve();
      await Promise.race([aborted, release.promise]);
      return new HttpResponse(null, { status: 204 });
    }),
    http.delete(`${API}/api/threads/:id`, () => new HttpResponse(null, { status: 204 })),
  );
  return { log, chatStarted, release };
}

async function confirmDelete(history: HTMLElement, title: string): Promise<void> {
  const user = userEvent.setup();
  await user.click(within(history).getByRole('button', { name: `Действия с беседой «${title}»` }));
  await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Удалить' }));
  const dialog = await screen.findByRole('alertdialog', { name: 'Удалить беседу?' });
  await user.click(within(dialog).getByRole('button', { name: 'Удалить' }));
}

describe('ShellActions.deleteThread cancels the run of the deleted thread first', () => {
  it('open thread with a reply in progress: the chat request is aborted before DELETE is sent', async () => {
    // Arrange
    const { log, chatStarted } = arrangeServer();
    window.history.replaceState(null, '', '/chat/a');
    const user = userEvent.setup();
    renderWithRuntime({ pathname: '/chat/a', pointer: 'fine' });
    const history = screen.getByRole('navigation', { name: 'История бесед' });
    await screen.findByText('Ответ a');
    await user.type(screen.getByRole('textbox', { name: 'Сообщение' }), 'Продолжим{Enter}');
    await chatStarted.promise;

    // Act
    await confirmDelete(history, 'Беседа A');

    // Assert
    await waitFor(() => expect(log).toContain('DELETE /api/threads/a'));
    const tail = log.slice(log.indexOf('POST /api/chat/assistant'));
    expect(tail.filter((entry) => entry === 'chat aborted' || entry.startsWith('DELETE'))).toEqual([
      'chat aborted',
      'DELETE /api/threads/a',
    ]);
    await waitFor(() => expect(within(history).queryByRole('link', { name: 'Беседа A' })).toBeNull());
    expect(within(history).getByRole('link', { name: 'Беседа B' })).toBeInTheDocument();
    expect(await screen.findByText('Беседа удалена')).toBeVisible();
  });

  it('background thread with a reply in progress: the chat request is aborted before DELETE is sent', async () => {
    // Arrange: reply started in A, then B is opened, so A runs in the background
    const { log, chatStarted } = arrangeServer();
    window.history.replaceState(null, '', '/chat/a');
    const user = userEvent.setup();
    const { setPathname } = renderWithRuntime({ pathname: '/chat/a', pointer: 'fine' });
    const history = screen.getByRole('navigation', { name: 'История бесед' });
    await screen.findByText('Ответ a');
    await user.type(screen.getByRole('textbox', { name: 'Сообщение' }), 'Продолжим{Enter}');
    await chatStarted.promise;
    window.history.replaceState(null, '', '/chat/b');
    setPathname('/chat/b');
    await screen.findByText('Ответ b');

    // Act
    await confirmDelete(history, 'Беседа A');

    // Assert
    await waitFor(() => expect(log).toContain('DELETE /api/threads/a'));
    const tail = log.slice(log.indexOf('POST /api/chat/assistant'));
    expect(tail.filter((entry) => entry === 'chat aborted' || entry.startsWith('DELETE'))).toEqual([
      'chat aborted',
      'DELETE /api/threads/a',
    ]);
    await waitFor(() => expect(within(history).queryByRole('link', { name: 'Беседа A' })).toBeNull());
    expect(within(history).getByRole('link', { name: 'Беседа B' })).toHaveAttribute('aria-current', 'page');
    expect(await screen.findByText('Беседа удалена')).toBeVisible();
  });

  it('a run that does not stop within 2 s: warns and deletes anyway', async () => {
    // Arrange: the chat request ignores aborts, so the run keeps reporting isRunning after cancel
    const { log, chatStarted, release } = arrangeServer();
    const mswFetch = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) =>
      String(input).endsWith('/api/chat/assistant') ? mswFetch(input, { ...init, signal: null }) : mswFetch(input, init),
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    window.history.replaceState(null, '', '/chat/a');
    const user = userEvent.setup();
    const { unmount } = renderWithRuntime({ pathname: '/chat/a', pointer: 'fine' });
    const history = screen.getByRole('navigation', { name: 'История бесед' });
    await screen.findByText('Ответ a');
    await user.type(screen.getByRole('textbox', { name: 'Сообщение' }), 'Продолжим{Enter}');
    await chatStarted.promise;

    // Act
    const confirmedAt = Date.now();
    await confirmDelete(history, 'Беседа A');

    // Assert
    await waitFor(() => expect(log).toContain('DELETE /api/threads/a'), { timeout: 5000 });
    expect(Date.now() - confirmedAt).toBeGreaterThanOrEqual(1900);
    expect(log).not.toContain('chat aborted');
    expect(warn).toHaveBeenCalledWith('[web-shell] run still active after cancel; deleting anyway', { threadId: 'a' });
    await waitFor(() => expect(within(history).queryByRole('link', { name: 'Беседа A' })).toBeNull());
    expect(await screen.findByText('Беседа удалена')).toBeVisible();

    unmount();
    release.resolve();
  });
});
