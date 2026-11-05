import {
  type BeforeApplicationShutdown,
  Inject,
  Module,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DatabaseConnection } from '@agent-os/db';
import { parseRuntimeConfig, type Runtime } from '@agent-os/runtime';
import { EngineModule } from '../engine/engine.module.js';
import { ResearchModule } from '../research/research.module.js';
import {
  RESEARCH_DATABASE,
  RESEARCH_RUNTIME,
} from '../research/research.tokens.js';
import { runtimeSettingsVariables } from '../research/runtime-settings.js';
import { ThreadDeletionHooks } from '../threads/thread-deletion-hooks.js';
import { ThreadsModule } from '../threads/threads.module.js';
import {
  ANSWER_APPENDER_SETTINGS,
  type AnswerAppenderSettings,
  ResearchAnswerAppender,
} from './research-answer.appender.js';
import { researchAnswerConsumer } from './research-answer.consumer.js';
import { parseResearchChatSettings } from './research-chat.settings.js';
import { ResearchChatController } from './research-chat.controller.js';
import { researchLaunchRepository as launches } from './research-launch.repository.js';
import { ResearchLaunchService } from './research-launch.service.js';

/**
 * Deep research started from a chat thread (design-chat-entry.md, C3 api). `MastraModule` does not import it: the chat
 * agent's `deepResearch` tool resolves `ResearchLaunchService` when it runs, which keeps the modules acyclic.
 *
 * Phases (KD-4): `onModuleInit` registers the answer consumer before `Runtime.start` and the thread deletion hook
 * (KD-7); the delivery loop starts in `onApplicationBootstrap` and stops in `beforeApplicationShutdown`. Nest runs
 * bootstrap hooks of an imported module first and shutdown hooks of an importing module first, so the loop starts after
 * `ResearchModule` started the runtime and stops before it stops the runtime.
 */
@Module({
  imports: [ThreadsModule, ResearchModule, EngineModule],
  controllers: [ResearchChatController],
  providers: [
    ResearchLaunchService,
    ResearchAnswerAppender,
    {
      provide: ANSWER_APPENDER_SETTINGS,
      useFactory: (config: ConfigService): AnswerAppenderSettings => {
        const read = (name: string) => config.get<string>(name);
        const runtime = parseRuntimeConfig(runtimeSettingsVariables(read));
        return {
          workers: runtime.workers,
          pollMs: runtime.pollMs,
          ...parseResearchChatSettings(read),
        };
      },
      inject: [ConfigService],
    },
  ],
  exports: [ResearchLaunchService],
})
export class ResearchChatModule
  implements OnModuleInit, OnApplicationBootstrap, BeforeApplicationShutdown
{
  constructor(
    @Inject(RESEARCH_RUNTIME) private readonly runtime: Runtime,
    @Inject(RESEARCH_DATABASE) private readonly database: DatabaseConnection,
    private readonly appender: ResearchAnswerAppender,
    private readonly deletionHooks: ThreadDeletionHooks,
  ) {}

  onModuleInit(): void {
    this.runtime.eventConsumers.register(researchAnswerConsumer);
    // The runtime's hook stops the thread's investigations, so `stop` has nothing to do. `purge` runs under the thread's
    // `ThreadWriteLock`, which is not reentrant: taking it again would hang the delete. The hook is idempotent (a
    // repeated delete removes nothing) and independent of the order of hooks: rows the runtime's purge already removed
    // by the FK cascade are simply not there.
    this.deletionHooks.register({
      stop: () => Promise.resolve({ settled: Promise.resolve() }),
      purge: (ref) => launches.deleteByThread(this.database.db, ref),
    });
  }

  onApplicationBootstrap(): void {
    this.appender.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.appender.stop();
  }
}
