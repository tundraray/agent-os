import { Inject, Injectable } from '@nestjs/common';
import { Db } from '../db';
import { auditEvents } from '../schema';

/** What an audit record writes; the id and the time are the database's. */
export type NewAuditEventRow = Omit<
  typeof auditEvents.$inferInsert,
  'id' | 'at'
>;

/**
 * Drizzle queries of `audit_events`. The api's `AuditLog` is the only
 * writer: it masks secrets before the row gets here.
 */
@Injectable()
export class AuditEventsRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  async insert(event: NewAuditEventRow): Promise<void> {
    await this.db.client.insert(auditEvents).values(event);
  }
}
