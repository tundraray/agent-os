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

/**
 * Records one audit event per handled request. Runs after guards, so req.user is set.
 * The thread id comes only from the route (`:threadId`), never from the body.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (req.user) {
      this.audit.record({
        type: `${req.method} ${req.route?.path ?? req.path}`,
        userId: req.user.id,
        agentId: asString(req.params?.agentId),
        threadId: asString(req.params?.threadId),
        at: new Date().toISOString(),
      });
    }
    return next.handle();
  }
}
