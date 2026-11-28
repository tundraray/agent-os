import { and, asc, eq, inArray, isNotNull, or, type SQL } from 'drizzle-orm';
import type { Db } from '../db';
import { accessGrants, models } from '../schema';

/** A row of `access_grants`; the api reads its target and holder out of the columns. */
export type AccessGrantRow = typeof accessGrants.$inferSelect;

/** What a new grant writes; the id and the time are the database's. */
export type NewAccessGrantRow = Omit<
  typeof accessGrants.$inferInsert,
  'id' | 'createdAt'
>;

/** A grant with the catalogue name of its model; `null` for another target. */
export interface AccessGrantWithModelName {
  grant: AccessGrantRow;
  modelName: string | null;
}

/** Whose grants: a role's or an employee's personal ones. */
export type GrantHolderQuery = { roleId: string } | { userId: string };

/**
 * Drizzle queries of `access_grants`. Lists come by creation time, then id.
 */
export class AccessGrantsRepository {
  constructor(private readonly db: Db) {}

  /** The grants of the employee's roles and his personal ones, in one query. */
  ofEmployee(
    roleIds: readonly string[],
    userId: string,
  ): Promise<AccessGrantRow[]> {
    const holder =
      roleIds.length === 0
        ? eq(accessGrants.userId, userId)
        : or(
            inArray(accessGrants.roleId, [...roleIds]),
            eq(accessGrants.userId, userId),
          );
    return this.db.client.select().from(accessGrants).where(holder);
  }

  list(holder: GrantHolderQuery): Promise<AccessGrantWithModelName[]> {
    return this.withModelName(holderIs(holder));
  }

  /** Every grant of the role, the copy of a role starts from them (access-levels AC-37.8). */
  ofRole(roleId: string): Promise<AccessGrantRow[]> {
    return this.db.client
      .select()
      .from(accessGrants)
      .where(eq(accessGrants.roleId, roleId))
      .orderBy(asc(accessGrants.createdAt), asc(accessGrants.id));
  }

  /** The holder's grants on servers and tools, on the servers named or, without them, on every server. */
  mcpOf(
    holder: GrantHolderQuery,
    servers?: readonly string[],
  ): Promise<AccessGrantRow[]> {
    return this.db.client
      .select()
      .from(accessGrants)
      .where(and(holderIs(holder), onServers(servers)))
      .orderBy(asc(accessGrants.createdAt), asc(accessGrants.id));
  }

  /** Removes the holder's grants on servers and tools of the servers named (a level is replaced, KD-1). */
  async deleteMcp(
    holder: GrantHolderQuery,
    servers: readonly string[],
  ): Promise<void> {
    if (servers.length === 0) return;
    await this.db.client
      .delete(accessGrants)
      .where(and(holderIs(holder), onServers(servers)));
  }

  /** Adds the grants as they are; the caller has removed any they would repeat. */
  async insertMany(grants: readonly NewAccessGrantRow[]): Promise<void> {
    if (grants.length === 0) return;
    await this.db.client.insert(accessGrants).values([...grants]);
  }

  async find(id: string): Promise<AccessGrantWithModelName | undefined> {
    const [grant] = await this.withModelName(eq(accessGrants.id, id));
    return grant;
  }

  /** Adds the grant; `undefined` when the holder already has one with the same effect and target. */
  async insert(grant: NewAccessGrantRow): Promise<string | undefined> {
    const [row] = await this.db.client
      .insert(accessGrants)
      .values(grant)
      .onConflictDoNothing()
      .returning({ id: accessGrants.id });
    return row?.id;
  }

  async updateQuota(id: string, quotaUsd: number | null): Promise<void> {
    await this.db.client
      .update(accessGrants)
      .set({ quotaUsd })
      .where(eq(accessGrants.id, id));
  }

  async delete(id: string): Promise<void> {
    await this.db.client.delete(accessGrants).where(eq(accessGrants.id, id));
  }

  /** Grants meeting the condition with the catalogue name of a model target, by creation time, then id. */
  private withModelName(
    where: SQL | undefined,
  ): Promise<AccessGrantWithModelName[]> {
    return this.db.client
      .select({ grant: accessGrants, modelName: models.name })
      .from(accessGrants)
      .leftJoin(models, eq(models.id, accessGrants.model))
      .where(where)
      .orderBy(asc(accessGrants.createdAt), asc(accessGrants.id));
  }
}

const holderIs = (holder: GrantHolderQuery): SQL =>
  'roleId' in holder
    ? eq(accessGrants.roleId, holder.roleId)
    : eq(accessGrants.userId, holder.userId);

/** Grants on a server or its tools: on the servers named, or on any server. */
const onServers = (servers?: readonly string[]): SQL =>
  servers === undefined
    ? isNotNull(accessGrants.server)
    : inArray(accessGrants.server, [...servers]);
