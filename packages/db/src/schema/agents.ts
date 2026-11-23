import { BuiltinKeySchema, RecordKindSchema } from '@agent-os/contracts';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { app } from './app';
import { agentVersions } from './agent-versions';
import { createdAt, isOneOf } from './helpers';
import { identityUsers } from './identity-users';

/**
 * An agent of the catalogue (data-model design-agents.md, KD-1): what changes without a new definition —
 * name, description, owner, audience flags, key, deletion mark — and the pointer to its active version.
 */
export const agents = app.table(
  'agents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** `agent` or `deep_agent`; never changes. */
    kind: text('kind').notNull(),
    /** Null — a system agent (an exception to the owner rule, design-agents.md «Таблицы каталога»). */
    ownerId: uuid('owner_id').references(() => identityUsers.id, {
      onDelete: 'cascade',
    }),
    name: text('name').notNull(),
    description: text('description').notNull(),
    offerInChat: boolean('offer_in_chat').notNull().default(false),
    /** Key of a default agent (`chat`, `agent`, `deep_agent`); null for every other agent. */
    builtinKey: text('builtin_key'),
    /** When an admin closed sharing of an employee agent; null — not closed. */
    closedAt: timestamp('closed_at', { withTimezone: true }),
    /** The deletion mark (KD-7); a deleted agent answers as a missing one in every read. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    /** Null only inside the transaction that inserts the agent and its first version. */
    activeVersionId: uuid('active_version_id'),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    /** A name is unique per owner regardless of case and kind among agents not deleted; system agents are one group. */
    uniqueIndex('agents_owner_name_idx')
      .on(t.ownerId, sql`lower(${t.name})`)
      .where(sql`${t.ownerId} is not null and ${t.deletedAt} is null`),
    uniqueIndex('agents_system_name_idx')
      .on(sql`lower(${t.name})`)
      .where(sql`${t.ownerId} is null and ${t.deletedAt} is null`),
    uniqueIndex('agents_builtin_key_idx').on(t.builtinKey),
    /** The pointer names only a version of this agent. */
    foreignKey({
      name: 'agents_active_version_fk',
      columns: [t.id, t.activeVersionId],
      foreignColumns: [agentVersions.agentId, agentVersions.id],
    }).onDelete('restrict'),
    check('agents_kind_check', isOneOf(t.kind, RecordKindSchema.options)),
    check(
      'agents_builtin_key_check',
      sql`${t.builtinKey} is null or (${t.ownerId} is null and ${isOneOf(t.builtinKey, BuiltinKeySchema.options)})`,
    ),
    check(
      'agents_closed_at_check',
      sql`${t.closedAt} is null or ${t.ownerId} is not null`,
    ),
    check(
      'agents_deleted_at_check',
      sql`${t.deletedAt} is null or ${t.builtinKey} is null`,
    ),
  ],
);
