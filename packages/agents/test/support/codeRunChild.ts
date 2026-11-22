import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LogRecord } from '@agent-os/common';
import type { RunCodeArgs } from '@agent-os/contracts';
import { TestChild } from '@agent-os/runtime/testing';

/**
 * Child-process harness of code-execution E2E-1: a child (`codeRunChildMain.ts`, plain Node running it and
 * the packages from source through the `tsx` loader) plays the API process with the real code executor. The test never talks to the
 * agents inside a child: it starts one, kills it from outside while a call of the script is held on
 * the MCP fixture, starts a fresh one over the same database and fixture files, and reads the rows and
 * the child's log. One scenario serves every row: one agent record, a read run and a write run, over the
 * run's servers that the test registered at its own fixture process before the first child starts (a
 * child registers nothing: the registry rows are in the database). The module is loaded by the
 * child, so it takes the run's server names as values and imports no vitest helper.
 */

const PACKAGE_ROOT = fileURLToPath(new URL('../..', import.meta.url));
const CHILD_ENTRY = join(PACKAGE_ROOT, 'test/support/codeRunChildMain.ts');

/** The variable that hands the child its {@link ChildScenario}. */
export const CHILD_SCENARIO_ENV = 'CODE_RUN_CHILD_SCENARIO';

/**
 * The default model of the child: the default of `agentsHarness.ts` (`TEST_MODEL_DEFAULT`, which this module, loaded
 * by the child, cannot import), so a launch of the test process is priced in the child. Its provider row
 * `agents-harness` is written by the test process's own harness before the first child starts; a child writes none.
 */
export const CHILD_MODEL = 'agents-harness/test-default';

/** The run's names of the two fixture servers of the scenario. */
export interface ScenarioServers {
  readonly logs: string;
  readonly backoffice: string;
}

/**
 * The one agent record of the scenario, the root the test process starts: its name and both fixture
 * servers. A child never asks the library: a step reads the run's snapshot from the task input.
 */
export function codeRunRecord(servers: ScenarioServers): { readonly name: string; readonly servers: string[] } {
  return { name: 'code-run-restart', servers: [servers.logs, servers.backoffice] };
}

/** The trace the read script reads (`get_trace` of the `logs` server). */
export const TRACE = { traceId: 'a'.repeat(32) };
/** The two notes the write script creates, in order (`create_incident_note` of the `backoffice` server). */
export const FIRST_NOTE = { orderId: 'ORD-1001', text: 'first note of the run' };
const SECOND_NOTE = { orderId: 'ORD-1001', text: 'second note of the run' };

/** One run of the scenario: the agent's task, its `run_code` call and the report after the result. */
export interface ScenarioRun {
  readonly task: string;
  /** The agent's description at its start. */
  readonly description: string;
  readonly args: RunCodeArgs;
  readonly report: string;
}

/** A `read` run: one call of `get_trace`, then the literal result `trace read`. */
export function readRun(servers: ScenarioServers): ScenarioRun {
  const getTrace = `mcp__${servers.logs}__get_trace`;
  return {
    task: 'Read the trace in code',
    description: 'code reader',
    args: {
      description: 'Read one trace',
      class: 'read',
      script: [`await callTool("${getTrace}", ${JSON.stringify(TRACE)});`, 'return "trace read";'].join('\n'),
    },
    report: 'report of the read run',
  };
}

/** A `write` run: two notes, one after the other, then the literal result `notes created`. */
export function writeRun(servers: ScenarioServers): ScenarioRun {
  const createNote = `mcp__${servers.backoffice}__create_incident_note`;
  return {
    task: 'Write two notes in code',
    description: 'code writer',
    args: {
      description: 'Create two incident notes',
      class: 'write',
      script: [
        `await callTool("${createNote}", ${JSON.stringify(FIRST_NOTE)});`,
        `await callTool("${createNote}", ${JSON.stringify(SECOND_NOTE)});`,
        'return "notes created";',
      ].join('\n'),
    },
    report: 'report of the write run',
  };
}

/**
 * What a child gets from the test: the agents settings, the server rights of its access gate double
 * (`{ <owner id> | '*': [<server>, …] }`) and the run's names of the scenario's servers.
 */
export interface ChildScenario {
  readonly variables: Readonly<Record<string, string>>;
  readonly access: Readonly<Record<string, readonly string[]>>;
  readonly servers: ScenarioServers;
}

/** The scenario of a test: its server rights and the run's servers it registered. */
export function childScenario(
  access: Readonly<Record<string, readonly string[]>>,
  servers: ScenarioServers,
): ChildScenario {
  return {
    variables: {
      MCP_CALL_TIMEOUT_MS: '90000',
      NODE_ENV: 'test',
    },
    access,
    servers,
  };
}

/** A console line of the child as a log record; `undefined` for any other output. */
function logRecordOf(line: string): LogRecord | undefined {
  try {
    const value = JSON.parse(line) as Partial<LogRecord> | null;
    if (typeof value?.message !== 'string' || typeof value.fields !== 'object' || value.fields === null) {
      return undefined;
    }
    return value as LogRecord;
  } catch {
    return undefined;
  }
}

/** One child process: an API process with workers on and the real code executor. */
export class CodeRunChild extends TestChild {
  private readonly records: LogRecord[] = [];

  constructor(scenario: ChildScenario) {
    super({
      name: 'Code-run child',
      entry: CHILD_ENTRY,
      cwd: PACKAGE_ROOT,
      // The API process starts with `--disable-sigusr1`: a script's executor cannot open its inspector.
      execArgv: ['--disable-sigusr1', '--import', import.meta.resolve('tsx')],
      env: { [CHILD_SCENARIO_ENV]: JSON.stringify(scenario) },
    });
  }

  /** Keeps every log record of the child's output. */
  protected override line(line: string): void {
    const record = logRecordOf(line);
    if (record !== undefined) this.records.push(record);
  }

  /** The child's log records of one `run_code` run (its `runId` is the run's `callId`) with this message. */
  runLogs(runId: string, message: string): LogRecord[] {
    return this.records.filter((record) => record.fields.runId === runId && record.message === message);
  }

  /** The pids of the executor processes this child started for the run, in start order. */
  executorPids(runId: string): number[] {
    return this.runLogs(runId, 'code executor started').map((record) => Number(record.fields.pid));
  }
}

/** Children of one test; {@link killAll} ends whatever is left of them. */
export class CodeRunChildren {
  private readonly started: CodeRunChild[] = [];

  /** Starts a child and waits until its workers run. */
  async start(scenario: ChildScenario): Promise<CodeRunChild> {
    const child = new CodeRunChild(scenario);
    this.started.push(child);
    await child.ready();
    return child;
  }

  /** Kills every child still alive: cleanup after a passed or failed test. */
  async killAll(): Promise<void> {
    await Promise.all(this.started.map((child) => child.kill()));
  }
}
