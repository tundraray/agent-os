import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuthedRequest } from './auth.types.js';

/**
 * Placeholder guard. Real session/JWT validation via corporate OIDC is the next step
 * (see README "Что дальше"). In development every request runs as a fixed dev user,
 * optionally overridden by the `x-user-id` header; in production requests are rejected.
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
    req.user = {
      id: typeof header === 'string' && header ? header : 'dev-user',
      roles: ['user'],
    };
    return true;
  }
}
