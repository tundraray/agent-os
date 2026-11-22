import { Module } from '@nestjs/common';
import type { Agents } from '@agent-os/agents';
import type { Logger } from '@agent-os/common';
import { AgentsModule } from '../agents/agents.module';
import { AGENTS } from '../agents/agents.tokens';
import { IdentityDirectory } from '../identity/identity-directory';
import { IdentityModule } from '../identity/identity.module';
import { APP_LOGGER } from '../logging/app-logger';
import { AdminLibraryController } from './admin-library.controller';
import { BuiltinRecordsSeeder } from './builtin-records.seeder';
import { LibraryController } from './library.controller';
import { LibraryModule } from './library.module';
import { LibraryChatService } from './library-chat.service';
import { createRecordTools, RECORD_TOOLS_REGISTRATION } from './record-tools';

/**
 * The library's routes (port-module-split.md, design-library.md KD-6): the controllers import
 * `AgentsModule` for the MCP registry and the default model, which `LibraryModule` may not import
 * because the agents import it for the library port. The seeder of the built-in records lives here for
 * the same default model (design-runtime.md, KD-7). The five record tools of the main chat
 * (deep-agents KD-3) are registered in the `RECORD_TOOLS_REGISTRATION` factory: Nest builds every
 * provider before any `onModuleInit`, where `AgentsModule` calls `agents.start()` and closes the
 * registration.
 */
@Module({
  imports: [LibraryModule, AgentsModule, IdentityModule],
  controllers: [LibraryController, AdminLibraryController],
  providers: [
    BuiltinRecordsSeeder,
    {
      provide: RECORD_TOOLS_REGISTRATION,
      useFactory: (
        agents: Agents,
        library: LibraryChatService,
        identity: IdentityDirectory,
        logger: Logger,
      ): true => {
        for (const tool of createRecordTools({
          library,
          identity,
          mcp: agents.mcp,
          logger,
        }))
          agents.tools.register(tool);
        return true;
      },
      inject: [AGENTS, LibraryChatService, IdentityDirectory, APP_LOGGER],
    },
  ],
})
export class LibraryApiModule {}
