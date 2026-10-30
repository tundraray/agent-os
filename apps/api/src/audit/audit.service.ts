import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AuditEvent } from '@agent-os/contracts';
import pg from 'pg';

const FLUSH_INTERVAL_MS = 2000;
const MAX_BATCH = 100;

/** Buffers audit events in memory and writes them to Postgres in batches. */
@Injectable()
export class AuditService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditService.name);
  private readonly pool: pg.Pool;
  private buffer: AuditEvent[] = [];
  private timer?: NodeJS.Timeout;

  constructor(config: ConfigService) {
    this.pool = new pg.Pool({
      connectionString: config.getOrThrow<string>('DATABASE_URL'),
    });
  }

  async onModuleInit() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS audit_events (
        id BIGSERIAL PRIMARY KEY,
        type TEXT NOT NULL,
        user_id TEXT NOT NULL,
        agent_id TEXT,
        thread_id TEXT,
        at TIMESTAMPTZ NOT NULL,
        payload JSONB
      )`);
    this.timer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
  }

  async onModuleDestroy() {
    clearInterval(this.timer);
    await this.flush();
    await this.pool.end();
  }

  record(event: AuditEvent) {
    this.logger.log(
      `audit ${event.type} user=${event.userId} agent=${event.agentId ?? '-'}`,
    );
    this.buffer.push(event);
    if (this.buffer.length >= MAX_BATCH) void this.flush();
  }

  private async flush() {
    if (this.buffer.length === 0) return;
    const batch = this.buffer;
    this.buffer = [];
    const values: unknown[] = [];
    const rows = batch.map((e, i) => {
      values.push(
        e.type,
        e.userId,
        e.agentId ?? null,
        e.threadId ?? null,
        e.at,
        e.payload ?? null,
      );
      const o = i * 6;
      return `($${o + 1}, $${o + 2}, $${o + 3}, $${o + 4}, $${o + 5}, $${o + 6})`;
    });
    try {
      await this.pool.query(
        `INSERT INTO audit_events (type, user_id, agent_id, thread_id, at, payload) VALUES ${rows.join(', ')}`,
        values,
      );
    } catch (err) {
      this.logger.error(
        `Failed to write ${batch.length} audit events`,
        err as Error,
      );
      this.buffer.unshift(...batch);
    }
  }
}
