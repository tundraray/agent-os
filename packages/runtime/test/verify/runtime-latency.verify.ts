// agent-platform / runtime — on-demand timing checks, not part of any suite (testing-principles: timing-sensitive checks live in a separate
// script). Run: `pnpm --filter @agent-os/runtime test:verify`.
// Design Doc: docs/features/agent-platform/design-runtime.md, Non-Functional Use Case UC-N1 (NFR-05).
// UC-N1: the step runs in a child process (test/support/runtimeChild.ts) with the Runtime settings at their defaults; the test
// process creates the task through its own runtime with `RUNTIME_WORKERS=off`.
// NFR-01 has no scenario here: an interrupt and a stop write the new status in the command's own transaction, so the status is
// read as soon as the command returns (agent-platform-runtime.int INT-3 rows A, B); nothing is left to measure.

import { consoleSink, createLogger } from '@agent-os/common';
import { afterAll, describe, expect, it } from 'vitest';
import { newUser } from '@agent-os/db/testing';
import {
  Children,
  DEFAULT_SETTINGS,
  type RuntimeChild,
} from '../support/runtimeChild';
import { handlersFor } from '../support/runtimeChildHandlers';
import { closeRuntimeDb, recoveriesOf, statusesOf } from '../support/runtimeDb';
import {
  createRuntimeHarness,
  type RuntimeHarness,
} from '../support/runtimeHarness';
import { uniqueType } from '../support/testHandlers';

/** NFR-05: the step is started again within 60 s of the kill. */
const RESUME_TARGET_MS = 60_000;
const WAIT_MS = 120_000;
const MEASUREMENT_MS = 900_000;

const logger = createLogger({
  sinks: [consoleSink()],
  secrets: [],
  minLevel: 'info',
});

async function holdRuntime(holdType: string): Promise<RuntimeHarness> {
  const control = await createRuntimeHarness({
    handlers: [],
    config: { workers: false },
  });
  for (const handler of handlersFor({ hold: holdType }, control.runtimeDb)) {
    control.handlers.register(handler);
  }
  return control;
}

/** The lost step was requeued once and claimed again: `running` with one recovery. */
async function startedAgain(taskId: string): Promise<boolean> {
  const [status, recoveries] = await Promise.all([
    statusOf(taskId),
    recoveriesOf([taskId]),
  ]);
  return status === 'running' && recoveries.get(taskId) === 1;
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
  const taskId = await control.tasks.create({
    type: holdType,
    ownerId,
    input: {},
  });
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
      const ownerId = await newUser();
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
        await second.until(() => startedAgain(taskId), {
          what: 'the lost step to start again',
          timeoutMs: WAIT_MS,
        });
        const resumedMs = Date.now() - killedAt;
        logger.info('UC-N1: step started again after the kill', {
          durationMs: resumedMs,
        });

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
