import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { AuthedRequest } from '../auth/auth.types.js';
import { AuditService } from './audit.service.js';

/** Records one audit event per handled request. Runs after guards, so req.user is set. */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly audit: AuditService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (req.user) {
      const body = (req.body ?? {}) as { threadId?: string; id?: string };
      this.audit.record({
        type: `${req.method} ${req.route?.path ?? req.path}`,
        userId: req.user.id,
        agentId: typeof req.params?.agentId === 'string' ? req.params.agentId : undefined,
        threadId: body.threadId ?? body.id,
        at: new Date().toISOString(),
      });
    }
    return next.handle();
  }
}
