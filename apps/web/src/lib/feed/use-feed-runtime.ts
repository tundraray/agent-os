import {
  MessageNotSentError,
  useAui,
  useAuiState,
  useExternalStoreRuntime,
  type AppendMessage,
  type AssistantRuntime,
  type ThreadMessageLike,
} from "@assistant-ui/react";
// The thread hook runs inside assistant-ui's tap resources, where every thread of the list shares one
// React component: plain React hooks there would change that component's hook count as threads come
// and go. The shim runs them as tap hooks inside a resource and as React hooks in a component.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "@assistant-ui/tap/react-shim";

import { logger } from "@/lib/logger";
import type { ShellServices } from "@/lib/threads/shell-services";
import { describeThreadsError } from "@/lib/threads/threads-api-error";

import type { FeedState, FeedStore } from "./feed-store";
import { toFeed } from "./to-feed";

const NO_MESSAGES: ThreadMessageLike[] = [];
const noSubscription = (): (() => void) => () => {};

/** The text of a composer message; attachments are hidden (D-04), so only text parts count. */
function textOf(message: AppendMessage): string {
  return message.content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

/**
 * Sends through the store. A refused or lost message is already logged by the store and kept in
 * `sendFailure`, which the composer shows with its text (KD-4, MC-27); assistant-ui gets no error,
 * because an error there would not return the text and would mark nothing the UXRD asks for.
 */
async function sendToFeed(feed: FeedStore, text: string): Promise<void> {
  try {
    await feed.send(text);
  } catch {
    // Handled by the store: logged once in its command wrapper and recorded as `sendFailure`.
  }
}

function useFeedState(feed: FeedStore | null): FeedState | null {
  return useSyncExternalStore(
    feed === null ? noSubscription : feed.subscribe,
    () => (feed === null ? null : feed.getState()),
    () => (feed === null ? null : feed.getState()),
  );
}

/**
 * assistant-ui over a feed store (design-web.md, KD-1, Contract «useFeedRuntime»): messages from
 * `toFeed`, `onNew` → `send`, `isLoading` until the first read. No `isRunning`, `onCancel`, `onEdit`
 * or `onReload`: with `isRunning` the library disables «Отправить», and FR-16 keeps sending open.
 * `feed` is null for a conversation not created yet; `send` then decides where the text goes.
 */
export function useFeedRuntime(
  feed: FeedStore | null,
  send: (text: string) => Promise<void> = (text) =>
    feed === null ? Promise.resolve() : sendToFeed(feed, text),
): AssistantRuntime {
  const state = useFeedState(feed);
  const messages = useMemo(
    () =>
      state === null || state.view === null
        ? NO_MESSAGES
        : toFeed(state.view, state.draft, state.optimistic),
    [state],
  );

  return useExternalStoreRuntime<ThreadMessageLike>({
    messages,
    convertMessage: (message) => message,
    isLoading: state !== null && !state.loaded && state.loadError === null,
    onNew: (message) => send(textOf(message)),
  });
}

/**
 * The conversation's runtime, called by the thread list's `runtimeHook` once per hosted thread.
 * An item without `remoteId` creates the conversation on its first message: `initialize()` of the
 * list item, then the stream watches it (≤ 1 s, so the first parts of the answer are not lost), then
 * the message is sent (KD-1, KD-2). Once the feed shows the first model answer, the item asks for
 * its title once (spike S-1, c): the library asks only right after `initialize()`, before any answer.
 */
export function useThreadFeedRuntime(services: ShellServices): AssistantRuntime {
  const aui = useAui();
  const itemId = useAuiState((s) => s.threadListItem.id);
  const itemRemoteId = useAuiState((s) => s.threadListItem.remoteId);
  const titled = useAuiState((s) => (s.threadListItem.title ?? "").trim() !== "");
  // `initialize()` resolves before the item's state carries the remoteId (spike S-1, a).
  const [createdId, setCreatedId] = useState<string | undefined>(undefined);
  const remoteId = itemRemoteId ?? createdId;

  const feed = useMemo(
    () => (remoteId === undefined ? null : services.feeds.forThread(remoteId, itemId)),
    [services, remoteId, itemId],
  );

  const send = useCallback(
    async (text: string): Promise<void> => {
      if (feed !== null) return sendToFeed(feed, text);
      let created: string;
      try {
        ({ remoteId: created } = await aui.threadListItem.initialize());
      } catch (error) {
        logger.error("[web-shell] thread create failed", describeThreadsError(error));
        // The library returns the text to the composer for this error only.
        throw new MessageNotSentError();
      }
      setCreatedId(created);
      await services.live.watch(`thread:${created}`);
      await sendToFeed(services.feeds.forThread(created, itemId), text);
    },
    [aui, feed, itemId, services],
  );

  const hasModelAnswer = useSyncExternalStore(
    feed === null ? noSubscription : feed.subscribe,
    () => feed?.getState().view?.entries.some((entry) => entry.kind === "model_answer") ?? false,
    () => false,
  );
  const titleRequestedRef = useRef(false);
  useEffect(() => {
    if (!hasModelAnswer || titled || titleRequestedRef.current) return;
    titleRequestedRef.current = true;
    aui.threadListItem.generateTitle();
  }, [aui, hasModelAnswer, titled]);

  return useFeedRuntime(feed, send);
}
