export * from './app';

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
// Agent tables (agent-platform/design-agents.md, Data Model). The session key is the runtime task
// id; the cascade from it stays for a future retention purge, the application marks a conversation
// deleted (`deleted_at`) rather than deleting it.
// ---------------------------------------------------------------------------------------------
export * from './agent-sessions';
export * from './agent-messages';
export * from './agent-tool-results';
export * from './agent-tool-result-settings';
export * from './agent-code-calls';
export * from './agent-session-tasks';

// ---------------------------------------------------------------------------------------------
// MCP registry and employee accounts (enterprise-access/design-mcp-connect.md, Data Model, KD-1).
// Owned by the `agents` package (ADR-0014). Tokens and the client secret are stored as is.
// ---------------------------------------------------------------------------------------------
export * from './agent-mcp-servers';
export * from './agent-mcp-accounts';

// ---------------------------------------------------------------------------------------------
// Model providers (model-providers/design-core.md, Data Model, KD-1). Owned by the `agents` package.
// A catalogue model names its provider by the first part of its id, as text without FK (ADR-0018).
// The key is stored as is.
// ---------------------------------------------------------------------------------------------
export * from './agent-model-providers';

// ---------------------------------------------------------------------------------------------
// Identity (enterprise-access/design-identity.md, Data Model). Read only by the `identity` module
// of `apps/api`. Email and login are stored normalized (trimmed, lower case), so a plain unique
// index makes them unique regardless of case. Owner columns of `runtime` and `agents` stay text
// without FK (ADR-0012).
// ---------------------------------------------------------------------------------------------
export * from './identity-users';
export * from './identity-roles';
export * from './identity-role-members';
export * from './identity-providers';
export * from './identity-login-requests';
export * from './identity-sessions';
export * from './identity-settings';

// ---------------------------------------------------------------------------------------------
// Access (enterprise-access/design-access.md, Data Model, KD-1, KD-3). Read and written only by the
// `access` module of `apps/api` (ADR-0015). A grant names its MCP server and tool as text without
// FK: the registry belongs to the `agents` package (ADR-0014).
// ---------------------------------------------------------------------------------------------
export * from './access-models';
export * from './access-model-defaults';
export * from './access-grants';

// ---------------------------------------------------------------------------------------------
// Library (custom-agents/design-library.md, Data Model, KD-1). Read and written only by the
// `library` module of `apps/api` (ADR-0016). The content of a record is one jsonb in the form of its
// kind, checked by the kind's schema in `@agent-os/contracts`. A holder is a role or an employee
// with FK and cascade, as in `access_grants`, or "everyone".
// ---------------------------------------------------------------------------------------------
export * from './library-records';
export * from './library-shares';
export * from './library-settings';

// ---------------------------------------------------------------------------------------------
// Knowledge of self-learning deep agents (self-learning/design-core.md, Data Model). Owned by the
// `agents` package (KD-1). The graph, its vectors and the deep agent's vector row reference
// `library_records` with cascade — the one exception to package tables not referencing app tables:
// deleting a deep agent by any path takes its knowledge with it, while `agents` never reads `library_*`.
// ---------------------------------------------------------------------------------------------
export * from './agent-knowledge-entities';
export * from './agent-knowledge-relations';
export * from './agent-knowledge-runs';
export * from './agent-knowledge-questions';
export * from './agent-knowledge-embedding';
export * from './agent-knowledge-vectors';
export * from './agent-knowledge-settings';

// ---------------------------------------------------------------------------------------------
// Audit (enterprise-access/design-identity.md, KD-7). Written only by `AuditLog` of `apps/api`;
// kinds are open: every part adds its own.
// ---------------------------------------------------------------------------------------------
export * from './audit-events';
