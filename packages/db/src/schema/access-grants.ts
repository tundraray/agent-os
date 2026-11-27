import { GrantEffectSchema, GrantTargetKindSchema } from '@agent-os/contracts';
import { sql } from 'drizzle-orm';
import { check, index, numeric, text, unique, uuid } from 'drizzle-orm/pg-core';
import { app } from './app';
import { createdAt, isOneOf, literal } from './helpers';
import { mcpServers } from './mcp-servers';
import { models } from './models';
import { identityRoles } from './identity-roles';
import { identityUsers } from './identity-users';

/** A grant of a role or an employee on a server, its read tools, a tool or a model; one per holder, effect, target. */
export const accessGrants = app.table(
  'access_grants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    roleId: uuid('role_id').references(() => identityRoles.id, {
      onDelete: 'cascade',
    }),
    userId: uuid('user_id').references(() => identityUsers.id, {
      onDelete: 'cascade',
    }),
    effect: text('effect').notNull(),
    targetKind: text('target_kind').notNull(),
    /** Removing the server removes its grants and the grants on its tools. */
    server: text('server').references(() => mcpServers.name, {
      onDelete: 'cascade',
    }),
    /** No FK: a tool is an item of its server's list, not a row. */
    tool: text('tool'),
    model: text('model').references(() => models.id, {
      onDelete: 'cascade',
    }),
    /** Monthly quota of a model allow; null — no quota. */
    quotaUsd: numeric('quota_usd', { precision: 12, scale: 2, mode: 'number' }),
    createdAt: createdAt(),
  },
  (t) => [
    unique('access_grants_holder_target_key')
      .on(t.roleId, t.userId, t.effect, t.targetKind, t.server, t.tool, t.model)
      .nullsNotDistinct(),
    /** The cascade from a role is served by the unique key above: `role_id` is its first column. */
    index('access_grants_user_idx').on(t.userId),
    /** The cascade from a server. */
    index('access_grants_server_idx').on(t.server),
    check(
      'access_grants_effect_check',
      isOneOf(t.effect, GrantEffectSchema.options),
    ),
    check(
      'access_grants_target_kind_check',
      isOneOf(t.targetKind, GrantTargetKindSchema.options),
    ),
    check(
      'access_grants_holder_check',
      sql`num_nonnulls(${t.roleId}, ${t.userId}) = 1`,
    ),
    check(
      'access_grants_target_check',
      sql`((${t.targetKind} = ${literal(GrantTargetKindSchema.enum.server)}
            or ${t.targetKind} = ${literal(GrantTargetKindSchema.enum.server_read)})
          and ${t.server} is not null and ${t.tool} is null and ${t.model} is null)
        or (${t.targetKind} = ${literal(GrantTargetKindSchema.enum.tool)}
          and ${t.server} is not null and ${t.tool} is not null and ${t.model} is null)
        or (${t.targetKind} = ${literal(GrantTargetKindSchema.enum.model)}
          and ${t.server} is null and ${t.tool} is null and ${t.model} is not null)`,
    ),
    /** Invariant 2: a deny belongs only to an employee. */
    check(
      'access_grants_deny_holder_check',
      sql`${t.effect} = ${literal(GrantEffectSchema.enum.allow)} or ${t.userId} is not null`,
    ),
    check(
      'access_grants_quota_check',
      sql`${t.quotaUsd} is null or (${t.effect} = ${literal(GrantEffectSchema.enum.allow)}
        and ${t.targetKind} = ${literal(GrantTargetKindSchema.enum.model)})`,
    ),
  ],
);
