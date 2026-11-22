import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AgentsModule as AgentsPackageModule } from '@agent-os/agents';
import { AccessModule } from '../access/access.module';
import { IdentityModule } from '../identity/identity.module';
import { createAppLogger } from '../logging/app-logger';
import { AdminMcpServersController } from './admin-mcp-servers.controller';
import { AdminModelProvidersController } from './admin-model-providers.controller';
import { AdminToolResultsController } from './admin-tool-results.controller';
import { AgentsPortsModule } from './agents-ports.module';
import { readAgentsSettings } from './agents-settings';
import { McpConnectionsController } from './mcp-connections.controller';

/**
 * The agents package in `apps/api` (composition-root.md, design-agents.md C2 `api`, design-chat.md
 * «Сборка»): the package's module with the settings read from the environment and the ports of
 * `AgentsPortsModule`, over the services of `RuntimeModule` and the pool of `DbModule`. It logs through a
 * logger of its own.
 */
const agentsPackage = AgentsPackageModule.forRootAsync({
  imports: [AgentsPortsModule],
  inject: [ConfigService],
  useFactory: (config: ConfigService) =>
    readAgentsSettings((name) => config.get<string>(name)),
  // Provider keys reach the mask through the process's secret memory, not a list (KD-7).
  logger: () => createAppLogger(process.env),
});

/**
 * The agents in `apps/api`: imports the package's module and hands its services on to the modules that
 * import this one. The package registers its agents, handlers, event consumers and system tools in
 * `onModuleInit`; upper modules register their tools in theirs; the tools library closes in
 * `onApplicationBootstrap`.
 *
 * Its controllers are the HTTP layer of `AgentsMcp` (an employee's MCP accounts and the admin's registry),
 * of `AgentsProviders` (the admin's model provider registry) and of `AgentsToolResults` (the admin's
 * settings of large tool results).
 */
@Module({
  imports: [IdentityModule, AccessModule, agentsPackage],
  controllers: [
    McpConnectionsController,
    AdminMcpServersController,
    AdminToolResultsController,
    AdminModelProvidersController,
  ],
  exports: [agentsPackage],
})
export class AgentsModule {}
