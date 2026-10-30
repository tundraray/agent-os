import type {
  AssistantClient,
  MessageFormatAdapter,
  MessageFormatRepository,
  ThreadHistoryAdapter,
} from "@assistant-ui/react";
import type { UIMessage } from "ai";
import { createRetryGate } from "./retry-gate";
import type { ThreadsApiClient } from "./threads-api-client";
import { describeThreadsError, isThreadsApiError } from "./threads-api-error";
import type { ShellStatusStore } from "./shell-status-store";

export type HistoryAdapterDeps = {
  api: Pick<ThreadsApiClient, "getThreadMessages">;
  status: ShellStatusStore;
};

export type HistoryAdapterFactory = {
  /** One adapter per thread body; the same object for the same `aui` client. */
  adapterFor: (aui: AssistantClient) => ThreadHistoryAdapter;
  /** «Повторить» for a failed history load. */
  retry: (remoteId: string) => void;
  /** The thread was deleted: reject a parked load and drop its statuses. */
  forget: (remoteId: string) => void;
};

const AI_SDK_V6_FORMAT = "ai-sdk/v6";

type AnyFormatAdapter = MessageFormatAdapter<unknown, Record<string, unknown>>;

function assertAiSdkV6Format(formatAdapter: Pick<AnyFormatAdapter, "format">): void {
  if (formatAdapter.format !== AI_SDK_V6_FORMAT) {
    throw new Error(
      `Thread history supports only the "${AI_SDK_V6_FORMAT}" format, got "${formatAdapter.format}"`,
    );
  }
}

/**
 * The only narrowing of the generic TMessage to UIMessage. It is sound because withFormat accepts
 * only the "ai-sdk/v6" format adapter, whose message type is the AI SDK UIMessage.
 */
function narrowRepository<TMessage, TStorageFormat extends Record<string, unknown>>(
  formatAdapter: MessageFormatAdapter<TMessage, TStorageFormat>,
  repository: MessageFormatRepository<UIMessage>,
): MessageFormatRepository<TMessage> {
  assertAiSdkV6Format(formatAdapter);
  return repository as unknown as MessageFormatRepository<TMessage>;
}

/** Linear chain, oldest first: parentId = previous id, headId = last id. */
const toRepository = (messages: readonly UIMessage[]): MessageFormatRepository<UIMessage> => ({
  headId: messages.at(-1)?.id ?? null,
  messages: messages.map((message, index) => ({
    parentId: messages[index - 1]?.id ?? null,
    message,
  })),
});

export function createHistoryAdapterFactory({
  api,
  status,
}: HistoryAdapterDeps): HistoryAdapterFactory {
  const gate = createRetryGate();
  const cache = new WeakMap<AssistantClient, ThreadHistoryAdapter>();

  const loadFor = async (remoteId: string): Promise<MessageFormatRepository<UIMessage>> => {
    for (;;) {
      status.getState().setHistory(remoteId, "loading");
      try {
        const messages = await api.getThreadMessages(remoteId);
        status.getState().setHistory(remoteId, "ready");
        return toRepository(messages);
      } catch (error) {
        if (isThreadsApiError(error) && error.kind === "not_found") {
          status.getState().setHistory(remoteId, "not_found");
          throw error;
        }
        console.error("[web-shell] thread history load failed", {
          remoteId,
          ...describeThreadsError(error),
        });
        status.getState().setHistory(remoteId, "load_failed");
        // Resolves on retry (loop again); rejects with not_found when the thread is deleted.
        await gate.wait(remoteId);
      }
    }
  };

  const adapterFor = (aui: AssistantClient): ThreadHistoryAdapter => {
    const cached = cache.get(aui);
    if (cached) return cached;
    // Resolved lazily on every call: the thread gets its remoteId only after initialize().
    const getRemoteId = (): string | undefined =>
      aui.threadListItem.source ? aui.threadListItem.getState().remoteId : undefined;
    const adapter: ThreadHistoryAdapter = {
      load: () => Promise.resolve({ messages: [] }),
      append: () => Promise.resolve(),
      withFormat(formatAdapter) {
        assertAiSdkV6Format(formatAdapter);
        return {
          load: async () => {
            const remoteId = getRemoteId();
            if (remoteId === undefined) return { messages: [] };
            return narrowRepository(formatAdapter, await loadFor(remoteId));
          },
          // Messages are persisted by POST /api/chat on the server.
          append: () => Promise.resolve(),
        };
      },
    };
    cache.set(aui, adapter);
    return adapter;
  };

  return {
    adapterFor,
    retry: (remoteId) => gate.release(remoteId),
    forget: (remoteId) => {
      gate.drop(remoteId);
      status.getState().forgetThread(remoteId);
    },
  };
}
