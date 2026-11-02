import { Module } from '@nestjs/common';
import { ResearchChatModule } from '../research-chat/research-chat.module.js';
import { ThreadsModule } from '../threads/threads.module.js';
import { ChatController } from './chat.controller.js';

@Module({
  imports: [ThreadsModule, ResearchChatModule],
  controllers: [ChatController],
})
export class ChatModule {}
