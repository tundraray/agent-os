import { Module } from '@nestjs/common';
import type { Agents } from '@agent-os/agents';
import type { Logger } from '@agent-os/common';
import { AGENT_PAGE_SIZE } from '@agent-os/contracts';
import { AgentsModule } from '../agents/agents.module';
import { AGENTS } from '../agents/agents.tokens';
import { LibraryModule } from '../library/library.module';
import { LibraryService } from '../library/library.service';
import { APP_LOGGER } from '../logging/app-logger';
import { RuntimeModule } from '../runtime/runtime.module';
import { WorkflowsModule } from '../workflows/workflows.module';
import { WORKFLOWS } from '../workflows/workflows.tokens';
import { AgentControlService } from './agent-control.service';
import { AgentsController } from './agents.controller';
import { AGENT_LIST_PAGE_SIZE } from './chat.tokens';
import { ConversationsService } from './conversations.service';
import { DecisionsController } from './decisions.controller';
import { createDraftRecordTool, DRAFT_RECORD_REGISTRATION } from './draft-record.tool';
import { DraftsService } from './drafts.service';
import { EventsController } from './events.controller';
import { LiveHub } from './live-hub';
import { SpendController } from './spend.controller';
import { ThreadsController } from './threads.controller';
import { TitleService } from './title.service';

/**
 * The conversations of the agent platform (design-chat.md, C3 `api`). The root of a conversation starts
 * from the library record with the key `chat` (design-runtime.md, KD-7, DC-2), seeded by
 * `BuiltinRecordsSeeder`; `start_workflow`, a tool of the root, is registered by `WorkflowsModule`.
 * `draft_record`, the root's other tool (KD-6), is registered in the `DRAFT_RECORD_REGISTRATION`
 * factory: Nest builds every provider before any `onModuleInit`, and `AgentsModule.onModuleInit`
 * calls `agents.start()`, which closes the registration; `WORKFLOWS` is injected so that the root
 * offers `start_workflow` before `draft_record`. A message's record chip is checked through
 * `LibraryModule`. `LiveHub` opens its `LISTEN` connection
 * at application bootstrap and closes the streams and the connection before shutdown.
 */
@Module({
  imports: [RuntimeModule, AgentsModule, LibraryModule, WorkflowsModule],
  controllers: [
    ThreadsController,
    AgentsController,
    DecisionsController,
    SpendController,
    EventsController,
  ],
  providers: [
    {
      provide: DRAFT_RECORD_REGISTRATION,
      useFactory: (agents: Agents, library: LibraryService, logger: Logger): true => {
        agents.tools.register(createDraftRecordTool({ library, logger }));
        return true;
      },
      inject: [AGENTS, LibraryService, APP_LOGGER, WORKFLOWS],
    },
    DraftsService,
    TitleService,
    ConversationsService,
    { provide: AGENT_LIST_PAGE_SIZE, useValue: AGENT_PAGE_SIZE },
    AgentControlService,
    LiveHub,
  ],
  exports: [ConversationsService, LiveHub],
})
export class ChatModule {}
