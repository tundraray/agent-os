import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Agents } from '@agent-os/agents';
import {
  createScriptedModel,
  type ScriptedModel,
} from '@agent-os/agents/testing';
import type { DatabaseConnection } from '@agent-os/db';
import {
  createFixtureFiles,
  type FixtureFaultRule,
  type FixtureFiles,
  fixtureServersFile,
} from '@agent-os/mcp-fixture';
import type { Runtime } from '@agent-os/runtime';
import type { App } from 'supertest/types.js';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { AGENTS, AGENT_TURN_CLIENT } from '../../src/agents/agents.tokens.js';
import { AGENT_LIST_PAGE_SIZE } from '../../src/chat/chat.tokens.js';
import { RUNTIME, RUNTIME_DATABASE } from '../../src/runtime/runtime.tokens.js';

export interface TestAppOptions {
  /** The scripted model double behind `AGENT_TURN_CLIENT`; default — one with no scripts. */
  model?: ScriptedModel;
  /** `MCP_ACCESS_TABLE`: employee id → MCP server ids; default — nobody has servers. */
  mcpAccess?: Readonly<Record<string, readonly string[]>>;
  /** Runs the runtime workers (`RUNTIME_WORKERS=on`); default — as `vitest.config.e2e.ts` sets it (off). */
  workers?: boolean;
  /** Replaces `AGENT_LIST_PAGE_SIZE` (the page of `GET /agents`), so a cursor walk shows over a few agents. */
  agentPageSize?: number;
  /**
   * Fault rules of the fixture processes (`holdCall`, `crashOn`), written before the boot: the processes
   * start with the app and read their rules once. Latches come from the given files (`files.latch(name)`;
   * the same name later gives the same latch through `fixtureLog.latch(name)`).
   */
  faults?: (files: FixtureFiles) => readonly FixtureFaultRule[];
}

export interface TestApp {
  /** Initialised app with `configureApp` applied: requests go to `/api/...`. */
  app: INestApplication<App>;
  model: ScriptedModel;
  /** The fixture files of this app: the call log of the `logs` and `backoffice` servers, fault rules, latches. */
  fixtureLog: FixtureFiles;
  /** The app's agents package (`AGENTS`), for reads the API does not offer. */
  agents: Agents;
  /** The app's runtime (`RUNTIME`). */
  runtime: Runtime;
  /** The app's pool (`RUNTIME_DATABASE`): rows the plan's tests name and `pg_terminate_backend`. */
  pool: DatabaseConnection['pool'];
  /** Closes the app and removes the fixture files. */
  close(): Promise<void>;
}

/**
 * Boots the real `AppModule` against the docker-compose Postgres (`pnpm db:up`) with only
 * `AGENT_TURN_CLIENT` replaced by the scripted double of `@agent-os/agents/testing` — no network,
 * no provider keys. The MCP servers are the fixture processes (`logs`, `backoffice`) writing into
 * this app's call log. `MCP_SERVERS_FILE`, `MCP_ACCESS_TABLE` and `RUNTIME_WORKERS` are set for the
 * boot only and restored once the app is initialised.
 */
export async function createTestApp(
  options: TestAppOptions = {},
): Promise<TestApp> {
  const model = options.model ?? createScriptedModel();
  const fixtureLog = createFixtureFiles('api-e2e');
  const serversFile = join(fixtureLog.dir, 'mcp-servers.json');
  writeFileSync(
    serversFile,
    JSON.stringify(
      fixtureServersFile(fixtureLog, [
        { id: 'logs', source: 'logs' },
        { id: 'backoffice', source: 'backoffice' },
      ]),
    ),
    'utf8',
  );
  if (options.faults) fixtureLog.setFaults(options.faults(fixtureLog));

  const restoreEnv = setEnv({
    MCP_SERVERS_FILE: serversFile,
    MCP_ACCESS_TABLE: JSON.stringify(options.mcpAccess ?? {}),
    ...(options.workers ? { RUNTIME_WORKERS: 'on' } : {}),
  });
  let app: INestApplication<App>;
  try {
    let builder = Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AGENT_TURN_CLIENT)
      .useValue(model.turnClient);
    if (options.agentPageSize !== undefined) {
      builder = builder
        .overrideProvider(AGENT_LIST_PAGE_SIZE)
        .useValue(options.agentPageSize);
    }
    const moduleRef = await builder.compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    configureApp(app);
    await app.init();
  } finally {
    restoreEnv();
  }

  return {
    app,
    model,
    fixtureLog,
    agents: app.get<Agents>(AGENTS),
    runtime: app.get<Runtime>(RUNTIME),
    pool: app.get<DatabaseConnection>(RUNTIME_DATABASE).pool,
    close: async () => {
      await app.close();
      rmSync(fixtureLog.dir, { recursive: true, force: true });
    },
  };
}

/** Sets the variables and returns the function that puts back their previous values. */
function setEnv(values: Readonly<Record<string, string>>): () => void {
  const previous = Object.entries(values).map(
    ([name]) => [name, process.env[name]] as const,
  );
  Object.assign(process.env, values);
  return () => {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}
