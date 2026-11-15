import { Inject, Injectable } from '@nestjs/common';
import type { Database, DatabaseConnection } from '@agent-os/db';
import { RUNTIME_DATABASE } from '../runtime/runtime.tokens.js';
import { normalizeIdentifier } from './identity-input.js';
import { verifyPassword } from './password.js';
import { findUserByLogin, type UserRow } from './users.repository.js';

/** The real reason of a refused password; the client always gets the same answer (KD-5). */
export type PasswordRejection = 'unknown_login' | 'wrong_password';

export type PasswordCheck =
  | { ok: true; user: UserRow }
  | { ok: false; reason: PasswordRejection; user: UserRow | undefined };

/**
 * Checks a login and a password (KD-5, C3 api): the employee by the normalized login, then the
 * argon2id hash, computed for an unknown login too so the timing does not tell whether it exists.
 */
@Injectable()
export class PasswordSignIn {
  private readonly db: Database;

  constructor(@Inject(RUNTIME_DATABASE) database: DatabaseConnection) {
    this.db = database.db;
  }

  async check(login: string, password: string): Promise<PasswordCheck> {
    const user = await findUserByLogin(this.db, normalizeIdentifier(login));
    const matches = await verifyPassword(password, user?.passwordHash ?? null);
    if (user === undefined) return { ok: false, reason: 'unknown_login', user };
    if (!matches) return { ok: false, reason: 'wrong_password', user };
    return { ok: true, user };
  }
}
