import { setTimeout as delay } from 'node:timers/promises';
import type { INestApplication } from '@nestjs/common';
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
  type ApiError,
  type AwaitingCount,
  type ConversationView,
  type DecisionRequest,
  type DecisionResponse,
  type InheritedHistory,
  type InterruptResponse,
  type RestartResponse,
  type SendMessageResponse,
  type SpendResponse,
  type StopResponse,
  type ThreadListResponse,
  type ThreadSummary,
  type WorkflowRunView,
} from '@agent-os/contracts';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types.js';
import { z } from 'zod';

/**
 * Typed helpers over supertest for the chat API (design-chat.md, Contract Definitions): every request
 * carries the employee as `x-user-id` (SessionGuard is real), every success body is parsed with its
 * `packages/contracts` schema (time fields are ISO strings), and an unexpected status fails with the body.
 */

/** Poll interval of {@link waitFor}. */
const POLL_MS = 50;

export type Method = 'get' | 'post' | 'patch' | 'delete';

/** Fails unless the response has `status`; returns the body parsed with `schema`. */
export async function expectBody<T>(
  response: Promise<Response> | Response,
  status: number,
  schema: z.ZodType<T>,
): Promise<T> {
  const answered = await response;
  if (answered.status !== status) {
    throw new Error(
      `Expected ${status}, got ${answered.status}: ${JSON.stringify(answered.body)}`,
    );
  }
  return schema.parse(answered.body);
}

/** Fails unless the response is an error with `status`; returns its `ApiErrorSchema` body. */
export function expectError(
  response: Promise<Response> | Response,
  status: number,
): Promise<ApiError> {
  return expectBody(response, status, ApiErrorSchema);
}

/** The API as one employee sees it. */
export interface ChatApi {
  readonly ownerId: string;
  /** A request under `/api` as this employee; the body, when given, is sent as JSON. */
  raw(method: Method, path: string, body?: object): Promise<Response>;

  listThreads(cursor?: string): Promise<ThreadListResponse>;
  createThread(): Promise<ThreadSummary>;
  getThread(threadId: string): Promise<ThreadSummary>;
  renameThread(threadId: string, title: string): Promise<ThreadSummary>;
  deleteThread(threadId: string): Promise<void>;
  history(threadId: string, afterSeq?: number): Promise<ConversationView>;
  threadAgents(threadId: string): Promise<AgentNode[]>;
  /** `POST /threads/:id/messages`, 202. */
  send(threadId: string, text: string): Promise<SendMessageResponse>;
  /** `POST /threads/:id/interrupt`, 200; without text the body is absent. */
  interrupt(threadId: string, text?: string): Promise<InterruptResponse>;

  agentList(cursor?: string): Promise<AgentListPage>;
  awaiting(): Promise<AwaitingCount>;
  agentPage(agentId: string, afterSeq?: number): Promise<AgentPageView>;
  inherited(agentId: string, afterSeq?: number): Promise<InheritedHistory>;
  run(agentId: string): Promise<WorkflowRunView>;
  sendToAgent(agentId: string, text: string): Promise<SendMessageResponse>;
  interruptAgent(agentId: string, text?: string): Promise<InterruptResponse>;
  stopAgent(agentId: string): Promise<StopResponse>;
  restartAgent(agentId: string): Promise<RestartResponse>;

  /** `POST /decisions/:id`, 200. */
  decide(decisionId: string, decision: DecisionRequest): Promise<DecisionResponse>;
  spend(): Promise<SpendResponse>;
}

const AgentTreeSchema = z.array(AgentNodeSchema);
const NoBodySchema = z.unknown();

function afterSeqQuery(afterSeq: number | undefined): string {
  return afterSeq === undefined ? '' : `?afterSeq=${afterSeq}`;
}

function cursorQuery(cursor: string | undefined): string {
  return cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`;
}

export function chatApi(app: INestApplication<App>, ownerId: string): ChatApi {
  const raw = (method: Method, path: string, body?: object): Promise<Response> => {
    const test = request(app.getHttpServer())[method](`/api${path}`).set('x-user-id', ownerId);
    return body === undefined ? test : test.send(body);
  };
  const ok = <T>(status: number, schema: z.ZodType<T>, method: Method, path: string, body?: object) =>
    expectBody(raw(method, path, body), status, schema);

  return {
    ownerId,
    raw,
    listThreads: (cursor) => ok(200, ThreadListResponseSchema, 'get', `/threads${cursorQuery(cursor)}`),
    createThread: () => ok(201, ThreadSummarySchema, 'post', '/threads'),
    getThread: (threadId) => ok(200, ThreadSummarySchema, 'get', `/threads/${threadId}`),
    renameThread: (threadId, title) =>
      ok(200, ThreadSummarySchema, 'patch', `/threads/${threadId}`, { title }),
    deleteThread: async (threadId) => {
      await ok(204, NoBodySchema, 'delete', `/threads/${threadId}`);
    },
    history: (threadId, afterSeq) =>
      ok(200, ConversationViewSchema, 'get', `/threads/${threadId}/history${afterSeqQuery(afterSeq)}`),
    threadAgents: (threadId) => ok(200, AgentTreeSchema, 'get', `/threads/${threadId}/agents`),
    send: (threadId, text) =>
      ok(202, SendMessageResponseSchema, 'post', `/threads/${threadId}/messages`, { text }),
    interrupt: (threadId, text) =>
      ok(
        200,
        InterruptResponseSchema,
        'post',
        `/threads/${threadId}/interrupt`,
        text === undefined ? undefined : { text },
      ),

    agentList: (cursor) => ok(200, AgentListPageSchema, 'get', `/agents${cursorQuery(cursor)}`),
    awaiting: () => ok(200, AwaitingCountSchema, 'get', '/agents/awaiting'),
    agentPage: (agentId, afterSeq) =>
      ok(200, AgentPageViewSchema, 'get', `/agents/${agentId}/history${afterSeqQuery(afterSeq)}`),
    inherited: (agentId, afterSeq) =>
      ok(200, InheritedHistorySchema, 'get', `/agents/${agentId}/inherited${afterSeqQuery(afterSeq)}`),
    run: (agentId) => ok(200, WorkflowRunViewSchema, 'get', `/agents/${agentId}/run`),
    sendToAgent: (agentId, text) =>
      ok(202, SendMessageResponseSchema, 'post', `/agents/${agentId}/messages`, { text }),
    interruptAgent: (agentId, text) =>
      ok(
        200,
        InterruptResponseSchema,
        'post',
        `/agents/${agentId}/interrupt`,
        text === undefined ? undefined : { text },
      ),
    stopAgent: (agentId) => ok(200, StopResponseSchema, 'post', `/agents/${agentId}/stop`),
    restartAgent: (agentId) => ok(201, RestartResponseSchema, 'post', `/agents/${agentId}/restart`),

    decide: (decisionId, decision) =>
      ok(200, DecisionResponseSchema, 'post', `/decisions/${decisionId}`, decision),
    spend: () => ok(200, SpendResponseSchema, 'get', '/spend'),
  };
}

/** Polls `read` until `done` holds and returns that value; fails after `timeoutMs` with the last value. */
export async function waitFor<T>(
  read: () => Promise<T> | T,
  done: (value: T) => boolean,
  what: string,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}; last: ${JSON.stringify(value)}`);
    }
    await delay(POLL_MS);
    value = await read();
  }
  return value;
}
