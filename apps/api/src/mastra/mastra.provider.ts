import type { Provider } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Mastra } from '@mastra/core/mastra';
import { PostgresStore } from '@mastra/pg';
import { createDeepResearchTool } from '../research-chat/deep-research.tool.js';
import { DEEP_RESEARCH_TOOL } from '../research-chat/research-turn.js';
import { ResearchLaunchService } from '../research-chat/research-launch.service.js';
import { createAssistantAgent } from './agents/assistant.agent.js';
import { MASTRA } from './mastra.constants.js';
import { parseModelId, type ReasoningEffort } from './models.js';

export const mastraProvider: Provider = {
  provide: MASTRA,
  inject: [ConfigService, ModuleRef],
  useFactory: (config: ConfigService, moduleRef: ModuleRef) =>
    new Mastra({
      agents: {
        assistant: createAssistantAgent(
          parseModelId(config.get<string>('ASSISTANT_MODEL')),
          config.get<ReasoningEffort>('REASONING_EFFORT', 'medium'),
          {
            // Resolved when the tool runs: the service's own dependencies reach back to MASTRA, so neither module
            // imports the other (design-chat-entry.md, C3 api).
            [DEEP_RESEARCH_TOOL]: createDeepResearchTool(() =>
              moduleRef.get(ResearchLaunchService, { strict: false }),
            ),
          },
        ),
      },
      storage: new PostgresStore({
        id: 'agent-os',
        connectionString: config.getOrThrow<string>('DATABASE_URL'),
      }),
      // ADR-0001: the research runtime owns recovery; Mastra must never
      // resume workflow or durable-agent runs on boot.
      recovery: { workflows: 'off', durableAgents: 'off' },
    }),
};
