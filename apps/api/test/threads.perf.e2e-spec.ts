// chat-shell / threads-api Performance Test - Design Doc: docs/features/chat-shell/design-threads-api.md (v1.8)
// Generated: 2026-10-28 | Part: threads-api | Test type: performance (integration harness, real Postgres)
// File name per Design Doc Test Strategy ("threads.perf.e2e-spec.ts"). Runs under `test:e2e` (work plan T6.1 decision;
// it moves to a separate `test:perf` script only if it fails in >= 1 of 3 full runs but passes alone).
// Not counted against the integration budget: performance ACs are design-mandated and excluded from functional ROI.
//
// Method (Design Doc): seed data, 5 warm-up + 50 sequential requests, sort durations ascending,
// p95 = durations[ceil(0.95 * n) - 1] = durations[47] for n = 50. Local Postgres from infra/docker-compose.yml,
// unique `resourceId = 'e2e-' + randomUUID()`, afterAll cleanup. Mock models; no network.

import { performance } from 'node:perf_hooks';
import {
  ThreadListResponseSchema,
  ThreadMessagesResponseSchema,
} from '@agent-os/contracts';
import request from 'supertest';
import type { Response } from 'supertest';
import { createTestApp, type TestApp } from './support/createTestApp.js';
import {
  cleanupUsers,
  descendingDates,
  newUser,
  seed,
} from './support/seed.js';

const WARM_UP_REQUESTS = 5;
const TIMED_REQUESTS = 50;
/** Index of p95 in the ascending durations: ceil(0.95 * 50) - 1. */
const P95_INDEX = 47;
/** Seeding hundreds of rows plus 55 requests exceeds the default 5 s test timeout. */
const PERF_TEST_TIMEOUT_MS = 120_000;

let testApp: TestApp;
const users = new Set<string>();

beforeAll(async () => {
  testApp = await createTestApp();
});

afterAll(async () => {
  try {
    await cleanupUsers(testApp.memory, users);
  } finally {
    await testApp.app.close();
  }
});

function perfUser(): string {
  const id = newUser();
  users.add(id);
  return id;
}

/**
 * Sends `send()` 5 times (discarded), then 50 times sequentially, timing each
 * with `performance.now()`; `check` asserts every timed response. Returns the
 * durations in ms, sorted ascending.
 */
async function measureSequential(
  send: () => Promise<Response>,
  check: (res: Response) => void,
): Promise<number[]> {
  for (let i = 0; i < WARM_UP_REQUESTS; i += 1) check(await send());
  const durations: number[] = [];
  for (let i = 0; i < TIMED_REQUESTS; i += 1) {
    const started = performance.now();
    const res = await send();
    durations.push(performance.now() - started);
    check(res);
  }
  return durations.sort((a, b) => a - b);
}

describe('Threads API performance (local Postgres)', () => {
  // AC-13.4: "The system shall отвечать на GET /api/threads с p95 ≤ 300 мс при 200 беседах пользователя на локальном Postgres."
  // EARS: (none) -> basic
  // ROI: 2.1 | Business Value: 6 | Frequency: 10 | Defect detection: 3 (non-deterministic in CI)
  // Behavior: 200 seeded threads -> 50 timed list requests -> p95 within budget
  // Primary failure mode: list implementation loads/sorts all threads per request (e.g. perPage: false + in-memory sort
  //   grows superlinearly) pushing p95 over 300 ms.
  // @category: edge-case
  // @dependency: ThreadsService.list, thread-cursor, PostgresStore
  // @complexity: medium
  it(
    'AC-13.4: GET /api/threads p95 <= 300 ms with 200 threads',
    async () => {
      // Arrange: user = 'e2e-'+uuid; seed 200 threads with distinct updatedAt
      const user = perfUser();
      await seed(testApp.memory, {
        resourceId: user,
        threads: descendingDates(200, new Date('2026-04-01T12:00:00.000Z')).map(
          (updatedAt) => ({ updatedAt }),
        ),
      });
      const http = request(testApp.app.getHttpServer());

      // Act: 5 warm-up GET /api/threads (discarded), then 50 sequential timed requests
      const durations = await measureSequential(
        () => http.get('/api/threads').set('x-user-id', user),
        (res) => {
          expect(res.status).toBe(200);
          expect(ThreadListResponseSchema.parse(res.body).threads).toHaveLength(
            20,
          );
        },
      );

      // Assert
      expect(durations).toHaveLength(50);
      console.info(`AC-13.4 p95 = ${durations[P95_INDEX].toFixed(1)} ms`);
      expect(durations[P95_INDEX]).toBeLessThanOrEqual(300);
    },
    PERF_TEST_TIMEOUT_MS,
  );

  // AC-14.4: "The system shall отвечать p95 ≤ 500 мс для беседы из 100 сообщений."
  // EARS: (none) -> basic
  // ROI: 2.1 | Business Value: 6 | Frequency: 9 | Defect detection: 3
  // Behavior: 100 seeded format-2 messages -> 50 timed history requests -> p95 within budget
  // Primary failure mode: per-message storage round-trips or repeated conversion push p95 over 500 ms.
  // @category: edge-case
  // @dependency: ThreadsService.listMessages, Memory.recall, toAISdkMessages, PostgresStore
  // @complexity: medium
  it(
    'AC-14.4: GET /api/threads/:threadId/messages p95 <= 500 ms with 100 messages',
    async () => {
      // Arrange: user = 'e2e-'+uuid; seed one thread with 100 messages (content.format = 2, alternating user/assistant)
      const user = perfUser();
      const { ids } = await seed(testApp.memory, {
        resourceId: user,
        threads: [
          { updatedAt: new Date('2026-04-01T12:00:00.000Z'), messages: 100 },
        ],
      });
      const threadId = ids.get(1);
      if (!threadId) throw new Error('seed returned no thread id');
      const http = request(testApp.app.getHttpServer());

      // Act: 5 warm-up GET /api/threads/:threadId/messages (discarded), then 50 sequential timed requests
      const durations = await measureSequential(
        () =>
          http.get(`/api/threads/${threadId}/messages`).set('x-user-id', user),
        (res) => {
          expect(res.status).toBe(200);
          expect(
            ThreadMessagesResponseSchema.parse(res.body).messages,
          ).toHaveLength(100);
        },
      );

      // Assert
      expect(durations).toHaveLength(50);
      console.info(`AC-14.4 p95 = ${durations[P95_INDEX].toFixed(1)} ms`);
      expect(durations[P95_INDEX]).toBeLessThanOrEqual(500);
    },
    PERF_TEST_TIMEOUT_MS,
  );
});
