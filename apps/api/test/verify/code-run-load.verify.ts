// code-execution / code-execution — on-demand load check, not part of any suite (testing-principles: timing-sensitive
// checks live in a separate script). Run: `pnpm --filter api test:verify` (builds the workspace packages the API uses first).
// Design Doc: docs/features/code-execution/design-code-execution.md, Non-Functional Use Case UC-N3 (NFR-04, AC-10.5).
// Budgets: `.claude/skills/project-context/SKILL.md`, «Performance Requirements» — the conversation list (200 conversations)
// p95 <= 300 ms, the conversation's messages p95 <= 500 ms, on the local Postgres.
//
// One boot of the real `AppModule` with runtime workers (`createTestApp`): the scripted model plays both employees, the
// code runs go through the real executor processes with the production limits (`CODE_RUN_*` defaults). Employee A keeps
// two runs at their limits — an endless loop (held until the 30 s time limit) and a growing heap (up to the memory
// limit, asked again after each failure) — while employee B reads the conversation list and writes to the chat.

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { ConversationView } from '@agent-os/contracts';
import { consoleSink, createLogger } from '@agent-os/common';
import type { Response } from 'supertest';
import { describe, expect, it } from 'vitest';
import {
  addModel,
  allowRole,
  HAIKU_TEST_PRICES,
  removeRunRows,
  runModel,
} from '../support/access.js';
import { chatApi, type ChatApi, waitFor } from '../support/api.js';
import { createTestApp } from '../support/createTestApp.js';
import { createEmployee, seedSuperAdmin } from '../support/session.js';

/** The app's default model: a model of the run, allowed to both employees through the run's role. */
const DEFAULT_MODEL = runModel('code-run-load-haiku');
/** «Performance Requirements»: the conversation list, p95. */
const LIST_P95_BUDGET_MS = 300;
/** «Performance Requirements»: the conversation's messages, p95. */
const MESSAGE_P95_BUDGET_MS = 500;
/** The list budget holds for an employee with 200 conversations. */
const CONVERSATIONS = 200;
const WARM_UP_ROUNDS = 5;
const TIMED_ROUNDS = 50;
/** How long A's two runs may take to reach the executor after the messages are sent. */
const RUNS_START_MS = 60_000;
const MEASUREMENT_MS = 300_000;

/** Runs until the run's time limit stops it. */
const ENDLESS_LOOP_SCRIPT = 'while (true) {}';
/** Grows the heap until the run's memory limit stops it. */
const GROWING_HEAP_SCRIPT = [
  'const chunks = [];',
  'while (true) chunks.push(new Array(1_000_000).fill(chunks.length));',
].join('\n');

const logger = createLogger({
  sinks: [consoleSink()],
  secrets: [],
  minLevel: 'info',
});

/** The nearest-rank 95th percentile. */
function p95(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1] ?? Number.NaN;
}

/** The duration of one request, in ms; fails unless it answered `status`. */
async function timed(
  send: () => Promise<Response>,
  status: number,
): Promise<number> {
  const startedAt = performance.now();
  const response = await send();
  const durationMs = performance.now() - startedAt;
  if (response.status !== status) {
    throw new Error(
      `Expected ${status}, got ${response.status}: ${JSON.stringify(response.body)}`,
    );
  }
  return durationMs;
}

/** A `read` run of `script` the model asks for. */
function runCodeCall(description: string, script: string) {
  return { tool: 'run_code', args: { description, class: 'read', script } };
}

/** Whether the conversation's chat has a `run_code` call whose run is in flight: a read run stays `requested` (it has no intent). */
function hasRunInFlight(view: ConversationView): boolean {
  return view.entries.some(
    (entry) =>
      entry.kind === 'model_answer' &&
      entry.content.toolCalls.some(
        (call) => call.tool === 'run_code' && call.state === 'requested',
      ),
  );
}

/** Finished `run_code` calls of the conversation's first history page. */
function finishedRuns(view: ConversationView): number {
  return view.entries.filter(
    (entry) =>
      entry.kind === 'tool_result' && entry.content.tool === 'run_code',
  ).length;
}

/** Waits until the conversation's chat runs a script. */
function runInFlight(
  api: ChatApi,
  threadId: string,
  what: string,
): Promise<ConversationView> {
  return waitFor(
    () => api.history(threadId),
    hasRunInFlight,
    what,
    RUNS_START_MS,
  );
}

describe("UC-N3: the server answers in its budgets while another employee's runs are at their limits", () => {
  it(
    'employee B reads the conversation list and writes to the chat within the budgets while employee A runs an endless loop and a growing heap',
    async () => {
      // Given: one app with runtime workers; A's two conversations each ask for one run at its limit, again after
      // every failure; B's chat answers every message with text; B has 200 conversations
      const harness = await createTestApp({
        workers: true,
        defaultModel: DEFAULT_MODEL,
      });
      let roleId: string | undefined;
      try {
        const loopTask = 'UC-N3: run the endless loop';
        const heapTask = 'UC-N3: grow the heap';
        const chatTask = 'UC-N3: hello';
        harness.model.completeText({ text: 'UC-N3' });
        harness.model.script({ task: loopTask }, [], {
          thereafter: {
            calls: [runCodeCall('Бесконечный цикл', ENDLESS_LOOP_SCRIPT)],
          },
        });
        harness.model.script({ task: heapTask }, [], {
          thereafter: {
            calls: [runCodeCall('Рост памяти', GROWING_HEAP_SCRIPT)],
          },
        });
        harness.model.script({ task: chatTask }, [], {
          thereafter: { text: 'Принято.' },
        });

        const admin = await seedSuperAdmin(
          harness.app,
          `verify-admin-${randomUUID()}`,
        );
        await addModel(harness.app, admin, {
          id: DEFAULT_MODEL,
          ...HAIKU_TEST_PRICES,
        });
        const role = await allowRole(harness.app, admin, {
          name: 'code-run-load',
          models: [DEFAULT_MODEL],
          servers: [],
        });
        roleId = role.id;
        const employee = async () => {
          const session = await createEmployee(harness.app, admin);
          await role.add(session);
          return chatApi(harness.app, session);
        };
        const employeeA = await employee();
        const employeeB = await employee();
        for (let index = 1; index < CONVERSATIONS; index += 1)
          await employeeB.createThread();
        const chat = await employeeB.createThread();
        await employeeB.send(chat.id, chatTask);

        // When: A's two runs are in flight
        const loop = await employeeA.createThread();
        const heap = await employeeA.createThread();
        await employeeA.send(loop.id, loopTask);
        await employeeA.send(heap.id, heapTask);
        await runInFlight(employeeA, loop.id, 'the endless loop run');
        await runInFlight(employeeA, heap.id, 'the growing heap run');

        // When: B reads the list and writes to the chat, round after round (the first rounds are not timed)
        const listMs: number[] = [];
        const messageMs: number[] = [];
        for (
          let round = 1;
          round <= WARM_UP_ROUNDS + TIMED_ROUNDS;
          round += 1
        ) {
          const list = await timed(() => employeeB.raw('get', '/threads'), 200);
          const message = await timed(
            () =>
              employeeB.raw('post', `/threads/${chat.id}/messages`, {
                text: `UC-N3: message ${round}`,
              }),
            202,
          );
          if (round <= WARM_UP_ROUNDS) continue;
          listMs.push(list);
          messageMs.push(message);
        }

        // Then: the loop run was still at its limit when B finished, so every timed request met the load
        const loopAfter = await employeeA.history(loop.id);
        const heapAfter = await employeeA.history(heap.id);
        // A's chats stop asking for runs before the app closes
        await employeeA.interrupt(loop.id);
        await employeeA.interrupt(heap.id);
        logger.info(
          "UC-N3: employee B under employee A's runs at their limits",
          {
            rounds: TIMED_ROUNDS,
            listP95Ms: Math.round(p95(listMs)),
            listMaxMs: Math.round(Math.max(...listMs)),
            listBudgetMs: LIST_P95_BUDGET_MS,
            messageP95Ms: Math.round(p95(messageMs)),
            messageMaxMs: Math.round(Math.max(...messageMs)),
            messageBudgetMs: MESSAGE_P95_BUDGET_MS,
            loopRunsFinished: finishedRuns(loopAfter),
            heapRunsFinished: finishedRuns(heapAfter),
          },
        );
        expect(hasRunInFlight(loopAfter)).toBe(true);

        // Then: B's p95 is within the budgets (NFR-04, AC-10.5)
        expect(p95(listMs), 'list p95, ms').toBeLessThanOrEqual(
          LIST_P95_BUDGET_MS,
        );
        expect(p95(messageMs), 'message p95, ms').toBeLessThanOrEqual(
          MESSAGE_P95_BUDGET_MS,
        );
      } finally {
        try {
          await removeRunRows(harness.pool, {
            models: [DEFAULT_MODEL],
            roles: roleId === undefined ? [] : [roleId],
          });
        } finally {
          await harness.close();
        }
      }
    },
    MEASUREMENT_MS,
  );
});
