// source-planning / catalog-planning E2E Test Skeletons (api process) - Design Doc: docs/features/source-planning/design-catalog-planning.md (v1.2, approved 2026-11-10)
// PRD: docs/features/source-planning/prd.md (FR-01, FR-03, FR-04, FR-08, FR-09; AC-01.2, AC-09.2, AC-08.x as the employee meets them). UXRD: deep-research/uxrd.md (MC-31..MC-33, the "no sources" flow) - read, not changed by this part.
// Generated: 2026-11-10 | Part: catalog-planning | Test type: End-to-End (a built api process + real runtime + real engine + the TWO real fixture processes + real Postgres; scripted models), CI job `e2e` of apps/api
// Implementation timing: after all catalog-planning slices land (final phase only).
// Counterpart in-process files: packages/engine/test/source-planning-catalog-planning.int.e2e-spec.ts (INT-1..INT-3, scripted tool calls, counting sources) and apps/api/test/source-planning-catalog-planning.int.e2e-spec.ts (INT-4).
// The rules and the wiring of the engine are proven there; this file proves only what a built server with real MCP processes and a restart adds.
//
// Generated as `it.todo` skeletons. Implement each todo following its Given/When/Then comments. Do not convert a todo into a passing stub.
//
// Environment:
// - Postgres 16 from infra/docker-compose.yml; a scratch database per row; the api child booted in the research-flow mode of test/support/chatEntryChild.ts (`pnpm --filter api build:child` first), with
//   `SOURCE_ACCESS_TABLE` set per row and BOTH fixture processes (`logs`, `backoffice`) started by the real `SourcesModule` on one `FIXTURE_SCENARIO` (`two-sources`).
// - Doubles are the model boundary only: the scripted chat model (one `deepResearch` call, then plain replies) and the scripted agents of the shipped v3 behind `ENGINE_RESOLVE_MODEL` (test/support/engineScriptedRoles.ts, researchFlowAgents.ts).
//   No network, no API key. No test asserts on keywords of model text.
// - Isolation: a unique user per row (`x-user-id`); the file runs with `fileParallelism: false`; no latency assertions; the wait for each end state is the harness timeout.
//
// Support the plan must add: the child's `SOURCE_ACCESS_TABLE` per session (and a way to restart the same session's child with a different value, S2); scripted agents of the two-source journey in researchFlowAgents.ts
// (planner names `fixture`; worker gathers from both; for S2 the worker asks `backoffice` before and after the restart); the transcript reader of the existing harness (`ENGINE_JOURNEY`).
//
// Budget: E2E 1 of 2 for the part, one journey in three rows. It stays at this level because nothing below can prove it: the real MCP servers' own tool texts (AC-01.2), the table and the declaration composed by the built server,
//   a restart between two calls of one investigation (the catalog lives in the row, the table is read once at start of the process), and the offer card that reads the deployment flag while the run reads its own mode.
//
// AC -> proving test: AC-01.2 (declared description in every transcript, the MCP server's text in none) and AC-04.3 / AC-07.1 as seen by the employee-side run: S1;
//   AC-08.1, AC-08.2 across a restart (Flow 2 of the Design Doc): S2; AC-09.2 (the offer without the no-sources warning; the running card and the answer with it) and AC-09.1 end to end: S3.

import { randomUUID } from 'node:crypto';
import {
  type HistoryMessage,
  RESEARCH_METADATA_KEYS,
  ResearchAnswerMetadataSchema,
  ThreadMessagesResponseSchema,
  ThreadResearchResponseSchema,
  ThreadSummarySchema,
} from '@agent-os/contracts';
import { BACKOFFICE_SOURCE_ID, FIXTURE_SOURCE_ID } from '@agent-os/sources';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SOURCES_DECLARATION } from '../src/sources/sources.config.js';
import {
  aliveChildren,
  BACKOFFICE_TOOLS,
  type ChatEntryChild,
  type ChatEntrySession,
  type ChildApi,
  dropLeftoverDatabases,
  withChatEntrySession,
} from './support/chatEntryChild.js';
import {
  TWO_SOURCES_TEXTS,
  twoSourcesFacts,
} from './support/engineScriptedRoles.js';
import { newUser } from './support/seed.js';

/** Harness timeout of a row: a boot (two for S2), one investigation on the shipped v3 with two fixture processes. */
const RUN_TIMEOUT_MS = 240_000;

const FIXTURE = FIXTURE_SOURCE_ID;
const BACKOFFICE = BACKOFFICE_SOURCE_ID;

/**
 * What the fixture MCP server reports in `tools/list` for the two tools the journey calls
 * (packages/mcp-fixture/src/tools/search-logs.ts, search-orders.ts), as literals: AC-01.2 says no agent ever reads them.
 */
const SERVER_TOOL_TEXTS = [
  'Search payment logs in [from, to) with optional service, level, event and status filters. ' +
    'Returns up to pageSize records in time order; pass nextCursor back as cursor for the next page.',
  'Search back-office orders created in [from, to) with optional status (paid, failed) and paymentMethod filters. ' +
    'Returns up to pageSize orders in time order; pass nextCursor back as cursor for the next page.',
] as const;

/** deep-research UXRD, Microcopy: the texts of an answer from model knowledge. */
const MC_32_WITHOUT_SOURCES =
  'Источники данных не подключены — ответ опирается только на знания модели и не проверен по данным.';
const MC_33_MODEL_KNOWLEDGE = 'из знаний модели, без источника';

/** The shipped declaration of a source: the descriptions an agent may see (the real one, not a copy of the harness). */
function declared(sourceId: string) {
  const source = SOURCES_DECLARATION.find((one) => one.sourceId === sourceId);
  if (source === undefined) throw new Error(`${sourceId} is not declared`);
  return source;
}

/** `SOURCE_ACCESS_TABLE` of a child: `user` may read `sources`. */
const accessTable = (user: string, sources: readonly string[]): string =>
  JSON.stringify({ [user]: sources });

/** A user message as the web sends it; `metadata` carries the research mode or a decision. */
function userMessage(text: string, metadata?: Record<string, unknown>) {
  return {
    id: `client-${randomUUID()}`,
    role: 'user',
    parts: [{ type: 'text', text }],
    ...(metadata && { metadata }),
  };
}

async function newThread(api: ChildApi, user: string): Promise<string> {
  const created = await api(user, '/api/threads', { method: 'POST' });
  expect(created.status).toBe(201);
  return ThreadSummarySchema.parse(await created.json()).id;
}

/**
 * Sends one chat turn, reads its stream to the end and waits until the thread has no run mark left (Mastra has saved
 * the turn), so the next turn of the thread starts after it.
 */
async function chatTurn(
  session: ChatEntrySession,
  child: ChatEntryChild,
  turn: {
    api: ChildApi;
    user: string;
    threadId: string;
    message: ReturnType<typeof userMessage>;
  },
): Promise<void> {
  const response = await turn.api(turn.user, '/api/chat/assistant', {
    method: 'POST',
    body: JSON.stringify({ id: turn.threadId, messages: [turn.message] }),
  });
  await response.text();
  expect(response.status).toBe(200);
  await session.until('the chat turn released', child, async () => {
    const [row] = await session.query<{ runs: number }>(
      'SELECT count(*)::int AS runs FROM app.chat_thread_runs WHERE thread_id = $1',
      [turn.threadId],
    );
    return row?.runs === 0 ? true : undefined;
  });
}

/** A research mode turn: the chat model calls `deepResearch` with the recorded question of the two-source set. */
const researchModeMessage = () =>
  userMessage(`Разберись: ${twoSourcesFacts().question}`, {
    [RESEARCH_METADATA_KEYS.deepResearch]: true,
  });

interface LaunchRow {
  readonly launchKey: string;
  readonly state: string;
  readonly investigationId: string | null;
}

async function launchOf(
  session: ChatEntrySession,
  user: string,
  threadId: string,
): Promise<LaunchRow | undefined> {
  const [row] = await session.query<LaunchRow>(
    `SELECT launch_key AS "launchKey", state, investigation_id AS "investigationId"
       FROM app.research_chat_launches WHERE resource_id = $1 AND thread_id = $2`,
    [user, threadId],
  );
  return row;
}

/** Waits until the thread's one launch has delivered its answer; returns its investigation. */
async function answeredInvestigation(
  session: ChatEntrySession,
  child: ChatEntryChild,
  user: string,
  threadId: string,
): Promise<{ launchKey: string; investigationId: string }> {
  return session.until('the answer delivered', child, async () => {
    const row = await launchOf(session, user, threadId);
    return row?.state === 'answered' && row.investigationId !== null
      ? { launchKey: row.launchKey, investigationId: row.investigationId }
      : undefined;
  });
}

/** The investigation's status and the mode and catalog its engine row holds. */
async function investigationRow(
  session: ChatEntrySession,
  investigationId: string,
) {
  const [row] = await session.query<{
    status: string;
    sourceMode: string;
    sourceCatalog: {
      sourceId: string;
      description: string;
      tools: { toolName: string; description: string }[];
      snapshot: string | null;
    }[];
  }>(
    `SELECT i.status, r.source_mode AS "sourceMode", r.source_catalog AS "sourceCatalog"
       FROM app.research_investigations i
       JOIN app.research_engine_runs r USING (investigation_id)
      WHERE i.investigation_id = $1`,
    [investigationId],
  );
  if (row === undefined) throw new Error(`no engine row of ${investigationId}`);
  return row;
}

/** The agent runs of the investigation: name and depth, oldest first. */
function agentRuns(session: ChatEntrySession, investigationId: string) {
  return session.query<{ agentName: string; depth: number }>(
    `SELECT agent_name AS "agentName", depth FROM app.research_agent_runs
      WHERE investigation_id = $1 ORDER BY created_at, task_id`,
    [investigationId],
  );
}

/** The `gather` calls of the investigation in request order, each with its audit row. */
function gatherCalls(session: ChatEntrySession, investigationId: string) {
  return session.query<{
    state: string;
    outcome: string | null;
    reason: string | null;
    returned: number | null;
    sourceId: string | null;
    auditSourceId: string | null;
    auditOutcome: string | null;
    auditResourceId: string | null;
    auditToolName: string | null;
    auditRecordedAt: Date | null;
  }>(
    `SELECT c.state, c.outcome->>'outcome' AS outcome, c.reason,
            (c.outcome->'result'->>'returned')::int AS returned, c.arguments->>'sourceId' AS "sourceId",
            a.source_id AS "auditSourceId", a.outcome AS "auditOutcome", a.resource_id AS "auditResourceId",
            a.tool_name AS "auditToolName", a.recorded_at AS "auditRecordedAt"
       FROM app.research_agent_tool_calls c
       LEFT JOIN app.agent_tool_audit a ON a.id = c.audit_id
      WHERE c.investigation_id = $1 AND c.tool_name = 'gather'
      ORDER BY c.created_at, c.call_index`,
    [investigationId],
  );
}

/** Every string inside a stored value, joined: what a transcript's input put in front of the model. */
function textsOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textsOf).join('\n');
  if (value !== null && typeof value === 'object') {
    return Object.values(value).map(textsOf).join('\n');
  }
  return '';
}

/** The input of every model call of the investigation as text, with the agent that made it (null outside a run). */
async function transcriptTexts(
  session: ChatEntrySession,
  investigationId: string,
): Promise<{ agentName: string | null; text: string }[]> {
  const rows = await session.query<{
    agentName: string | null;
    input: unknown;
  }>(
    `SELECT r.agent_name AS "agentName", t.input
       FROM app.research_llm_transcripts t
       LEFT JOIN app.research_agent_runs r ON r.task_id = t.task_id
      WHERE t.investigation_id = $1
      ORDER BY t.created_at, t.call_id`,
    [investigationId],
  );
  return rows.map((row) => ({
    agentName: row.agentName,
    text: textsOf(row.input),
  }));
}

/** The answer message of the investigation in the conversation, as the web reads it. */
async function answerMessage(
  api: ChildApi,
  user: string,
  threadId: string,
  investigationId: string,
) {
  const history = ThreadMessagesResponseSchema.parse(
    await (await api(user, `/api/threads/${threadId}/messages`)).json(),
  ).messages;
  const message: HistoryMessage | undefined = history.find(
    (one) => one.id === `research-answer-${investigationId}`,
  );
  expect(message?.role).toBe('assistant');
  const metadata = ResearchAnswerMetadataSchema.parse(
    (message?.metadata as Record<string, unknown> | undefined)?.[
      RESEARCH_METADATA_KEYS.researchAnswer
    ],
  );
  const text = (message?.parts ?? [])
    .flatMap((part) =>
      part.type === 'text' && typeof part.text === 'string' ? [part.text] : [],
    )
    .join('');
  return { metadata, text };
}

/** The cited pages of an answer as `[sourceId, toolName]`, sorted. */
const citedSources = (metadata: {
  sources: { sourceId: string; toolName: string }[];
}) =>
  metadata.sources
    .map((source) => `${source.sourceId} ${source.toolName}`)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((pair) => pair.split(' '));

/** The thread's launch cards, as the web reads them. */
async function launchCards(api: ChildApi, user: string, threadId: string) {
  const response = await api(user, `/api/threads/${threadId}/research`);
  expect(response.status).toBe(200);
  return ThreadResearchResponseSchema.parse(await response.json()).launches;
}

describe('source-planning / catalog-planning - E2E (built api process, two real fixture processes, real Postgres)', () => {
  describe('E2E-1: the employee journey over the catalog', () => {
    beforeAll(async () => {
      await dropLeftoverDatabases();
    });

    // Every child of a row is killed and its scratch database dropped by the harness; none may outlive the file.
    afterAll(() => {
      expect(aliveChildren()).toEqual([]);
    });

    // S1 - UC-1 / AC-01.2: a question answered over both sources
    // AC: AC-01.2 "the MCP server reports a tool description different from the declared one: every agent's transcript has the declared text and none of the server's text"
    // Given: `SOURCE_ACCESS_TABLE` lets the user read `fixture` and `backoffice`; the question is the recorded two-source question of the `two-sources` set.
    // When: the user sends it in the conversation; the scripted agents plan with `fixture` only, the worker gathers from both real processes.
    // Then: the investigation ends with an answer in the conversation; the run's catalog shows both sources; the worker's transcript holds the declared description of each source and tool, and not the text the fixture server reports for the same tool;
    //   records from `backoffice` appear in the evidence.
    // Behavior: built server -> declaration + table -> catalog -> real MCP tools/list text ignored, declared text shown -> answer
    // Catches: the server-reported description reaching an agent (the injection path AC-01.2 closes); the second fixture process not started or not given the same scenario (no matching order in the back office); the shipped declaration not fitting the shipped v3 limits.
    // @category: e2e
    // @dependency: full-system
    // @complexity: high
    it(
      'E2E-1 S1 (UC-1, AC-01.2): the two-source question ends with an answer; transcripts carry the declared descriptions, not the MCP server text',
      async () => {
        const user = newUser();

        await withChatEntrySession(
          async (session) => {
            // The shipped declaration fits the shipped v3: the server starts with both sources.
            const { child, api } = await session.start();
            const threadId = await newThread(api, user);

            await chatTurn(session, child, {
              api,
              user,
              threadId,
              message: researchModeMessage(),
            });
            const { investigationId } = await answeredInvestigation(
              session,
              child,
              user,
              threadId,
            );

            // The run's catalog: both sources, with the declared descriptions only.
            const run = await investigationRow(session, investigationId);
            expect([run.status, run.sourceMode]).toEqual([
              'completed',
              'sources',
            ]);
            expect(run.sourceCatalog.map((source) => source.sourceId)).toEqual([
              BACKOFFICE,
              FIXTURE,
            ]);
            for (const source of run.sourceCatalog) {
              const declaration = declared(source.sourceId);
              expect(source.description).toBe(declaration.description);
              expect(source.tools.length).toBeGreaterThan(0);
              for (const tool of source.tools) {
                expect(tool.description).toBe(
                  declaration.tools.find((one) => one.name === tool.toolName)
                    ?.description,
                );
              }
            }

            // The worker gathered from both real processes: one call each, served by two processes.
            const calls = session.fixtureCalls();
            const logCalls = calls.filter(
              (call) => call.tool === 'search_logs',
            );
            const orderCalls = calls.filter(
              (call) => call.tool === 'search_orders',
            );
            expect([logCalls.length, orderCalls.length]).toEqual([1, 1]);
            expect(logCalls[0]?.pid).not.toBe(orderCalls[0]?.pid);

            // AC-01.2: the worker was shown the declared description of each source and of each tool it called…
            const transcripts = await transcriptTexts(session, investigationId);
            const worker = transcripts
              .filter((one) => one.agentName === 'worker')
              .map((one) => one.text)
              .join('\n');
            expect(worker).not.toBe('');
            const workerTools: Readonly<Record<string, string>> = {
              [FIXTURE]: 'search_logs',
              [BACKOFFICE]: 'search_orders',
            };
            for (const sourceId of [FIXTURE, BACKOFFICE]) {
              const declaration = declared(sourceId);
              expect(worker).toContain(declaration.description);
              const toolText = declaration.tools.find(
                (tool) => tool.name === workerTools[sourceId],
              )?.description;
              expect(toolText).toBeDefined();
              expect(worker).toContain(toolText);
            }
            // …and no agent was ever shown what the MCP server reports about those tools.
            expect(transcripts.length).toBeGreaterThan(0);
            for (const { agentName, text } of transcripts) {
              for (const serverText of SERVER_TOOL_TEXTS) {
                expect(text, `transcript of ${agentName}`).not.toContain(
                  serverText,
                );
              }
            }

            // The back office returned orders of the same scenario, and its page is evidence the answer cites.
            const gathers = await gatherCalls(session, investigationId);
            expect(
              gathers.map((call) => [
                call.sourceId,
                call.state,
                call.auditSourceId,
              ]),
            ).toEqual([
              [FIXTURE, 'done', FIXTURE],
              [BACKOFFICE, 'done', BACKOFFICE],
            ]);
            expect(
              gathers.find((call) => call.sourceId === BACKOFFICE)?.returned,
            ).toBeGreaterThan(0);
            const evidence = await session.query<{ sourceId: string }>(
              `SELECT provenance->>'sourceId' AS "sourceId" FROM app.research_evidence
                WHERE investigation_id = $1 ORDER BY 1`,
              [investigationId],
            );
            expect(evidence.map((page) => page.sourceId)).toEqual([
              BACKOFFICE,
              FIXTURE,
            ]);

            // The answer in the conversation cites both sources.
            const { metadata } = await answerMessage(
              api,
              user,
              threadId,
              investigationId,
            );
            expect(metadata.sourceMode).toBe('sources');
            expect(citedSources(metadata)).toEqual([
              [BACKOFFICE, 'search_orders'],
              [FIXTURE, 'search_logs'],
            ]);

            expect(await child.stop()).toBe(0);
          },
          'research-flow',
          undefined,
          {
            sourceAccessTable: accessTable(user, [FIXTURE, BACKOFFICE]),
            journey: 'two-sources',
          },
        );
      },
      RUN_TIMEOUT_MS,
    );

    // S2 - UC-E5 across a restart (Flow 2): the right is taken away while the investigation lives
    // AC: AC-08.1 "the source is not called, the audit has a refusal with employee, source, tool and time, the worker continues"; AC-08.2 "no new audit row for the source after the first refusal"
    // Given: a user allowed both sources; an investigation on the catalog [fixture, backoffice] with a page already gathered from `backoffice`; the server is stopped between the worker's turns.
    // When: the server is started again with `SOURCE_ACCESS_TABLE` allowing only `fixture`; the investigation continues and the worker asks `backoffice` twice, then `fixture`.
    // Then: the catalog row of the investigation is unchanged (still two sources); the first `backoffice` call is `access_denied` with an audit row naming the source; the second is `source_revoked`; the `backoffice` process receives no call after the restart
    //   (its call log); the audit holds no further row naming `backoffice`; the `fixture` gather succeeds and the investigation ends with an answer.
    // Behavior: restart with a narrower table -> catalog read from the row -> port denies -> later calls refused from the recorded fact
    // Catches: the catalog rebuilt from the new table after the restart (the investigation silently losing a source, or a second root); the denial not recorded in a way that survives the restart.
    // @category: e2e
    // @dependency: full-system
    // @complexity: high
    it(
      'E2E-1 S2 (UC-E5, Flow 2): after a restart with a narrower table the catalog stays, backoffice is denied once and then revoked, no audit row after the first denial',
      async () => {
        const user = newUser();

        await withChatEntrySession(
          async (session) => {
            // The first server: both sources allowed; its worker gathers one back-office page, then its next turn waits.
            const first = await session.start();
            const threadId = await newThread(first.api, user);
            await chatTurn(session, first.child, {
              api: first.api,
              user,
              threadId,
              message: researchModeMessage(),
            });
            const investigationId = await session.until(
              'the investigation started',
              first.child,
              async () =>
                (await launchOf(session, user, threadId))?.investigationId ??
                undefined,
            );
            await session.until(
              'the worker held after its back-office page',
              first.child,
              async () => {
                const gathers = await gatherCalls(session, investigationId);
                const [open] = await session.query<{ turns: number }>(
                  `SELECT count(*)::int AS turns FROM app.research_llm_transcripts t
                     JOIN app.research_agent_runs r ON r.task_id = t.task_id
                    WHERE t.investigation_id = $1 AND r.agent_name = 'worker' AND t.outcome IS NULL`,
                  [investigationId],
                );
                return gathers.length === 1 &&
                  gathers[0]?.state === 'done' &&
                  open?.turns === 1
                  ? true
                  : undefined;
              },
            );
            const catalogBefore = (
              await investigationRow(session, investigationId)
            ).sourceCatalog;
            expect(catalogBefore.map((source) => source.sourceId)).toEqual([
              BACKOFFICE,
              FIXTURE,
            ]);
            expect(await first.child.stop()).toBe(0);
            const callsBefore = session.fixtureCalls();
            expect(
              callsBefore
                .filter((call) => BACKOFFICE_TOOLS.has(call.tool))
                .map((call) => call.tool),
            ).toEqual(['search_orders']);

            // The second server on the same database: the table allows only the logs.
            const second = await session.start(undefined, {
              sourceAccessTable: accessTable(user, [FIXTURE]),
              journey: 'revocation-resume',
            });
            await answeredInvestigation(session, second.child, user, threadId);

            // The catalog is the row's, not the new table's: unchanged, and still one root.
            const run = await investigationRow(session, investigationId);
            expect(run.sourceCatalog).toEqual(catalogBefore);
            expect([run.status, run.sourceMode]).toEqual([
              'completed',
              'sources',
            ]);
            expect(
              (await agentRuns(session, investigationId)).filter(
                (one) => one.depth === 0,
              ),
            ).toEqual([{ agentName: 'controller', depth: 0 }]);

            // AC-08.1: the first back-office call after the restart is denied by the port and audited with the employee,
            // the tool, the source and the time; AC-08.2: the second is refused from that recorded denial, its audit row
            // names no source; the logs gather goes through.
            const gathers = await gatherCalls(session, investigationId);
            expect(
              gathers.map((call) => [
                call.sourceId,
                call.state,
                call.outcome,
                call.reason,
                call.auditSourceId,
                call.auditOutcome,
                call.auditResourceId,
              ]),
            ).toEqual([
              [
                BACKOFFICE,
                'done',
                'success',
                null,
                BACKOFFICE,
                'success',
                user,
              ],
              [
                BACKOFFICE,
                'rejected',
                'access_denied',
                'access_denied',
                BACKOFFICE,
                'access_denied',
                user,
              ],
              [
                BACKOFFICE,
                'rejected',
                'rejected',
                'source_revoked',
                null,
                'rejected',
                user,
              ],
              [FIXTURE, 'done', 'success', null, FIXTURE, 'success', user],
            ]);
            const denied = gathers[1];
            expect(denied?.auditToolName).toBe('gather');
            expect(denied?.auditRecordedAt).toBeInstanceOf(Date);

            // AC-08.2 (invariant 4): after the first denial the audit names the back office nowhere again.
            const backofficeAudit = await session.query<{ outcome: string }>(
              `SELECT outcome FROM app.agent_tool_audit
                WHERE resource_id = $1 AND source_id = $2 ORDER BY recorded_at, id`,
              [user, BACKOFFICE],
            );
            expect(backofficeAudit.map((row) => row.outcome)).toEqual([
              'success',
              'access_denied',
            ]);

            // NFR-01: the back-office process got no call after the restart; the logs process of the new server got one.
            const callsAfter = session.fixtureCalls().slice(callsBefore.length);
            expect(
              callsAfter.filter((call) => BACKOFFICE_TOOLS.has(call.tool)),
            ).toEqual([]);
            expect(
              callsAfter.filter((call) => call.tool === 'search_logs'),
            ).toHaveLength(1);
            const pidsBefore = new Set(callsBefore.map((call) => call.pid));
            expect(
              callsAfter.filter((call) => pidsBefore.has(call.pid)),
            ).toEqual([]);

            // The page gathered before the revoke stays evidence the answer cites.
            const { metadata } = await answerMessage(
              second.api,
              user,
              threadId,
              investigationId,
            );
            expect(citedSources(metadata)).toEqual([
              [BACKOFFICE, 'search_orders'],
              [FIXTURE, 'search_logs'],
            ]);

            expect(await second.child.stop()).toBe(0);
          },
          'research-flow',
          undefined,
          {
            sourceAccessTable: accessTable(user, [FIXTURE, BACKOFFICE]),
            journey: 'revocation-hold',
          },
        );
      },
      RUN_TIMEOUT_MS,
    );

    // S3 - UC-E1 end to end: an employee with no rights
    // AC: AC-09.2 "the catalog is empty: the offer goes without the no-sources warning, the running card and the answer show it as today"; AC-09.1 "no source is called, the answer is from model knowledge"
    // Given: both sources are connected; the user is absent from `SOURCE_ACCESS_TABLE`.
    // When: the user asks a research question and receives the offer, confirms it, and the investigation runs.
    // Then: the offer carries no no-sources warning; the running card and the final answer carry the model-knowledge warnings (MC-31..MC-33); neither fixture process received a call; the run's mode is `model_knowledge`.
    // Behavior: deployment flag (`Engine.sourceMode` = sources) for the offer; the run's own mode (empty catalog) for the card and the answer
    // Catches: the offer built from the run mode (a warning on the offer that says sources are not connected when they are), or the card/answer built from the deployment flag (an answer from model knowledge shown as if it had sources).
    // @category: e2e
    // @dependency: full-system
    // @complexity: medium
    it(
      'E2E-1 S3 (UC-E1): an employee without rights gets an offer without the warning and a model-knowledge run with it; no fixture call',
      async () => {
        const user = newUser();
        // A non-empty table that does not name the user: an empty table would be the allow-all double.
        const someoneElse = newUser();

        await withChatEntrySession(
          async (session) => {
            const { child, api } = await session.start();
            const threadId = await newThread(api, user);

            // A plain question: the chat model proposes research; the card is the offer.
            await chatTurn(session, child, {
              api,
              user,
              threadId,
              message: userMessage(`Разберись: ${twoSourcesFacts().question}`),
            });
            const [offer] = await launchCards(api, user, threadId);
            // AC-09.2: the offer reads the deployment flag - sources are connected, so it carries no no-sources warning.
            expect(offer).toMatchObject({
              mode: 'proposal',
              state: 'proposed',
              sourceMode: 'sources',
            });
            if (offer === undefined) throw new Error('no offer card');

            // The employee confirms the offer as the card's button does.
            await chatTurn(session, child, {
              api,
              user,
              threadId,
              message: userMessage('Запустить', {
                [RESEARCH_METADATA_KEYS.researchDecision]: {
                  action: 'confirm',
                  launchKey: offer.launchKey,
                },
              }),
            });
            const { investigationId, launchKey } = await answeredInvestigation(
              session,
              child,
              user,
              threadId,
            );
            expect(launchKey).toBe(offer.launchKey);

            // AC-09.1: the run's own mode is model knowledge with an empty catalog; only the answer agent worked.
            const run = await investigationRow(session, investigationId);
            expect(run).toEqual({
              status: 'completed',
              sourceMode: 'model_knowledge',
              sourceCatalog: [],
            });
            expect(
              (await agentRuns(session, investigationId)).map(
                (one) => one.agentName,
              ),
            ).toEqual(['synthesis']);
            // Neither fixture process received a call.
            expect(session.fixtureCalls()).toEqual([]);

            // AC-09.2: the card of the launched investigation reads the run's mode, not the deployment flag.
            expect(await launchCards(api, user, threadId)).toEqual([
              expect.objectContaining({
                launchKey: offer.launchKey,
                state: 'completed',
                sourceMode: 'model_knowledge',
              }),
            ]);

            // The answer carries the model-knowledge warnings (MC-32 at the top, MC-33 on the claim).
            const { metadata, text } = await answerMessage(
              api,
              user,
              threadId,
              investigationId,
            );
            expect(metadata).toMatchObject({
              sourceMode: 'model_knowledge',
              sources: [],
              established: [],
              assumed: [
                expect.objectContaining({ text: TWO_SOURCES_TEXTS.assumption }),
              ],
            });
            expect(text.startsWith(MC_32_WITHOUT_SOURCES)).toBe(true);
            expect(text).toContain(
              `${TWO_SOURCES_TEXTS.assumption} (${MC_33_MODEL_KNOWLEDGE})`,
            );

            expect(await child.stop()).toBe(0);
          },
          'research-flow',
          undefined,
          {
            sourceAccessTable: accessTable(someoneElse, [FIXTURE, BACKOFFICE]),
            journey: 'two-sources',
          },
        );
      },
      RUN_TIMEOUT_MS,
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Not observable as an assertion
// ---------------------------------------------------------------------------------------------------------------
// - The warnings MC-31..MC-33 on the cards are drawn by the web from the card's `sourceMode`; the api half is that field:
//   `sources` on the offer, `model_knowledge` on the card of the launched run. S3 reads the card once the run has
//   answered: with an empty catalog only `synthesis` runs, so a `running` card is too short-lived to be read without a
//   race; the field it shows comes from the same launch row.
// - The text the fixture server reports in `tools/list` is held here as literals of its tool definitions: the package
//   exports no tool list, and AC-01.2 is about that text never reaching an agent.
