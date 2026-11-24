import { Global, Module } from '@nestjs/common';
import { AuditLog } from './audit-log';

/** Gives every module the application's `AuditLog` over the pool of `DbModule` (design-identity.md KD-7). */
@Global()
@Module({
  providers: [AuditLog],
  exports: [AuditLog],
})
export class AuditModule {}
