import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module.js';
import { AdminLibraryController } from './admin-library.controller.js';
import { BuiltinRecordsSeeder } from './builtin-records.seeder.js';
import { LibraryController } from './library.controller.js';
import { LibraryModule } from './library.module.js';

/**
 * The library's routes (port-module-split.md, design-library.md KD-6): the controllers import
 * `AgentsModule` for the MCP registry and the default model, which `LibraryModule` may not import
 * because the agents import it for the library port. The seeder of the built-in records lives here for
 * the same default model (design-runtime.md, KD-7).
 */
@Module({
  imports: [LibraryModule, AgentsModule],
  controllers: [LibraryController, AdminLibraryController],
  providers: [BuiltinRecordsSeeder],
})
export class LibraryApiModule {}
