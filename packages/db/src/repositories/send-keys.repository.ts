import type { Db } from '../db';
import { sendKeys } from '../schema';

/** Drizzle queries of `send_keys`. */
export class SendKeysRepository {
  constructor(private readonly db: Db) {}

  /** Inserts the employee's key unless it is there; true when this insert took it. */
  async claim(userId: string, sendKey: string): Promise<boolean> {
    const rows = await this.db.client
      .insert(sendKeys)
      .values({ userId, sendKey })
      .onConflictDoNothing()
      .returning({ sendKey: sendKeys.sendKey });
    return rows.length > 0;
  }
}
