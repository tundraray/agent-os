import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { DatabaseModule } from './database/database.module.js';
import { MastraModule } from './mastra/mastra.module.js';
import { AuthModule } from './auth/auth.module.js';
import { AuditModule } from './audit/audit.module.js';
import { ChatModule } from './chat/chat.module.js';
import { ThreadsModule } from './threads/threads.module.js';
import { ResearchModule } from './research/research.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    DatabaseModule,
    MastraModule,
    AuthModule,
    AuditModule,
    ChatModule,
    ThreadsModule,
    ResearchModule,
  ],
})
export class AppModule {}
