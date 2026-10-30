import { AssistantChatTransport, useChatRuntime } from '@assistant-ui/ai-sdk';
import {
  AssistantRuntimeProvider,
  ThreadListPrimitive,
  useAui,
  useAuiState,
  useRemoteThreadListRuntime,
  type AssistantClient,
  type MessageFormatAdapter,
} from '@assistant-ui/react';
import { render, waitFor } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { http, HttpResponse } from 'msw';
import { createElement, useEffect, useState, type ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { historyMessages, threadList, threadSummary } from '@/test/fixtures';
import { server } from '@/test/msw-server';
import { createShellStatusStore, type HistoryStatus, type ShellStatusStore } from './shell-status-store';
import { createHistoryAdapterFactory, type HistoryAdapterFactory } from './thread-history-adapter';
import { createThreadListAdapter } from './thread-list-adapter';
import { threadsApiClient } from './threads-api-client';
import { ThreadsApiError } from './threads-api-error';

const API = 'http://api.test';

const formatAdapter = (format: string): MessageFormatAdapter<UIMessage, Record<string, unknown>> => ({
  format,
  encode: () => ({}),
  decode: () => {
    throw new Error('decode is not used by the shell history adapter');
  },
  getId: (message) => message.id,
});

const AI_SDK_V6 = formatAdapter('ai-sdk/v6');

function useTestThreadRuntime() {
  const [transport] = useState(() => new AssistantChatTransport({ api: `${API}/api/chat/assistant` }));
  return useChatRuntime({ transport });
}

function TestRuntime({ children }: { children: ReactNode }) {
  const [adapter] = useState(() =>
    createThreadListAdapter({
      api: threadsApiClient,
      status: createShellStatusStore(),
      notify: { renameFailed: () => {}, deleted: () => {}, deleteFailed: () => {} },
      history: { forget: () => {} },
    }),
  );
  const runtime = useRemoteThreadListRuntime({ adapter, runtimeHook: useTestThreadRuntime });
  return createElement(AssistantRuntimeProvider, { runtime }, children);
}

/**
 * A real assistant-ui client scoped to the listed thread `remoteId`, as a thread body receives it.
 * List items do not mount thread runtimes, so the adapter under test is the only history reader.
 */
async function threadItemClient(remoteId: string): Promise<AssistantClient> {
  server.use(http.get(`${API}/api/threads`, () => HttpResponse.json(threadList([threadSummary({ id: remoteId })]))));
  let captured: AssistantClient | undefined;
  function CaptureItemClient() {
    const aui = useAui();
    useEffect(() => {
      if (aui.threadListItem.getState().remoteId === remoteId) captured = aui;
    }, [aui]);
    return null;
  }
  function FirstListItem() {
    const listed = useAuiState((state) => state.threads.threadIds.length > 0);
    return listed
      ? createElement(ThreadListPrimitive.ItemByIndex, { index: 0, components: { ThreadListItem: CaptureItemClient } })
      : null;
  }
  render(createElement(TestRuntime, null, createElement(FirstListItem)));
  await waitFor(() => expect(captured).toBeDefined());
  if (captured === undefined) throw new Error('thread list item client was not captured');
  return captured;
}

function recordHistory(status: ShellStatusStore, remoteId: string): (HistoryStatus | undefined)[] {
  const seen: (HistoryStatus | undefined)[] = [];
  status.subscribe((state, previous) => {
    if (state.history[remoteId] !== previous.history[remoteId]) seen.push(state.history[remoteId]);
  });
  return seen;
}

function messagesHandler(responses: Array<() => Response>) {
  const calls = { count: 0 };
  const handler = http.get(`${API}/api/threads/a/messages`, () => {
    const respond = responses[Math.min(calls.count, responses.length - 1)];
    calls.count += 1;
    return respond();
  });
  return { handler, calls };
}

describe('thread history adapter', () => {
  let status: ShellStatusStore;
  let factory: HistoryAdapterFactory;

  beforeEach(() => {
    status = createShellStatusStore();
    factory = createHistoryAdapterFactory({ api: threadsApiClient, status });
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('loads the history as a linear chain: parentId = previous id, headId = last id', async () => {
    const aui = await threadItemClient('a');
    server.use(http.get(`${API}/api/threads/a/messages`, () => HttpResponse.json({ messages: historyMessages(3) })));

    const repository = await factory.adapterFor(aui).withFormat?.(AI_SDK_V6).load();

    expect(repository).toEqual({
      headId: 'm3',
      messages: [
        { parentId: null, message: { id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Сообщение 1' }] } },
        { parentId: 'm1', message: { id: 'm2', role: 'assistant', parts: [{ type: 'text', text: 'Сообщение 2' }] } },
        { parentId: 'm2', message: { id: 'm3', role: 'user', parts: [{ type: 'text', text: 'Сообщение 3' }] } },
      ],
    });
    expect(status.getState().history).toEqual({ a: 'ready' });
  });

  it('404 sets not_found and rejects with not_found', async () => {
    const aui = await threadItemClient('a');
    server.use(http.get(`${API}/api/threads/a/messages`, () => HttpResponse.json({}, { status: 404 })));

    await expect(factory.adapterFor(aui).withFormat?.(AI_SDK_V6).load()).rejects.toMatchObject({
      kind: 'not_found',
    });
    expect(status.getState().history).toEqual({ a: 'not_found' });
  });

  it('500 sets load_failed; retry loads again, sets ready and resolves', async () => {
    const aui = await threadItemClient('a');
    const { handler, calls } = messagesHandler([
      () => HttpResponse.json({}, { status: 500 }),
      () => HttpResponse.json({ messages: historyMessages(1) }),
    ]);
    server.use(handler);
    const seen = recordHistory(status, 'a');

    const loading = factory.adapterFor(aui).withFormat?.(AI_SDK_V6).load();
    await waitFor(() => expect(status.getState().history.a).toBe('load_failed'));
    factory.retry('a');

    await expect(loading).resolves.toMatchObject({ headId: 'm1' });
    expect(calls.count).toBe(2);
    expect(seen).toEqual(['loading', 'load_failed', 'loading', 'ready']);
  });

  it("500 then forget rejects with ThreadsApiError('not_found'), makes no second request, drops the statuses", async () => {
    const aui = await threadItemClient('a');
    const { handler, calls } = messagesHandler([() => HttpResponse.json({}, { status: 500 })]);
    server.use(handler);

    const loading = factory.adapterFor(aui).withFormat?.(AI_SDK_V6).load();
    await waitFor(() => expect(status.getState().history.a).toBe('load_failed'));
    factory.forget('a');

    await expect(loading).rejects.toBeInstanceOf(ThreadsApiError);
    await expect(loading).rejects.toMatchObject({ kind: 'not_found' });
    expect(calls.count).toBe(1);
    expect(status.getState().history).toEqual({});
  });

  it('withFormat rejects any format other than ai-sdk/v6 as a configuration error', async () => {
    const aui = await threadItemClient('a');

    expect(() => factory.adapterFor(aui).withFormat?.(formatAdapter('ai-sdk/v5'))).toThrow(
      'Thread history supports only the "ai-sdk/v6" format, got "ai-sdk/v5"',
    );
  });
});
