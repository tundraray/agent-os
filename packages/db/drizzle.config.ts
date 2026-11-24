import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit configuration for schema `app` (ADR-0003). Only `app` is generated and diffed;
 * `public` stays outside. The migration journal lives in `app`.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema/index.ts',
  out: './src/migrations',
  schemaFilter: ['app'],
  migrations: {
    schema: 'app',
    table: '__drizzle_migrations',
  },
});
