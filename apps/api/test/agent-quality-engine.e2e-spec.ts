// agent-quality / engine E2E Test Skeletons (api process) - Design Doc: docs/features/agent-quality/design-engine.md (v1.3, approved 2026-11-07)
// PRD: docs/features/agent-quality/prd.md (FR-06, FR-14, FR-15, FR-16 for E2E-1 and E2E-2). UXRD: docs/features/agent-quality/uxrd.md (MC-1, MC-2, MC-3). Test type: End-to-End (a built api process + real runtime + real engine + real fixture + real Postgres; scripted models)
// Generated: 2026-11-07 | Part: engine | CI job `e2e` of apps/api
// Implementation timing: final phase only, after the engine slices (verification, answer assembly, delivery read, calibration, start check) have landed.
// Counterpart in-process files: packages/engine/test/agent-quality-engine.int.e2e-spec.ts (INT-1 to INT-4) and packages/db/test/agent-quality-engine.int.e2e-spec.ts (INT-5). The rules and the wiring are proven there and at unit level;
// this file proves the part as the employee and the developer meet it.
//
// File name follows the project convention (`*.e2e-spec.ts` under apps/api/test, run by `vitest.config.e2e.ts`; no config is created here). The api child is booted the way `deep-research-chat-entry.e2e-spec.ts` boots it
// (test/support/chatEntryChild.ts, a scratch database per row, `pnpm --filter api build:child` first); the program under test for E2E-2 is the built self-check program as in `agent-quality-self-check.e2e-spec.ts` (test/support/selfCheckChild.ts).
//
// State: E2E-1 and E2E-2 are implemented (`pnpm --filter api test:e2e:engine`).
//
// Environment:
// - Postgres 16 from infra/docker-compose.yml; a scratch database per row (CREATE DATABASE, dropped afterwards); migrations applied with the entry of @agent-os/db. E2E-2 runs `calibrate` on a migrated scratch database of its own as `DATABASE_URL` (test/support/selfCheckDb.ts).
// - Doubles are the model boundary only: the scripted chat model (one `deepResearch` call, then plain replies), and the scripted role models behind `resolveModel` (the verifier answers only the closed JSON assessment, synthesis only the closed draft; no
//   test asserts on keywords of model text). The engine is the REAL one - unlike the chat-entry E2E, whose engine is a double. The real MCP fixture process serves the logs. No network, no API key.
// - Support: test/support/chatEntryChildMain.ts runs in the mode `E2E_ENGINE_SCRIPTED_ROLES=1` (`withChatEntrySession(..., 'scripted-roles')`): the real engine and fixture source, with only `ENGINE_RESOLVE_MODEL` and
//   `ENGINE_TOKEN_COUNTER` swapped for the scripted roles of test/support/engineScriptedRoles.ts and `ENGINE_GROUP_TABLES` for the test table (every supported claim gets `low`). E2E-2 gives the same mode its engine files
//   (`EngineFiles`): `ENGINE_PROCESSES` holds only the configuration with the verifier prompt edited by one word (modelled on `workerEditConfig` of the engine self-check file, same `processId` and `version`: the chat
//   launch always starts `deep-research`) and `ENGINE_GROUP_TABLES` the files `calibrate` wrote. `calibrate` runs through test/support/selfCheckChildMain.ts, whose scripted verifier answers each calibration pair by its key
//   and errs on the pair kinds of `SELF_CHECK_CALIBRATION_ERRS_ON`.
// - Isolation (project convention): a unique user per row (`x-user-id`); a unique temp directory per command; the file runs with `fileParallelism: false`. No latency assertions; the wait for each end state is the harness timeout.
//
// Budget: E2E 2 of 2 for the part (the part's integration tests are 5 of 5, see the engine file). ROI under the raw skill formula does not reach a threshold for these journeys either, like the sibling parts; each stays because nothing at a lower level can prove it:
//   E2E-1 - the only test in which the real engine's stored message crosses the real delivery loop, the contract schema and the HTTP read of the conversation (a contract schema that strips a new field, or an appender that rebuilds the message, passes every in-process test);
//   E2E-2 - the only test that starts the server composition as a process against a changed verifier prompt (that the composition passes `requireCalibration` is invisible to a test that builds the engine directly).
//
// AC -> proving test:
// - AC-14.1 (causal in assumptions), AC-15.1 and AC-15.3 as the employee reads them (group words), AC-16.1 (summary), KD-8 / Invariant 9 (copy equals screen data), UXRD KD-3, KD-4: E2E-1 as the process-level confirmation of INT-2 A1
// - AC-06.1 (report with the shares per kind of pair), AC-06.2 (groups come from the new run), AC-15.2 (the share of right claims per group), DC-1, DC-2: E2E-2 (the calibration rule itself is unit, see the engine file)
// - The appender's delivery read (`readAnswerMessage`, only `launch` added, a re-append after regeneration gives the same text): E2E-1; the appender's rule (write only when completed, the pass over a not-yet-built message) stays at unit level
//   in `research-answer.appender.spec.ts`, which the plan adapts to the new read.

import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  type HistoryMessage,
  RESEARCH_METADATA_KEYS,
  ResearchAnswerMetadataSchema,
  ThreadMessagesResponseSchema,
  ThreadSummarySchema,
} from '@agent-os/contracts';
import {
  deepResearchProcessV2,
  type GroupTable,
  GroupTableSchema,
} from '@agent-os/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  aliveChildren,
  type ChatEntrySession,
  type ChildApi,
  dropLeftoverDatabases,
  withChatEntrySession,
} from './support/chatEntryChild.js';
import { ENGINE_JOURNEY } from './support/engineScriptedRoles.js';
import { newUser } from './support/seed.js';
import {
  assertSelfCheckChildBuildFresh,
  CALIBRATION_ERRS_ON_VARIABLE,
  SelfCheckCommand,
  type SelfCheckCommandResult,
} from './support/selfCheckChild.js';
import { ScratchDatabases } from './support/selfCheckDb.js';

/** Harness timeout of the journey: a boot, an investigation with five role kinds, four chat turns, two deliveries. */
const RUN_TIMEOUT_MS = 240_000;

/** UXRD agent-quality, Microcopy: the literals the employee reads. */
const MC_1_LOW = 'уверенность низкая';
const MC_2_CAPTION = 'Главное из установленного';
const MC_3_CAUSAL = 'причинная связь не доказана';

/** The launch row of the journey's thread. */
interface LaunchRow {
  launchKey: string;
  state: string;
  investigationId: string | null;
  answeredAt: Date | null;
}

interface UserMessage {
  id: string;
  role: 'user';
  parts: { type: 'text'; text: string }[];
  metadata?: Record<string, unknown>;
}

function userMessage(
  text: string,
  metadata?: Record<string, unknown>,
): UserMessage {
  return {
    id: `client-${randomUUID()}`,
    role: 'user',
    parts: [{ type: 'text', text }],
    ...(metadata && { metadata }),
  };
}

/** One chat turn as the web sends it (a regenerate resends the same message); the SSE body is read to its end. */
async function turn(
  api: ChildApi,
  user: string,
  threadId: string,
  message: UserMessage,
): Promise<number> {
  const res = await api(user, '/api/chat/assistant', {
    method: 'POST',
    body: JSON.stringify({ id: threadId, messages: [message] }),
  });
  await res.text();
  return res.status;
}

/** The text of a history message: its text parts, in order. */
const textOf = (message: HistoryMessage | undefined): string =>
  (message?.parts ?? [])
    .flatMap((part) =>
      part.type === 'text' && typeof part.text === 'string' ? [part.text] : [],
    )
    .join('');

/** The `researchAnswer` metadata of a history message as the HTTP read returns it. */
const researchAnswerOf = (
  message: HistoryMessage | undefined,
): { sources?: { snapshot?: unknown }[] } | undefined =>
  (
    message?.metadata as
      Record<string, { sources?: { snapshot?: unknown }[] }> | undefined
  )?.[RESEARCH_METADATA_KEYS.researchAnswer];

/** Role and text of each message a chat model call received. */
function promptTexts(
  messages: readonly unknown[],
): { role: string; text: string }[] {
  return messages.map((message) => {
    const { role, content } = message as {
      role: string;
      content: string | { type: string; text?: string }[];
    };
    const text =
      typeof content === 'string'
        ? content
        : content
            .flatMap((part) => (part.type === 'text' ? [part.text] : []))
            .join('');
    return { role, text };
  });
}

/** What the journey left: the launch at each delivery, both HTTP reads of the thread, the stored copies, the model input. */
interface EngineJourney {
  readonly modeMessage: UserMessage;
  readonly question: UserMessage;
  readonly next: UserMessage;
  readonly firstDelivery: LaunchRow;
  readonly reDelivery: LaunchRow;
  /** GET /messages once the answer was first delivered, and once more after the re-append and the next turn. */
  readonly firstRead: HistoryMessage[];
  readonly lastRead: HistoryMessage[];
  /** Rows of `mastra_messages` with the answer's id after the re-append. */
  readonly storedAnswers: number;
  /** The messages the chat model received in the turn after the re-append. */
  readonly nextTurnInput: { role: string; text: string }[];
  readonly exitCode: number | null;
}

/**
 * The employee's journey in its own scratch database, the child in the scripted-roles mode: a research mode message,
 * a plain question while the investigation runs (the synthesis call is held meanwhile), the answer delivered after the
 * reply, a regenerate of the question (the answer is in its tail, so the loop re-appends it), and the next question.
 */
function runEngineJourney(): Promise<EngineJourney> {
  return withChatEntrySession(async (session) => {
    const user = newUser();
    const { child, api } = await session.start();
    const created = await api(user, '/api/threads', { method: 'POST' });
    expect(created.status).toBe(201);
    const threadId = ThreadSummarySchema.parse(await created.json()).id;
    const launch = async (): Promise<LaunchRow | undefined> => {
      const rows = await session.query<LaunchRow>(
        `SELECT launch_key AS "launchKey", state, investigation_id AS "investigationId", answered_at AS "answeredAt"
           FROM app.research_chat_launches WHERE resource_id = $1 AND thread_id = $2`,
        [user, threadId],
      );
      return rows.length === 1 ? rows[0] : undefined;
    };
    const history = async (): Promise<HistoryMessage[]> =>
      ThreadMessagesResponseSchema.parse(
        await (await api(user, `/api/threads/${threadId}/messages`)).json(),
      ).messages;

    // The research mode message starts the investigation; the plain question is answered while it runs.
    const modeMessage = userMessage(`Разберись: ${ENGINE_JOURNEY.goal}`, {
      [RESEARCH_METADATA_KEYS.deepResearch]: true,
    });
    expect(await turn(api, user, threadId, modeMessage)).toBe(200);
    const running = await session.until('a running launch', child, async () => {
      const row = await launch();
      return row?.state === 'running' && row.investigationId !== null
        ? row
        : undefined;
    });
    const question = userMessage('Что проверить, пока идёт ресерч?');
    expect(await turn(api, user, threadId, question)).toBe(200);

    // The synthesis answers; the engine stores the answer with its message; the loop delivers it after the reply.
    // In the scripted-roles mode `release` opens the held synthesis call; the child ignores the investigation id.
    child.release(String(running.investigationId));
    const firstDelivery = await session.until(
      'the answer delivered',
      child,
      async () => {
        const row = await launch();
        return row?.state === 'answered' ? row : undefined;
      },
    );
    const firstRead = await history();

    // The regenerate removes the tail holding the answer; once the new reply is stored the loop writes it again.
    expect(await turn(api, user, threadId, question)).toBe(200);
    const reDelivery = await session.until(
      'the answer re-appended',
      child,
      async () => {
        const row = await launch();
        return row?.state === 'answered' &&
          (row.answeredAt?.getTime() ?? 0) >
            (firstDelivery.answeredAt?.getTime() ?? 0)
          ? row
          : undefined;
      },
    );
    const next = userMessage('Что показал ресерч?');
    expect(await turn(api, user, threadId, next)).toBe(200);
    const calls = await child.chatCalls();
    const lastRead = await history();
    const [stored] = await session.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM mastra_messages WHERE thread_id = $1 AND id = $2',
      [threadId, `research-answer-${String(running.investigationId)}`],
    );
    return {
      modeMessage,
      question,
      next,
      firstDelivery,
      reDelivery,
      firstRead,
      lastRead,
      storedAnswers: stored?.count ?? 0,
      nextTurnInput: promptTexts(calls.at(-1) ?? []),
      exitCode: await child.stop(),
    };
  }, 'scripted-roles');
}

/** The developer's edit of E2E-2: one word of the shipped verifier prompt, the same `processId` and `version`. */
const SHIPPED_ROLES = (
  deepResearchProcessV2 as {
    readonly roles: Readonly<Record<string, unknown>> & {
      readonly verifier: { readonly prompt: string };
    };
  }
).roles;
const SHIPPED_VERIFIER = SHIPPED_ROLES.verifier;
const EDITED_VERIFIER_PROMPT = SHIPPED_VERIFIER.prompt.replace(
  'You check one claim',
  'You verify one claim',
);
const verifierEditConfig = {
  ...(deepResearchProcessV2 as Readonly<Record<string, unknown>>),
  roles: {
    ...SHIPPED_ROLES,
    verifier: { ...SHIPPED_VERIFIER, prompt: EDITED_VERIFIER_PROMPT },
  },
};

/** KD-2 fingerprints (`promptVersion`) of the shipped and the edited verifier prompt, as literals. */
const SHIPPED_VERIFIER_VERSION = '6de9a2bbda25';
const EDITED_VERIFIER_VERSION = '903fc8012b4e';
const VERIFIER_MODEL = 'anthropic/claude-haiku-5-5';
/** The calibration set: three scenarios, seven pairs each, three of them on a page of hourly counts. */
const CALIBRATION_SET = 'smoke';

/** The profile of the journey's observation claim: one traced record supports it and its trace atom matched. */
const JOURNEY_PROFILE = {
  claimType: 'observation',
  valueCheck: 'matched',
  independentRecords: 'one',
  contradictions: false,
} as const;

/** The group a table gives the journey's profile; undefined when the table lacks it. */
const journeyGroupIn = (table: GroupTable): string | undefined =>
  table.profiles.find((entry) =>
    isDeepStrictEqual(entry.profile, JOURNEY_PROFILE),
  )?.group;

describe('agent-quality / engine - E2E (built api process, real engine, real fixture, real Postgres, scripted models)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // E2E-1  The employee asks a question and gets the answer with groups, a summary and a causal label, and the copy says what the screen data says
  // ---------------------------------------------------------------------------------------------------------------
  // User journey: an employee in a chat thread asks why a service slowed down; the card appears, the investigation runs in the background on the fixture logs, the answer arrives as its own message.
  //  1. The chat turn starts the investigation (the scripted chat model calls `deepResearch`); the card shows; the roles are scripted: the worker writes an observation claim and, separately, a causal claim, each with a pointer to the fixture records;
  //     the verifier assesses the first as `observation` / `yes` / records `supports` and the second as `causal`; the test group table puts every supported claim in the lowest group (`low`, «уверенность низкая»); synthesis chooses both for the summary.
  //  2. The answer message is appended to the thread. Then: reading the thread through the HTTP API returns a message whose `researchAnswer` metadata parses with the contract schema and keeps `summaryItems` (one item: the observation, with its group),
  //     `established[0].confidence`, `assumed[0].causal` true and `verified` true; the causal claim is not in `established` and not in the summary.
  //  3. The text of the stored message carries, as literals from the UXRD, the caption «Главное из установленного», the group words «уверенность …» next to the observation in the summary and in the findings, and the label «причинная связь не доказана» next to the causal claim;
  //     the text and the metadata name the same items and the same group.
  //  4. The delivery loop runs again for the same investigation (a re-append after regeneration): the thread has one answer message and its text and metadata are unchanged. The next chat turn's model input holds the stored text of the answer.
  //
  // AC: "Given проверяющий вызов отнёс утверждение к причинным, Then оно стоит в «Предположениях» и никогда - в «Установлено»." (AC-14.1); "Given ответ со сводкой выдан, Then каждый пункт сводки дословно совпадает с текстом принятого утверждения этого ответа." (AC-16.1)
  // Verification: the metadata read back from the HTTP response, not from the engine; the one answer message of the thread; the group word of the summary item equals the group word beside the same finding in the text.
  // Behavior: employee message -> chat turn starts the investigation -> real engine verifies, assembles and stores the answer with its message -> the delivery loop reads the message with `readAnswerMessage`, adds `launch` and saves it -> the thread read returns it
  // Catches: a contract schema of the conversation message that strips the new fields (`summaryItems`, `confidence`, `causal`) so the screen shows nothing new; a delivery loop that rebuilds or edits the engine's message instead of adding only `launch`; a re-append that writes a second
  //          message or another text; a text and metadata that diverge once they pass through the real storage and the HTTP read; the real engine's stored answer that no in-process test carries across the delivery loop of the server. The engine double of the chat-entry E2E cannot show any of these.
  // @category: e2e
  // @dependency: full-system (built apps/api process, real runtime and engine, mcp-fixture process, Postgres, scripted chat and role models)
  // @complexity: high
  describe('E2E-1', () => {
    beforeAll(async () => {
      await dropLeftoverDatabases();
    });

    afterAll(() => {
      expect(aliveChildren()).toEqual([]);
    });

    it(
      'E2E-1: the employee gets the answer message with the summary, the group words and the causal label, the HTTP read keeps the new metadata fields, and a re-append leaves one unchanged message',
      async () => {
        const run = await runEngineJourney();

        const { investigationId, launchKey } = run.firstDelivery;
        const answerId = `research-answer-${String(investigationId)}`;
        const answersIn = (read: HistoryMessage[]) =>
          read.filter((message) => message.id === answerId);
        const [delivered] = answersIn(run.firstRead);

        // The metadata as the HTTP read returns it under `researchAnswer`: the engine's fields with `launch` added and
        // nothing else; the causal claim stands in `assumed` with its flag, never in `established` or in the summary
        // (AC-14.1). The page is the first of more records, so the source is truncated.
        const researchAnswer = researchAnswerOf(delivered);
        const snapshot = researchAnswer?.sources?.[0]?.snapshot;
        expect(researchAnswer).toEqual({
          launchKey,
          launch: { messageId: run.modeMessage.id },
          goal: ENGINE_JOURNEY.goal,
          summary: null,
          summaryItems: [
            {
              claimId: expect.any(String),
              text: ENGINE_JOURNEY.observation,
              confidence: 'low',
            },
          ],
          outcome: 'answered',
          stopReason: null,
          established: [
            {
              text: ENGINE_JOURNEY.observation,
              footnotes: [1],
              verified: true,
              confidence: 'low',
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
        // The contract schema the web reads it with keeps every new field.
        expect(ResearchAnswerMetadataSchema.parse(researchAnswer)).toEqual(
          researchAnswer,
        );

        // The text carries the UXRD literals and names the same items, groups and label as the metadata (KD-8,
        // Invariant 9, AC-16.1: the summary item is the accepted claim's text).
        expect(textOf(delivered)).toBe(
          [
            '**Ответ ресерча** · Есть ответ',
            `Цель: ${ENGINE_JOURNEY.goal}`,
            '',
            `### ${MC_2_CAPTION}`,
            `- ${ENGINE_JOURNEY.observation} (${MC_1_LOW})`,
            '',
            '### Установлено',
            `- ${ENGINE_JOURNEY.observation} [1] (${MC_1_LOW})`,
            '',
            '### Предположения',
            `- ${ENGINE_JOURNEY.causal} [1] (${MC_3_CAUSAL})`,
            '',
            '### Источники (1)',
            `1. fixture · search_logs · ${String(snapshot)} · данные усечены`,
          ].join('\n'),
        );

        // The answer was delivered after the reply to the question, then re-appended after the regenerated reply.
        expect(run.reDelivery.investigationId).toBe(investigationId);
        expect(
          run.firstRead.map((message) => [message.role, textOf(message)]),
        ).toEqual([
          ['user', `Разберись: ${ENGINE_JOURNEY.goal}`],
          ['assistant', expect.any(String)],
          ['user', 'Что проверить, пока идёт ресерч?'],
          ['assistant', ENGINE_JOURNEY.replies[0]],
          ['assistant', textOf(delivered)],
        ]);
        const questionAt = run.lastRead.findIndex(
          (message) => message.id === run.question.id,
        );
        expect(
          run.lastRead
            .slice(questionAt)
            .map((message) => [
              message.id === answerId ? 'answer' : message.role,
              textOf(message),
            ]),
        ).toEqual([
          ['user', 'Что проверить, пока идёт ресерч?'],
          ['assistant', ENGINE_JOURNEY.replies[1]],
          ['answer', textOf(delivered)],
          ['user', 'Что показал ресерч?'],
          ['assistant', ENGINE_JOURNEY.replies[2]],
        ]);

        // One answer message, stored once, with the same text and metadata as before the regenerate.
        expect(run.storedAnswers).toBe(1);
        const reappended = answersIn(run.lastRead);
        expect(reappended).toHaveLength(1);
        expect(reappended[0]?.parts).toEqual(delivered?.parts);
        // The re-append writes it at its new position (`createdAt`), with the same answer.
        expect(researchAnswerOf(reappended[0])).toEqual(
          researchAnswerOf(delivered),
        );

        // The chat model of the next turn reads the stored text of the answer.
        expect(run.nextTurnInput).toContainEqual({
          role: 'assistant',
          text: textOf(delivered),
        });
        expect(run.exitCode).toBe(0);
      },
      RUN_TIMEOUT_MS,
    );
  });

  // ---------------------------------------------------------------------------------------------------------------
  // E2E-2  The developer changes the verifier prompt, the server refuses to start until the calibration is run again, then starts and uses the new groups
  // ---------------------------------------------------------------------------------------------------------------
  // User journey: the developer calibrates the verifier, edits one word of its prompt, tries to start the server, calibrates again and starts it. Commands and the server run as separate processes in this order:
  //  1. `calibrate` the first calibration set with a scripted verifier that errs on pairs of the kinds `values_match_meaning_wrong` and `insufficient`, exit code 0. Then: a group table file and a calibration report are written; the report shows, for each kind of pair
  //     (`supported`, `values_match_meaning_wrong`, `causal`, `contradicted`, `insufficient`), the shares of agreement with the key on "do the records support" and on the type, and the share of the algorithm's decisions that match the key, and for each group the number of pairs and the share
  //     of right claims; the shipped location of the table now holds the file.
  //  2. Start the server with the verifier prompt edited by one word. Then: the process exits with a non-zero code and the error `calibration_missing`, naming the process id, the version and the prompt fingerprint; it never listens.
  //  3. `calibrate` again with a different scripted verifier, exit code 0, then start the server with the same edited prompt. Then: the server starts and listens; an investigation started in it whose claim has the profile placed in a group by the NEW table stores that group, not the group of the old table.
  //     (The self-check program starts without a table: this second `calibrate` runs with the edited prompt, for which no table exists yet, and is not refused by the start check.)
  //
  // AC: "Given модель или промпт проверяющего вызова изменились, When калибровка прогнана заново, Then границы групп уверенности берутся из нового прогона." (AC-06.2); "Given калибровка прогнана, Then отчёт показывает долю совпадений проверяющего вызова с ключом по каждому типу пар." (AC-06.1);
  //     "Given калибровка прогнана, Then отчёт калибровки показывает долю верных утверждений по каждой группе." (AC-15.2); DC-2: "Сервер не стартует, если у загруженной конфигурации с возможностью `verify` нет таблицы групп для модели и версии промпта её роли `verifier`..."
  // Verification: exit codes and stderr of the processes; the table and report files as written; the group of the claim read from the server's stored revision; the table file the second calibration wrote is the one the second server run loaded.
  // Behavior: developer commands -> built self-check program calls the verifier per pair, writes the table -> the server composition loads the shipped tables and refuses a configuration without one -> after the new table it starts and the engine stores groups from it
  // Catches: a server composition that does not pass `requireCalibration`, so the server starts with groups taken from a stale or empty table (every claim in the lowest group, silently); a table keyed by the model alone, so a prompt edit does not invalidate it; a program entry that refuses to calibrate
  //          because it too lacks a table; a table written where the server does not read it. In-process tests build the engine directly and see none of these.
  // @category: e2e
  // @dependency: full-system (built apps/api server and self-check program, mcp-fixture process, Postgres, scripted verifier)
  // @complexity: high
  describe('E2E-2', () => {
    const databases = new ScratchDatabases();
    const commands: SelfCheckCommand[] = [];
    let databaseUrl: string | undefined;
    let workDir: string | undefined;

    beforeAll(async () => {
      assertSelfCheckChildBuildFresh();
      await dropLeftoverDatabases();
      databaseUrl = await databases.create();
      workDir = await mkdtemp(join(tmpdir(), 'engine-e2e-2-'));
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

    /** `calibrate` of the set as a process, its scripted verifier erring on the pair kinds of `errsOn`. */
    function calibrate(input: {
      readonly name: string;
      readonly out: string;
      readonly errsOn: string;
      readonly config?: string;
    }): Promise<SelfCheckCommandResult> {
      if (databaseUrl === undefined) {
        throw new Error('beforeAll did not finish');
      }
      const command = new SelfCheckCommand({
        argv: [
          'calibrate',
          '--set',
          CALIBRATION_SET,
          '--out',
          input.out,
          ...(input.config === undefined ? [] : ['--config', input.config]),
        ],
        reportsDir: join(workPath(), input.name),
        env: {
          DATABASE_URL: databaseUrl,
          [CALIBRATION_ERRS_ON_VARIABLE]: input.errsOn,
        },
      });
      commands.push(command);
      return command.exited;
    }

    /** The table file as written, read with the schema the engine loads it with. */
    const tableAt = (path: string): GroupTable =>
      GroupTableSchema.parse(JSON.parse(readFileSync(path, 'utf8')));

    /** A research mode message in a new thread; resolves its investigation once the answer is delivered. */
    async function investigate(
      session: ChatEntrySession,
      started: Awaited<ReturnType<ChatEntrySession['start']>>,
    ): Promise<string> {
      const { child, api } = started;
      const user = newUser();
      const created = await api(user, '/api/threads', { method: 'POST' });
      expect(created.status).toBe(201);
      const threadId = ThreadSummarySchema.parse(await created.json()).id;
      const launch = async (): Promise<LaunchRow | undefined> => {
        const rows = await session.query<LaunchRow>(
          `SELECT launch_key AS "launchKey", state, investigation_id AS "investigationId", answered_at AS "answeredAt"
             FROM app.research_chat_launches WHERE resource_id = $1 AND thread_id = $2`,
          [user, threadId],
        );
        return rows.length === 1 ? rows[0] : undefined;
      };
      const modeMessage = userMessage(`Разберись: ${ENGINE_JOURNEY.goal}`, {
        [RESEARCH_METADATA_KEYS.deepResearch]: true,
      });
      expect(await turn(api, user, threadId, modeMessage)).toBe(200);
      const running = await session.until(
        'a running launch',
        child,
        async () => {
          const row = await launch();
          return row?.state === 'running' ? row : undefined;
        },
      );
      const investigationId = String(running.investigationId);
      child.release(investigationId);
      await session.until('the answer delivered', child, async () => {
        const row = await launch();
        return row?.state === 'answered' ? row : undefined;
      });
      return investigationId;
    }

    it(
      'E2E-2: calibrate, edit one word of the verifier prompt, the server refuses to start with calibration_missing, calibrate again, the server starts and stores the group of the new table',
      async () => {
        const tablesDir = join(workPath(), 'group-tables');
        await mkdir(tablesDir);
        const shippedTable = join(tablesDir, '1-shipped-verifier.json');
        const editedTable = join(tablesDir, '2-edited-verifier.json');
        const configFile = join(workPath(), 'deep-research-verifier-edit.json');
        expect(EDITED_VERIFIER_PROMPT).not.toBe(SHIPPED_VERIFIER.prompt);
        await writeFile(configFile, JSON.stringify(verifierEditConfig), 'utf8');

        // 1. The shipped configuration calibrated with a verifier that errs on the pairs whose values match and whose
        //    meaning is wrong and on the pairs the records do not decide: the table names the model and the shipped
        //    prompt version; the report shows the shares per kind of pair (AC-06.1) and the share of right claims per
        //    group (AC-15.2). The count pairs' profile (three right, three wrong) ranks above the journey's (three
        //    right of nine), so the journey's profile is in `medium`; answered by the key, both profiles are right on
        //    every pair and the tie puts the journey's profile first, in `high`.
        const first = await calibrate({
          name: 'calibrate-shipped',
          out: shippedTable,
          errsOn: 'values_match_meaning_wrong,insufficient',
        });
        expect(first.exitCode, first.stderr).toBe(0);
        const firstTable = tableAt(shippedTable);
        expect(firstTable).toMatchObject({
          model: VERIFIER_MODEL,
          promptVersion: SHIPPED_VERIFIER_VERSION,
          scenarioSet: CALIBRATION_SET,
          groupCount: 3,
        });
        expect(journeyGroupIn(firstTable)).toBe('medium');
        expect(firstTable.pairKinds).toContainEqual({
          pairKind: 'values_match_meaning_wrong',
          supportMatch: 0,
          typeMatch: 1,
          decisionMatch: 0,
        });
        // The journey's profile: three right observation pairs, three of wrong meaning and three the records do not
        // decide.
        expect(firstTable.groups).toContainEqual({
          group: 'medium',
          establishedPairs: 9,
          correctShare: 1 / 3,
        });
        const report = first.stdout.split(/\r?\n/);
        expect(report).toContain(
          `- Модель: ${VERIFIER_MODEL}; версия промпта: ${SHIPPED_VERIFIER_VERSION}`,
        );
        // The old veto column: these pairs' values match, so the veto establishes them as the algorithm does - also
        // wrong on every pair (AC-13.2).
        expect(report).toContain(
          '| values_match_meaning_wrong | 0.0 % | 100.0 % | 0.0 % | 0.0 % |',
        );
        expect(report).toContain('| medium | 9 | 33.3 % | — |');

        await withChatEntrySession(
          async (session) => {
            // 2. One word of the verifier prompt edited, same process and version: the server refuses to start with
            //    `calibration_missing`, naming the process, the version, the model and the new prompt version, and
            //    never listens (DC-2) - the table of the same model for the old prompt does not count.
            const refused = await session.startRefused();
            expect(refused).toEqual({
              exitCode: 1,
              listened: false,
              failure: {
                code: 'calibration_missing',
                message:
                  `no group table for process deep-research version 2: verifier model ${VERIFIER_MODEL}, ` +
                  `prompt version ${EDITED_VERIFIER_VERSION}; build one with the calibrate command`,
              },
            });

            // 3. The edited configuration calibrated with a verifier that answers every pair by its key: the program
            //    starts without a table for it, and the new table puts the journey's profile in another group.
            const second = await calibrate({
              name: 'calibrate-edited',
              out: editedTable,
              errsOn: '',
              config: configFile,
            });
            expect(second.exitCode, second.stderr).toBe(0);
            const secondTable = tableAt(editedTable);
            expect(secondTable).toMatchObject({
              model: VERIFIER_MODEL,
              promptVersion: EDITED_VERIFIER_VERSION,
              scenarioSet: CALIBRATION_SET,
              groupCount: 3,
            });
            expect(journeyGroupIn(secondTable)).toBe('high');

            // The server starts on both tables, and the supported claim of its investigation stores the group of the
            // new table (AC-06.2): not the old table's `medium`, not the lowest group of a missing table.
            const started = await session.start();
            const investigationId = await investigate(session, started);
            const supported = await session.query<{
              text: string;
              confidence: string | null;
            }>(
              `SELECT text, confidence FROM app.research_claims
                 WHERE investigation_id = $1 AND status = 'supported' ORDER BY seq`,
              [investigationId],
            );
            expect(supported).toEqual([
              { text: ENGINE_JOURNEY.observation, confidence: 'high' },
            ]);
            expect(await started.child.stop()).toBe(0);
          },
          'scripted-roles',
          { processFile: configFile, groupTablesDir: tablesDir },
        );
      },
      RUN_TIMEOUT_MS,
    );
  });
});
