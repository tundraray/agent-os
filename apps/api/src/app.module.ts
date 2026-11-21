import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuditModule } from './audit/audit.module';
import { RuntimeModule } from './runtime/runtime.module';
import { LoggingModule } from './logging/logging.module';
import { AgentsModule } from './agents/agents.module';
import { WorkflowsModule } from './workflows/workflows.module';
import { ChatModule } from './chat/chat.module';
import { IdentityModule } from './identity/identity.module';
import { AccessModule } from './access/access.module';
import { AccessAdminModule } from './access/access-admin.module';
import { LibraryApiModule } from './library/library-api.module';
import { KnowledgeApiModule } from './knowledge/knowledge-api.module';

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
    KnowledgeApiModule,
    WorkflowsModule,
    ChatModule,
  ],
})
export class AppModule {}
