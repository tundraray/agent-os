import { AssistantChatTransport } from '@assistant-ui/ai-sdk';
import { ApiErrorSchema } from '@agent-os/contracts';
import { AuiConfig, type AssistantClient } from '@assistant-ui/react';
import { APICallError, type UIMessage } from 'ai';
import { toast } from 'sonner';
import { apiBaseUrl } from '@/lib/config';
import { createShellStatusStore, type ShellStatusStore } from './shell-status-store';
import { createHistoryAdapterFactory, type HistoryAdapterFactory } from './thread-history-adapter';
import { createThreadListAdapter, type OperationNotifier } from './thread-list-adapter';
import { threadsApiClient, type ThreadsApiClient } from './threads-api-client';

/** The only agent the shell talks to: `POST /api/chat/:agentId`. */
export const ASSISTANT_AGENT_ID = 'assistant';

export type ChatErrorContext = {
  error: Error;
  /** Client of the thread body whose request failed. */
  aui: AssistantClient;
};

export type ShellServices = {
  apiClient: ThreadsApiClient;
  status: ShellStatusStore;
  listAdapter: ReturnType<typeof createThreadListAdapter>;
  history: HistoryAdapterFactory;
  transport: AssistantChatTransport<UIMessage>;
  notify: OperationNotifier;
  auiConfig: AuiConfig;
  handleChatError: (context: ChatErrorContext) => void;
};

const notify: OperationNotifier = {
  renameFailed: () => {
    toast.error('Не удалось переименовать беседу. Попробуйте ещё раз.');
  },
  deleted: () => {
    toast('Беседа удалена');
  },
  deleteFailed: () => {
    toast.error('Не удалось удалить беседу. Попробуйте ещё раз.');
  },
};

const remoteIdOf = (aui: AssistantClient): string | undefined =>
  aui.threadListItem.source ? aui.threadListItem.getState().remoteId : undefined;

/** Log-safe description of a chat failure: never the response body or message text. */
const describeChatError = (error: Error): { name: string; statusCode: number | undefined } => ({
  name: error.name,
  statusCode: APICallError.isInstance(error) ? error.statusCode : undefined,
});

/** The JSON value of a response body; undefined when the body is absent or not JSON. */
const parseJsonBody = (body: string | undefined): unknown => {
  if (body === undefined) return undefined;
  try {
    return JSON.parse(body);
  } catch {
    // A non-JSON body (proxy page, empty text) is not the API error contract: the failure stays a generic TH-08 error.
    return undefined;
  }
};

/**
 * E-8: the chat endpoint answers 404 THREAD_NOT_FOUND before SSE when the thread was deleted elsewhere.
 * Only that error code counts — any other 404 (or status) stays a generic reply error.
 */
const isThreadNotFound = (error: Error): boolean => {
  if (!APICallError.isInstance(error) || error.statusCode !== 404) return false;
  const body = ApiErrorSchema.safeParse(parseJsonBody(error.responseBody));
  return body.success && body.data.errorCode === 'THREAD_NOT_FOUND';
};

export type ChatErrorReport = {
  error: Error;
  /** Remote id of the thread whose request failed; undefined before the thread exists on the server. */
  remoteId: string | undefined;
  status: ShellStatusStore;
};

/** Logs a chat failure without its body and marks the thread `deleted` on 404 THREAD_NOT_FOUND (E-8). */
export function reportChatError({ error, remoteId, status }: ChatErrorReport): void {
  console.error('[web-shell] chat request failed', { remoteId, ...describeChatError(error) });
  if (remoteId !== undefined && isThreadNotFound(error)) status.getState().setHistory(remoteId, 'deleted');
}

/** Builds the shell's dependencies once per provider mount. Pure wiring, no React. */
export function createShellServices(): ShellServices {
  const apiClient = threadsApiClient;
  const status = createShellStatusStore();
  const history = createHistoryAdapterFactory({ api: apiClient, status });
  const listAdapter = createThreadListAdapter({ api: apiClient, status, notify, history });
  const transport = new AssistantChatTransport({
    api: `${apiBaseUrl}/api/chat/${ASSISTANT_AGENT_ID}`,
    credentials: 'include',
  });

  return {
    apiClient,
    status,
    listAdapter,
    history,
    transport,
    notify,
    auiConfig: AuiConfig({}),
    handleChatError: ({ error, aui }) => reportChatError({ error, remoteId: remoteIdOf(aui), status }),
  };
}
