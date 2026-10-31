// research-runtime / runtime — on-demand timing checks, not part of any suite (testing-principles: timing-sensitive
// checks live in a separate script). Run: `pnpm --filter @agent-os/runtime test:verify` (builds the child first).
// Design Doc: docs/features/research-runtime/design-runtime.md, Non-Functional Use Cases UC-N1, UC-N2; Early Verification Point.
// PRD targets: Performance — dependent task start p95 <= 2 s (50 pairs, local Postgres); Reliability — recovery <= 60 s.

import type { ProposeResult } from '@agent-os/contracts';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newUser } from '../support/new-user.js';
import { RECOVERY_TARGET_MS, runScenario } from '../support/runtimeChild.js';
import { closeRuntimeDb, query } from '../support/runtimeDb.js';
import {
  createRuntimeHarness,
  type RuntimeHarness,
} from '../support/runtimeHarness.js';
import {
  completed,
  latch,
  type Latch,
  taskSpec,
  testHandler,
  uniqueWorkflowType,
} from '../support/testHandlers.js';

/** PRD Performance: start of the dependent task after its dependency succeeded, p95. */
const DEPENDENT_START_TARGET_MS = 2_000;
const PAIRS = 50;
const MEASUREMENT_MS = 600_000;
const POLL_MS = 25;
const PAIR_MS = 30_000;

/** Runtime Settings at their defaults (design-runtime.md, Runtime Settings). */
const DEFAULT_SETTINGS: Readonly<Record<string, string>> = {
  RUNTIME_CONCURRENCY: '4',
  RUNTIME_POLL_MS: '500',
  RUNTIME_NOTIFY: 'on',
  RUNTIME_LEASE_MS: '30000',
  RUNTIME_HEARTBEAT_MS: '10000',
  RUNTIME_REAPER_MS: '5000',
  DB_POOL_MAX: '10',
};

/** The nearest-rank 95th percentile. */
function p95(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function createdTaskId(result: ProposeResult): string {
  if (result.outcome !== 'created') {
    throw new Error(`Task not created: ${JSON.stringify(result)}`);
  }
  return result.taskId;
}

async function waitSucceeded(taskId: string): Promise<void> {
  const deadline = Date.now() + PAIR_MS;
  while (Date.now() < deadline) {
    const [row] = await query<{ status: string }>(
      'SELECT status FROM app.research_tasks WHERE task_id = $1',
      [taskId],
    );
    if (row?.status === 'succeeded') return;
    await delay(POLL_MS);
  }
  throw new Error(`Task ${taskId} did not succeed within ${PAIR_MS} ms`);
}

/** From the dependency's `TaskSucceeded` to the dependent's first `TaskStarted`, by the stored times. */
async function dependentStartMs(
  dependencyId: string,
  dependentId: string,
): Promise<number> {
  const [row] = await query<{ ms: number }>(
    `SELECT (extract(epoch FROM started.created_at - succeeded.created_at) * 1000)::float8 AS ms
       FROM app.research_events succeeded, app.research_events started
      WHERE succeeded.task_id = $1 AND succeeded.type = 'TaskSucceeded'
        AND started.task_id = $2 AND started.type = 'TaskStarted'
      ORDER BY started.seq LIMIT 1`,
    [dependencyId, dependentId],
  );
  return row.ms;
}

/** Waits until no delivery of the investigation's events is pending. */
async function deliveriesDrained(investigationId: string): Promise<void> {
  const deadline = Date.now() + PAIR_MS;
  while (Date.now() < deadline) {
    const [row] = await query<{ pending: number }>(
      `SELECT count(*)::int AS pending FROM app.research_event_deliveries d
         JOIN app.research_events e ON e.event_id = d.event_id
        WHERE e.investigation_id = $1 AND d.status = 'pending'`,
      [investigationId],
    );
    if (row.pending === 0) return;
    await delay(POLL_MS);
  }
  throw new Error(
    `Deliveries of investigation ${investigationId} still pending after ${PAIR_MS} ms`,
  );
}

afterAll(async () => {
  await closeRuntimeDb();
});

describe('UC-N1: dependent task start with RUNTIME_NOTIFY=off', () => {
  // The dependency runs in one instance and the dependent in another, so the dependent's start
  // rests on polling alone: no NOTIFY, and no local wake after the dependency's slot frees.
  const dependencyType = uniqueWorkflowType('n1-dependency');
  const dependentType = uniqueWorkflowType('n1-dependent');
  const resourceId = newUser();
  const settings = { notify: false, pollMs: 500, concurrency: 4 };
  // Per pair: opened once the dependent is admitted, so the dependency cannot succeed earlier and
  // the dependent's start never rests on the admission racing the dependency.
  const dependentAdmitted = new Map<string, Latch>();
  let upstream: RuntimeHarness | undefined;
  let downstream: RuntimeHarness | undefined;
  let investigationId: string | undefined;

  beforeAll(async () => {
    upstream = await createRuntimeHarness({
      handlers: [
        testHandler(dependencyType, async (ctx) => {
          const pair = ctx.input.pair;
          if (typeof pair !== 'string')
            throw new Error('Pair missing in input');
          await dependentAdmitted.get(pair)?.promise;
          return completed();
        }),
      ],
      runtime: settings,
    });
    downstream = await createRuntimeHarness({
      handlers: [
        testHandler(dependentType, () => Promise.resolve(completed())),
      ],
      runtime: settings,
    });
  }, 120_000);

  afterAll(async () => {
    // The last pairs' events are still being delivered to `runtime.scheduler` when the
    // measurement ends: closing now would leave them pending, and the kill matrix of UC-N2
    // refuses a database with pending runtime deliveries.
    if (investigationId) await deliveriesDrained(investigationId);
    await downstream?.close();
    await upstream?.close();
  }, PAIR_MS);

  it(
    `p95 over ${PAIRS} pairs is within the PRD target (${DEPENDENT_START_TARGET_MS} ms)`,
    async () => {
      if (!upstream || !downstream) throw new Error('Apps did not start');
      const threadId = await upstream.createThread(resourceId);
      ({ investigationId } = await upstream.investigations.create({
        resourceId,
        threadId,
        query: 'UC-N1',
        budget: { maxTasks: 2 * PAIRS, maxToolCalls: 4 * PAIRS },
      }));

      const latencies: number[] = [];
      for (let pair = 0; pair < PAIRS; pair += 1) {
        const input = { pair: String(pair) };
        const admitted = latch();
        dependentAdmitted.set(input.pair, admitted);
        const dependency = createdTaskId(
          await upstream.scheduler.propose(
            taskSpec({ investigationId, workflowType: dependencyType, input }),
            `n1-dependency-${pair}`,
          ),
        );
        const dependent = createdTaskId(
          await downstream.scheduler.propose(
            taskSpec({
              investigationId,
              workflowType: dependentType,
              input,
              dependsOn: [dependency],
            }),
            `n1-dependent-${pair}`,
          ),
        );
        admitted.release();
        await waitSucceeded(dependent);
        latencies.push(await dependentStartMs(dependency, dependent));
      }

      const value = p95(latencies);
      console.log(
        `UC-N1 RUNTIME_NOTIFY=off RUNTIME_POLL_MS=500, ${PAIRS} pairs: p95=${value.toFixed(0)} ms, ` +
          `max=${Math.max(...latencies).toFixed(0)} ms, median=${median(latencies).toFixed(0)} ms`,
      );
      expect(value).toBeLessThanOrEqual(DEPENDENT_START_TARGET_MS);
    },
    MEASUREMENT_MS,
  );
});

describe('UC-N2: recovery time after a process death, Runtime Settings at their defaults', () => {
  it.each([
    { point: 'handler.after-evidence', left: 'a running task' },
    {
      point: 'dispatch.after-terminal',
      left: 'end-to-end recovery of the undelivered terminal event',
    },
  ])(
    'death at $point ($left): the restarted process reaches the end state within the PRD target',
    async ({ point }) => {
      const run = await runScenario({
        crashAt: point,
        settings: DEFAULT_SETTINGS,
        // Measure past the target instead of timing out at it.
        recoveryTimeoutMs: 2 * RECOVERY_TARGET_MS,
      });

      console.log(
        `UC-N2 ${point}: recovery ${run.recoveryMs} ms from the restart's spawn (recovered attempts: ${run.recoveries})`,
      );
      expect(run.firstExitCode).toBe(137);
      expect(run.recoveryMs).toBeLessThanOrEqual(RECOVERY_TARGET_MS);
    },
    MEASUREMENT_MS,
  );
});
