import { AccessGrantsRepository } from './access-grants.repository';
import { AccessModelsRepository } from './access-models.repository';
import { AgentCodeCallsRepository } from './agent-code-calls.repository';
import { AgentKnowledgeRunsRepository } from './agent-knowledge-runs.repository';
import { AgentKnowledgeVectorsRepository } from './agent-knowledge-vectors.repository';
import { AgentKnowledgeRepository } from './agent-knowledge.repository';
import { AgentMcpAccountsRepository } from './agent-mcp-accounts.repository';
import { AgentMcpServersRepository } from './agent-mcp-servers.repository';
import { AgentMessagesRepository } from './agent-messages.repository';
import { AgentModelProvidersRepository } from './agent-model-providers.repository';
import { AgentSessionTasksRepository } from './agent-session-tasks.repository';
import { AgentSessionsRepository } from './agent-sessions.repository';
import { AgentToolResultsRepository } from './agent-tool-results.repository';
import { AuditEventsRepository } from './audit-events.repository';
import { IdentityProvidersRepository } from './identity-providers.repository';
import { IdentityRolesRepository } from './identity-roles.repository';
import { IdentitySessionsRepository } from './identity-sessions.repository';
import { IdentitySettingsRepository } from './identity-settings.repository';
import { IdentityUsersRepository } from './identity-users.repository';
import { LibraryRecordsRepository } from './library-records.repository';
import { LibrarySettingsRepository } from './library-settings.repository';
import { RuntimeDecisionsRepository } from './runtime-decisions.repository';
import { RuntimeEventDeliveriesRepository } from './runtime-event-deliveries.repository';
import { RuntimeEventsRepository } from './runtime-events.repository';
import { RuntimeInboxRepository } from './runtime-inbox.repository';
import { RuntimeModelCallsRepository } from './runtime-model-calls.repository';
import { RuntimeTasksRepository } from './runtime-tasks.repository';
import { RuntimeTrackersRepository } from './runtime-trackers.repository';

export * from './access-grants.repository';
export * from './access-models.repository';
export * from './agent-code-calls.repository';
export * from './agent-knowledge-runs.repository';
export * from './agent-knowledge-vectors.repository';
export * from './agent-knowledge.repository';
export * from './agent-mcp-accounts.repository';
export * from './agent-mcp-servers.repository';
export * from './agent-messages.repository';
export * from './agent-model-providers.repository';
export * from './agent-session-tasks.repository';
export * from './agent-sessions.repository';
export * from './agent-tool-results.repository';
export type { FinishedMcpCall, FinishedWindow } from './finished-window';
export * from './audit-events.repository';
export * from './identity-providers.repository';
export * from './identity-roles.repository';
export * from './identity-sessions.repository';
export * from './identity-settings.repository';
export * from './identity-users.repository';
export * from './library-records.repository';
export * from './library-settings.repository';
export * from './runtime-decisions.repository';
export * from './runtime-event-deliveries.repository';
export * from './runtime-events.repository';
export * from './runtime-inbox.repository';
export * from './runtime-model-calls.repository';
export * from './runtime-tasks.repository';
export * from './runtime-trackers.repository';

/** Every repository class: `DbModule` provides and exports them all. */
export const REPOSITORIES = [
  AccessGrantsRepository,
  AccessModelsRepository,
  AgentCodeCallsRepository,
  AgentKnowledgeRunsRepository,
  AgentKnowledgeVectorsRepository,
  AgentKnowledgeRepository,
  AgentMcpAccountsRepository,
  AgentMcpServersRepository,
  AgentMessagesRepository,
  AgentModelProvidersRepository,
  AgentSessionTasksRepository,
  AgentSessionsRepository,
  AgentToolResultsRepository,
  AuditEventsRepository,
  IdentityProvidersRepository,
  IdentityRolesRepository,
  IdentitySessionsRepository,
  IdentitySettingsRepository,
  IdentityUsersRepository,
  LibraryRecordsRepository,
  LibrarySettingsRepository,
  RuntimeDecisionsRepository,
  RuntimeEventDeliveriesRepository,
  RuntimeEventsRepository,
  RuntimeInboxRepository,
  RuntimeModelCallsRepository,
  RuntimeTasksRepository,
  RuntimeTrackersRepository,
];
