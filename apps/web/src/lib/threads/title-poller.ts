import type { ThreadMessage } from "@assistant-ui/react";
import { createAssistantStream, type AssistantStream } from "assistant-stream";
import { logger } from "@/lib/logger";
import type { ThreadsApiClient } from "./threads-api-client";
import { describeThreadsError, isThreadsApiError } from "./threads-api-error";
import type { ShellStatusStore } from "./shell-status-store";

/** At most one GET /api/threads/:id per interval. */
const TITLE_POLL_INTERVAL_MS = 1_000;
/** The poll stops once this window after the call has elapsed. */
const TITLE_POLL_WINDOW_MS = 15_000;

export type TitlePollDeps = {
  api: Pick<ThreadsApiClient, "getThread">;
  status: ShellStatusStore;
};

export type TitlePollInput = {
  remoteId: string;
  messages: readonly ThreadMessage[];
  deps: TitlePollDeps;
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * The server writes the title asynchronously after the first answer; this stream polls the thread
 * until the title appears and emits it as text. Without an assistant answer there is nothing to
 * title yet, so the stream closes at once without requests.
 */
export function createTitlePollStream({
  remoteId,
  messages,
  deps,
}: TitlePollInput): AssistantStream {
  const hasAssistantAnswer = messages.some((message) => message.role === "assistant");
  if (!hasAssistantAnswer) return createAssistantStream(() => {});

  const { api, status } = deps;
  return createAssistantStream(async (controller) => {
    const deadline = Date.now() + TITLE_POLL_WINDOW_MS;
    status.getState().setTitleWaiting(remoteId, true);
    try {
      for (;;) {
        const startedAt = Date.now();
        try {
          const thread = await api.getThread(remoteId);
          if (thread.title !== null) {
            controller.appendText(thread.title);
            return;
          }
        } catch (error) {
          if (isThreadsApiError(error) && error.kind === "not_found") return;
          logger.warn("[web-shell] title poll request failed", {
            remoteId,
            ...describeThreadsError(error),
          });
        }
        const nextAt = startedAt + TITLE_POLL_INTERVAL_MS;
        if (nextAt >= deadline) return;
        await delay(Math.max(0, nextAt - Date.now()));
      }
    } finally {
      status.getState().setTitleWaiting(remoteId, false);
    }
  });
}
