// `app` (./app.ts) is not exported: the migrator creates the schema, and an exported one makes drizzle-kit emit a CREATE SCHEMA that fails on every database.

// ---------------------------------------------------------------------------------------------
// Runtime tables (agent-platform/design-runtime.md, Data Model).
// ---------------------------------------------------------------------------------------------
export * from './runtime-tasks';
export * from './runtime-inbox';
export * from './runtime-model-calls';

// ---------------------------------------------------------------------------------------------
// Conversation tables (agent-platform/design-agents.md, Data Model). The conversation key is the
// runtime task id and cascades from it; a deleted conversation is marked on its tasks
// (`runtime_tasks.deleted_at`), the cascade stays for a future retention purge.
// ---------------------------------------------------------------------------------------------
export * from './conversations';
export * from './messages';
export * from './tool-results';
export * from './code-calls';
export * from './conversation-tasks';

// ---------------------------------------------------------------------------------------------
// MCP registry and employee accounts (enterprise-access/design-mcp-connect.md, Data Model, KD-1).
// Owned by the `agents` package (ADR-0014). Tokens and the client secret are stored as is.
// ---------------------------------------------------------------------------------------------
export * from './mcp-servers';
export * from './mcp-accounts';

// ---------------------------------------------------------------------------------------------
// Model providers (model-providers/design-core.md, Data Model, KD-1). Owned by the `agents` package.
// The key is stored as is.
// ---------------------------------------------------------------------------------------------
export * from './model-providers';

// ---------------------------------------------------------------------------------------------
// Identity (enterprise-access/design-identity.md, Data Model). Read only by the `identity` module
// of `apps/api`. Email and login are stored normalized (trimmed, lower case), so a plain unique
// index makes them unique regardless of case.
// ---------------------------------------------------------------------------------------------
export * from './identity-users';
export * from './identity-roles';
export * from './identity-role-members';
export * from './identity-providers';
export * from './identity-login-requests';
export * from './identity-sessions';

// ---------------------------------------------------------------------------------------------
// Access (enterprise-access/design-access.md, Data Model, KD-1, KD-3). Read and written only by the
// `access` module of `apps/api` (ADR-0015).
// ---------------------------------------------------------------------------------------------
export * from './models';
export * from './access-grants';

// ---------------------------------------------------------------------------------------------
// Catalogue of agents (custom-agents/design-library.md; data-model/design-agents.md, KD-1). Read and written only
// by the `library` module of `apps/api` (ADR-0016). An agent points to its active version; a version is an
// immutable `content` in the form of the agent's kind, checked by the kind's schema in `@agent-os/contracts`.
// A holder is a role or an employee with FK and cascade, as in `access_grants`, or "everyone".
// ---------------------------------------------------------------------------------------------
export * from './agents';
export * from './agent-versions';
export * from './agent-shares';

// ---------------------------------------------------------------------------------------------
// Memory of self-learning deep agents (self-learning/design-memory.md, KD-1): a record belongs to an agent or
// an employee and goes with it by cascade. Its texts live in immutable versions, which go with the record by
// cascade (schedules-search-memory/design-memory-hygiene.md, KD-1).
// ---------------------------------------------------------------------------------------------
export * from './memories';
export * from './memory-versions';

// ---------------------------------------------------------------------------------------------
// Notepad of a deep agent run (self-learning/design-notepad.md, KD-1): a document belongs to the run's
// conversation and goes with it by cascade.
// ---------------------------------------------------------------------------------------------
export * from './documents';

// ---------------------------------------------------------------------------------------------
// Training of a deep agent (self-learning/design-training.md, KD-6): one row per training, its id is the
// training's conversation; the comparison list lives in the row.
// ---------------------------------------------------------------------------------------------
export * from './trainings';

// ---------------------------------------------------------------------------------------------
// Schedules (schedules-search-memory/design-schedules.md, Data Model): an employee's schedules and the
// history of their terms, one row per term; both go with the employee and the schedule by cascade.
// ---------------------------------------------------------------------------------------------
export * from './schedules';
export * from './schedule-runs';

// ---------------------------------------------------------------------------------------------
// Send keys (runtime-fixes/design-send.md, Data Model, KD-1): one row per accepted send of an employee
// with a key; goes with the employee by cascade, never expires.
// ---------------------------------------------------------------------------------------------
export * from './send-keys';

// ---------------------------------------------------------------------------------------------
// Settings (data-model/design-schema.md, KD-3): one row per key, the value checked by the key's schema
// in `@agent-os/contracts`. Written only by the settings service of `apps/api`.
// ---------------------------------------------------------------------------------------------
export * from './settings';

// ---------------------------------------------------------------------------------------------
// Audit (enterprise-access/design-identity.md, KD-7). Written only by `AuditLog` of `apps/api`;
// kinds are open: every part adds its own.
// ---------------------------------------------------------------------------------------------
export * from './audit-events';
