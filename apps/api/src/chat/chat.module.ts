import { Module } from '@nestjs/common';
import { ThreadsModule } from '../threads/threads.module.js';
import { ChatController } from './chat.controller.js';

@Module({ imports: [ThreadsModule], controllers: [ChatController] })
export class ChatModule {}
