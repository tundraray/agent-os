import type { Provider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Mastra } from '@mastra/core/mastra';
import { PostgresStore } from '@mastra/pg';
import { createAssistantAgent } from './agents/assistant.agent.js';
import { MASTRA } from './mastra.constants.js';
import { parseModelId, type ReasoningEffort } from './models.js';

export const mastraProvider: Provider = {
  provide: MASTRA,
  inject: [ConfigService],
  useFactory: (config: ConfigService) =>
    new Mastra({
      agents: {
        assistant: createAssistantAgent(
          parseModelId(config.get<string>('ASSISTANT_MODEL')),
          config.get<ReasoningEffort>('REASONING_EFFORT', 'medium'),
        ),
      },
      storage: new PostgresStore({
        id: 'agent-os',
        connectionString: config.getOrThrow<string>('DATABASE_URL'),
      }),
    }),
};
