// custom-agents / runtime — on-demand measurement, not part of any suite (testing-principles: timing-sensitive
// checks live in a separate script). Run: `pnpm --filter api test:verify` (builds the workspace packages the API uses first).
// Design Doc: docs/features/custom-agents/design-runtime.md, Non-Functional Use Case UC-N1 (NFR-04).
// Budget: `.claude/skills/project-context/SKILL.md`, «Performance Requirements» — the time to the first token is no worse
// than before plus 50 ms. The chat listing is what the root's step now does before its model call, so one build of it
// (`listVisible` of the employee, the count of his sessions per record, `chatListing` within `CHAT_LISTING_BUDGET`) must
// take at most 50 ms (p95).
//
// One boot of the real `AppModule` with runtime workers and the real library. One employee owns a hundred records (agents
// and workflows, each with the longest description, so the listing runs past its budget and drops descriptions) and
// writes to his chat round after round. The tool registry times every build of the root's listing and logs it
// (`chat listing built`, `durationMs`); the script reads those records. The model is the scripted double: no provider is
// called.

import { randomUUID } from 'node:crypto';
import { RECORD_DESCRIPTION_MAX_LENGTH } from '@agent-os/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  allowRole,
  HAIKU_TEST_PRICES,
  removeRunRows,
  runModel,
  useRunModels,
} from '../support/access.js';
import { chatApi, waitFor } from '../support/api.js';
import { createTestApp } from '../support/createTestApp.js';
import {
  agentBody,
  createRecord,
  pointBuiltinsAt,
  recordName,
  workflowBody,
} from '../support/library.js';
import { createEmployee, seedSuperAdmin } from '../support/session.js';

/** The model of the built-in records and of the employee's records: a model of the run, allowed to him. */
const MODEL = runModel('chat-listing');
/** «Performance Requirements»: the time to the first token grows by at most this much, p95. */
const LISTING_P95_BUDGET_MS = 50;
/** UC-N1: the employee sees a hundred records; a fifth of them are workflows. */
const AGENTS = 80;
const WORKFLOWS = 20;
const WARM_UP_ROUNDS = 5;
const TIMED_ROUNDS = 30;
const MEASUREMENT_MS = 300_000;

/** The log record of one build of the root's listing (`tool-registry.ts`, `rootListing`). */
const ListingRecordSchema = z.object({
  message: z.literal('chat listing built'),
  fields: z.object({
    ownerId: z.string(),
    visible: z.number(),
    described: z.number(),
    length: z.number(),
    durationMs: z.number(),
  }),
});
type ListingRecord = z.infer<typeof ListingRecordSchema>['fields'];

/** The nearest-rank percentile `fraction` (0.5, 0.95). */
function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? Number.NaN;
}

/** The listing builds of `ownerId` among the captured console lines, in order. */
function listingsOf(
  lines: readonly string[],
  ownerId: string,
): ListingRecord[] {
  return lines.flatMap((line) => {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      return [];
    }
    const parsed = ListingRecordSchema.safeParse(record);
    return parsed.success && parsed.data.fields.ownerId === ownerId
      ? [parsed.data.fields]
      : [];
  });
}

/** A description of the longest length the library takes. */
function longDescription(name: string): string {
  return `${name}: `.padEnd(RECORD_DESCRIPTION_MAX_LENGTH, 'x');
}

describe('UC-N1: the chat listing of an employee who sees a hundred records stays in its budget', () => {
  it(
    'one build of the root listing (listVisible, the session counts, chatListing) is within the p95 budget',
    async () => {
      // Given: one app with runtime workers; the built-in records on the run's model
      const harness = await createTestApp({
        workers: true,
        captureLog: true,
      });
      let roleId: string | undefined;
      /** The administrator and the employee; his records go with him. */
      const users: string[] = [];
      let restoreBuiltins: (() => Promise<void>) | undefined;
      let restoreModels: (() => Promise<void>) | undefined;
      try {
        const task = 'UC-N1: hello';
        harness.model.completeText({ text: 'UC-N1' });
        harness.model.script({ task }, [], { thereafter: { text: 'Принято.' } });
        const admin = await seedSuperAdmin(
          harness.app,
          `verify-admin-${randomUUID()}`,
        );
        users.push(admin.id);
        restoreModels = await useRunModels(harness.app, admin, {
          chat: { id: MODEL, ...HAIKU_TEST_PRICES },
        });
        restoreBuiltins = await pointBuiltinsAt(harness.app, admin, MODEL);
        const role = await allowRole(harness.app, admin, {
          name: 'chat-listing',
          models: [MODEL],
          servers: [],
        });
        roleId = role.id;
        const owner = await createEmployee(harness.app, admin);
        users.push(owner.id);
        await role.add(owner);

        // Given: the employee's hundred records, each with the longest description
        for (let index = 1; index <= AGENTS; index += 1) {
          const name = recordName(`UC-N1 agent ${index}`);
          await createRecord(harness.app, owner, {
            ...agentBody(name, { model: MODEL }),
            description: longDescription(name),
          });
        }
        for (let index = 1; index <= WORKFLOWS; index += 1) {
          const name = recordName(`UC-N1 workflow ${index}`);
          await createRecord(harness.app, owner, {
            ...workflowBody(name, MODEL),
            description: longDescription(name),
          });
        }

        // When: he writes to his chat round after round; every root step builds the listing once
        const api = chatApi(harness.app, owner);
        const thread = await api.createThread();
        for (
          let round = 1;
          round <= WARM_UP_ROUNDS + TIMED_ROUNDS;
          round += 1
        ) {
          await api.send(thread.id, round === 1 ? task : `UC-N1: ${round}`);
          await waitFor(
            () => api.history(thread.id),
            (view) =>
              view.chat.status === 'idle' &&
              view.pending.length === 0 &&
              view.entries.filter((entry) => entry.kind === 'model_answer')
                .length === round,
            `the answer of round ${round}`,
          );
        }
        const builds = listingsOf(harness.log, owner.id);
        expect(builds).toHaveLength(WARM_UP_ROUNDS + TIMED_ROUNDS);
        const timed = builds.slice(WARM_UP_ROUNDS);
        const durationsMs = timed.map((build) => build.durationMs);

        // Then: the listing saw the hundred records and ran past its budget; p95 is within the budget (NFR-04)
        const [first] = timed;
        const p95Ms = percentile(durationsMs, 0.95);
        // Straight to stdout: the default reporter hides the logger lines the app writes.
        process.stdout.write(
          `UC-N1: the chat listing of an employee with a hundred records ${JSON.stringify(
            {
              builds: TIMED_ROUNDS,
              visible: first?.visible,
              described: first?.described,
              length: first?.length,
              p50Ms: percentile(durationsMs, 0.5),
              p95Ms,
              maxMs: Math.max(...durationsMs),
              budgetMs: LISTING_P95_BUDGET_MS,
            },
          )}
`,
        );
        expect(first?.visible ?? 0).toBeGreaterThanOrEqual(AGENTS + WORKFLOWS);
        expect(first?.described ?? 0).toBeLessThan(AGENTS + WORKFLOWS);
        expect(p95Ms, 'listing p95, ms').toBeLessThanOrEqual(
          LISTING_P95_BUDGET_MS,
        );
      } finally {
        try {
          try {
            await restoreBuiltins?.();
            await restoreModels?.();
          } finally {
            await removeRunRows(harness.pool, {
              models: [MODEL],
              roles: roleId === undefined ? [] : [roleId],
              users,
            });
          }
        } finally {
          await harness.close();
        }
      }
    },
    MEASUREMENT_MS,
  );
});
