// `app` (./app.ts) is not exported: the migrator creates the schema, and an exported one makes drizzle-kit emit a CREATE SCHEMA that fails on every database.

// ---------------------------------------------------------------------------------------------
// Runtime tables (agent-platform/design-runtime.md, Data Model).
// ---------------------------------------------------------------------------------------------
export * from './runtime-tasks';
export * from './runtime-trackers';
export * from './runtime-inbox';
export * from './runtime-decisions';
export * from './runtime-events';
export * from './runtime-event-deliveries';
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
// Knowledge of self-learning deep agents (self-learning/design-core.md, Data Model). Owned by the
// `agents` package (KD-1). The graph, its vectors and the deep agent's vector row reference
// `agents` with cascade — the one exception to package tables not referencing app tables: a deep agent
// removed by any path takes its knowledge with it, while the `agents` package never reads the catalogue tables.
// ---------------------------------------------------------------------------------------------
export * from './agent-knowledge-entities';
export * from './agent-knowledge-relations';
export * from './agent-knowledge-runs';
export * from './agent-knowledge-questions';
export * from './agent-knowledge-embedding';
export * from './agent-knowledge-vectors';
export * from './agent-knowledge-settings';

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
