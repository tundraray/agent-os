import { z } from 'zod';
import {
  AgentListPageSchema,
  AgentNodeSchema,
  AgentPageViewSchema,
  AgentTasksViewSchema,
  AwaitingCountSchema,
  ConversationSearchResponseSchema,
  ConversationViewSchema,
  DecisionResponseSchema,
  DeepAgentRunViewSchema,
  DocumentSchema,
  InheritedHistorySchema,
  InterruptResponseSchema,
  RestartResponseSchema,
  SendMessageResponseSchema,
  SpendResponseSchema,
  StopResponseSchema,
  ThreadDocumentsViewSchema,
  ThreadForksResponseSchema,
  ThreadListResponseSchema,
  ThreadSummarySchema,
  type AgentListPage,
  type AgentNode,
  type AgentPageView,
  type AgentTasksView,
  type AwaitingCount,
  type ConversationSearchResponse,
  type ConversationView,
  type DecisionRequest,
  type DecisionResponse,
  type DeepAgentRunView,
  type Document,
  type ForkRequest,
  type InheritedHistory,
  type InterruptResponse,
  type MarkSeenRequest,
  type RenameThreadRequest,
  type RestartResponse,
  type SendMessageRequest,
  type SendMessageResponse,
  type SpendResponse,
  type StopResponse,
  type ThreadDocumentsView,
  type ThreadForksResponse,
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

/** GET /api/search: one page of matches for `q`; `cursor` is the previous page's `nextCursor`. */
async function searchConversations(
  q: string,
  cursor?: string,
): Promise<ConversationSearchResponse> {
  const params = new URLSearchParams({ q });
  if (cursor !== undefined) params.set('cursor', cursor);
  return apiRequest({
    path: `/api/search?${params.toString()}`,
    schema: ConversationSearchResponseSchema,
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

/**
 * 201: the fork; 409 `FORK_REFUSED` carries its `reason`. Without `body` the whole conversation is forked; `throughSeq`
 * forks it through that message, `edit` replaces an employee's message (improvements design-web.md, KD-2).
 */
async function forkThread(
  threadId: string,
  body?: ForkRequest,
): Promise<ThreadSummary> {
  return apiRequest({
    path: `${threadRoute(threadId)}/fork`,
    method: 'POST',
    body,
    schema: ThreadSummarySchema,
  });
}

/** 204: the conversation's «seen through» mark rose to `throughSeq` (improvements KD-4); it never goes down. */
async function markSeen(threadId: string, throughSeq: number): Promise<void> {
  const body: MarkSeenRequest = { throughSeq };
  await apiRequest({
    path: `${threadRoute(threadId)}/seen`,
    method: 'PUT',
    body,
  });
}

async function getThreadForks(threadId: string): Promise<ThreadForksResponse> {
  return apiRequest({
    path: `${threadRoute(threadId)}/forks`,
    schema: ThreadForksResponseSchema,
  });
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

async function getThreadDocuments(
  threadId: string,
): Promise<ThreadDocumentsView> {
  return apiRequest({
    path: `${threadRoute(threadId)}/documents`,
    schema: ThreadDocumentsViewSchema,
  });
}

async function getThreadDocument(
  threadId: string,
  documentId: number,
): Promise<Document> {
  return apiRequest({
    path: `${threadRoute(threadId)}/documents/${documentId}`,
    schema: DocumentSchema,
  });
}

/**
 * 202: the message is queued; `messageId` is null for the conversation's first message and for a repeat of
 * `sendKey`. `recordId` is the chip's record (KD-5), sent only when there is one.
 */
async function sendThreadMessage(
  threadId: string,
  text: string,
  sendKey: string,
  recordId?: string,
): Promise<SendMessageResponse> {
  const body: SendMessageRequest =
    recordId === undefined ? { text, sendKey } : { text, sendKey, recordId };
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
  sendKey: string,
): Promise<SendMessageResponse> {
  const body: SendMessageRequest = { text, sendKey };
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
  searchConversations,
  getThread,
  createThread,
  renameThread,
  deleteThread,
  forkThread,
  markSeen,
  getThreadForks,
  getConversation,
  getThreadAgents,
  getThreadDocuments,
  getThreadDocument,
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
