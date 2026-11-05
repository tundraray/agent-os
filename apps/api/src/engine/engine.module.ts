import { Inject, Logger, Module, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { DatabaseConnection } from '@agent-os/db';
import {
  AnthropicTokenCounter,
  createEngine,
  deepResearchProcessV1,
  type Engine,
  type EngineLogFields,
  type EngineLogger,
  type ResolveModel,
  type TokenCounter,
} from '@agent-os/engine';
import type { Clock, Runtime } from '@agent-os/runtime';
import type { SourceAdapter, SourceRegistry } from '@agent-os/sources';
import { withFields } from '../common/log-fields.js';
import { ResearchModule } from '../research/research.module.js';
import {
  RESEARCH_DATABASE,
  RESEARCH_RUNTIME,
  RUNTIME_CLOCK,
} from '../research/research.tokens.js';
import {
  SOURCE_ADAPTERS,
  SOURCE_REGISTRY,
  SourcesModule,
} from '../sources/sources.module.js';
import { type EngineSettings, parseEngineSettings } from './engine-settings.js';
import {
  ENGINE_RESOLVE_MODEL,
  ENGINE_TOKEN_COUNTER,
  RESEARCH_ENGINE,
} from './engine.tokens.js';
import { createResolveModel } from './resolve-model.js';

/** Workflow types `createEngine` registers, for the start log line. */
const ENGINE_HANDLERS =
  'research.controller, research.analyze, research.verify, research.synthesize';

/** Engine settings parsed from the environment; internal to this module. */
const ENGINE_SETTINGS = Symbol('ENGINE_SETTINGS');

/**
 * `EngineLogger` over the Nest `Logger`: the level is kept, and the fields follow the message as `key=value`. The
 * engine puts only identifiers, roles, models, tokens and outcome classes there (Security Considerations).
 */
class NestEngineLogger implements EngineLogger {
  private readonly logger = new Logger('ResearchEngine');

  log(message: string, fields?: EngineLogFields): void {
    this.logger.log(withFields(message, fields));
  }

  warn(message: string, fields?: EngineLogFields): void {
    this.logger.warn(withFields(message, fields));
  }

  error(message: string, fields?: EngineLogFields): void {
    this.logger.error(withFields(message, fields));
  }
}

/**
 * The `Engine` other modules inject. A provider factory would run before `SourcesModule` binds the source registry
 * in its `onModuleInit`, so the engine is created in this module's `onModuleInit` and bound here; until then every
 * member throws instead of answering for an engine that does not exist yet.
 */
class BoundEngine implements Engine {
  private current: Engine | null = null;

  bind(engine: Engine): void {
    this.current = engine;
  }

  get sourceMode(): Engine['sourceMode'] {
    return this.engine().sourceMode;
  }

  startInvestigation(
    input: Parameters<Engine['startInvestigation']>[0],
  ): ReturnType<Engine['startInvestigation']> {
    return this.engine().startInvestigation(input);
  }

  recordSignal(
    input: Parameters<Engine['recordSignal']>[0],
  ): ReturnType<Engine['recordSignal']> {
    return this.engine().recordSignal(input);
  }

  readInvestigation(
    input: Parameters<Engine['readInvestigation']>[0],
  ): ReturnType<Engine['readInvestigation']> {
    return this.engine().readInvestigation(input);
  }

  private engine(): Engine {
    if (this.current === null) {
      throw new Error(
        'the research engine is not created yet: EngineModule creates it in onModuleInit',
      );
    }
    return this.current;
  }
}

/**
 * Assembly point of `@agent-os/engine` in `apps/api` (design-engine.md, C2; ADR-0004): reads the engine settings and
 * calls `createEngine` with the shipped `deep-research` configuration, the runtime's ports, the source registry and
 * the connected sources, the clock, `resolveModel` and `AnthropicTokenCounter` on one base.
 *
 * Phase: `onModuleInit`, after `SourcesModule` (imported here, so Nest initialises it first) registered `source.fetch`
 * and bound the registry, and before `ResearchModule` starts the workers in `onApplicationBootstrap` — the four engine
 * handlers are registered before the first claim. A refused configuration stops the start here (DC-14).
 *
 * `connectedSources` are the `sourceId` of the adapters `SourcesModule` built — neither the allowlist nor the
 * registry: without `@agent-os/mcp-fixture` the list is empty, the engine runs on model knowledge and writes one
 * warning (KD-8, DC-18). The engine's role agents are not registered in the application's `MASTRA` (ADR-0001).
 */
@Module({
  imports: [ResearchModule, SourcesModule],
  providers: [
    {
      provide: ENGINE_SETTINGS,
      useFactory: (config: ConfigService): EngineSettings =>
        parseEngineSettings((name) => config.get<string>(name)),
      inject: [ConfigService],
    },
    {
      provide: ENGINE_RESOLVE_MODEL,
      useFactory: (settings: EngineSettings): ResolveModel =>
        createResolveModel(settings),
      inject: [ENGINE_SETTINGS],
    },
    {
      provide: ENGINE_TOKEN_COUNTER,
      useFactory: (settings: EngineSettings): TokenCounter =>
        new AnthropicTokenCounter({
          apiKey: settings.anthropicApiKey,
          baseUrl: settings.anthropicBaseUrl,
        }),
      inject: [ENGINE_SETTINGS],
    },
    { provide: RESEARCH_ENGINE, useFactory: () => new BoundEngine() },
  ],
  exports: [RESEARCH_ENGINE],
})
export class EngineModule implements OnModuleInit {
  constructor(
    @Inject(RESEARCH_DATABASE) private readonly database: DatabaseConnection,
    @Inject(RESEARCH_RUNTIME) private readonly runtime: Runtime,
    @Inject(RUNTIME_CLOCK) private readonly clock: Clock,
    @Inject(SOURCE_REGISTRY) private readonly sourceRegistry: SourceRegistry,
    @Inject(SOURCE_ADAPTERS) private readonly adapters: SourceAdapter[],
    @Inject(ENGINE_RESOLVE_MODEL) private readonly resolveModel: ResolveModel,
    @Inject(ENGINE_TOKEN_COUNTER) private readonly tokenCounter: TokenCounter,
    @Inject(RESEARCH_ENGINE) private readonly engine: BoundEngine,
  ) {}

  onModuleInit(): void {
    const { handlers, scheduler, investigations, evidence } = this.runtime;
    const logger = new NestEngineLogger();
    const engine = createEngine({
      database: this.database.db,
      runtime: { handlers, scheduler, investigations, evidence },
      sourceRegistry: this.sourceRegistry,
      connectedSources: this.adapters.map(
        (adapter) => adapter.descriptor.sourceId,
      ),
      processes: [deepResearchProcessV1],
      resolveModel: this.resolveModel,
      tokenCounter: this.tokenCounter,
      clock: this.clock,
      logger,
    });
    this.engine.bind(engine);
    logger.log(
      `Research engine handlers registered (${ENGINE_HANDLERS}), sourceMode ${engine.sourceMode}`,
    );
  }
}
