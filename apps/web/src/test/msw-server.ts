import type { AgentNode, AwaitingCount, SpendResponse } from '@agent-os/contracts';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { apiBaseUrl } from '@/lib/config';

/**
 * Reads the shell makes on every mount whatever the test is about: the «Агенты» counter (NV-01), the
 * month's spend (SP-01) and the agents of a thread in the delete dialog (MC-26). A test that cares
 * overrides them with `server.use(...)`.
 */
const shellDefaults = [
  http.get(`${apiBaseUrl}/api/agents/awaiting`, () => HttpResponse.json({ count: 0 } satisfies AwaitingCount)),
  http.get(`${apiBaseUrl}/api/spend`, () =>
    HttpResponse.json({ month: '2026-11', costUsd: 0 } satisfies SpendResponse),
  ),
  http.get(`${apiBaseUrl}/api/threads/:threadId/agents`, () => HttpResponse.json([] satisfies AgentNode[])),
];

/**
 * Shared MSW server for every test. Apart from the shell defaults above, each test declares the API
 * responses it relies on with `server.use(...)`, and any request without a handler fails the test
 * (`onUnhandledRequest: 'error'` in setup.ts). `resetHandlers()` keeps the defaults.
 */
export const server = setupServer(...shellDefaults);
