import { Inject, Injectable } from '@nestjs/common';
import {
  DATABASE_CONNECTION,
  type Database,
  type DatabaseConnection,
  type IdentityUserRow,
  IdentityUsersRepository,
} from '@agent-os/db';
import { normalizeIdentifier } from './identity-input';
import { verifyPassword } from './password';

/** The real reason of a refused password; the client always gets the same answer (KD-5). */
export type PasswordRejection = 'unknown_login' | 'wrong_password';

export type PasswordCheck =
  | { ok: true; user: IdentityUserRow }
  | { ok: false; reason: PasswordRejection; user: IdentityUserRow | undefined };

/**
 * Checks a login and a password (KD-5, C3 api): the employee by the normalized login, then the
 * argon2id hash, computed for an unknown login too so the timing does not tell whether it exists.
 */
@Injectable()
export class PasswordSignIn {
  private readonly db: Database;

  constructor(
    @Inject(DATABASE_CONNECTION) database: DatabaseConnection,
    private readonly users: IdentityUsersRepository,
  ) {
    this.db = database.db;
  }

  async check(login: string, password: string): Promise<PasswordCheck> {
    const user = await this.users.findByLogin(
      this.db,
      normalizeIdentifier(login),
    );
    const matches = await verifyPassword(password, user?.passwordHash ?? null);
    if (user === undefined) return { ok: false, reason: 'unknown_login', user };
    if (!matches) return { ok: false, reason: 'wrong_password', user };
    return { ok: true, user };
  }
}
