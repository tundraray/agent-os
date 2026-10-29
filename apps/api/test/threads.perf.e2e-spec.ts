// chat-shell / threads-api Performance Test - Design Doc: docs/features/chat-shell/design-threads-api.md (v1.2)
// Generated: 2026-10-28 | Part: threads-api | Test type: performance (integration harness, real Postgres)
// File name per Design Doc Test Strategy ("threads.perf.e2e-spec.ts"). Runs under `test:e2e`; if unstable on a slow
// machine the work plan may move it to a separate `test:perf` script (Design Doc decision deferred to the plan).
// Not counted against the integration budget: performance ACs are design-mandated and excluded from functional ROI.
//
// SKELETON ONLY: every case is `it.todo`.
//
// Method (Design Doc): seed data, 5 warm-up + 50 sequential requests, sort durations ascending,
// p95 = durations[ceil(0.95 * n) - 1] = durations[47] for n = 50. Local Postgres from infra/docker-compose.yml,
// unique `resourceId = 'e2e-' + randomUUID()`, afterAll cleanup. Mock models; no network.

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
  it.todo('AC-13.4: GET /api/threads p95 <= 300 ms with 200 threads', () => {
    // Arrange: user = 'e2e-'+uuid; seed 200 threads with distinct updatedAt
    // Act: 5 warm-up GET /api/threads (discarded), then 50 sequential GET /api/threads timed with performance.now()
    // Assert: every response 200 with 20 threads; sorted durations[47] <= 300 (ms)
  });

  // AC-14.4: "The system shall отвечать p95 ≤ 500 мс для беседы из 100 сообщений."
  // EARS: (none) -> basic
  // ROI: 2.1 | Business Value: 6 | Frequency: 9 | Defect detection: 3
  // Behavior: 100 seeded format-2 messages -> 50 timed history requests -> p95 within budget
  // Primary failure mode: per-message storage round-trips or repeated conversion push p95 over 500 ms.
  // @category: edge-case
  // @dependency: ThreadsService.listMessages, Memory.recall, toAISdkMessages, PostgresStore
  // @complexity: medium
  it.todo(
    'AC-14.4: GET /api/threads/:threadId/messages p95 <= 500 ms with 100 messages',
    () => {
      // Arrange: user = 'e2e-'+uuid; seed one thread with 100 messages (content.format = 2, alternating user/assistant)
      // Act: 5 warm-up GET /api/threads/:threadId/messages (discarded), then 50 sequential timed requests
      // Assert: every response 200 with messages.length === 100; sorted durations[47] <= 500 (ms)
    },
  );
});
