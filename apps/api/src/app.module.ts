import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuditModule } from './audit/audit.module.js';
import { RuntimeModule } from './runtime/runtime.module.js';
import { LoggingModule } from './logging/logging.module.js';
import { AgentsModule } from './agents/agents.module.js';
import { WorkflowsModule } from './workflows/workflows.module.js';
import { ChatModule } from './chat/chat.module.js';
import { IdentityModule } from './identity/identity.module.js';
import { AccessModule } from './access/access.module.js';
import { AccessAdminModule } from './access/access-admin.module.js';
import { LibraryApiModule } from './library/library-api.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    LoggingModule,
    AuditModule,
    IdentityModule,
    RuntimeModule,
    AccessModule,
    AgentsModule,
    AccessAdminModule,
    LibraryApiModule,
    WorkflowsModule,
    ChatModule,
  ],
})
export class AppModule {}
