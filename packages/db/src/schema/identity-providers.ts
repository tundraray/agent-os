import { ProviderTypeSchema } from '@agent-os/contracts';
import {
  boolean,
  check,
  integer,
  jsonb,
  text,
  uuid,
} from 'drizzle-orm/pg-core';
import { app } from './app';
import { createdAt, isOneOf } from './helpers';

export const identityProviders = app.table(
  'identity_providers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** Never changes after creation. */
    type: text('type').notNull(),
    name: text('name').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    /** Grows with every change of the provider. */
    version: integer('version').notNull().default(1),
    /** Settings of the type, the client secret included as is (KD-7). */
    options: jsonb('options').notNull().default({}),
    /** Orders the providers. */
    createdAt: createdAt(),
  },
  (t) => [
    check(
      'identity_providers_type_check',
      isOneOf(t.type, ProviderTypeSchema.options),
    ),
  ],
);
