import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { IdentityModule } from '../identity/identity.module';
import { AdminLibraryController } from './admin-library.controller';
import { BuiltinRecordsSeeder } from './builtin-records.seeder';
import { LibraryController } from './library.controller';
import { LibraryModule } from './library.module';
import { RecordToolsRegistration } from './record-tools';

/**
 * The library's routes (port-module-split.md, design-library.md KD-6): the controllers import
 * `AgentsModule` for the MCP registry and the default model, which `LibraryModule` may not import
 * because the agents import it for the library port. The seeder of the built-in records lives here for
 * the same default model (design-runtime.md, KD-7). The five record tools of the main chat
 * (deep-agents KD-3) are registered by `RecordToolsRegistration`.
 */
@Module({
  imports: [LibraryModule, AgentsModule, IdentityModule],
  controllers: [LibraryController, AdminLibraryController],
  providers: [BuiltinRecordsSeeder, RecordToolsRegistration],
})
export class LibraryApiModule {}
