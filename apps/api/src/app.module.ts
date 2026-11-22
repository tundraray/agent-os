import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { DbModule } from '@agent-os/db';
import { AuditModule } from './audit/audit.module';
import { ApiRuntimeModule } from './runtime/api-runtime.module';
import { readRuntimeSettings } from './runtime/runtime-settings';
import { LoggingModule } from './logging/logging.module';
import { AgentsModule } from './agents/agents.module';
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
    DbModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connectionString: config.getOrThrow<string>('DATABASE_URL'),
        poolMax: readRuntimeSettings((name) => config.get<string>(name))
          .dbPoolMax,
      }),
    }),
    AuditModule,
    IdentityModule,
    ApiRuntimeModule,
    AccessModule,
    AgentsModule,
    AccessAdminModule,
    LibraryApiModule,
    KnowledgeApiModule,
    ChatModule,
  ],
})
export class AppModule {}
