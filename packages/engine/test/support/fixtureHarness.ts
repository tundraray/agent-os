import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixtureServerPath } from '@agent-os/mcp-fixture';
import {
  FIXTURE_SOURCE_ID,
  FixtureSourceAdapter,
  type SourceAllowlist,
  type SourcesLogger,
  type SourcesSettings,
} from '@agent-os/sources';

/**
 * The real MCP fixture as the engine's source (design-engine.md, Test Strategy), modelled on
 * `packages/sources/test/support/fixtureHarness.ts`: a temp dir of its own with the fault rules and the call log — the
 * independent counter of `tools/call` — and the adapter whose process `fixtureServerPath` of `@agent-os/mcp-fixture`
 * starts on its first call. Only the package entries are imported, as `apps/api` imports them.
 */

/** One line of the fixture call log: only `tools/call`, written before the call is processed. */
export interface CallLogLine {
  readonly seq: number;
  readonly tool: string;
  readonly argsHash: string;
  readonly occurrence: number;
  readonly mode: string | null;
  readonly pid: number;
}

/** The gather tools of `deep-research` (design-engine.md, C2, DC-14), as `apps/api` allows them. */
export const FIXTURE_ALLOWLIST: SourceAllowlist = {
  'source.fetch': ['search_logs', 'aggregate_logs', 'get_trace'].map((toolName) => ({ sourceId: FIXTURE_SOURCE_ID, toolName })),
};

/** The files of one fixture source and the Sources Settings that point at them. */
export interface FixtureFiles {
  /**
   * Every Sources Settings variable, so none leaks in from the environment of a child: dataset `v1`, a short backoff,
   * no fault rule, and this fixture's `FIXTURE_FAULTS` and `FIXTURE_CALL_LOG`.
   */
  readonly env: Readonly<Record<string, string>>;
  /** The call log in file order; empty before the first `tools/call`. */
  readCallLog(): CallLogLine[];
  remove(): void;
}

export function fixtureFiles(): FixtureFiles {
  const dir = mkdtempSync(join(tmpdir(), 'agent-os-engine-e2e-'));
  const faultsPath = join(dir, 'faults.json');
  const callLogPath = join(dir, 'calls.jsonl');
  writeFileSync(faultsPath, '[]', 'utf8');
  return {
    env: {
      SOURCE_CALL_TIMEOUT_MS: '30000',
      SOURCE_RETRY_BASE_MS: '10',
      SOURCE_RETRY_CAP_MS: '50',
      SOURCE_MAX_PAGES: '1000',
      FIXTURE_DATASET: 'v1',
      FIXTURE_FAULTS: faultsPath,
      FIXTURE_CALL_LOG: callLogPath,
    },
    readCallLog() {
      if (!existsSync(callLogPath)) return [];
      return readFileSync(callLogPath, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as CallLogLine);
    },
    remove() {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

/** The fixture adapter over `settings` (its `FIXTURE_*` files included). */
export function fixtureAdapter(settings: SourcesSettings, logger: SourcesLogger): FixtureSourceAdapter {
  return new FixtureSourceAdapter({ serverPath: fixtureServerPath, settings, logger });
}
