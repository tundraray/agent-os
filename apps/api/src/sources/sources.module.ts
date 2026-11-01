import {
  Inject,
  Logger,
  Module,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Clock, HandlerRegistry } from '@agent-os/runtime';
import {
  createSourceRegistry,
  createSources,
  FixtureSourceAdapter,
  parseSourcesSettings,
  type SourceAdapter,
  type SourceRegistry,
  type Sources,
  type SourcesLogger,
  type SourcesSettings,
  type SourceToolRequest,
} from '@agent-os/sources';
import { ResearchModule } from '../research/research.module.js';
import {
  HANDLER_REGISTRY,
  RUNTIME_CLOCK,
} from '../research/research.tokens.js';
import {
  SOURCES_ALLOWLIST,
  sourcesSettingsVariables,
} from './sources.config.js';

/** The `SourceRegistry` of the connected sources; empty when none is connected. */
export const SOURCE_REGISTRY = Symbol('SOURCE_REGISTRY');
/** Adapters of the connected sources, built at compile time; no source is started by building them. */
export const SOURCE_ADAPTERS = Symbol('SOURCE_ADAPTERS');
/** Sources Settings parsed from the environment; internal to this module. */
const SOURCES_SETTINGS = Symbol('SOURCES_SETTINGS');

const FIXTURE_PACKAGE = '@agent-os/mcp-fixture';
/** The quoted target of Node's "Cannot find module|package '<target>' imported from …". */
const MISSING_TARGET = /^Cannot find (?:module|package) '([^']+)'/;
/** The fixture package's entry: missing when the package is linked but not built. */
const FIXTURE_ENTRY = /[\\/]mcp-fixture[\\/]dist[\\/]index\.js$/;

/**
 * `SourcesLogger` over the Nest `Logger` (design-mcp-source.md, Logging and Monitoring): the level is kept,
 * and the fields follow the message as `key=value`. The package never puts arguments or records there.
 */
class NestSourcesLogger implements SourcesLogger {
  private readonly logger = new Logger('Sources');

  debug(message: string, fields: Readonly<Record<string, unknown>>): void {
    this.logger.debug(withFields(message, fields));
  }

  warn(message: string, fields: Readonly<Record<string, unknown>>): void {
    this.logger.warn(withFields(message, fields));
  }

  error(message: string, fields: Readonly<Record<string, unknown>>): void {
    this.logger.error(withFields(message, fields));
  }
}

function withFields(
  message: string,
  fields: Readonly<Record<string, unknown>>,
): string {
  const pairs = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`);
  return pairs.length === 0 ? message : `${message} ${pairs.join(' ')}`;
}

/**
 * The registry other modules inject. It is provided before `createSources` runs in `onModuleInit`, so it
 * starts as the empty registry (whose `currentSnapshot` answers "no adapter") and is bound once the sources
 * are connected.
 */
class BoundSourceRegistry implements SourceRegistry {
  private current: SourceRegistry = createSourceRegistry({
    adapters: [],
    allowlist: {},
  });

  bind(registry: SourceRegistry): void {
    this.current = registry;
  }

  resolveTool(request: SourceToolRequest) {
    return this.current.resolveTool(request);
  }

  currentSnapshot(sourceId: string, signal: AbortSignal): Promise<string> {
    return this.current.currentSnapshot(sourceId, signal);
  }
}

/**
 * Entry of the fixture process, or null when `@agent-os/mcp-fixture` (a devDependency, ADR-0004) is not
 * installed. Only the failure to resolve that package counts as "not installed"; any other import error
 * propagates and stops the start.
 */
async function resolveFixtureServerPath(): Promise<string | null> {
  try {
    const { fixtureServerPath } = await import('@agent-os/mcp-fixture');
    return fixtureServerPath;
  } catch (error) {
    if (isFixtureNotInstalled(error)) return null;
    throw error;
  }
}

function isFixtureNotInstalled(error: unknown): boolean {
  if (
    !(error instanceof Error) ||
    (error as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND'
  ) {
    return false;
  }
  const target = MISSING_TARGET.exec(error.message)?.[1];
  return (
    target !== undefined &&
    (target === FIXTURE_PACKAGE || FIXTURE_ENTRY.test(target))
  );
}

async function fixtureAdapters(
  settings: SourcesSettings,
): Promise<SourceAdapter[]> {
  const logger = new NestSourcesLogger();
  const serverPath = await resolveFixtureServerPath();
  if (serverPath === null) {
    logger.warn(
      `${FIXTURE_PACKAGE} is not installed: no sources are connected`,
      { package: FIXTURE_PACKAGE },
    );
    return [];
  }
  return [new FixtureSourceAdapter({ serverPath, settings, logger })];
}

/**
 * Assembly point of the sources package in `apps/api` (ADR-0004, design-mcp-source.md): reads the environment,
 * resolves the fixture process entry and binds `createSources` to the Nest phases around the runtime's.
 *
 * Phases: `onModuleInit` — `createSources` registers `source.fetch` (a refused allowlist stops the start here),
 * before `ResearchModule` starts the workers in `onApplicationBootstrap`; `onApplicationShutdown` — the adapters
 * close, after `ResearchModule` stopped the workers in `beforeApplicationShutdown` (UC-9). Without the fixture
 * `createSources` is not called: `source.fetch` stays unregistered and the registry stays empty.
 */
@Module({
  imports: [ResearchModule],
  providers: [
    {
      provide: SOURCES_SETTINGS,
      useFactory: (config: ConfigService): SourcesSettings =>
        parseSourcesSettings(
          sourcesSettingsVariables((name) => config.get<string>(name)),
        ),
      inject: [ConfigService],
    },
    {
      provide: SOURCE_ADAPTERS,
      useFactory: fixtureAdapters,
      inject: [SOURCES_SETTINGS],
    },
    {
      provide: SOURCE_REGISTRY,
      useFactory: () => new BoundSourceRegistry(),
    },
  ],
  exports: [SOURCE_REGISTRY, SOURCE_ADAPTERS],
})
export class SourcesModule implements OnModuleInit, OnApplicationShutdown {
  private sources: Sources | null = null;

  constructor(
    @Inject(HANDLER_REGISTRY) private readonly handlers: HandlerRegistry,
    @Inject(RUNTIME_CLOCK) private readonly clock: Clock,
    @Inject(SOURCES_SETTINGS) private readonly settings: SourcesSettings,
    @Inject(SOURCE_ADAPTERS) private readonly adapters: SourceAdapter[],
    @Inject(SOURCE_REGISTRY) private readonly registry: BoundSourceRegistry,
  ) {}

  onModuleInit(): void {
    if (this.adapters.length === 0) return;
    this.sources = createSources({
      handlers: this.handlers,
      adapters: this.adapters,
      allowlist: SOURCES_ALLOWLIST,
      settings: this.settings,
      clock: this.clock,
      logger: new NestSourcesLogger(),
    });
    this.registry.bind(this.sources.registry);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.sources?.close();
  }
}
