import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { MastraModule } from './mastra/mastra.module.js';
import { AuthModule } from './auth/auth.module.js';
import { AuditModule } from './audit/audit.module.js';
import { ChatModule } from './chat/chat.module.js';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true }), MastraModule, AuthModule, AuditModule, ChatModule],
})
export class AppModule {}
