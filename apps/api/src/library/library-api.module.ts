import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { IdentityModule } from '../identity/identity.module';
import { SettingsModule } from '../settings/settings.module';
import { AdminLibraryController } from './admin-library.controller';
import { LibraryController } from './library.controller';
import { LibraryModule } from './library.module';
import { PersonalInstructionsToolRegistration } from './personal-instructions-tool';
import { RecordToolsRegistration } from './record-tools';
import { TestRunToolsRegistration } from './test-run-tools';

/**
 * The library's routes (port-module-split.md, design-library.md KD-6): the controllers import
 * `AgentsModule` for the MCP registry and the default model, which `LibraryModule` may not import
 * because the agents import it for the library port. The five record tools of the main chat
 * (deep-agents KD-3) are registered by `RecordToolsRegistration`, the test run's `library_overview`,
 * `offer_agent`, `take_agent`, `propose_plan` and `create_agent` (design-trainer-dialog.md) by `TestRunToolsRegistration`,
 * the main chat's `set_personal_instructions` (agent-guidance KD-8) by `PersonalInstructionsToolRegistration`.
 */
@Module({
  imports: [LibraryModule, AgentsModule, IdentityModule, SettingsModule],
  controllers: [LibraryController, AdminLibraryController],
  providers: [
    RecordToolsRegistration,
    TestRunToolsRegistration,
    PersonalInstructionsToolRegistration,
  ],
})
export class LibraryApiModule {}
