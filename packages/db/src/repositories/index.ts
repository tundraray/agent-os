import { AccessGrantsRepository } from './access-grants.repository';
import { ModelsRepository } from './models.repository';
import { CodeCallsRepository } from './code-calls.repository';
import { AgentKnowledgeRunsRepository } from './agent-knowledge-runs.repository';
import { AgentKnowledgeVectorsRepository } from './agent-knowledge-vectors.repository';
import { AgentKnowledgeRepository } from './agent-knowledge.repository';
import { McpAccountsRepository } from './mcp-accounts.repository';
import { McpServersRepository } from './mcp-servers.repository';
import { MessagesRepository } from './messages.repository';
import { ModelProvidersRepository } from './model-providers.repository';
import { ConversationTasksRepository } from './conversation-tasks.repository';
import { ConversationsRepository } from './conversations.repository';
import { ToolResultsRepository } from './tool-results.repository';
import { AuditEventsRepository } from './audit-events.repository';
import { IdentityProvidersRepository } from './identity-providers.repository';
import { IdentityRolesRepository } from './identity-roles.repository';
import { IdentitySessionsRepository } from './identity-sessions.repository';
import { IdentityUsersRepository } from './identity-users.repository';
import { AgentsRepository } from './agents.repository';
import { RuntimeInboxRepository } from './runtime-inbox.repository';
import { RuntimeModelCallsRepository } from './runtime-model-calls.repository';
import { RuntimeTasksRepository } from './runtime-tasks.repository';
import { SettingsRepository } from './settings.repository';

export * from './access-grants.repository';
export * from './models.repository';
export * from './code-calls.repository';
export * from './agent-knowledge-runs.repository';
export * from './agent-knowledge-vectors.repository';
export * from './agent-knowledge.repository';
export * from './mcp-accounts.repository';
export * from './mcp-servers.repository';
export * from './messages.repository';
export * from './model-providers.repository';
export * from './conversation-tasks.repository';
export * from './conversations.repository';
export * from './tool-results.repository';
export type { FinishedMcpCall, FinishedWindow } from './finished-window';
export * from './audit-events.repository';
export * from './identity-providers.repository';
export * from './identity-roles.repository';
export * from './identity-sessions.repository';
export * from './identity-users.repository';
export * from './agents.repository';
export * from './runtime-inbox.repository';
export * from './runtime-model-calls.repository';
export * from './runtime-tasks.repository';
export * from './settings.repository';

/** Every repository class: `DbModule` provides and exports them all. */
export const REPOSITORIES = [
  AccessGrantsRepository,
  ModelsRepository,
  CodeCallsRepository,
  AgentKnowledgeRunsRepository,
  AgentKnowledgeVectorsRepository,
  AgentKnowledgeRepository,
  McpAccountsRepository,
  McpServersRepository,
  MessagesRepository,
  ModelProvidersRepository,
  ConversationTasksRepository,
  ConversationsRepository,
  ToolResultsRepository,
  AuditEventsRepository,
  IdentityProvidersRepository,
  IdentityRolesRepository,
  IdentitySessionsRepository,
  IdentityUsersRepository,
  AgentsRepository,
  RuntimeInboxRepository,
  RuntimeModelCallsRepository,
  RuntimeTasksRepository,
  SettingsRepository,
];
