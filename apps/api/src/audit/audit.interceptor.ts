import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { AuthedRequest } from '../auth/auth.types.js';
import { AuditService } from './audit.service.js';

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** Longest thread id accepted by validation (`ThreadIdSchema` in `@agent-os/contracts`: 1..255). */
const MAX_THREAD_ID_LENGTH = 255;

/**
 * `body.threadId ?? body.id` of a not-yet-validated request body. An id longer
 * than validation accepts is dropped rather than truncated: the request will be
 * rejected with 400, and an oversized raw value must not reach the audit table.
 */
const bodyThreadId = (body: unknown): string | undefined => {
  if (typeof body !== 'object' || body === null) return undefined;
  const threadId = 'threadId' in body ? body.threadId : undefined;
  const id = 'id' in body ? body.id : undefined;
  const value = asString(threadId ?? id);
  return value !== undefined && value.length <= MAX_THREAD_ID_LENGTH
    ? value
    : undefined;
};

/**
 * Records one audit event per handled request. Runs after guards, so req.user is set.
 * The thread id comes from the route (`:threadId`); the body is read only on agent routes
 * (`/chat/:agentId`), so a body cannot substitute the route id or name a thread on `POST /threads`.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (req.user) {
      const agentId = asString(req.params?.agentId);
      this.audit.record({
        type: `${req.method} ${req.route?.path ?? req.path}`,
        userId: req.user.id,
        agentId,
        threadId:
          asString(req.params?.threadId) ??
          (agentId ? bodyThreadId(req.body) : undefined),
        at: new Date().toISOString(),
      });
    }
    return next.handle();
  }
}
