import { Injectable } from '@nestjs/common';
import type { Executor } from '../database';
import { auditEvents } from '../schema';

/** What an audit record writes; the id and the time are the database's. */
export type NewAuditEventRow = Omit<typeof auditEvents.$inferInsert, 'id' | 'at'>;

/**
 * Drizzle queries of `audit_events` (repository over a transaction). The api's `AuditLog` is the only
 * writer: it masks secrets before the row gets here.
 */
@Injectable()
export class AuditEventsRepository {
  async insert(executor: Executor, event: NewAuditEventRow): Promise<void> {
    await executor.insert(auditEvents).values(event);
  }
}
