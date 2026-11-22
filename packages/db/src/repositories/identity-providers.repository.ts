import { Injectable } from '@nestjs/common';
import { asc, eq, lte, sql } from 'drizzle-orm';
import type { Executor } from '../database';
import { identityLoginRequests, identityProviders } from '../schema';

/** A row of `identity_providers`; `type` and `options` are read by the api, which owns their shape. */
export type IdentityProviderRow = typeof identityProviders.$inferSelect;

/** What creation writes; a new provider is always disabled. */
export type NewIdentityProviderRow = Pick<
  typeof identityProviders.$inferInsert,
  'type' | 'name' | 'options'
>;

/** What may change after creation. */
export type IdentityProviderPatch = Pick<
  typeof identityProviders.$inferInsert,
  'name' | 'enabled' | 'options'
>;

export type IdentityLoginRequestRow = typeof identityLoginRequests.$inferSelect;

export type NewIdentityLoginRequestRow = Omit<
  typeof identityLoginRequests.$inferInsert,
  'id' | 'createdAt'
>;

/** The creation order of the providers (`created_at`, then `id`). */
const CREATION_ORDER = [asc(identityProviders.createdAt), asc(identityProviders.id)];

/**
 * Drizzle queries of `identity_providers` and `identity_login_requests` (repository over a
 * transaction): each takes the caller's transaction or the plain client first.
 */
@Injectable()
export class IdentityProvidersRepository {
  /** The providers in creation order. */
  list(executor: Executor) {
    return executor
      .select({
        id: identityProviders.id,
        type: identityProviders.type,
        name: identityProviders.name,
        enabled: identityProviders.enabled,
      })
      .from(identityProviders)
      .orderBy(...CREATION_ORDER);
  }

  /** The enabled providers in creation order, as the sign-in page shows them. */
  listEnabled(executor: Executor) {
    return executor
      .select({
        id: identityProviders.id,
        name: identityProviders.name,
        type: identityProviders.type,
      })
      .from(identityProviders)
      .where(eq(identityProviders.enabled, true))
      .orderBy(...CREATION_ORDER);
  }

  async find(executor: Executor, id: string): Promise<IdentityProviderRow | undefined> {
    const [row] = await executor.select().from(identityProviders).where(eq(identityProviders.id, id));
    return row;
  }

  /** A new provider, always disabled (DC-6). */
  async insert(executor: Executor, values: NewIdentityProviderRow): Promise<IdentityProviderRow> {
    const [row] = await executor
      .insert(identityProviders)
      .values({ ...values, enabled: false })
      .returning();
    if (row === undefined) throw new Error('identity_providers insert returned no row');
    return row;
  }

  /** Writes the change and raises `version`. */
  async update(executor: Executor, id: string, values: IdentityProviderPatch): Promise<void> {
    await executor
      .update(identityProviders)
      .set({ ...values, version: sql`${identityProviders.version} + 1` })
      .where(eq(identityProviders.id, id));
  }

  async insertLoginRequest(
    executor: Executor,
    values: NewIdentityLoginRequestRow,
  ): Promise<string> {
    const [row] = await executor
      .insert(identityLoginRequests)
      .values(values)
      .returning({ id: identityLoginRequests.id });
    if (row === undefined) throw new Error('identity_login_requests insert returned no row');
    return row.id;
  }

  /** Deletes the request of this `state` and returns it: a second return finds nothing (DC-4). */
  async consumeLoginRequest(
    executor: Executor,
    state: string,
  ): Promise<IdentityLoginRequestRow | undefined> {
    const [row] = await executor
      .delete(identityLoginRequests)
      .where(eq(identityLoginRequests.state, state))
      .returning();
    return row;
  }

  /** Deletes every sign-in request past its expiry; returns how many went. */
  async deleteExpiredLoginRequests(executor: Executor): Promise<number> {
    const deleted = await executor
      .delete(identityLoginRequests)
      .where(lte(identityLoginRequests.expiresAt, sql`now()`))
      .returning({ id: identityLoginRequests.id });
    return deleted.length;
  }
}
