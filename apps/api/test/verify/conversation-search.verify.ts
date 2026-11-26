// schedules-search-memory / conversation-search - on-demand measurement, not part of any suite (testing-principles: timing-sensitive
// checks live in a separate script). Run: `pnpm --filter api test:verify` against a test database only.
// Design Doc: docs/features/schedules-search-memory/design-conversation-search.md, Test Strategy UC-5 (NFR-01).
// Not counted in the integration budget (verify script, not run in CI).
//
// Shape (like chat-listing.verify.ts): one boot of the real `AppModule` without workers, one employee with 1 000 conversations that have
// sub-agents and stored tool results (rows written straight into the tables through the repositories of `@agent-os/db`, the model double
// is not called), then a set of queries - frequent and rare words, the first page and the following ones - timed on the route.

import { randomUUID } from 'node:crypto';
import {
  AGENT_TASK_TYPE,
  CHAT_TASK_TYPE,
  ConversationSearchResponseSchema,
} from '@agent-os/contracts';
import {
  ConversationsRepository,
  MessagesRepository,
  RuntimeTasksRepository,
  ToolResultsRepository,
} from '@agent-os/db';
import { describe, expect, it } from 'vitest';
import { removeRunRows } from '../support/access';
import { chatApi, expectBody } from '../support/api';
import { createTestApp } from '../support/createTestApp';
import { createEmployee, seedSuperAdmin } from '../support/session';

/** NFR-01: p95 of the route response with 1 000 conversations of one employee. */
const SEARCH_P95_BUDGET_MS = 1000;
const CONVERSATIONS = 1000;
/** Pages read of a frequent word: the first and the following ones. */
const PAGES = 5;
const ROUNDS = 10;
const MEASUREMENT_MS = 600_000;
/** A stored result of a size the reading tools page through. */
const RESULT_TEXT = Array.from(
  { length: 400 },
  (_, line) =>
    `${line} provider-adapter timeout payment-service request abandoned after local timeout`,
).join('\n');

/** The nearest-rank percentile `fraction` (0.5, 0.95). */
function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? Number.NaN;
}

describe('UC-5: the search of an employee with 1 000 conversations stays in its budget', () => {
  it(
    'p95 of GET /api/search over 1 000 conversations with sub-agents and tool results is at most 1 second',
    async () => {
      const harness = await createTestApp({ workers: false });
      const users: string[] = [];
      try {
        const admin = await seedSuperAdmin(
          harness.app,
          `verify-search-admin-${randomUUID()}`,
        );
        users.push(admin.id);
        const owner = await createEmployee(harness.app, admin);
        users.push(owner.id);
        const { rows } = await harness.pool.query<{ id: string }>(
          'select id from app.agent_versions order by created_at limit 1',
        );
        const agentVersionId = rows[0]?.id;
        if (agentVersionId === undefined) throw new Error('no agent version');

        // Given: 1 000 conversations, each with a sub-agent, a frequent word in the root's task, a rare word, and a stored result
        const tasks = harness.app.get(RuntimeTasksRepository);
        const conversations = harness.app.get(ConversationsRepository);
        const entries = harness.app.get(MessagesRepository);
        const results = harness.app.get(ToolResultsRepository);
        const session = {
          ownerId: owner.id,
          model: 'verify-model',
          agentVersionId,
          subagent: null,
          firstRun: false,
          forkedThroughSeq: null,
        };
        for (let n = 1; n <= CONVERSATIONS; n += 1) {
          const rootId = randomUUID();
          const childId = randomUUID();
          const callId = `call-${n}`;
          await tasks.insert({
            taskId: rootId,
            type: CHAT_TASK_TYPE,
            ownerId: owner.id,
            parentId: null,
            rootId,
            depth: 0,
            input: {},
            awaitedStep: null,
            exclusiveKey: null,
            waiting: true,
          });
          await conversations.create(
            {
              ...session,
              id: rootId,
              parentId: null,
              startCallId: null,
              name: 'Главный чат',
              description: '',
            },
            {
              text: `Квартальный отчёт по клиенту редкость${n}х`,
              record: null,
              schedule: null,
            },
          );
          await tasks.insert({
            taskId: childId,
            type: AGENT_TASK_TYPE,
            ownerId: owner.id,
            parentId: rootId,
            rootId,
            depth: 1,
            input: {},
            awaitedStep: null,
            exclusiveKey: null,
            waiting: true,
          });
          await conversations.create(
            {
              ...session,
              id: childId,
              parentId: rootId,
              startCallId: `start-${n}`,
              name: 'general-purpose',
              description: 'Разбор логов',
            },
            { text: `Разбери логи клиента ${n}`, record: null, schedule: null },
          );
          await entries.insert([
            {
              conversationId: childId,
              seq: 2,
              kind: 'model_answer',
              content: { text: 'Читаю логи.', toolCalls: [] },
              callId: null,
            },
            {
              conversationId: childId,
              seq: 3,
              kind: 'tool_result',
              content: {
                callId,
                tool: 'search_logs',
                text: `[stored result] ${RESULT_TEXT.slice(0, 200)}`,
              },
              callId,
            },
          ]);
          await results.insert({
            taskId: childId,
            callId,
            value: {},
            text: RESULT_TEXT,
          });
        }

        // When: frequent and rare words, the first page and the following ones, timed on the route
        const api = chatApi(harness.app, owner);
        const durationsMs: number[] = [];
        const timed = async (q: string, cursor?: string) => {
          const query = new URLSearchParams({ q });
          if (cursor !== undefined) query.set('cursor', cursor);
          const startedAt = performance.now();
          const page = await expectBody(
            api.raw('get', `/search?${query.toString()}`),
            200,
            ConversationSearchResponseSchema,
          );
          durationsMs.push(performance.now() - startedAt);
          return page;
        };
        for (let round = 1; round <= ROUNDS; round += 1) {
          for (const frequent of ['отчёт', 'provider-adapter', 'логи']) {
            let cursor: string | undefined;
            for (let page = 1; page <= PAGES; page += 1) {
              const found = await timed(frequent, cursor);
              expect(found.matches).toHaveLength(20);
              cursor = found.nextCursor ?? undefined;
            }
          }
          const rare = await timed(`редкость${round * 97}х`);
          expect(rare.matches).toHaveLength(1);
        }

        // Then: p95 is within the budget (NFR-01)
        const p95Ms = percentile(durationsMs, 0.95);
        // Straight to stdout: the default reporter hides the logger lines the app writes.
        process.stdout.write(
          `UC-5: conversation search over ${CONVERSATIONS} conversations ${JSON.stringify(
            {
              requests: durationsMs.length,
              p50Ms: Math.round(percentile(durationsMs, 0.5)),
              p95Ms: Math.round(p95Ms),
              maxMs: Math.round(Math.max(...durationsMs)),
              budgetMs: SEARCH_P95_BUDGET_MS,
            },
          )}\n`,
        );
        expect(p95Ms, 'search p95, ms').toBeLessThanOrEqual(
          SEARCH_P95_BUDGET_MS,
        );
      } finally {
        try {
          await removeRunRows(harness.pool, { models: [], roles: [], users });
        } finally {
          await harness.close();
        }
      }
    },
    MEASUREMENT_MS,
  );
});
