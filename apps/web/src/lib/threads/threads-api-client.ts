import { z } from 'zod';
import {
  AgentListPageSchema,
  AgentNodeSchema,
  AgentPageViewSchema,
  AgentTasksViewSchema,
  AwaitingCountSchema,
  ConversationViewSchema,
  DecisionResponseSchema,
  DeepAgentRunViewSchema,
  InheritedHistorySchema,
  InterruptResponseSchema,
  RestartResponseSchema,
  SendMessageResponseSchema,
  SpendResponseSchema,
  StopResponseSchema,
  ThreadListResponseSchema,
  ThreadSummarySchema,
  type AgentListPage,
  type AgentNode,
  type AgentPageView,
  type AgentTasksView,
  type AwaitingCount,
  type ConversationView,
  type DecisionRequest,
  type DecisionResponse,
  type DeepAgentRunView,
  type InheritedHistory,
  type InterruptResponse,
  type RenameThreadRequest,
  type RestartResponse,
  type SendMessageRequest,
  type SendMessageResponse,
  type SpendResponse,
  type StopResponse,
  type ThreadListResponse,
  type ThreadSummary,
} from '@agent-os/contracts';
import { apiRequest } from '@/lib/api/api-request';

const threadRoute = (threadId: string): string =>
  `/api/threads/${encodeURIComponent(threadId)}`;

async function listThreads(cursor?: string): Promise<ThreadListResponse> {
  const query =
    cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`;
  return apiRequest({
    path: `/api/threads${query}`,
    schema: ThreadListResponseSchema,
  });
}

async function getThread(threadId: string): Promise<ThreadSummary> {
  return apiRequest({
    path: threadRoute(threadId),
    schema: ThreadSummarySchema,
  });
}

async function createThread(): Promise<ThreadSummary> {
  return apiRequest({
    path: '/api/threads',
    method: 'POST',
    schema: ThreadSummarySchema,
  });
}

async function renameThread({
  threadId,
  title,
}: {
  threadId: string;
  title: string;
}): Promise<ThreadSummary> {
  const body: RenameThreadRequest = { title };
  return apiRequest({
    path: threadRoute(threadId),
    method: 'PATCH',
    body,
    schema: ThreadSummarySchema,
  });
}

/** 204 on success; 404 surfaces as kind `not_found` and the caller decides what it means. */
async function deleteThread(threadId: string): Promise<void> {
  await apiRequest({ path: threadRoute(threadId), method: 'DELETE' });
}

const agentRoute = (agentId: string): string =>
  `/api/agents/${encodeURIComponent(agentId)}`;
const afterSeqQuery = (afterSeq: number): string => `?afterSeq=${afterSeq}`;

async function getConversation(
  threadId: string,
  afterSeq: number,
): Promise<ConversationView> {
  return apiRequest({
    path: `${threadRoute(threadId)}/history${afterSeqQuery(afterSeq)}`,
    schema: ConversationViewSchema,
  });
}

async function getThreadAgents(threadId: string): Promise<AgentNode[]> {
  return apiRequest({
    path: `${threadRoute(threadId)}/agents`,
    schema: z.array(AgentNodeSchema),
  });
}

/**
 * 202: the message is queued; `messageId` is null for the conversation's first message. `recordId` is
 * the chip's record (KD-5), sent only when there is one.
 */
async function sendThreadMessage(
  threadId: string,
  text: string,
  recordId?: string,
): Promise<SendMessageResponse> {
  const body: SendMessageRequest =
    recordId === undefined ? { text } : { text, recordId };
  return apiRequest({
    path: `${threadRoute(threadId)}/messages`,
    method: 'POST',
    body,
    schema: SendMessageResponseSchema,
  });
}

async function interruptThread(threadId: string): Promise<InterruptResponse> {
  return apiRequest({
    path: `${threadRoute(threadId)}/interrupt`,
    method: 'POST',
    schema: InterruptResponseSchema,
  });
}

async function listAgents(cursor?: string): Promise<AgentListPage> {
  const query =
    cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`;
  return apiRequest({
    path: `/api/agents${query}`,
    schema: AgentListPageSchema,
  });
}

async function getAwaitingCount(): Promise<AwaitingCount> {
  return apiRequest({
    path: '/api/agents/awaiting',
    schema: AwaitingCountSchema,
  });
}

async function getAgentPage(
  agentId: string,
  afterSeq: number,
): Promise<AgentPageView> {
  return apiRequest({
    path: `${agentRoute(agentId)}/history${afterSeqQuery(afterSeq)}`,
    schema: AgentPageViewSchema,
  });
}

async function getInherited(
  agentId: string,
  afterSeq: number,
): Promise<InheritedHistory> {
  return apiRequest({
    path: `${agentRoute(agentId)}/inherited${afterSeqQuery(afterSeq)}`,
    schema: InheritedHistorySchema,
  });
}

async function getRun(agentId: string): Promise<DeepAgentRunView> {
  return apiRequest({
    path: `${agentRoute(agentId)}/run`,
    schema: DeepAgentRunViewSchema,
  });
}

/** The session's tasks by number and its delegations in order; both empty for an agent without them. */
async function getAgentTasks(agentId: string): Promise<AgentTasksView> {
  return apiRequest({
    path: `${agentRoute(agentId)}/tasks`,
    schema: AgentTasksViewSchema,
  });
}

async function sendAgentMessage(
  agentId: string,
  text: string,
): Promise<SendMessageResponse> {
  const body: SendMessageRequest = { text };
  return apiRequest({
    path: `${agentRoute(agentId)}/messages`,
    method: 'POST',
    body,
    schema: SendMessageResponseSchema,
  });
}

async function interruptAgent(agentId: string): Promise<InterruptResponse> {
  return apiRequest({
    path: `${agentRoute(agentId)}/interrupt`,
    method: 'POST',
    schema: InterruptResponseSchema,
  });
}

async function stopAgent(agentId: string): Promise<StopResponse> {
  return apiRequest({
    path: `${agentRoute(agentId)}/stop`,
    method: 'POST',
    schema: StopResponseSchema,
  });
}

/** 201: the new agent; 409 `NOT_FINISHED` / `PARENT_FINISHED` surfaces as `http` with that code. */
async function restartAgent(agentId: string): Promise<RestartResponse> {
  return apiRequest({
    path: `${agentRoute(agentId)}/restart`,
    method: 'POST',
    schema: RestartResponseSchema,
  });
}

/** `args` are the tool's full arguments when the brief or call was edited. */
async function decide(
  decisionId: string,
  decision: DecisionRequest,
): Promise<DecisionResponse> {
  return apiRequest({
    path: `/api/decisions/${encodeURIComponent(decisionId)}`,
    method: 'POST',
    body: decision,
    schema: DecisionResponseSchema,
  });
}

async function getSpend(): Promise<SpendResponse> {
  return apiRequest({ path: '/api/spend', schema: SpendResponseSchema });
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
  getAgentTasks,
  sendAgentMessage,
  interruptAgent,
  stopAgent,
  restartAgent,
  decide,
  getSpend,
};

export type ThreadsApiClient = typeof threadsApiClient;
