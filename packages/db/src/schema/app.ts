import { pgSchema } from 'drizzle-orm/pg-core';

/**
 * Model of Postgres schema `app` (ADR-0003): every table, constraint and index of `app` is
 * declared in this folder, one table per file; runtime tables carry the prefix `runtime_`.
 * drizzle-kit generates the migrations in `packages/db/src/migrations/` from `index.ts`.
 *
 * CHECK domains are built from the contract enums in `@agent-os/contracts`, never duplicated here.
 * The cascade starts at the root task: deleting it deletes its tree with its messages, decisions
 * and events. The application marks a tree deleted (`deleted_at`) rather than deleting it; the
 * cascades stay for a future retention purge. The token ledger has no FK and outlives the tree.
 */
export const app = pgSchema('app');
