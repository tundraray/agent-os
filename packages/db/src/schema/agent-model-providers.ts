import { ModelProviderKindSchema } from '@agent-os/contracts';
import { boolean, check, text, timestamp } from 'drizzle-orm/pg-core';
import { app } from './app';
import { createdAt, isOneOf } from './helpers';

export const agentModelProviders = app.table(
  'agent_model_providers',
  {
    /** Never changes: model ids carry it as their first part. */
    name: text('name').primaryKey(),
    /** Never changes after registration. */
    kind: text('kind').notNull(),
    /** Null — the kind's default address. */
    baseUrl: text('base_url'),
    /** Null — no key set. */
    apiKey: text('api_key'),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check('agent_model_providers_kind_check', isOneOf(t.kind, ModelProviderKindSchema.options)),
  ],
);
