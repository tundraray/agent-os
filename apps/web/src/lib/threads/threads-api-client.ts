import { z, type ZodType } from "zod";
import {
  AgentListPageSchema,
  AgentNodeSchema,
  AgentPageViewSchema,
  ApiErrorSchema,
  AwaitingCountSchema,
  ConversationViewSchema,
  DecisionResponseSchema,
  InheritedHistorySchema,
  InterruptResponseSchema,
  RestartResponseSchema,
  SendMessageResponseSchema,
  SpendResponseSchema,
  StopResponseSchema,
  ThreadListResponseSchema,
  ThreadSummarySchema,
  WorkflowRunViewSchema,
  type AgentListPage,
  type AgentNode,
  type AgentPageView,
  type AwaitingCount,
  type ConversationView,
  type DecisionRequest,
  type DecisionResponse,
  type InheritedHistory,
  type InterruptRequest,
  type InterruptResponse,
  type RenameThreadRequest,
  type RestartResponse,
  type SendMessageRequest,
  type SendMessageResponse,
  type SpendResponse,
  type StopResponse,
  type ThreadListResponse,
  type ThreadSummary,
  type WorkflowRunView,
} from "@agent-os/contracts";
import { apiBaseUrl } from "@/lib/config";
import { ThreadsApiError } from "./threads-api-error";

type RequestInput = {
  path: string;
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  body?: unknown;
  /** 400 on a `:threadId` route means the id is outside ThreadIdSchema: no such thread for the user. */
  treatBadRequestAsNotFound?: boolean;
};

async function send({
  path,
  method = "GET",
  body,
  treatBadRequestAsNotFound = false,
}: RequestInput): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      method,
      credentials: "include",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ThreadsApiError("network");
  }
  if (response.ok) return response;
  const code = await errorCodeOf(response);
  if (response.status === 404 || (treatBadRequestAsNotFound && response.status === 400)) {
    throw new ThreadsApiError("not_found", response.status, code);
  }
  throw new ThreadsApiError("http", response.status, code);
}

/** `errorCode` of an ApiError body; a body that is not JSON or not an ApiError has no code. */
async function errorCodeOf(response: Response): Promise<string | undefined> {
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    return undefined; // the status alone classifies the failure
  }
  const result = ApiErrorSchema.safeParse(data);
  return result.success ? result.data.errorCode : undefined;
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

const threadRoute = (threadId: string): string => `/api/threads/${encodeURIComponent(threadId)}`;

async function listThreads(cursor?: string): Promise<ThreadListResponse> {
  const query = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
  return parse(await send({ path: `/api/threads${query}` }), ThreadListResponseSchema);
}

async function getThread(threadId: string): Promise<ThreadSummary> {
  return parse(
    await send({ path: threadRoute(threadId), treatBadRequestAsNotFound: true }),
    ThreadSummarySchema,
  );
}

async function createThread(): Promise<ThreadSummary> {
  return parse(await send({ path: "/api/threads", method: "POST" }), ThreadSummarySchema);
}

async function renameThread({
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
async function deleteThread(threadId: string): Promise<void> {
  await send({ path: threadRoute(threadId), method: "DELETE" });
}

const agentRoute = (agentId: string): string => `/api/agents/${encodeURIComponent(agentId)}`;
const afterSeqQuery = (afterSeq: number): string => `?afterSeq=${afterSeq}`;
const interruptBody = (text: string | undefined): InterruptRequest =>
  text === undefined ? {} : { text };

async function getConversation(threadId: string, afterSeq: number): Promise<ConversationView> {
  return parse(
    await send({ path: `${threadRoute(threadId)}/history${afterSeqQuery(afterSeq)}` }),
    ConversationViewSchema,
  );
}

async function getThreadAgents(threadId: string): Promise<AgentNode[]> {
  return parse(await send({ path: `${threadRoute(threadId)}/agents` }), z.array(AgentNodeSchema));
}

/** 202: the message is queued; `messageId` is null for the conversation's first message. */
async function sendThreadMessage(threadId: string, text: string): Promise<SendMessageResponse> {
  const body: SendMessageRequest = { text };
  return parse(
    await send({ path: `${threadRoute(threadId)}/messages`, method: "POST", body }),
    SendMessageResponseSchema,
  );
}

async function interruptThread(threadId: string, text?: string): Promise<InterruptResponse> {
  return parse(
    await send({ path: `${threadRoute(threadId)}/interrupt`, method: "POST", body: interruptBody(text) }),
    InterruptResponseSchema,
  );
}

async function listAgents(cursor?: string): Promise<AgentListPage> {
  const query = cursor === undefined ? "" : `?cursor=${encodeURIComponent(cursor)}`;
  return parse(await send({ path: `/api/agents${query}` }), AgentListPageSchema);
}

async function getAwaitingCount(): Promise<AwaitingCount> {
  return parse(await send({ path: "/api/agents/awaiting" }), AwaitingCountSchema);
}

async function getAgentPage(agentId: string, afterSeq: number): Promise<AgentPageView> {
  return parse(
    await send({ path: `${agentRoute(agentId)}/history${afterSeqQuery(afterSeq)}` }),
    AgentPageViewSchema,
  );
}

async function getInherited(agentId: string, afterSeq: number): Promise<InheritedHistory> {
  return parse(
    await send({ path: `${agentRoute(agentId)}/inherited${afterSeqQuery(afterSeq)}` }),
    InheritedHistorySchema,
  );
}

async function getRun(agentId: string): Promise<WorkflowRunView> {
  return parse(await send({ path: `${agentRoute(agentId)}/run` }), WorkflowRunViewSchema);
}

async function sendAgentMessage(agentId: string, text: string): Promise<SendMessageResponse> {
  const body: SendMessageRequest = { text };
  return parse(
    await send({ path: `${agentRoute(agentId)}/messages`, method: "POST", body }),
    SendMessageResponseSchema,
  );
}

async function interruptAgent(agentId: string, text?: string): Promise<InterruptResponse> {
  return parse(
    await send({ path: `${agentRoute(agentId)}/interrupt`, method: "POST", body: interruptBody(text) }),
    InterruptResponseSchema,
  );
}

async function stopAgent(agentId: string): Promise<StopResponse> {
  return parse(await send({ path: `${agentRoute(agentId)}/stop`, method: "POST" }), StopResponseSchema);
}

/** 201: the new agent; 409 `NOT_FINISHED` / `PARENT_FINISHED` surfaces as `http` with that code. */
async function restartAgent(agentId: string): Promise<RestartResponse> {
  return parse(
    await send({ path: `${agentRoute(agentId)}/restart`, method: "POST" }),
    RestartResponseSchema,
  );
}

/** `args` are the tool's full arguments when the brief or call was edited. */
async function decide(decisionId: string, decision: DecisionRequest): Promise<DecisionResponse> {
  return parse(
    await send({
      path: `/api/decisions/${encodeURIComponent(decisionId)}`,
      method: "POST",
      body: decision,
    }),
    DecisionResponseSchema,
  );
}

async function getSpend(): Promise<SpendResponse> {
  return parse(await send({ path: "/api/spend" }), SpendResponseSchema);
}

export const threadsApiClient = {
  listThreads,
  getThread,
  createThread,
  renameThread,
  deleteThread,
  getConversation,
  getThreadAgents,
  sendThreadMessage,
  interruptThread,
  listAgents,
  getAwaitingCount,
  getAgentPage,
  getInherited,
  getRun,
  sendAgentMessage,
  interruptAgent,
  stopAgent,
  restartAgent,
  decide,
  getSpend,
};

export type ThreadsApiClient = typeof threadsApiClient;
