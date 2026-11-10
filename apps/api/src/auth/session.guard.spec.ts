import { UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExecutionContextHost } from '@nestjs/core/helpers/execution-context-host.js';
import type { AuthedRequest } from './auth.types.js';
import { SessionGuard } from './session.guard.js';
import { SELF_CHECK_OWNER } from './system-owners.js';

const guardRequest = (userId: string) => {
  const request = {
    headers: { 'x-user-id': userId },
  } as unknown as AuthedRequest;
  const guard = new SessionGuard(
    new ConfigService({ NODE_ENV: 'development' }),
  );
  const run = () => guard.canActivate(new ExecutionContextHost([request]));
  return { request, run };
};

// KD-3 (design-self-check.md): no request may act as a `system:` owner, or it would reach the self-check program's
// investigations, which the transcript purge keeps and the program cancels and deletes.
describe('SessionGuard reserved owners', () => {
  it.each([SELF_CHECK_OWNER, 'system:other'])('rejects %s', (userId) => {
    const { request, run } = guardRequest(userId);
    expect(run).toThrow(UnauthorizedException);
    expect(request.user).toBeUndefined();
  });

  it('accepts an ordinary user as that user', () => {
    const { request, run } = guardRequest('employee-42');
    expect(run()).toBe(true);
    expect(request.user).toEqual({ id: 'employee-42', roles: ['user'] });
  });
});
