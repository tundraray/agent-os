import { AccessGrantsRepository } from './access-grants.repository';
import { ModelsRepository } from './models.repository';
import { CodeCallsRepository } from './code-calls.repository';
import { MemoriesRepository } from './memories.repository';
import { DocumentsRepository } from './documents.repository';
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
import { TrainingsRepository } from './trainings.repository';

export * from './access-grants.repository';
export * from './models.repository';
export * from './code-calls.repository';
export * from './memories.repository';
export * from './documents.repository';
export * from './mcp-accounts.repository';
export * from './mcp-servers.repository';
export * from './messages.repository';
export * from './model-providers.repository';
export * from './conversation-tasks.repository';
export * from './conversations.repository';
export * from './tool-results.repository';
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
export * from './trainings.repository';

/** Every repository class: `DbModule` provides and exports them all. */
export const REPOSITORIES = [
  AccessGrantsRepository,
  ModelsRepository,
  CodeCallsRepository,
  MemoriesRepository,
  DocumentsRepository,
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
  TrainingsRepository,
];
