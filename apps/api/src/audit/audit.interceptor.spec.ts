import { ConfigService } from '@nestjs/config';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host.js';
import type { AuditEvent } from '@agent-os/contracts';
import { lastValueFrom, of } from 'rxjs';
import { AuditInterceptor } from './audit.interceptor.js';
import { AuditService } from './audit.service.js';

type FakeRequest = {
  method: string;
  path: string;
  route: { path: string };
  params: Record<string, string>;
  body: unknown;
  user?: { id: string; roles: string[] };
};

/** A real AuditService whose database write is replaced: the pool is never connected. */
const fakeAudit = () => {
  const audit = new AuditService(
    new ConfigService({ DATABASE_URL: 'postgres://audit@localhost:1/unused' }),
  );
  const record = vi
    .spyOn(audit, 'record')
    .mockImplementation((): void => undefined);
  return { audit, record };
};

const intercept = async (request: FakeRequest) => {
  const { audit, record } = fakeAudit();
  const context = new ExecutionContextHost([request]);
  const result = await lastValueFrom(
    new AuditInterceptor(audit).intercept(context, { handle: () => of('ok') }),
  );
  return { record, result };
};

const user = { id: 'u-1', roles: [] };

// Integration Point 4 (Design Doc): the audited thread id comes from the route for /threads/:threadId
// and from the body only for /chat/:agentId; the body must never substitute the route id.
describe('AuditInterceptor threadId source', () => {
  it.each<{
    name: string;
    request: FakeRequest;
    expected: Pick<AuditEvent, 'type' | 'agentId' | 'threadId'>;
  }>([
    {
      name: 'GET /threads/:threadId with body { id } → route id recorded',
      request: {
        method: 'GET',
        path: '/api/threads/t-route',
        route: { path: '/api/threads/:threadId' },
        params: { threadId: 't-route' },
        body: { id: 't-body', threadId: 't-body-2' },
        user,
      },
      expected: {
        type: 'GET /api/threads/:threadId',
        agentId: undefined,
        threadId: 't-route',
      },
    },
    {
      name: 'GET /threads/:threadId/messages without body → route id recorded',
      request: {
        method: 'GET',
        path: '/api/threads/t-route/messages',
        route: { path: '/api/threads/:threadId/messages' },
        params: { threadId: 't-route' },
        body: undefined,
        user,
      },
      expected: {
        type: 'GET /api/threads/:threadId/messages',
        agentId: undefined,
        threadId: 't-route',
      },
    },
    {
      name: 'POST /chat/:agentId with body { threadId, id } → body.threadId',
      request: {
        method: 'POST',
        path: '/api/chat/assistant',
        route: { path: '/api/chat/:agentId' },
        params: { agentId: 'assistant' },
        body: { threadId: 't-chat', id: 't-other' },
        user,
      },
      expected: {
        type: 'POST /api/chat/:agentId',
        agentId: 'assistant',
        threadId: 't-chat',
      },
    },
    {
      name: 'POST /chat/:agentId with body { id } only → body.id',
      request: {
        method: 'POST',
        path: '/api/chat/assistant',
        route: { path: '/api/chat/:agentId' },
        params: { agentId: 'assistant' },
        body: { id: 't-chat-id' },
        user,
      },
      expected: {
        type: 'POST /api/chat/:agentId',
        agentId: 'assistant',
        threadId: 't-chat-id',
      },
    },
    {
      name: 'POST /chat/:agentId with a 255-character body.threadId → recorded',
      request: {
        method: 'POST',
        path: '/api/chat/assistant',
        route: { path: '/api/chat/:agentId' },
        params: { agentId: 'assistant' },
        body: { threadId: 't'.repeat(255) },
        user,
      },
      expected: {
        type: 'POST /api/chat/:agentId',
        agentId: 'assistant',
        threadId: 't'.repeat(255),
      },
    },
    {
      // Risk: the interceptor runs before validation, so an oversized raw id would reach audit_events.thread_id.
      name: 'POST /chat/:agentId drops a body thread id longer than 255 characters',
      request: {
        method: 'POST',
        path: '/api/chat/assistant',
        route: { path: '/api/chat/:agentId' },
        params: { agentId: 'assistant' },
        body: { threadId: 't'.repeat(256), id: 'i'.repeat(256) },
        user,
      },
      expected: {
        type: 'POST /api/chat/:agentId',
        agentId: 'assistant',
        threadId: undefined,
      },
    },
    {
      name: 'POST /threads with body { id: "x" } → no threadId',
      request: {
        method: 'POST',
        path: '/api/threads',
        route: { path: '/api/threads' },
        params: {},
        body: { id: 'x' },
        user,
      },
      expected: {
        type: 'POST /api/threads',
        agentId: undefined,
        threadId: undefined,
      },
    },
  ])('$name', async ({ request, expected }) => {
    const { record, result } = await intercept(request);

    expect(result).toBe('ok');
    expect(record).toHaveBeenCalledTimes(1);
    expect(record).toHaveBeenCalledWith({
      ...expected,
      userId: 'u-1',
      at: expect.any(String),
    });
  });

  it('does not record a request without req.user', async () => {
    const { record, result } = await intercept({
      method: 'GET',
      path: '/api/threads/t-route',
      route: { path: '/api/threads/:threadId' },
      params: { threadId: 't-route' },
      body: undefined,
    });

    expect(result).toBe('ok');
    expect(record).not.toHaveBeenCalled();
  });
});
