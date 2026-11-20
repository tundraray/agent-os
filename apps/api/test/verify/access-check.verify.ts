// enterprise-access / access — on-demand measurement, not part of any suite (testing-principles: timing-sensitive
// checks live in a separate script). Run: `pnpm --filter api test:verify` (builds the workspace packages the API uses first).
// Design Doc: docs/features/enterprise-access/design-access.md, Non-Functional Use Case UC-N1 (NFR-04).
// Budget: `.claude/skills/project-context/SKILL.md`, «Performance Requirements» — the check before a model call adds
// at most 50 ms (p95) to the time to the first token.
//
// One boot of the real `AppModule` with the fixture MCP servers registered under the run's names. One employee sits in
// ten roles of the run that hold a hundred rights between them (the three servers and the seven tools of the fixture
// sources), and one of the roles allows the run's model with a quota. The script times `AccessService.model` itself:
// the time to the first token with and without the check differs by exactly this call (the provider here is scripted).

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { AccessService } from '../../src/access/access.service.js';
import {
  allowRole,
  grantTo,
  HAIKU_TEST_PRICES,
  removeRunRows,
  runModel,
  useRunModels,
} from '../support/access.js';
import { createTestApp } from '../support/createTestApp.js';
import { runName } from '../support/mcp-servers.js';
import { createEmployee, seedSuperAdmin } from '../support/session.js';

const MODEL = runModel('n1');
/** «Performance Requirements»: the check adds at most this much, p95. */
const CHECK_P95_BUDGET_MS = 50;
const WARM_UP_CALLS = 20;
const TIMED_CALLS = 100;
const ROLES = 10;
const QUOTA_USD = 1_000;
const MEASUREMENT_MS = 120_000;

/** The sources of the fixture process and the tools each of them lists. */
const TOOLS_OF_SOURCE = {
  logs: ['search_logs', 'aggregate_logs', 'get_trace'],
  backoffice: ['search_orders', 'get_order', 'create_incident_note'],
  tracker: ['search_tickets'],
} as const;

/** The nearest-rank percentile `fraction` (0.5, 0.95). */
function percentile(values: readonly number[], fraction: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1] ?? Number.NaN;
}

describe('UC-N1: the check before a model call stays in its budget for an employee with a hundred rights', () => {
  it(
    'AccessService.model of an employee in ten roles and a hundred rights, with a quota, is within the p95 budget',
    async () => {
      // Given: one app with the run's servers registered and the run's model as the default
      const harness = await createTestApp({
        mcpServers: ['logs', 'backoffice', 'tracker'],
      });
      const roles: string[] = [];
      const users: string[] = [];
      let restoreModels: (() => Promise<void>) | undefined;
      try {
        const admin = await seedSuperAdmin(
          harness.app,
          `verify-admin-${randomUUID()}`,
        );
        users.push(admin.id);
        restoreModels = await useRunModels(harness.app, admin, {
          chat: { id: MODEL, ...HAIKU_TEST_PRICES },
        });
        const owner = await createEmployee(harness.app, admin);
        users.push(owner.id);

        // Given: ten roles of ten rights each — the three servers and the seven tools — and the model with a quota
        const servers = Object.keys(TOOLS_OF_SOURCE) as Array<
          keyof typeof TOOLS_OF_SOURCE
        >;
        for (let index = 0; index < ROLES; index += 1) {
          const role = await allowRole(harness.app, admin, {
            name: `n1-${index}`,
            models: [],
            servers: servers.map(runName),
          });
          roles.push(role.id);
          for (const source of servers)
            for (const tool of TOOLS_OF_SOURCE[source])
              await grantTo(
                harness.app,
                admin,
                { roleId: role.id },
                {
                  effect: 'allow',
                  target: { kind: 'tool', server: runName(source), tool },
                },
              );
          await role.add(owner);
        }
        const [firstRole] = roles;
        await grantTo(
          harness.app,
          admin,
          { roleId: firstRole as string },
          {
            effect: 'allow',
            target: { kind: 'model', model: MODEL },
            quotaUsd: QUOTA_USD,
          },
        );

        // When: the check runs, warm-up calls first
        const access = harness.app.get(AccessService);
        const durationsMs: number[] = [];
        for (let call = 1; call <= WARM_UP_CALLS + TIMED_CALLS; call += 1) {
          const startedAt = performance.now();
          const verdict = await access.model(owner.id, MODEL);
          const durationMs = performance.now() - startedAt;
          expect(verdict.kind).toBe('allowed');
          if (call > WARM_UP_CALLS) durationsMs.push(durationMs);
        }

        // Then: p95 is within the budget (NFR-04)
        const p50Ms = percentile(durationsMs, 0.5);
        const p95Ms = percentile(durationsMs, 0.95);
        // Straight to stdout: the default reporter hides the logger lines the app writes.
        process.stdout.write(
          `UC-N1: AccessService.model for an employee in ten roles ${JSON.stringify(
            {
              calls: TIMED_CALLS,
              rights: ROLES * 10 + 1,
              p50Ms: Math.round(p50Ms * 100) / 100,
              p95Ms: Math.round(p95Ms * 100) / 100,
              maxMs: Math.round(Math.max(...durationsMs) * 100) / 100,
              budgetMs: CHECK_P95_BUDGET_MS,
            },
          )}
`,
        );
        expect(p95Ms, 'check p95, ms').toBeLessThanOrEqual(CHECK_P95_BUDGET_MS);
      } finally {
        try {
          await restoreModels?.();
          await removeRunRows(harness.pool, { models: [MODEL], roles, users });
        } finally {
          await harness.close();
        }
      }
    },
    MEASUREMENT_MS,
  );
});
