import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit configuration for schema `app` (ADR-0003). Only `app` is generated and diffed;
 * `public` (Mastra, audit_events) stays outside. The migration journal lives in `app`.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/database/schema.ts',
  out: './migrations',
  schemaFilter: ['app'],
  migrations: {
    schema: 'app',
    table: '__drizzle_migrations',
  },
});
