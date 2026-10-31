import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { argsHash, fixtureServerPath, type DatasetVersion } from '@agent-os/mcp-fixture';
import { FixtureSourceAdapter } from '../../src/fixture/fixture-source.adapter.js';
import { McpSourceClient } from '../../src/mcp/mcp-source-client.js';
import { parseSourcesSettings, type SourcesEnv, type SourcesSettings } from '../../src/sources.settings.js';

/** A `FIXTURE_FAULTS` rule (design-mcp-source.md, Отказы fixture); mode parameters sit next to `mode`. */
export interface FixtureFaultRule {
  readonly tool: string;
  readonly argsHash: string;
  readonly occurrences: 'all' | readonly number[];
  readonly mode: string;
  readonly [parameter: string]: unknown;
}

/** One line of the fixture call log: only `tools/call`, written before the call is processed. */
export interface CallLogLine {
  readonly seq: number;
  readonly tool: string;
  readonly argsHash: string;
  readonly occurrence: number;
  readonly mode: string | null;
  readonly pid: number;
}

export interface LogRecord {
  readonly level: 'debug' | 'warn' | 'error';
  readonly message: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

/** Logger port double that keeps every record, for assertions on levels and fields. */
export class RecordingLogger {
  readonly records: LogRecord[] = [];

  debug(message: string, fields: Readonly<Record<string, unknown>>): void {
    this.records.push({ level: 'debug', message, fields });
  }

  warn(message: string, fields: Readonly<Record<string, unknown>>): void {
    this.records.push({ level: 'warn', message, fields });
  }

  error(message: string, fields: Readonly<Record<string, unknown>>): void {
    this.records.push({ level: 'error', message, fields });
  }
}

export interface FixtureHarness {
  readonly adapter: FixtureSourceAdapter;
  readonly settings: SourcesSettings;
  readonly logger: RecordingLogger;
  /** The call log in file order; empty before the first `tools/call`. */
  readCallLog(): CallLogLine[];
  close(): Promise<void>;
}

/**
 * The hash the fixture keys rules and log lines by: sha256 of the canonical arguments without `cursor`, as the
 * adapter sends them (after `argsSchema`, defaults included).
 */
export function fixtureArgsHash(args: Readonly<Record<string, unknown>>): string {
  return argsHash(args);
}

/**
 * A fixture source of its own: a temp dir with the rules file and call log, and an adapter whose process is
 * started by `fixtureServerPath` of `@agent-os/mcp-fixture` on its first call. `env` overrides the settings
 * (`SOURCE_CALL_TIMEOUT_MS` and the backoff are short by default so failure rows stay fast).
 */
export function startFixture(options: { rules?: readonly FixtureFaultRule[]; env?: SourcesEnv } = {}): FixtureHarness {
  const dir = mkdtempSync(join(tmpdir(), 'agent-os-sources-int-'));
  const faultsPath = join(dir, 'faults.json');
  const callLogPath = join(dir, 'calls.jsonl');
  writeFileSync(faultsPath, JSON.stringify(options.rules ?? []), 'utf8');
  const settings = parseSourcesSettings({
    SOURCE_CALL_TIMEOUT_MS: '500',
    SOURCE_RETRY_BASE_MS: '1',
    SOURCE_RETRY_CAP_MS: '5',
    ...options.env,
    FIXTURE_FAULTS: faultsPath,
    FIXTURE_CALL_LOG: callLogPath,
  });
  const logger = new RecordingLogger();
  const adapter = new FixtureSourceAdapter({ serverPath: fixtureServerPath, settings, logger });

  return {
    adapter,
    settings,
    logger,
    readCallLog() {
      if (!existsSync(callLogPath)) {
        return [];
      }
      return readFileSync(callLogPath, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as CallLogLine);
    },
    async close() {
      await adapter.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

/** A bare client over a fixture process of its own: raw `CallToolResult`s and resources, no rules and no call log. */
export interface FixtureClient {
  readonly client: McpSourceClient;
  close(): Promise<void>;
}

/** Each call starts another fixture process (on its first request) serving `dataset`. */
export function openFixtureClient(dataset: DatasetVersion): FixtureClient {
  const client = new McpSourceClient({
    serverPath: fixtureServerPath,
    fixtureEnv: { FIXTURE_DATASET: dataset },
    logger: new RecordingLogger(),
  });
  return { client, close: () => client.close() };
}

/** The committed ground truth of `version`, `ground-truth/<version>.json` next to the fixture package's `dist`. */
export function readGroundTruthFile(version: DatasetVersion): unknown {
  const file = join(dirname(fixtureServerPath), '..', 'ground-truth', `${version}.json`);
  return JSON.parse(readFileSync(file, 'utf8'));
}
