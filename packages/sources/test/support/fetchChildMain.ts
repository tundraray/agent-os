import { parseRuntimeConfig } from '@agent-os/runtime';
import { parseSourcesSettings } from '@agent-os/sources';
import { createSourcesHarness, FETCH_CHILD_SCENARIO_ENV, type FetchArgs, proposeFetch } from './runtimeHarness.js';

/**
 * Entry of the recovery child process (E2E-2, UC-E11), run only compiled (`pnpm --filter @agent-os/sources
 * build:child` → `dist/test-child/`). It is the assembly point of its test: it reads its environment — Runtime
 * Settings with `RUNTIME_CRASH_AT`, Sources Settings with the test's `FIXTURE_FAULTS` and `FIXTURE_CALL_LOG`,
 * `DATABASE_URL` — and builds `createDatabase`, `createRuntime` and `createSources` with the fixture adapter from
 * the packages' `dist` (imported by name).
 *
 * Mode `fetch-recovery`: the first start pins the fixture's snapshot and proposes one `source.fetch` "all" task in
 * an investigation of `resourceId`; a restart (`proposed: true`) only starts the workers, whose reaper takes the
 * dead process's attempt back. `{ kind: 'stop' }` over IPC stops the runtime, closes the sources and the pool and
 * exits 0.
 */

/** What the child runs, as JSON in {@link FETCH_CHILD_SCENARIO_ENV}. */
export interface FetchChildScenario {
  readonly mode: 'fetch-recovery';
  readonly resourceId: string;
  /** `search_logs` arguments of the task. */
  readonly args: FetchArgs;
  /** A previous start proposed the task: this one only runs workers. */
  readonly proposed: boolean;
}

/** Messages of the harness to the child (IPC). */
export interface StopMessage {
  readonly kind: 'stop';
}

function readScenario(): FetchChildScenario {
  const raw = process.env[FETCH_CHILD_SCENARIO_ENV];
  if (!raw) throw new Error(`${FETCH_CHILD_SCENARIO_ENV} is not set`);
  return JSON.parse(raw) as FetchChildScenario;
}

async function main(): Promise<void> {
  const scenario = readScenario();
  const harness = createSourcesHarness({
    sources: parseSourcesSettings(process.env),
    // The environment is authoritative here: the child is the composition root of its runtime.
    runtime: parseRuntimeConfig(process.env),
    echoLogs: true,
  });
  process.on('message', (message: StopMessage) => {
    if (message.kind !== 'stop') return;
    harness.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error('Closing the child failed', error);
        process.exit(1);
      },
    );
  });
  if (!scenario.proposed) {
    await proposeFetch(harness, { resourceId: scenario.resourceId, args: scenario.args, completeness: 'all' });
  }
}

main().catch((error: unknown) => {
  console.error('Fetch child failed', error);
  process.exit(1);
});
