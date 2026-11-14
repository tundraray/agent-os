import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module.js';
import { AuditModule } from './audit/audit.module.js';
import { RuntimeModule } from './runtime/runtime.module.js';
import { LoggingModule } from './logging/logging.module.js';
import { AgentsModule } from './agents/agents.module.js';
import { WorkflowsModule } from './workflows/workflows.module.js';
import { ChatModule } from './chat/chat.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggingModule,
    AuthModule,
    AuditModule,
    RuntimeModule,
    AgentsModule,
    WorkflowsModule,
    ChatModule,
  ],
})
export class AppModule {}
