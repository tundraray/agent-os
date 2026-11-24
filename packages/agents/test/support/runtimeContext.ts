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
import { type DynamicModule, Module, type Provider } from '@nestjs/common';

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
 * `AgentsModule` of a test process, over the modules of `runtimeModules` (`@agent-os/runtime/testing`): the given settings and the
 * given doubles behind the port tokens. The seams with a default of the package (`AGENT_TURN_CLIENT`,
 * `EMBEDDING_CLIENT`, `CODE_RUNNER`) are replaced by the caller with `overrideProvider`.
 */
export function agentsModule(
  config: AgentsConfig,
  ports: AgentsPorts,
): DynamicModule {
  const providers: Provider[] = [
    { provide: ACCESS_GATE, useValue: ports.access },
    { provide: ACCESS_AUDIT, useValue: ports.audit },
    { provide: RECORD_LIBRARY, useValue: ports.library },
    ...(ports.onTextDelta === undefined
      ? []
      : [{ provide: ON_TEXT_DELTA, useValue: ports.onTextDelta }]),
  ];
  return AgentsModule.forRootAsync({
    imports: [{ module: PortsModule, providers, exports: providers }],
    useFactory: () => config,
  });
}
