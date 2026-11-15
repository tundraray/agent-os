import { Global, Module } from '@nestjs/common';
import type { DatabaseConnection } from '@agent-os/db';
import { RuntimeModule } from '../runtime/runtime.module.js';
import { RUNTIME_DATABASE } from '../runtime/runtime.tokens.js';
import { AuditLog } from './audit-log.js';

/** Gives every module the application's `AuditLog` over the runtime's pool (design-identity.md KD-7). */
@Global()
@Module({
  imports: [RuntimeModule],
  providers: [
    {
      provide: AuditLog,
      inject: [RUNTIME_DATABASE],
      useFactory: (database: DatabaseConnection) => new AuditLog(database.db),
    },
  ],
  exports: [AuditLog],
})
export class AuditModule {}
