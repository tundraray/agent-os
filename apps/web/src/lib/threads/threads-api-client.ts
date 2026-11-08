import type { ZodType } from "zod";
import {
  ResearchStopResponseSchema,
  ThreadListResponseSchema,
  ThreadMessagesResponseSchema,
  ThreadResearchResponseSchema,
  ThreadSummarySchema,
  type RenameThreadRequest,
  type ResearchLaunchView,
  type ThreadListResponse,
  type ThreadResearchResponse,
  type ThreadSummary,
} from "@agent-os/contracts";
import { safeValidateUIMessages, type UIMessage } from "ai";
import { apiBaseUrl } from "@/lib/config";
import { ThreadsApiError } from "./threads-api-error";

type RequestInput = {
  path: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  /** 400 on a `:threadId` route means the id is outside ThreadIdSchema: no such thread for the user. */
  treatBadRequestAsNotFound?: boolean;
  signal?: AbortSignal;
};

async function send({
  path,
  method = "GET",
  body,
  treatBadRequestAsNotFound = false,
  signal,
}: RequestInput): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      method,
      credentials: "include",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch {
    throw new ThreadsApiError("network");
  }
  if (response.status === 404 || (treatBadRequestAsNotFound && response.status === 400)) {
    throw new ThreadsApiError("not_found", response.status);
  }
  if (!response.ok) throw new ThreadsApiError("http", response.status);
  return response;
}

async function parse<T>(response: Response, schema: ZodType<T>): Promise<T> {
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    throw new ThreadsApiError("invalid_response", response.status);
  }
  const result = schema.safeParse(data);
  if (!result.success) throw new ThreadsApiError("invalid_response", response.status);
  return result.data;
}

/**
 * Sends and parses within `timeoutMs`, the body read included: a body that stalls after the headers would otherwise
 * outlive the limit. Past the limit the request is aborted and the caller sees a lost connection (`network`).
 */
async function sendAndParseWithin<T>(
  input: Omit<RequestInput, "signal">,
  schema: ZodType<T>,
  timeoutMs: number,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Rejected before the abort, so the abort's own failure of the fetch or the body read cannot win the race.
      reject(new ThreadsApiError("network"));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      send({ ...input, signal: controller.signal }).then((response) => parse(response, schema)),
      expired,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const threadRoute = (threadId: string): string => `/api/threads/${encodeURIComponent(threadId)}`;

export async function listThreads(cursor?: string): Promise<ThreadListResponse> {
  const query = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
  return parse(await send({ path: `/api/threads${query}` }), ThreadListResponseSchema);
}

export async function getThread(threadId: string): Promise<ThreadSummary> {
  return parse(
    await send({ path: threadRoute(threadId), treatBadRequestAsNotFound: true }),
    ThreadSummarySchema,
  );
}

export async function getThreadMessages(threadId: string): Promise<UIMessage[]> {
  const { messages } = await parse(
    await send({ path: `${threadRoute(threadId)}/messages`, treatBadRequestAsNotFound: true }),
    ThreadMessagesResponseSchema,
  );
  if (messages.length === 0) return []; // safeValidateUIMessages rejects an empty array
  const deep = await safeValidateUIMessages({ messages });
  if (!deep.success) throw new ThreadsApiError("invalid_response", 200);
  return deep.data;
}

/** Launches of the thread in creation order (design-chat-entry.md, `GET /api/threads/:threadId/research`). */
export async function getThreadResearch(threadId: string): Promise<ThreadResearchResponse> {
  return parse(
    await send({ path: `${threadRoute(threadId)}/research`, treatBadRequestAsNotFound: true }),
    ThreadResearchResponseSchema,
  );
}

export async function createThread(): Promise<ThreadSummary> {
  return parse(await send({ path: "/api/threads", method: "POST" }), ThreadSummarySchema);
}

export async function renameThread({
  threadId,
  title,
}: {
  threadId: string;
  title: string;
}): Promise<ThreadSummary> {
  const body: RenameThreadRequest = { title };
  return parse(
    await send({ path: threadRoute(threadId), method: "PATCH", body }),
    ThreadSummarySchema,
  );
}

/** 204 on success; 404 surfaces as ThreadsApiError('not_found') and the caller decides what it means. */
export async function deleteThread(threadId: string): Promise<void> {
  await send({ path: threadRoute(threadId), method: "DELETE" });
}

/**
 * The stop route gives no response deadline of its own (design-lifecycle.md, ResearchStopResponse), so the client
 * bounds the wait: without it a hung network would keep the card in «Остановка» for minutes (design-web.md, KD-4).
 * A fixed value of the client, not a setting.
 */
const STOP_RESEARCH_TIMEOUT_MS = 20_000;

/**
 * `POST /api/threads/:threadId/research/:launchKey/stop` (design-web.md, Contract `threadsApiClient.stopResearch`).
 * Every failure is a ThreadsApiError; the error code in the body is never read.
 */
export async function stopResearch(
  threadId: string,
  launchKey: string,
  timeoutMs: number = STOP_RESEARCH_TIMEOUT_MS,
): Promise<ResearchLaunchView> {
  const { launch } = await sendAndParseWithin(
    {
      path: `${threadRoute(threadId)}/research/${encodeURIComponent(launchKey)}/stop`,
      method: "POST",
      treatBadRequestAsNotFound: true,
    },
    ResearchStopResponseSchema,
    timeoutMs,
  );
  return launch;
}

export type ThreadsApiClient = {
  listThreads: typeof listThreads;
  getThread: typeof getThread;
  getThreadMessages: typeof getThreadMessages;
  getThreadResearch: typeof getThreadResearch;
  createThread: typeof createThread;
  renameThread: typeof renameThread;
  deleteThread: typeof deleteThread;
  stopResearch: typeof stopResearch;
};

export const threadsApiClient: ThreadsApiClient = {
  listThreads,
  getThread,
  getThreadMessages,
  getThreadResearch,
  createThread,
  renameThread,
  deleteThread,
  stopResearch,
};
