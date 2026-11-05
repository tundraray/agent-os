import {
  type BeforeApplicationShutdown,
  Inject,
  Module,
  type OnApplicationBootstrap,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseRuntimeConfig, type Runtime } from '@agent-os/runtime';
import { EngineModule } from '../engine/engine.module.js';
import { ResearchModule } from '../research/research.module.js';
import { RESEARCH_RUNTIME } from '../research/research.tokens.js';
import { runtimeSettingsVariables } from '../research/runtime-settings.js';
import { ThreadsModule } from '../threads/threads.module.js';
import {
  ANSWER_APPENDER_SETTINGS,
  type AnswerAppenderSettings,
  ResearchAnswerAppender,
} from './research-answer.appender.js';
import { researchAnswerConsumer } from './research-answer.consumer.js';
import { parseResearchChatSettings } from './research-chat.settings.js';
import { ResearchChatController } from './research-chat.controller.js';
import { ResearchLaunchService } from './research-launch.service.js';

/**
 * Deep research started from a chat thread (design-chat-entry.md, C3 api). `MastraModule` does not import it: the chat
 * agent's `deepResearch` tool resolves `ResearchLaunchService` when it runs, which keeps the modules acyclic.
 *
 * Phases (KD-4): `onModuleInit` registers the answer consumer before `Runtime.start`; the delivery loop starts in
 * `onApplicationBootstrap` and stops in `beforeApplicationShutdown`. Nest runs bootstrap hooks of an imported module
 * first and shutdown hooks of an importing module first, so the loop starts after `ResearchModule` started the runtime
 * and stops before it stops the runtime.
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
    private readonly appender: ResearchAnswerAppender,
  ) {}

  onModuleInit(): void {
    this.runtime.eventConsumers.register(researchAnswerConsumer);
  }

  onApplicationBootstrap(): void {
    this.appender.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.appender.stop();
  }
}
