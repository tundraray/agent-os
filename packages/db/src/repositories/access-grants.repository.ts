import { Inject, Injectable } from '@nestjs/common';
import { asc, eq, inArray, or, type SQL } from 'drizzle-orm';
import { Db } from '../db';
import { accessGrants, accessModels } from '../schema';

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
@Injectable()
export class AccessGrantsRepository {
  constructor(@Inject(Db) private readonly db: Db) {}

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
    return this.withModelName(
      'roleId' in holder
        ? eq(accessGrants.roleId, holder.roleId)
        : eq(accessGrants.userId, holder.userId),
    );
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

  /** Deletes every grant on the server and its tools; returns how many there were. */
  async deleteOfServer(server: string): Promise<number> {
    const rows = await this.db.client
      .delete(accessGrants)
      .where(eq(accessGrants.server, server))
      .returning({ id: accessGrants.id });
    return rows.length;
  }

  /** Grants meeting the condition with the catalogue name of a model target, by creation time, then id. */
  private withModelName(
    where: SQL | undefined,
  ): Promise<AccessGrantWithModelName[]> {
    return this.db.client
      .select({ grant: accessGrants, modelName: accessModels.name })
      .from(accessGrants)
      .leftJoin(accessModels, eq(accessModels.id, accessGrants.model))
      .where(where)
      .orderBy(asc(accessGrants.createdAt), asc(accessGrants.id));
  }
}
