// agent-platform / chat - performance of the conversation list over the root sessions
// Design Doc: docs/features/agent-platform/design-chat.md (v1.2), «Не меняется»: the list's performance budget (NFR-03)
// stays as it was. Rewritten from the Mastra-based `threads.perf.e2e-spec.ts` (work plan T6.4): the rows are
// root sessions, each created by the first message of a conversation (`POST /threads`, then `POST .../messages`);
// the former `/messages` measurement is removed (the route is gone).
//
// Method (unchanged): 5 warm-up + 50 sequential requests, durations sorted ascending,
// p95 = durations[ceil(0.95 * n) - 1] = durations[47] for n = 50. Local Postgres (`pnpm db:up`), a fresh employee (`createEmployee`),
// one `createTestApp()` without runtime workers, scripted model double; no network.

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import {
  THREAD_PAGE_SIZE,
  ThreadListResponseSchema,
} from '@agent-os/contracts';
import type { Response } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './support/createTestApp';
import { removeRunRows } from './support/access';
import {
  type ConversationsSetup,
  conversationsSetup,
  startConversation,
} from './support/library';
import { seedSuperAdmin } from './support/session';

const WARM_UP_REQUESTS = 5;
const TIMED_REQUESTS = 50;
/** Index of p95 in the ascending durations: ceil(0.95 * 50) - 1. */
const P95_INDEX = 47;
/** Budget of the former file (AC-13.4), kept by «Не меняется». */
const LIST_P95_BUDGET_MS = 300;
const CONVERSATIONS = 200;
/** Creating 200 conversations one by one plus 55 requests exceeds the default 5 s test timeout. */
const PERF_TEST_TIMEOUT_MS = 120_000;

let harness: TestApp;
/** The administrator the case makes; deleted in `afterAll`. */
let adminId: string | undefined;
/** What the employee needs to start a conversation. */
let setup: ConversationsSetup | undefined;

beforeAll(async () => {
  harness = await createTestApp();
  // Every first message starts a title in the background; it answers, so no title call fails.
  harness.model.completeText({ text: 'Заголовок' });
});

afterAll(async () => {
  if (harness === undefined) return;
  try {
    try {
      await setup?.restore();
    } finally {
      if (adminId !== undefined)
        await removeRunRows(harness.pool, {
          models: setup === undefined ? [] : [setup.model],
          roles: setup === undefined ? [] : [setup.roleId],
          users: [adminId],
        });
    }
  } finally {
    await harness.close();
  }
}, PERF_TEST_TIMEOUT_MS);

/**
 * Sends `send()` 5 times (discarded), then 50 times sequentially, timing each with `performance.now()`;
 * `check` asserts every response. Returns the durations in ms, sorted ascending.
 */
async function measureSequential(
  send: () => Promise<Response>,
  check: (response: Response) => void,
): Promise<number[]> {
  for (let index = 0; index < WARM_UP_REQUESTS; index += 1) check(await send());
  const durations: number[] = [];
  for (let index = 0; index < TIMED_REQUESTS; index += 1) {
    const started = performance.now();
    const response = await send();
    durations.push(performance.now() - started);
    check(response);
  }
  return durations.sort((a, b) => a - b);
}

describe('agent-platform / chat - conversation list performance (local Postgres)', () => {
  // NFR-03 (list budget unchanged), former AC-13.4: "The system shall отвечать на GET /api/threads с p95 ≤ 300 мс при
  //   200 беседах пользователя на локальном Postgres."
  // Catches: a list that reads or sorts all of the owner's conversations per request instead of one keyset page
  //   over `agent_sessions_owner_page_idx`, pushing p95 over the budget.
  it(
    'GET /threads answers with p95 <= 300 ms for an owner with 200 conversations',
    async () => {
      const admin = await seedSuperAdmin(
        harness.app,
        `e2e-admin-${randomUUID()}`,
      );
      adminId = admin.id;
      setup = await conversationsSetup(harness.app, admin);
      const api = await setup.newEmployee();
      for (let index = 0; index < CONVERSATIONS; index += 1)
        await startConversation(api);

      const durations = await measureSequential(
        () => api.raw('get', '/threads'),
        (response) => {
          expect(response.status).toBe(200);
          expect(
            ThreadListResponseSchema.parse(response.body).threads,
          ).toHaveLength(THREAD_PAGE_SIZE);
        },
      );

      expect(durations).toHaveLength(TIMED_REQUESTS);
      expect(durations[P95_INDEX], 'list p95, ms').toBeLessThanOrEqual(
        LIST_P95_BUDGET_MS,
      );
    },
    PERF_TEST_TIMEOUT_MS,
  );
});
