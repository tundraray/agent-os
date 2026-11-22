import { rmSync } from 'node:fs';
import { inspect } from 'node:util';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  AGENT_TURN_CLIENT,
  AgentsEmbeddings,
  AgentsMcp,
  AgentsProviders,
  EMBEDDING_CLIENT,
  ViewOperations,
} from '@agent-os/agents';
import {
  createScriptedEmbeddings,
  createScriptedModel,
  type ScriptedEmbeddings,
  type ScriptedModel,
  registerFixtureServers,
} from '@agent-os/agents/testing';
import { DATABASE_CONNECTION, type DatabaseConnection } from '@agent-os/db';
import {
  createFixtureFiles,
  type FixtureFaultRule,
  type FixtureFiles,
  type FixtureProcess,
  type FixtureSource,
  startFixtureProcess,
} from '@agent-os/mcp-fixture';
import type { App } from 'supertest/types.js';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { AGENT_LIST_PAGE_SIZE } from '../../src/chat/chat.tokens';
import { GOOGLE_ISSUER_URL } from '../../src/identity/identity.tokens';
import { runName } from './mcp-servers';

export interface TestAppOptions {
  /** The scripted model double behind `AGENT_TURN_CLIENT`; default — one with no scripts. */
  model?: ScriptedModel;
  /** The scripted embeddings double behind `EMBEDDING_CLIENT`; default — a fresh one, so no request leaves the process. */
  embeddings?: ScriptedEmbeddings;
  /** Runs the runtime workers (`RUNTIME_WORKERS=on`); default — as `vitest.config.e2e.ts` sets it (off). */
  workers?: boolean;
  /** Replaces `AGENT_LIST_PAGE_SIZE` (the page of `GET /agents`), so a cursor walk shows over a few agents. */
  agentPageSize?: number;
  /**
   * Starts a fixture process writing into `fixtureLog` and registers the run's server of each source at
   * its shared-token path once the app is up; without it no fixture process runs.
   */
  mcpServers?: readonly FixtureSource[];
  /**
   * Fault rules of the fixture process (`holdCall`), written before the boot; the process reads them on
   * every call. Latches come from the given files (`files.latch(name)`; the same name later gives the
   * same latch through `fixtureLog.latch(name)`).
   */
  faults?: (files: FixtureFiles) => readonly FixtureFaultRule[];
  /** Issuers of the provider types fixed in code: `google` points at this issuer (the test issuer). */
  providerEndpoints?: { google: string };
  /** Keeps every console line the process writes while the app lives in `TestApp.log` (the secrets scan). */
  captureLog?: boolean;
}

/** The services of the agents package the tests reach directly. */
export interface TestAgents {
  readonly mcp: AgentsMcp;
  readonly providers: AgentsProviders;
  readonly embeddings: AgentsEmbeddings;
  readonly sessions: ViewOperations;
}

export interface TestApp {
  /** Initialised app with `configureApp` applied: requests go to `/api/...`. */
  app: INestApplication<App>;
  model: ScriptedModel;
  embeddings: ScriptedEmbeddings;
  /** The fixture files of this app: the call log of its fixture process, fault rules, latches. */
  fixtureLog: FixtureFiles;
  /** The fixture process started for `mcpServers`; reading it without that option throws. */
  readonly fixture: FixtureProcess;
  /** The app's agents services, for reads the API does not offer. */
  agents: TestAgents;
  /** The app's pool (`DATABASE_CONNECTION`): rows the plan's tests name and `pg_terminate_backend`. */
  pool: DatabaseConnection['pool'];
  /** With `captureLog`: the console lines (logger records are JSON lines) from the boot until `close`; else empty. */
  log: readonly string[];
  /** Closes the app, stops the fixture process and removes the fixture files. */
  close(): Promise<void>;
}

/**
 * Boots the real `AppModule` against the docker-compose Postgres (`pnpm db:up`) with only
 * `AGENT_TURN_CLIENT` and `EMBEDDING_CLIENT` replaced by the scripted doubles of `@agent-os/agents/testing` —
 * no network, no provider keys. The providers, the catalogue and the default models are the database's: a suite
 * sets its own through `access.ts` `useRunModels`. With `mcpServers` the MCP servers are one fixture process writing
 * into this app's call log, registered in the registry under the run's names after the boot. `RUNTIME_WORKERS` is
 * set for the boot only and restored once the app is initialised. The app listens on a port of `127.0.0.1`, and the
 * helpers reach it as `http://localhost:<port>` (session.ts `apiOrigin`).
 */
export async function createTestApp(
  options: TestAppOptions = {},
): Promise<TestApp> {
  const model = options.model ?? createScriptedModel();
  const embeddings = options.embeddings ?? createScriptedEmbeddings();
  const fixtureLog = createFixtureFiles('api-e2e');
  if (options.faults) fixtureLog.setFaults(options.faults(fixtureLog));
  const fixtureProcess =
    options.mcpServers === undefined
      ? undefined
      : await startFixtureProcess(fixtureLog);

  const restoreEnv = setEnv(options.workers ? { RUNTIME_WORKERS: 'on' } : {});
  const log = options.captureLog ? captureConsole() : undefined;
  let app: INestApplication<App>;
  try {
    let builder = Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(AGENT_TURN_CLIENT)
      .useValue(model.turnClient)
      .overrideProvider(EMBEDDING_CLIENT)
      .useValue(embeddings.client);
    if (options.agentPageSize !== undefined) {
      builder = builder
        .overrideProvider(AGENT_LIST_PAGE_SIZE)
        .useValue(options.agentPageSize);
    }
    if (options.providerEndpoints !== undefined) {
      builder = builder
        .overrideProvider(GOOGLE_ISSUER_URL)
        .useValue(options.providerEndpoints.google);
    }
    const moduleRef = await builder.compile();
    app = moduleRef.createNestApplication<INestApplication<App>>();
    configureApp(app);
    await app.init();
    await app.listen(0, '127.0.0.1');
  } catch (error) {
    log?.restore();
    await fixtureProcess?.stop();
    throw error;
  } finally {
    restoreEnv();
  }

  const agents: TestAgents = {
    mcp: app.get(AgentsMcp),
    providers: app.get(AgentsProviders),
    embeddings: app.get(AgentsEmbeddings),
    sessions: app.get(ViewOperations),
  };
  const close = async () => {
    try {
      await app.close();
    } finally {
      log?.restore();
      await fixtureProcess?.stop();
      rmSync(fixtureLog.dir, { recursive: true, force: true });
    }
  };
  if (fixtureProcess !== undefined && options.mcpServers !== undefined) {
    try {
      await registerFixtureServers(
        agents,
        fixtureProcess,
        options.mcpServers,
        runName,
      );
    } catch (error) {
      await close();
      throw error;
    }
  }

  return {
    app,
    model,
    embeddings,
    fixtureLog,
    get fixture(): FixtureProcess {
      if (fixtureProcess === undefined) {
        throw new Error(
          'createTestApp started no fixture process: pass mcpServers',
        );
      }
      return fixtureProcess;
    },
    agents,
    pool: app.get<DatabaseConnection>(DATABASE_CONNECTION).pool,
    log: log?.lines ?? [],
    close,
  };
}

const CONSOLE_METHODS = ['debug', 'info', 'log', 'warn', 'error'] as const;

/**
 * Records every line written through `console` (the logger's console sink, Nest's own output) and still
 * prints it; `restore` puts the original methods back.
 */
function captureConsole(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const originals = CONSOLE_METHODS.map(
    (method) => [method, console[method]] as const,
  );
  for (const [method, original] of originals) {
    console[method] = (...args: unknown[]) => {
      lines.push(
        args
          .map((arg) => (typeof arg === 'string' ? arg : inspect(arg)))
          .join(' '),
      );
      original.apply(console, args);
    };
  }
  return {
    lines,
    restore: () => {
      for (const [method, original] of originals) console[method] = original;
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
