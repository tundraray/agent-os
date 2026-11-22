import {
  UserStatusSchema,
  type Language,
  type UserStatus,
} from '@agent-os/contracts';
import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { Db } from '../db';
import { identityUsers } from '../schema';
import { IS_ADMIN } from './identity-columns';

/** A row of `identity_users`. */
export type IdentityUserRow = typeof identityUsers.$inferSelect;

export interface NewLocalUserRow {
  /** Normalized by the caller. */
  login: string;
  /** Normalized by the caller. */
  email: string;
  name: string;
  passwordHash: string;
}

/** Position of the last employee of a list page: the order is name, then id. */
export interface UserListPosition {
  name: string;
  id: string;
}

export interface UserPageQuery {
  /** Matched against name, email and login ignoring case; absent or blank lists everyone. */
  search?: string;
  /** The employees strictly after this position; absent for the first page. */
  after?: UserListPosition;
  limit: number;
}

/** `%`, `_` and `\` of the search are literal characters, not `ilike` wildcards. */
const escapeLikePattern = (text: string): string =>
  text.replace(/[\\%_]/g, '\\$&');

/**
 * Drizzle queries of `identity_users`. The id is always the database's `gen_random_uuid()`
 * (ADR-0012, Invariant 3).
 */
@Injectable()
export class IdentityUsersRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

  async findByLogin(login: string): Promise<IdentityUserRow | undefined> {
    const [row] = await this.db.client
      .select()
      .from(identityUsers)
      .where(eq(identityUsers.login, login));
    return row;
  }

  async insertLocal(user: NewLocalUserRow): Promise<IdentityUserRow> {
    const [row] = await this.db.client
      .insert(identityUsers)
      .values(user)
      .returning();
    if (row === undefined)
      throw new Error('identity_users insert returned no row');
    return row;
  }

  /**
   * The employee of a provider sign-in (AC-04.1, AC-04.2): the one with this normalized email, or a new
   * one without roles (JIT). The name from the ID token replaces the stored one when the token has it;
   * the status, roles, login and password stay as they are.
   */
  async upsertFromProvider(user: {
    email: string;
    name: string | undefined;
  }): Promise<IdentityUserRow> {
    const [row] = await this.db.client
      .insert(identityUsers)
      .values({ email: user.email, name: user.name ?? '' })
      .onConflictDoUpdate({
        target: identityUsers.email,
        set:
          user.name === undefined ? { email: user.email } : { name: user.name },
      })
      .returning();
    if (row === undefined)
      throw new Error('identity_users upsert returned no row');
    return row;
  }

  async findById(userId: string): Promise<IdentityUserRow | undefined> {
    const [row] = await this.db.client
      .select()
      .from(identityUsers)
      .where(eq(identityUsers.id, userId));
    return row;
  }

  /** Whether the employee has the admin right now; `false` for an unknown one. */
  async hasAdminRight(userId: string): Promise<boolean> {
    const [row] = await this.db.client
      .select({ isAdmin: IS_ADMIN })
      .from(identityUsers)
      .where(eq(identityUsers.id, userId));
    return row?.isAdmin ?? false;
  }

  /** Of the employee ids given, those of employees that exist. */
  async existingIds(userIds: string[]): Promise<string[]> {
    if (userIds.length === 0) return [];
    const rows = await this.db.client
      .select({ id: identityUsers.id })
      .from(identityUsers)
      .where(inArray(identityUsers.id, userIds));
    return rows.map((row) => row.id);
  }

  /** Id, name and status of the employees named, by name. */
  async names(
    userIds: string[],
  ): Promise<{ id: string; name: string; status: string }[]> {
    if (userIds.length === 0) return [];
    return this.db.client
      .select({
        id: identityUsers.id,
        name: identityUsers.name,
        status: identityUsers.status,
      })
      .from(identityUsers)
      .where(inArray(identityUsers.id, userIds))
      .orderBy(asc(identityUsers.name));
  }

  /** Up to `limit` employees by name, then id, strictly after `after` (keyset over the pair). */
  async page(query: UserPageQuery): Promise<IdentityUserRow[]> {
    const search = query.search?.trim();
    const pattern = search ? `%${escapeLikePattern(search)}%` : undefined;
    return this.db.client
      .select()
      .from(identityUsers)
      .where(
        and(
          pattern === undefined
            ? undefined
            : or(
                ilike(identityUsers.name, pattern),
                ilike(identityUsers.email, pattern),
                ilike(identityUsers.login, pattern),
              ),
          query.after === undefined
            ? undefined
            : sql`(${identityUsers.name}, ${identityUsers.id}) > (${query.after.name}, ${query.after.id}::uuid)`,
        ),
      )
      .orderBy(asc(identityUsers.name), asc(identityUsers.id))
      .limit(query.limit);
  }

  /** Replaces the password hash; the status stays as it is. */
  async setPasswordHash(userId: string, passwordHash: string): Promise<void> {
    await this.db.client
      .update(identityUsers)
      .set({ passwordHash })
      .where(eq(identityUsers.id, userId));
  }

  /** Gives or takes the personal admin right. */
  async setPersonalAdmin(userId: string, enabled: boolean): Promise<void> {
    await this.db.client
      .update(identityUsers)
      .set({ isAdmin: enabled })
      .where(eq(identityUsers.id, userId));
  }

  /** Turns the account on or off; nothing else of the employee changes. */
  async setStatus(userId: string, status: UserStatus): Promise<void> {
    await this.db.client
      .update(identityUsers)
      .set({ status })
      .where(eq(identityUsers.id, userId));
  }

  /** Sets a new password hash and turns the account on. */
  async setPasswordAndEnable(
    userId: string,
    passwordHash: string,
  ): Promise<void> {
    await this.db.client
      .update(identityUsers)
      .set({ passwordHash, status: UserStatusSchema.enum.active })
      .where(eq(identityUsers.id, userId));
  }

  /** Records the employee's interface language. */
  async setLanguage(userId: string, language: Language): Promise<void> {
    await this.db.client
      .update(identityUsers)
      .set({ language })
      .where(eq(identityUsers.id, userId));
  }

  async markSignedIn(userId: string): Promise<void> {
    await this.db.client
      .update(identityUsers)
      .set({ lastSignInAt: sql`now()` })
      .where(eq(identityUsers.id, userId));
  }
}
