import { Module } from '@nestjs/common';
import {
  ACCESS_AUDIT,
  ACCESS_GATE,
  ON_TEXT_DELTA,
  RECORD_LIBRARY,
  type AccessAudit,
  type OnTextDelta,
} from '@agent-os/agents';
import { LOGGER, type Logger } from '@agent-os/common';
import { DATABASE_CONNECTION, type DatabaseConnection } from '@agent-os/db';
import { CLOCK, type Clock } from '@agent-os/runtime';
import { AccessModule } from '../access/access.module';
import { AccessService } from '../access/access.service';
import { AuditLog } from '../audit/audit-log';
import { LibraryModule } from '../library/library.module';
import { LibraryService } from '../library/library.service';
import { AGENT_TEXT_DELTA_CHANNEL, DeltaPublisher } from './delta-publisher';

/**
 * The agents' audit hook (design-access.md KD-6; agent-harness design-core.md KD-6): an `access_denied` or
 * `tool_call_refused` record, as is, by its own insert, outside any transaction. A failed write is logged with
 * the record and thrown, so the step that refused is repeated (plan Notes 3) — a refusal is never left out of
 * the audit silently.
 */
function accessAudit(auditLog: AuditLog, logger: Logger): AccessAudit {
  return async (entry) => {
    try {
      await auditLog.record(null, entry);
    } catch (error) {
      logger.error('audit record not written', {
        ...entry,
        error,
      });
      throw error;
    }
  };
}

/**
 * The ports of the agents package that `apps/api` implements (design-access.md KD-1, KD-6;
 * design-runtime.md; port-module-split.md): `AccessService` as the `AccessGate`, `AuditLog` behind the
 * audit hook, `LibraryService` as the `RecordLibrary` (`LibraryModule` does not import the agents) and the
 * `DeltaPublisher` as the receiver of text parts. The package's module lists this one in its `imports`.
 */
@Module({
  imports: [AccessModule, LibraryModule],
  providers: [
    { provide: ACCESS_GATE, useExisting: AccessService },
    { provide: RECORD_LIBRARY, useExisting: LibraryService },
    {
      provide: ACCESS_AUDIT,
      useFactory: (auditLog: AuditLog, logger: Logger): AccessAudit =>
        accessAudit(auditLog, logger.child({ service: 'agents.audit' })),
      inject: [AuditLog, LOGGER],
    },
    {
      provide: DeltaPublisher,
      useFactory: (
        database: DatabaseConnection,
        clock: Clock,
        logger: Logger,
      ): DeltaPublisher =>
        new DeltaPublisher({
          notify: async (payload) => {
            await database.pool.query('SELECT pg_notify($1, $2)', [
              AGENT_TEXT_DELTA_CHANNEL,
              payload,
            ]);
          },
          clock,
          logger: logger.child({ service: 'agents.delta' }),
        }),
      inject: [DATABASE_CONNECTION, CLOCK, LOGGER],
    },
    {
      provide: ON_TEXT_DELTA,
      useFactory:
        (publisher: DeltaPublisher): OnTextDelta =>
        (delta) =>
          publisher.publish(delta),
      inject: [DeltaPublisher],
    },
  ],
  exports: [ACCESS_GATE, RECORD_LIBRARY, ACCESS_AUDIT, ON_TEXT_DELTA],
})
export class AgentsPortsModule {}
