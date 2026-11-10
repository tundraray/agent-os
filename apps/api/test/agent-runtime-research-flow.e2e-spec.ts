// agent-runtime / research-flow E2E Tests (api process) - Design Doc: docs/features/agent-runtime/design-research-flow.md (v1.4)
// PRD: docs/features/agent-runtime/prd.md (FR-14, FR-16; AC-12.1, AC-12.5 and AC-15.1 as the employee meets them). UXRD: none (the employee's screen does not change). Test type: End-to-End (a built api process + real runtime + real engine + real fixture + real Postgres; scripted models)
// Part: research-flow | CI job `e2e` of apps/api, `pnpm --filter api test:e2e:research-flow`.
// Counterpart in-process files: packages/engine/test/agent-runtime-research-flow.int.e2e-spec.ts (INT-1..INT-4) and apps/api/test/agent-runtime-research-flow.int.e2e-spec.ts (INT-5). The rules and the wiring of the engine and of the self-check are proven there and at unit level;
// this file proves what a developer does after editing the checker agent, and what the employee gets after.
//
// The api child is booted in the research-flow mode of test/support/chatEntryChild.ts (a scratch database per row, `pnpm --filter api build:child` first); `calibrate` runs through the built self-check program as there (test/support/selfCheckChild.ts, a migrated scratch database of its own as `DATABASE_URL`).
//
// Environment:
// - Postgres 16 from infra/docker-compose.yml; a scratch database per row (CREATE DATABASE, dropped afterwards); migrations applied with the entry of @agent-os/db.
// - Doubles are the model boundary only: the scripted chat model (one `deepResearch` call without a budget, then plain replies) and the scripted agents of the shipped v3 behind `ENGINE_RESOLVE_MODEL` (test/support/engineScriptedRoles.ts, researchFlowAgents.ts). The engine is the REAL one;
//   the real MCP fixture process serves the logs. No network, no API key. No test asserts on keywords of model text.
// - The child (`withChatEntrySession(..., 'research-flow')`) runs `EngineModule`'s own group tables and the settings under test: `RESEARCH_GROUP_TABLES_DIR` is a directory of the row. `E2E_ENGINE_PROCESS_FILE` replaces the configuration with the copy of the shipped v3 whose checker prompt differs by one word,
//   which is what makes the shipped v3 table not match: the shipped files are not edited.
// - Isolation (project convention): a unique user per row (`x-user-id`); a unique temp directory per command; the file runs with `fileParallelism: false`. No latency assertions; the wait for each end state is the harness timeout.
//
// Budget: E2E 2 of 2 for the part (the other is the engine restart file). It stays because nothing at a lower level can prove it: the composition of `apps/api` (that it loads v3, reads the budget limits from it, passes the group-table directory and refuses to start without a table) is invisible to a test that builds the engine directly.
//
// AC -> proving test:
// - AC-16.1 (a changed checker agent: the server does not start without a table for its fingerprint; the error names it): S1
// - AC-16.2 (the calibration report: shares per kind of pair, the comparison with the rule "value not found - not established", the share of right per group): S2 (the rule of the calibration is unit; the report is read here)
// - AC-12.1, AC-12.5, AC-14.1 (a question sent to the built server as a conversation message ends with the answer in that conversation, agents of all five stages in the tree): S2
// - AC-15.1 as the employee reads it (the same kind of answer through the same path), KD-5 (the launch budget comes from v3): S2

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type HistoryMessage,
  RESEARCH_METADATA_KEYS,
  ResearchAnswerMetadataSchema,
  ThreadMessagesResponseSchema,
  ThreadSummarySchema,
} from '@agent-os/contracts';
import {
  deepResearchProcessV3,
  type GroupTable,
  GroupTableSchema,
} from '@agent-os/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  aliveChildren,
  dropLeftoverDatabases,
  withChatEntrySession,
} from './support/chatEntryChild.js';
import { ENGINE_JOURNEY } from './support/engineScriptedRoles.js';
import { newUser } from './support/seed.js';
import {
  assertSelfCheckChildBuildFresh,
  CALIBRATION_ERRS_ON_VARIABLE,
  SelfCheckCommand,
} from './support/selfCheckChild.js';
import { ScratchDatabases } from './support/selfCheckDb.js';

/** Harness timeout of a row: `calibrate` over the set, a boot, one investigation of five stages. */
const RUN_TIMEOUT_MS = 240_000;

/** The developer's edit: one word of the shipped checker prompt, in a copy of the configuration. */
const SHIPPED_AGENTS = (
  deepResearchProcessV3 as {
    readonly agents: Readonly<Record<string, unknown>> & {
      readonly verifier: { readonly prompt: string };
    };
  }
).agents;
const EDITED_VERIFIER_PROMPT = SHIPPED_AGENTS.verifier.prompt.replace(
  'You check one claim',
  'You verify one claim',
);
const EDITED_V3 = {
  ...(deepResearchProcessV3 as Readonly<Record<string, unknown>>),
  agents: {
    ...SHIPPED_AGENTS,
    verifier: { ...SHIPPED_AGENTS.verifier, prompt: EDITED_VERIFIER_PROMPT },
  },
};

/** The pair of fingerprints of the edited checker, with no definition memory, as literals. */
const EDITED_AGENT_FINGERPRINT = 'c0d0d964553b';
const EMPTY_MEMORY_FINGERPRINT = '4f53cda18c2b';
const VERIFIER_MODEL = 'anthropic/claude-haiku-5-5';
const CALIBRATION_SET = 'smoke';
/** `limits.investigationTokens.default` of the shipped v3. */
const V3_LAUNCH_BUDGET = 800_000;

const CALIBRATION_MISSING_MESSAGE =
  `no group table for process deep-research version 3: agent fingerprint ${EDITED_AGENT_FINGERPRINT}, ` +
  `definition memory fingerprint ${EMPTY_MEMORY_FINGERPRINT}; build one with the calibrate command`;

/** UXRD agent-quality, Microcopy: the literals the employee reads. */
const MC_2_CAPTION = 'Главное из установленного';
const MC_3_CAUSAL = 'причинная связь не доказана';

/** The text of a history message: its text parts, in order. */
const textOf = (message: HistoryMessage | undefined): string =>
  (message?.parts ?? [])
    .flatMap((part) =>
      part.type === 'text' && typeof part.text === 'string' ? [part.text] : [],
    )
    .join('');

describe('agent-runtime / research-flow - E2E (built api process, real Postgres, real engine, scripted models, shipped v3)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // E2E-2  A developer edits the checker agent: the server refuses to start, calibration, the server starts, the employee asks in the conversation
  // ---------------------------------------------------------------------------------------------------------------
  // User journey: a developer edits one word of the checker agent's prompt -> the server does not start, naming the new fingerprint -> the developer calibrates into the directory of `RESEARCH_GROUP_TABLES_DIR` -> the server starts -> an employee asks a research question in the conversation and gets the answer there, from the agents of all five stages.
  // Verification: the composition of the server, end to end.
  // Covers (original statements):
  // AC-12.1: "Given расследование по v3 завершено, Then в его дереве есть запуски агентов плана, controller, worker, проверяющего и synthesis."
  // AC-12.5: "Given сценарный прогон отправляет вопрос на собранный сервер сообщением в беседе, Then расследование завершается ответом в этой беседе, и в его дереве есть запуски всех пяти стадий (AC-12.1)."
  // AC-14.1: "Given сотрудник запускает расследование, Then оно идёт по v3, и в его ходе есть запуски агентов."
  // AC-16.1: "Given изменились модель, промпт, инструменты или форма ответа проверяющего агента, Then его отпечаток меняется, и сервер не стартует, пока для нового отпечатка нет таблицы групп; ошибка называет отпечаток."
  // AC-16.2: "Given калибровка v3 прогнана, Then отчёт показывает долю совпадений проверяющего агента с ключом по каждому типу пар, сравнение с правилом «значение не нашлось — не установлено» и долю верных по группам."
  // KD-5 (Design Doc): the server loads only v3; the launch budget limits come from it.
  // Use cases: UC-1 (as the employee meets it), UC-8 (the start-up half).
  //
  // Primary failure mode (turns red when): the server starts with no table for the edited checker (`Engine.checkCalibration` is not called at the start, or looks at the wrong pair); the table of `calibrate` does not reach the server (the directory setting is not passed), so a freshly calibrated checker still blocks the start;
  //   the chat launch takes a budget that is not v3's, so the investigation runs with the wrong limit.
  // @category: e2e
  // @dependency: full-system (built api process, runtime, engine, MCP fixture, Postgres, built self-check program)
  // @complexity: high
  describe('E2E-2', () => {
    const databases = new ScratchDatabases();
    const commands: SelfCheckCommand[] = [];
    let workDir: string | undefined;

    beforeAll(async () => {
      assertSelfCheckChildBuildFresh();
      await dropLeftoverDatabases();
      workDir = await mkdtemp(join(tmpdir(), 'research-flow-e2e-2-'));
      await writeFile(editedConfigFile(), JSON.stringify(EDITED_V3), 'utf8');
    });

    afterAll(async () => {
      for (const command of commands) command.kill();
      await Promise.allSettled(commands.map((command) => command.exited));
      await databases.dropAll();
      if (workDir !== undefined) {
        await rm(workDir, { recursive: true, force: true });
      }
      expect(aliveChildren()).toEqual([]);
    });

    function workPath(): string {
      if (workDir === undefined) throw new Error('beforeAll did not finish');
      return workDir;
    }

    const editedConfigFile = (): string =>
      join(workPath(), 'deep-research-v3-verifier-edit.json');

    /** The row's empty `RESEARCH_GROUP_TABLES_DIR`. */
    async function newTablesDir(row: string): Promise<string> {
      const dir = join(workPath(), `group-tables-${row}`);
      await mkdir(dir);
      return dir;
    }

    // S1: no table for the verifier's pair (the shipped v3 table is for the unedited checker): the process exits non-zero, it never listens, and the error and the log say `calibration_missing`, the process `deep-research`, the version 3 and both fingerprints.
    it(
      "E2E-2 S1: a server whose checker agent was edited does not start without a table for the agent's fingerprints and names them",
      async () => {
        expect(EDITED_VERIFIER_PROMPT).not.toBe(SHIPPED_AGENTS.verifier.prompt);
        const groupTablesDir = await newTablesDir('s1');

        await withChatEntrySession(
          async (session) => {
            const refused = await session.startRefused();

            expect(refused).toEqual({
              exitCode: 1,
              listened: false,
              failure: {
                code: 'calibration_missing',
                message: CALIBRATION_MISSING_MESSAGE,
              },
            });
            // Output chunks may split a line, so only a short stable part of it is read.
            expect(session.lastChildLog()).toContain('calibration_missing');
          },
          'research-flow',
          { processFile: editedConfigFile(), groupTablesDir },
        );
      },
      RUN_TIMEOUT_MS,
    );

    // S2 Given: the edited checker of S1; `calibrate` over the same edited file, the scripted checker erring on the named kinds of pair, `--out` into the directory of `RESEARCH_GROUP_TABLES_DIR`.
    // When: `calibrate` ends; the server starts on that directory; a unique employee sends a research mode message, so the chat model calls `deepResearch` once without a budget; the investigation ends.
    // Then: the report shows the shares per kind of pair, the comparison with the old rule and the share of right per group (AC-16.2); the file holds both fingerprints and the model; the server starts (the table reached it through the directory);
    //   the investigation is `completed` on v3 with the budget 800 000 (KD-5), its tree has the agents of all five stages under the root `controller` (AC-12.1, AC-14.1) and there is no task of the old controller; the answer message in that conversation passes the contract schemas, keeps the same shape as v2 and carries the group of the calibrated table (AC-12.5, AC-15.1).
    it(
      "E2E-2 S2: after the developer calibrates the edited checker into RESEARCH_GROUP_TABLES_DIR the server starts, and the employee's question in the conversation runs the five-stage agent tree with the v3 budget and ends with the answer in that conversation",
      async () => {
        const groupTablesDir = await newTablesDir('s2');
        const tableFile = join(groupTablesDir, 'edited-verifier.json');

        const command = new SelfCheckCommand({
          argv: [
            'calibrate',
            '--set',
            CALIBRATION_SET,
            '--out',
            tableFile,
            '--config',
            editedConfigFile(),
          ],
          reportsDir: join(workPath(), 'calibrate-s2'),
          env: {
            DATABASE_URL: await databases.create(),
            [CALIBRATION_ERRS_ON_VARIABLE]:
              'values_match_meaning_wrong,insufficient',
          },
        });
        commands.push(command);
        const calibrated = await command.exited;

        expect(calibrated.exitCode, calibrated.stderr).toBe(0);
        const table: GroupTable = GroupTableSchema.parse(
          JSON.parse(readFileSync(tableFile, 'utf8')),
        );
        expect(table).toMatchObject({
          model: VERIFIER_MODEL,
          agentFingerprint: EDITED_AGENT_FINGERPRINT,
          definitionMemoryFingerprint: EMPTY_MEMORY_FINGERPRINT,
          scenarioSet: CALIBRATION_SET,
          groupCount: 3,
        });
        const report = calibrated.stdout.split(/\r?\n/);
        expect(report).toContain(
          `- Модель: ${VERIFIER_MODEL}; отпечаток агента: ${EDITED_AGENT_FINGERPRINT}; отпечаток памяти определения: ${EMPTY_MEMORY_FINGERPRINT}`,
        );
        // Answered wrong by the checker, and the old veto establishes these pairs as the algorithm does: wrong on each.
        expect(report).toContain(
          '| values_match_meaning_wrong | 0.0 % | 100.0 % | 0.0 % | 0.0 % |',
        );
        expect(report).toContain('| medium | 9 | 33.3 % | — |');

        await withChatEntrySession(
          async (session) => {
            const { child, api } = await session.start();
            const user = newUser();
            const created = await api(user, '/api/threads', { method: 'POST' });
            expect(created.status).toBe(201);
            const threadId = ThreadSummarySchema.parse(await created.json()).id;

            const mode = await api(user, '/api/chat/assistant', {
              method: 'POST',
              body: JSON.stringify({
                id: threadId,
                messages: [
                  {
                    id: `client-${randomUUID()}`,
                    role: 'user',
                    parts: [
                      {
                        type: 'text',
                        text: `Разберись: ${ENGINE_JOURNEY.goal}`,
                      },
                    ],
                    metadata: { [RESEARCH_METADATA_KEYS.deepResearch]: true },
                  },
                ],
              }),
            });
            await mode.text();
            expect(mode.status).toBe(200);

            const delivered = await session.until(
              'the answer delivered',
              child,
              async () => {
                const [row] = await session.query<{
                  launchKey: string;
                  state: string;
                  investigationId: string;
                  tokenBudget: number;
                }>(
                  `SELECT launch_key AS "launchKey", state, investigation_id AS "investigationId", token_budget AS "tokenBudget"
                     FROM app.research_chat_launches WHERE resource_id = $1 AND thread_id = $2`,
                  [user, threadId],
                );
                return row?.state === 'answered' ? row : undefined;
              },
            );
            const { investigationId, launchKey } = delivered;

            // The investigation: completed on v3, with the budget of v3 at both the launch and the run.
            expect(delivered.tokenBudget).toBe(V3_LAUNCH_BUDGET);
            expect(
              await session.query(
                `SELECT i.status, r.process_id AS "processId", r.process_version AS "processVersion", r.token_budget AS "tokenBudget"
                   FROM app.research_investigations i
                   JOIN app.research_engine_runs r USING (investigation_id)
                  WHERE i.investigation_id = $1`,
                [investigationId],
              ),
            ).toEqual([
              {
                status: 'completed',
                processId: 'deep-research',
                processVersion: 3,
                tokenBudget: V3_LAUNCH_BUDGET,
              },
            ]);

            // The tree: the root and the agents of all five stages.
            const runs = await session.query<{
              agentName: string;
              depth: number;
            }>(
              `SELECT agent_name AS "agentName", depth
                 FROM app.research_agent_runs WHERE investigation_id = $1`,
              [investigationId],
            );
            expect(
              runs.filter((run) => run.depth === 0).map((run) => run.agentName),
            ).toEqual(['controller']);
            expect(runs.map((run) => run.agentName).sort()).toEqual([
              'controller',
              'planner',
              'synthesis',
              'verifier',
              'verifier',
              'worker',
            ]);

            // No task of the old controller, and none left unfinished.
            const tasks = await session.query<{
              workflowType: string;
              status: string;
            }>(
              `SELECT workflow_type AS "workflowType", status
                 FROM app.research_tasks WHERE investigation_id = $1`,
              [investigationId],
            );
            expect(tasks.filter((task) => task.status !== 'succeeded')).toEqual(
              [],
            );

            // The answer in the conversation: the read the web makes, the contract schemas, the shape of the stored answer.
            const history = ThreadMessagesResponseSchema.parse(
              await (
                await api(user, `/api/threads/${threadId}/messages`)
              ).json(),
            ).messages;
            const answer = history.find(
              (message) => message.id === `research-answer-${investigationId}`,
            );
            expect(answer?.role).toBe('assistant');
            const researchAnswer = (
              answer?.metadata as Record<string, unknown> | undefined
            )?.[RESEARCH_METADATA_KEYS.researchAnswer];
            expect(researchAnswer).toEqual({
              launchKey,
              launch: { messageId: expect.any(String) },
              goal: ENGINE_JOURNEY.goal,
              summary: null,
              summaryItems: [
                {
                  claimId: expect.any(String),
                  text: ENGINE_JOURNEY.observation,
                  confidence: 'medium',
                },
              ],
              outcome: 'answered',
              stopReason: null,
              established: [
                {
                  text: ENGINE_JOURNEY.observation,
                  footnotes: [1],
                  verified: true,
                  confidence: 'medium',
                  causal: false,
                },
              ],
              assumed: [
                {
                  text: ENGINE_JOURNEY.causal,
                  footnotes: [1],
                  verified: true,
                  confidence: null,
                  causal: true,
                },
              ],
              unknown: [],
              sources: [
                {
                  number: 1,
                  sourceId: 'fixture',
                  toolName: 'search_logs',
                  snapshot: expect.any(String),
                  truncated: true,
                },
              ],
              sourceMode: 'sources',
            });
            expect(ResearchAnswerMetadataSchema.parse(researchAnswer)).toEqual(
              researchAnswer,
            );
            const text = textOf(answer);
            expect(text).toContain(`### ${MC_2_CAPTION}`);
            expect(text).toContain(
              `${ENGINE_JOURNEY.causal} [1] (${MC_3_CAUSAL})`,
            );

            expect(await child.stop()).toBe(0);
          },
          'research-flow',
          { processFile: editedConfigFile(), groupTablesDir },
        );
      },
      RUN_TIMEOUT_MS,
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Not observable as an assertion
// ---------------------------------------------------------------------------------------------------------------
// - The design says a server without a table "does not start"; the test reads the exit code, the reported error and the log of the child, because the composition fails in `EngineModule.onModuleInit` before the HTTP port opens - there is no HTTP error body to assert.
// - The one-word edit of the checker prompt is the only way to create "a changed fingerprint" without editing shipped data; it is passed to the child as its engine file.
