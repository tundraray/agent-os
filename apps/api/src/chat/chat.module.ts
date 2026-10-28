import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller.js';

@Module({ controllers: [ChatController] })
export class ChatModule {}
