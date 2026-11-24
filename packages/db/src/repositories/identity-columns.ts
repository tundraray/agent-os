import { sql } from 'drizzle-orm';
import { identityRoleMembers, identityRoles } from '../schema';

/** A column written with its table name: drizzle drops it in a query over one table, and the subquery below needs it. */
const col = (table: string, column: string) =>
  sql`${sql.identifier(table)}.${sql.identifier(column)}`;

/** A role of the employee row has the flag column given. */
const roleFlag = (column: string) => sql<boolean>`exists (
  select 1 from ${identityRoleMembers}
  join ${identityRoles} on ${col('identity_roles', 'id')} = ${col('identity_role_members', 'role_id')}
  where ${col('identity_role_members', 'user_id')} = ${col('identity_users', 'id')} and ${col('identity_roles', column)}
)`;

/**
 * The admin right of the employee row: the personal mark or a membership in a role with the admin
 * right. The one rule of the session (`IdentitySessionsRepository.findByTokenHash`) and of
 * `IdentityUsersRepository.hasAdminRight`.
 */
export const IS_ADMIN = sql<boolean>`(${col('identity_users', 'is_admin')} or ${roleFlag('is_admin')})`;

/** The two training rights of the employee row: only a role gives them, there is no personal mark (KD-8). */
export const TRAIN_OWN = roleFlag('train_own');
export const TRAIN_ANY = roleFlag('train_any');
