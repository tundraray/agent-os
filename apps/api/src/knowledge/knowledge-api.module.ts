import { Module } from '@nestjs/common';
import { AgentsModule } from '../agents/agents.module';
import { AuditModule } from '../audit/audit.module';
import { LibraryModule } from '../library/library.module';
import { AdminKnowledgeSettingsController } from './admin-knowledge-settings.controller';
import { KnowledgeController } from './knowledge.controller';

/**
 * The knowledge routes (port-module-split.md, self-learning design-core.md KD-7): the access rule comes
 * from `LibraryModule` (`knowledgeTarget`), the graph and the settings from `AgentsModule`
 * (`AgentsKnowledge`). They live apart from `LibraryModule`, which may not import `AgentsModule`.
 */
@Module({
  imports: [LibraryModule, AgentsModule, AuditModule],
  controllers: [KnowledgeController, AdminKnowledgeSettingsController],
})
export class KnowledgeApiModule {}
