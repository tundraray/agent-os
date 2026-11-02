import { Module } from '@nestjs/common';
import { EngineModule } from '../engine/engine.module.js';
import { ResearchModule } from '../research/research.module.js';
import { ThreadsModule } from '../threads/threads.module.js';
import { ResearchChatController } from './research-chat.controller.js';
import { ResearchLaunchService } from './research-launch.service.js';

/**
 * Deep research started from a chat thread (design-chat-entry.md, C3 api). `MastraModule` does not import it: the chat
 * agent's `deepResearch` tool resolves `ResearchLaunchService` when it runs, which keeps the modules acyclic.
 */
@Module({
  imports: [ThreadsModule, ResearchModule, EngineModule],
  controllers: [ResearchChatController],
  providers: [ResearchLaunchService],
  exports: [ResearchLaunchService],
})
export class ResearchChatModule {}
