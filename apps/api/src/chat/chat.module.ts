import { Module } from '@nestjs/common';
import type { Agents } from '@agent-os/agents';
import { AGENT_PAGE_SIZE } from '@agent-os/contracts';
import { AgentsModule } from '../agents/agents.module.js';
import { AGENTS } from '../agents/agents.tokens.js';
import { RuntimeModule } from '../runtime/runtime.module.js';
import { WorkflowsModule } from '../workflows/workflows.module.js';
import { WORKFLOWS } from '../workflows/workflows.tokens.js';
import { AgentControlService } from './agent-control.service.js';
import { AgentsController } from './agents.controller.js';
import { CHAT_DEFINITION } from './chat-definition.js';
import { AGENT_LIST_PAGE_SIZE } from './chat.tokens.js';
import { ConversationsRepository } from './conversations.repository.js';
import { ConversationsService } from './conversations.service.js';
import { DecisionsController } from './decisions.controller.js';
import { EventsController } from './events.controller.js';
import { LiveHub } from './live-hub.js';
import { SpendController } from './spend.controller.js';
import { ThreadsController } from './threads.controller.js';
import { TitleService } from './title.service.js';

/** The registration of the `chat` definition: a marker provider whose factory does the work. */
const CHAT_REGISTRATION = Symbol('CHAT_REGISTRATION');

/**
 * The conversations of the agent platform (design-chat.md, C3 `api`). The `chat` definition is
 * registered in the `CHAT_REGISTRATION` factory: Nest builds every provider before any
 * `onModuleInit`, and `AgentsModule.onModuleInit` calls `agents.start()`, which seals the catalog
 * (agents plan, Notes 8). `WORKFLOWS` is injected so that `start_workflow`, a tool of `chat`, is
 * registered before the catalog check. The chat model is `AGENT_DEFAULT_MODEL` (no `model` field).
 * `LiveHub` opens its `LISTEN` connection at application bootstrap and closes the streams and the
 * connection before shutdown.
 */
@Module({
  imports: [RuntimeModule, AgentsModule, WorkflowsModule],
  controllers: [
    ThreadsController,
    AgentsController,
    DecisionsController,
    SpendController,
    EventsController,
  ],
  providers: [
    {
      provide: CHAT_REGISTRATION,
      useFactory: (agents: Agents): true => {
        agents.definitions.register(CHAT_DEFINITION);
        return true;
      },
      inject: [AGENTS, WORKFLOWS],
    },
    ConversationsRepository,
    TitleService,
    ConversationsService,
    { provide: AGENT_LIST_PAGE_SIZE, useValue: AGENT_PAGE_SIZE },
    AgentControlService,
    LiveHub,
  ],
  exports: [ConversationsRepository, ConversationsService, LiveHub],
})
export class ChatModule {}
