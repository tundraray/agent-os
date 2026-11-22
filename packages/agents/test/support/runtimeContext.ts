import {
  ACCESS_AUDIT,
  ACCESS_GATE,
  type AccessAudit,
  type AccessGate,
  type AgentsConfig,
  AgentsModule,
  ON_TEXT_DELTA,
  type OnTextDelta,
  RECORD_LIBRARY,
  type RecordLibrary,
} from '@agent-os/agents';
import { LOGGER, type Logger } from '@agent-os/common';
import { DbModule } from '@agent-os/db';
import { type RuntimeConfig, RuntimeModule } from '@agent-os/runtime';
import { type DynamicModule, Module, type Provider } from '@nestjs/common';

@Module({})
class LoggerModule {}

/**
 * The modules a test process builds its runtime from, as `apps/api` does: `LOGGER` for every module,
 * `DbModule` over its own pool and `RuntimeModule`.
 */
export function runtimeModules(
  logger: Logger,
  connectionString: string,
  config: RuntimeConfig,
): DynamicModule[] {
  return [
    {
      module: LoggerModule,
      global: true,
      providers: [{ provide: LOGGER, useValue: logger }],
      exports: [LOGGER],
    },
    DbModule.forRootAsync({
      useFactory: () => ({ connectionString, poolMax: config.dbPoolMax }),
    }),
    RuntimeModule.forRootAsync({ useFactory: () => config }),
  ];
}

/** The doubles of the ports `apps/api` implements for the agents. */
export interface AgentsPorts {
  readonly access: AccessGate;
  readonly audit: AccessAudit;
  readonly library: RecordLibrary;
  /** Gets every text part of an agent's answer; none by default. */
  readonly onTextDelta?: OnTextDelta;
}

@Module({})
class PortsModule {}

/**
 * `AgentsModule` of a test process, over the modules of {@link runtimeModules}: the given settings and the
 * given doubles behind the port tokens. The seams with a default of the package (`AGENT_TURN_CLIENT`,
 * `EMBEDDING_CLIENT`, `CODE_RUNNER`) are replaced by the caller with `overrideProvider`.
 */
export function agentsModule(config: AgentsConfig, ports: AgentsPorts): DynamicModule {
  const providers: Provider[] = [
    { provide: ACCESS_GATE, useValue: ports.access },
    { provide: ACCESS_AUDIT, useValue: ports.audit },
    { provide: RECORD_LIBRARY, useValue: ports.library },
    ...(ports.onTextDelta === undefined ? [] : [{ provide: ON_TEXT_DELTA, useValue: ports.onTextDelta }]),
  ];
  return AgentsModule.forRootAsync({
    imports: [{ module: PortsModule, providers, exports: providers }],
    useFactory: () => config,
  });
}
