import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuditModule } from './audit/audit.module.js';
import { RuntimeModule } from './runtime/runtime.module.js';
import { LoggingModule } from './logging/logging.module.js';
import { AgentsModule } from './agents/agents.module.js';
import { WorkflowsModule } from './workflows/workflows.module.js';
import { ChatModule } from './chat/chat.module.js';
import { IdentityModule } from './identity/identity.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggingModule,
    AuditModule,
    IdentityModule,
    RuntimeModule,
    AgentsModule,
    WorkflowsModule,
    ChatModule,
  ],
})
export class AppModule {}
