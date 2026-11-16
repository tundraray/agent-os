import { rmSync } from 'node:fs';
import { inspect } from 'node:util';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Agents } from '@agent-os/agents';
import {
  createScriptedModel,
  type ScriptedModel,
} from '@agent-os/agents/testing';
import type { Logger } from '@agent-os/common';
import type { DatabaseConnection } from '@agent-os/db';
import {
  createFixtureFiles,
  type FixtureFaultRule,
  type FixtureFiles,
  type FixtureProcess,
  type FixtureSource,
  startFixtureProcess,
} from '@agent-os/mcp-fixture';
import type { Runtime } from '@agent-os/runtime';
import { createWorkflows, type Workflows } from '@agent-os/workflows';
import type { App } from 'supertest/types.js';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { AGENTS, AGENT_TURN_CLIENT } from '../../src/agents/agents.tokens.js';
import { AGENT_LIST_PAGE_SIZE } from '../../src/chat/chat.tokens.js';
import { GOOGLE_ISSUER_URL } from '../../src/identity/identity.tokens.js';
import { APP_LOGGER } from '../../src/logging/app-logger.js';
import { RUNTIME, RUNTIME_DATABASE } from '../../src/runtime/runtime.tokens.js';
import { WORKFLOWS } from '../../src/workflows/workflows.tokens.js';
import { registerFixtureServers } from './mcp-servers.js';

export interface TestAppOptions {
  /** The scripted model double behind `AGENT_TURN_CLIENT`; default — one with no scripts. */
  model?: ScriptedModel;
  /**
   * `AGENT_DEFAULT_MODEL` for the boot: a model of the run (`access.ts` `runModel`) that the suite adds to the
   * catalogue and allows its employees itself; default — the variable as the environment has it.
   */
  defaultModel?: string;
  /**
   * Raw workflow templates in place of the shipped ones (`createWorkflows({ templates })`); default — the shipped
   * templates.
   */
  workflowTemplates?: readonly unknown[];
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

export interface TestApp {
  /** Initialised app with `configureApp` applied: requests go to `/api/...`. */
  app: INestApplication<App>;
  model: ScriptedModel;
  /** The fixture files of this app: the call log of its fixture process, fault rules, latches. */
  fixtureLog: FixtureFiles;
  /** The fixture process started for `mcpServers`; reading it without that option throws. */
  readonly fixture: FixtureProcess;
  /** The app's agents package (`AGENTS`), for reads the API does not offer. */
  agents: Agents;
  /** The app's runtime (`RUNTIME`). */
  runtime: Runtime;
  /** The app's pool (`RUNTIME_DATABASE`): rows the plan's tests name and `pg_terminate_backend`. */
  pool: DatabaseConnection['pool'];
  /** With `captureLog`: the console lines (logger records are JSON lines) from the boot until `close`; else empty. */
  log: readonly string[];
  /** Closes the app, stops the fixture process and removes the fixture files. */
  close(): Promise<void>;
}

/**
 * Boots the real `AppModule` against the docker-compose Postgres (`pnpm db:up`) with only
 * `AGENT_TURN_CLIENT` replaced by the scripted double of `@agent-os/agents/testing` — no network,
 * no provider keys. With `mcpServers` the MCP servers are one fixture process writing into this app's
 * call log, registered in the registry under the run's names after the boot. `AGENT_DEFAULT_MODEL` and
 * `RUNTIME_WORKERS` are set for the boot only and restored once the app is initialised. The app listens on a port of `127.0.0.1`, and the
 * helpers reach it as `http://localhost:<port>` (session.ts `apiOrigin`).
 */
export async function createTestApp(
  options: TestAppOptions = {},
): Promise<TestApp> {
  const model = options.model ?? createScriptedModel();
  const fixtureLog = createFixtureFiles('api-e2e');
  if (options.faults) fixtureLog.setFaults(options.faults(fixtureLog));
  const fixtureProcess =
    options.mcpServers === undefined
      ? undefined
      : await startFixtureProcess(fixtureLog);

  const restoreEnv = setEnv({
    ...(options.defaultModel === undefined
      ? {}
      : { AGENT_DEFAULT_MODEL: options.defaultModel }),
    ...(options.workers ? { RUNTIME_WORKERS: 'on' } : {}),
  });
  const log = options.captureLog ? captureConsole() : undefined;
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
    const templates = options.workflowTemplates;
    if (templates !== undefined) {
      builder = builder.overrideProvider(WORKFLOWS).useFactory({
        factory: (agents: Agents, logger: Logger): Workflows =>
          createWorkflows({ agents, logger, templates }),
        inject: [AGENTS, APP_LOGGER],
      });
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

  const agents = app.get<Agents>(AGENTS);
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
      await registerFixtureServers(agents, fixtureProcess, options.mcpServers);
    } catch (error) {
      await close();
      throw error;
    }
  }

  return {
    app,
    model,
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
    runtime: app.get<Runtime>(RUNTIME),
    pool: app.get<DatabaseConnection>(RUNTIME_DATABASE).pool,
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
