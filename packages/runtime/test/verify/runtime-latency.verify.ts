// agent-platform / runtime — on-demand timing checks, not part of any suite (testing-principles: timing-sensitive checks live in a separate
// script). Run: `pnpm --filter @agent-os/runtime test:verify` (builds the package and the child first).
// Design Doc: docs/features/agent-platform/design-runtime.md, Non-Functional Use Cases UC-N1 (NFR-05), UC-N2 (NFR-01).
// The step runs in a compiled child process (test/support/runtimeChild.ts) with the Runtime settings at their defaults; the test process
// creates the tasks and sends the commands through its own runtime with `RUNTIME_WORKERS=off`.

import { consoleSink, createLogger } from '@agent-os/common';
import { afterAll, describe, expect, it } from 'vitest';
import { newUser } from '../support/new-user.js';
import { Children, DEFAULT_SETTINGS, type RuntimeChild } from '../support/runtimeChild.js';
import { handlersFor } from '../support/runtimeChildHandlers.js';
import { closeRuntimeDb, eventsOf, statusesOf } from '../support/runtimeDb.js';
import { createRuntimeHarness, type RuntimeHarness } from '../support/runtimeHarness.js';
import { uniqueType } from '../support/testHandlers.js';

/** NFR-05: the step is started again within 60 s of the kill. */
const RESUME_TARGET_MS = 60_000;
/** NFR-01: the new status is read within 5 s of the command, p95. */
const STATUS_TARGET_MS = 5_000;
/** Samples per command of UC-N2. */
const SAMPLES = 20;
const WAIT_MS = 120_000;
const MEASUREMENT_MS = 900_000;

const logger = createLogger({ sinks: [consoleSink()], secrets: [], minLevel: 'info' });

/** The nearest-rank 95th percentile. */
function p95(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

async function holdRuntime(holdType: string): Promise<RuntimeHarness> {
  const control = await createRuntimeHarness({ handlers: [], config: { workers: false } });
  for (const handler of handlersFor({ hold: holdType }, control.db)) {
    control.handlers.register(handler);
  }
  return control;
}

async function stepStarts(taskId: string): Promise<number> {
  const events = await eventsOf(taskId);
  return events.filter((event) => event.type === 'task.step_started').length;
}

async function statusOf(taskId: string): Promise<string | undefined> {
  return (await statusesOf([taskId])).get(taskId);
}

/** Creates a root task of the hold type and waits until the child runs its step. */
async function runningHold(
  control: RuntimeHarness,
  child: RuntimeChild,
  holdType: string,
  ownerId: string,
): Promise<string> {
  const taskId = await control.tasks.create({ type: holdType, ownerId, input: {} });
  await child.until(async () => (await statusOf(taskId)) === 'running', {
    what: `task ${taskId} to run`,
    timeoutMs: WAIT_MS,
  });
  return taskId;
}

afterAll(closeRuntimeDb);

describe('UC-N1: a step killed with its process starts again within 60 s', () => {
  it(
    'measures from the kill to the next claim of the same step on a fresh process',
    async () => {
      const holdType = uniqueType('n1-hold');
      const control = await holdRuntime(holdType);
      const children = new Children();
      const ownerId = newUser();
      try {
        const first = await children.start({
          types: { hold: holdType },
          settings: DEFAULT_SETTINGS,
        });
        const taskId = await runningHold(control, first, holdType, ownerId);

        await first.kill();
        const killedAt = Date.now();
        const second = await children.start({
          types: { hold: holdType },
          settings: DEFAULT_SETTINGS,
        });
        await second.until(async () => (await stepStarts(taskId)) === 2, {
          what: 'the lost step to start again',
          timeoutMs: WAIT_MS,
        });
        const resumedMs = Date.now() - killedAt;
        logger.info('UC-N1: step started again after the kill', { durationMs: resumedMs });

        await control.tasks.stop(taskId, ownerId);
        await second.stop();
        expect(resumedMs).toBeLessThanOrEqual(RESUME_TARGET_MS);
      } finally {
        await children.killAll();
        await control.close();
      }
    },
    MEASUREMENT_MS,
  );
});

describe('UC-N2: the status after interrupt and stop is read within 5 s (p95)', () => {
  it(
    'measures from the command to the read of the new status while the step holds on another instance',
    async () => {
      const holdType = uniqueType('n2-hold');
      const control = await holdRuntime(holdType);
      const children = new Children();
      const ownerId = newUser();
      const interrupted: string[] = [];
      try {
        const child = await children.start({
          types: { hold: holdType },
          settings: DEFAULT_SETTINGS,
        });
        const interruptMs: number[] = [];
        const stopMs: number[] = [];
        for (let sample = 0; sample < SAMPLES; sample += 1) {
          const toInterrupt = await runningHold(control, child, holdType, ownerId);
          const interruptAt = Date.now();
          expect(await control.tasks.interrupt(toInterrupt, ownerId)).toBe('interrupted');
          await child.until(async () => (await statusOf(toInterrupt)) === 'waiting', {
            what: 'the interrupted status',
            timeoutMs: WAIT_MS,
          });
          interruptMs.push(Date.now() - interruptAt);
          interrupted.push(toInterrupt);

          const toStop = await runningHold(control, child, holdType, ownerId);
          const stopAt = Date.now();
          expect(await control.tasks.stop(toStop, ownerId)).toEqual([toStop]);
          await child.until(async () => (await statusOf(toStop)) === 'stopped', {
            what: 'the stopped status',
            timeoutMs: WAIT_MS,
          });
          stopMs.push(Date.now() - stopAt);
        }
        logger.info('UC-N2: status read after the command, p95', {
          interruptP95Ms: p95(interruptMs),
          stopP95Ms: p95(stopMs),
          samples: SAMPLES,
        });

        for (const taskId of interrupted) await control.tasks.stop(taskId, ownerId);
        await child.stop();
        expect(p95(interruptMs)).toBeLessThanOrEqual(STATUS_TARGET_MS);
        expect(p95(stopMs)).toBeLessThanOrEqual(STATUS_TARGET_MS);
      } finally {
        await children.killAll();
        await control.close();
      }
    },
    MEASUREMENT_MS,
  );
});
