import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module';
import { IdentityModule } from '../identity/identity.module';
import { SettingsModule } from '../settings/settings.module';
import { LibraryChatService } from './library-chat.service';
import { LibraryPanelService } from './library-panel.service';
import { LibraryRecords } from './library-records';
import { LibrarySave } from './library-save';
import { LibrarySettingsService } from './library-settings';
import { LibraryService } from './library.service';

/**
 * The library's port module (port-module-split.md, design-library.md KD-6): the services — the
 * employee's and the `runtime` part's `LibraryService`, the panel's, the main chat's, over the shared
 * `LibraryRecords` and `LibrarySave` — over `AgentsRepository` of `@agent-os/db`, the only reader and writer of the catalogue tables. It does not import `AgentsModule`: the agents
 * will import it for the library port, and the routes that need the MCP registry and the default model
 * live in `LibraryApiModule`, which hands those facts to the service as input.
 */
@Module({
  imports: [IdentityModule, AccessModule, SettingsModule],
  providers: [
    LibraryRecords,
    LibrarySave,
    LibraryService,
    LibraryPanelService,
    LibraryChatService,
    LibrarySettingsService,
  ],
  exports: [
    LibraryService,
    LibraryPanelService,
    LibraryChatService,
    LibrarySettingsService,
  ],
})
export class LibraryModule {}
