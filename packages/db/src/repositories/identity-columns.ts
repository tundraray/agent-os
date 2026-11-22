import { sql } from 'drizzle-orm';
import {
  identityRoleMembers,
  identityRoles,
  identitySettings,
} from '../schema';

/** A column written with its table name: drizzle drops it in a query over one table, and the subquery below needs it. */
const col = (table: string, column: string) =>
  sql`${sql.identifier(table)}.${sql.identifier(column)}`;

/**
 * The admin right of the employee row: the personal mark or a membership in a role with the admin
 * right. The one rule of the session (`IdentitySessionsRepository.findByTokenHash`) and of
 * `IdentityUsersRepository.hasAdminRight`.
 */
export const IS_ADMIN = sql<boolean>`(${col('identity_users', 'is_admin')} or exists (
  select 1 from ${identityRoleMembers}
  join ${identityRoles} on ${col('identity_roles', 'id')} = ${col('identity_role_members', 'role_id')}
  where ${col('identity_role_members', 'user_id')} = ${col('identity_users', 'id')} and ${col('identity_roles', 'is_admin')}
))`;

/** The session limit columns of the single `identity_settings` row, for a select or a join. */
export const sessionLimitColumns = {
  idleMinutes: identitySettings.idleMinutes,
  absoluteMinutes: identitySettings.absoluteMinutes,
};
