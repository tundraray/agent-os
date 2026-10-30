import { APICallError } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { reportChatError } from './shell-services';
import { createShellStatusStore } from './shell-status-store';

const CHAT_URL = 'http://api.test/api/chat/assistant';
const THREAD_NOT_FOUND_BODY = JSON.stringify({
  statusCode: 404,
  message: 'Thread not found',
  error: 'Not Found',
  errorCode: 'THREAD_NOT_FOUND',
});

const apiCallError = (statusCode: number, responseBody: string | undefined) =>
  new APICallError({
    message: responseBody ?? 'Failed to fetch the chat response.',
    url: CHAT_URL,
    requestBodyValues: undefined,
    statusCode,
    responseBody,
  });

describe('reportChatError — classification of chat failures (E-8, Connection Map «Транспорт → 404 чата»)', () => {
  it('APICallError 404 with errorCode THREAD_NOT_FOUND marks the thread deleted', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const status = createShellStatusStore();
    status.getState().setHistory('a', 'ready');

    reportChatError({ error: apiCallError(404, THREAD_NOT_FOUND_BODY), remoteId: 'a', status });

    expect(status.getState().history).toEqual({ a: 'deleted' });
  });

  it.each([
    {
      name: '404 with another errorCode',
      error: apiCallError(404, JSON.stringify({ statusCode: 404, message: 'Agent not found', errorCode: 'AGENT_NOT_FOUND' })),
    },
    { name: '404 without errorCode', error: apiCallError(404, JSON.stringify({ statusCode: 404, message: 'Not Found' })) },
    { name: '404 with an unparsable body', error: apiCallError(404, '<html>Not Found</html>') },
    { name: '404 without a body', error: apiCallError(404, undefined) },
    { name: '500 with THREAD_NOT_FOUND in the body', error: apiCallError(500, THREAD_NOT_FOUND_BODY) },
    { name: 'a plain Error carrying the 404 body as its message', error: new Error(THREAD_NOT_FOUND_BODY) },
  ])('$name leaves the thread status unchanged', ({ error }) => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const status = createShellStatusStore();
    status.getState().setHistory('a', 'ready');

    reportChatError({ error, remoteId: 'a', status });

    expect(status.getState().history).toEqual({ a: 'ready' });
  });

  it('a thread without a remote id is not marked', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const status = createShellStatusStore();

    reportChatError({ error: apiCallError(404, THREAD_NOT_FOUND_BODY), remoteId: undefined, status });

    expect(status.getState().history).toEqual({});
  });

  it('logs the remote id, error name and status code, never the response body or message', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const status = createShellStatusStore();

    reportChatError({ error: apiCallError(404, THREAD_NOT_FOUND_BODY), remoteId: 'a', status });

    expect(log).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith('[web-shell] chat request failed', {
      remoteId: 'a',
      name: 'AI_APICallError',
      statusCode: 404,
    });
  });
});
