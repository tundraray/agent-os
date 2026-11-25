import { Module } from '@nestjs/common';
import { AGENT_PAGE_SIZE } from '@agent-os/contracts';
import { AgentsModule } from '../agents/agents.module';
import { LibraryModule } from '../library/library.module';
import { SchedulesModule } from '../schedules/schedules.module';
import { AgentControlService } from './agent-control.service';
import { AgentsController } from './agents.controller';
import { AGENT_LIST_PAGE_SIZE } from './chat.tokens';
import { ConversationSearchService } from './conversation-search.service';
import { ConversationsService } from './conversations.service';
import { DecisionsController } from './decisions.controller';
import { EventsController } from './events.controller';
import { LiveHub } from './live-hub';
import { SearchController } from './search.controller';
import { SpendController } from './spend.controller';
import { ThreadsController } from './threads.controller';
import { TitleService } from './title.service';

/**
 * The conversations of the agent platform (design-chat.md, C3 `api`). The root of a conversation starts
 * from the default agent with the key `chat`, a row of the built-in rows migration (data-model
 * design-agents.md, KD-4); `start_deep_agent`, a tool of the root, is a built-in tool of `agents`.
 * A message's record chip is checked through `LibraryModule`. `LiveHub` opens its `LISTEN` connection
 * at application bootstrap and closes the streams and the connection before shutdown.
 */
@Module({
  imports: [AgentsModule, LibraryModule, SchedulesModule],
  controllers: [
    ThreadsController,
    AgentsController,
    DecisionsController,
    SpendController,
    EventsController,
    SearchController,
  ],
  providers: [
    TitleService,
    ConversationsService,
    ConversationSearchService,
    { provide: AGENT_LIST_PAGE_SIZE, useValue: AGENT_PAGE_SIZE },
    AgentControlService,
    LiveHub,
  ],
  exports: [ConversationsService, LiveHub],
})
export class ChatModule {}
