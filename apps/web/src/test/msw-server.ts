import type {
  AgentNode,
  AwaitingCount,
  McpConnection,
  MyModels,
  RecordSummary,
  AgentTasksView,
  SpendResponse,
} from '@agent-os/contracts';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import {
  currentUser,
  knowledgeSettings,
  modelDefaults,
  modelProviderView,
  toolResultSettings,
} from './fixtures';

/**
 * Reads the shell makes on every mount whatever the test is about: the signed-in employee (UM-01, also
 * the probe of a closed live stream), the «Агенты» counter (NV-01), the month's spend (SP-01), the
 * employee's MCP connections behind the menu's «нужна аутентификация» dot (UM-01), the agents of a
 * thread in the delete dialog (MC-26) and the employee's models, read by «Мой доступ» (MA-02) and the
 * quota failure line (QS-01), and the library list behind the record labels of the conversation, the
 * agent page and the agent list (custom-agents design-web.md, KD-2). The model providers and the model
 * defaults are read by the grant dialog, the company record editor and the «Модели» section; a ready
 * `anthropic` keeps the models of today's tests selectable. The self-learning settings are read by the
 * «Системные» tab of «Агенты и глубокие агенты» (self-learning AS-01); the settings of large tool results by the
 * «MCP-серверы» list (tool-result-reading R-5). A session's task list is read by a deep agent's page and, for
 * the conversation's root, by the shell for the diagram panel (deep-agents DA-05, DA-12). A test that cares overrides them with
 * `server.use(...)`.
 */
const shellDefaults = [
  http.get('/api/auth/me', () => HttpResponse.json(currentUser())),
  http.get('/api/agents/awaiting', () =>
    HttpResponse.json({ count: 0 } satisfies AwaitingCount),
  ),
  http.get('/api/spend', () =>
    HttpResponse.json({ month: '2026-11', costUsd: 0 } satisfies SpendResponse),
  ),
  http.get('/api/mcp/connections', () =>
    HttpResponse.json([] satisfies McpConnection[]),
  ),
  http.get('/api/threads/:threadId/agents', () =>
    HttpResponse.json([] satisfies AgentNode[]),
  ),
  http.get('/api/agents/:agentId/tasks', () =>
    HttpResponse.json({ tasks: [], delegations: [] } satisfies AgentTasksView),
  ),
  http.get('/api/access/models', () =>
    HttpResponse.json({ month: '2026-11', models: [] } satisfies MyModels),
  ),
  http.get('/api/library', () =>
    HttpResponse.json([] satisfies RecordSummary[]),
  ),
  http.get('/api/admin/model-providers', () =>
    HttpResponse.json([modelProviderView()]),
  ),
  http.get('/api/admin/model-defaults', () =>
    HttpResponse.json(modelDefaults()),
  ),
  http.get('/api/admin/knowledge/settings', () =>
    HttpResponse.json(knowledgeSettings()),
  ),
  http.get('/api/admin/tool-results/settings', () =>
    HttpResponse.json(toolResultSettings()),
  ),
];

/**
 * Shared MSW server for every test. Apart from the shell defaults above, each test declares the API
 * responses it relies on with `server.use(...)`, and any request without a handler fails the test
 * (`onUnhandledRequest: 'error'` in setup.ts). `resetHandlers()` keeps the defaults.
 */
export const server = setupServer(...shellDefaults);
