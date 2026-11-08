import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthedRequest } from './auth.types.js';
import { RESERVED_USER_PREFIX } from './system-owners.js';

/**
 * Placeholder guard. Real session/JWT validation via corporate OIDC is the next step
 * (see README "Что дальше"). In development every request runs as a fixed dev user,
 * optionally overridden by the `x-user-id` header, which may not name a reserved
 * `system:` owner; in production requests are rejected.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (this.config.get('NODE_ENV') === 'production') {
      throw new UnauthorizedException('Authentication is not configured');
    }
    const header = req.headers['x-user-id'];
    if (typeof header === 'string' && header.startsWith(RESERVED_USER_PREFIX)) {
      throw new UnauthorizedException('Reserved user id');
    }
    req.user = {
      id: typeof header === 'string' && header ? header : 'dev-user',
      roles: ['user'],
    };
    return true;
  }
}
