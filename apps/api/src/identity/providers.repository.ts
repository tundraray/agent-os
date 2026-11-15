import {
  ProviderTypeSchema,
  type ProviderButtonList,
  type ProviderList,
  type ProviderType,
} from '@agent-os/contracts';
import { identityLoginRequests, identityProviders } from '@agent-os/db';
import { asc, eq, lte, sql } from 'drizzle-orm';
import type { Executor } from '../common/executor.js';
import {
  ProviderOptionsSchema,
  type ProviderOptions,
} from './provider-options.js';

/** A provider row with its type and settings read. */
export interface Provider {
  id: string;
  type: ProviderType;
  name: string;
  enabled: boolean;
  /** Raised by every change, so the sign-in rebuilds its client config (AC-03.3). */
  version: number;
  options: ProviderOptions;
}

export type LoginRequestRow = typeof identityLoginRequests.$inferSelect;

/** The creation order of the providers (`created_at`, then `id`). */
const CREATION_ORDER = [
  asc(identityProviders.createdAt),
  asc(identityProviders.id),
];

function toProvider(row: typeof identityProviders.$inferSelect): Provider {
  return {
    id: row.id,
    type: ProviderTypeSchema.parse(row.type),
    name: row.name,
    enabled: row.enabled,
    version: row.version,
    options: ProviderOptionsSchema.parse(row.options),
  };
}

/**
 * Drizzle queries of `identity_providers` and `identity_login_requests`
 * (repository-over-transaction.md): each takes the caller's transaction or the plain client first.
 */
export async function listProviders(executor: Executor): Promise<ProviderList> {
  const rows = await executor
    .select({
      id: identityProviders.id,
      type: identityProviders.type,
      name: identityProviders.name,
      enabled: identityProviders.enabled,
    })
    .from(identityProviders)
    .orderBy(...CREATION_ORDER);
  return rows.map((row) => ({
    ...row,
    type: ProviderTypeSchema.parse(row.type),
  }));
}

/** The enabled providers in creation order, as the sign-in page shows them. */
export async function listProviderButtons(
  executor: Executor,
): Promise<ProviderButtonList> {
  const rows = await executor
    .select({
      id: identityProviders.id,
      name: identityProviders.name,
      type: identityProviders.type,
    })
    .from(identityProviders)
    .where(eq(identityProviders.enabled, true))
    .orderBy(...CREATION_ORDER);
  return rows.map((row) => ({
    ...row,
    type: ProviderTypeSchema.parse(row.type),
  }));
}

export async function findProvider(
  executor: Executor,
  id: string,
): Promise<Provider | undefined> {
  const [row] = await executor
    .select()
    .from(identityProviders)
    .where(eq(identityProviders.id, id));
  return row === undefined ? undefined : toProvider(row);
}

/** A new provider, always disabled (DC-6). */
export async function insertProvider(
  executor: Executor,
  values: Pick<Provider, 'type' | 'name' | 'options'>,
): Promise<Provider> {
  const [row] = await executor
    .insert(identityProviders)
    .values({ ...values, enabled: false })
    .returning();
  if (row === undefined)
    throw new Error('identity_providers insert returned no row');
  return toProvider(row);
}

/** Writes the change and raises `version`. */
export async function updateProvider(
  executor: Executor,
  id: string,
  values: Pick<Provider, 'name' | 'enabled' | 'options'>,
): Promise<void> {
  await executor
    .update(identityProviders)
    .set({ ...values, version: sql`${identityProviders.version} + 1` })
    .where(eq(identityProviders.id, id));
}

export async function insertLoginRequest(
  executor: Executor,
  values: Omit<typeof identityLoginRequests.$inferInsert, 'id' | 'createdAt'>,
): Promise<string> {
  const [row] = await executor
    .insert(identityLoginRequests)
    .values(values)
    .returning({ id: identityLoginRequests.id });
  if (row === undefined)
    throw new Error('identity_login_requests insert returned no row');
  return row.id;
}

/** Deletes the request of this `state` and returns it: a second return finds nothing (DC-4). */
export async function consumeLoginRequest(
  executor: Executor,
  state: string,
): Promise<LoginRequestRow | undefined> {
  const [row] = await executor
    .delete(identityLoginRequests)
    .where(eq(identityLoginRequests.state, state))
    .returning();
  return row;
}

/** Deletes every sign-in request past its expiry; returns how many went. */
export async function deleteExpiredLoginRequests(
  executor: Executor,
): Promise<number> {
  const deleted = await executor
    .delete(identityLoginRequests)
    .where(lte(identityLoginRequests.expiresAt, sql`now()`))
    .returning({ id: identityLoginRequests.id });
  return deleted.length;
}
