import { AssistantChatTransport } from '@assistant-ui/ai-sdk';
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
    handleChatError: ({ error, aui }) => {
      console.error('[web-shell] chat request failed', {
        remoteId: remoteIdOf(aui),
        ...describeChatError(error),
      });
    },
  };
}
