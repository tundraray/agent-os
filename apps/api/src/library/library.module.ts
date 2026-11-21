import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { IdentityModule } from '../identity/identity.module';
import { RuntimeModule } from '../runtime/runtime.module';
import { LibrarySettingsService } from './library-settings';
import { LibraryService } from './library.service';

/**
 * The library's port module (port-module-split.md, design-library.md KD-6): the service and the
 * repository, the only reader and writer of `library_*`. It does not import `AgentsModule`: the agents
 * will import it for the library port, and the routes that need the MCP registry and the default model
 * live in `LibraryApiModule`, which hands those facts to the service as input.
 */
@Module({
  imports: [RuntimeModule, IdentityModule, AccessModule],
  providers: [LibraryService, LibrarySettingsService],
  exports: [LibraryService, LibrarySettingsService],
})
export class LibraryModule {}
