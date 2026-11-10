// deep-research / chat-entry E2E Test Skeletons (api process) - Design Doc: docs/features/deep-research/design-chat-entry.md
// PRD: docs/features/deep-research/prd.md v1.12 (NFR-03, FR-19, FR-20; FR-26 and FR-27 in the L1 scenario only). Verification Strategy of the runtime: "Correctness Proof Method", kill matrix (design-runtime.md).
// Generated: 2026-11-01 | Updated: 2026-11-01 for the no-source mode (Design Doc v1.6: KD-8, DC-8, DC-9, UC-12, UC-13; E2E-1 unchanged, L1-6 extended, L1-7 added) | Part: chat-entry | Test type: End-to-End (a built api process + real runtime + real Postgres; scripted chat model and engine double behind the composition root), CI job `e2e` of apps/api
// Implementation timing: after all chat-entry slices land (final phase only). E2E-1 needs the chat-entry crash points, which the plan adds with the launch and delivery slices.
// Counterpart in-process file: deep-research-chat-entry.int.e2e-spec.ts. The runtime's own kill matrix (packages/runtime/test/research-runtime-runtime.e2e-spec.ts) proves the primitives; the engine's E2E-2 proves the engine on top of them;
// this file proves the part's two writes that span a process death.
//
// File name follows the project convention (`*.e2e-spec.ts` under apps/api/test, run by vitest.config.e2e.ts; no config is created here). The api child is booted the way research-runtime-boot.e2e-spec.ts boots
// `dist/main.js` (scratch database per row), from its own compiled entry: test/support/chatEntryChildMain.ts, built by `pnpm --filter api build:child` into `dist/test-child/` (`test:e2e:chat-entry` builds it first);
// `dist/main.js` and `src/` never import it.
//
// Environment:
// - Postgres 16 from infra/docker-compose.yml. Each row runs in its own scratch database (CREATE DATABASE, dropped afterwards), so a killed process leaves no row for a neighbour; migrations applied with the entry of @agent-os/db.
// - The only doubles are the model boundary (a scripted chat model: one `deepResearch` call) and the engine port (a test Engine over the real runtime whose controller task finishes when the test releases it), both selected by the
//   child's composition when `E2E_CHAT_ENTRY_DOUBLES=1` (test/support/chatEntryDoubles.ts). No network, no API key.
// - Crash points of the part live in the child's code, not in `src` and not in the runtime's closed `RUNTIME_CRASH_AT` list (the runtime's contract does not change): `CHAT_ENTRY_CRASH_AT=<point>[:n]`, ignored when
//   NODE_ENV=production, exits with code 137 as the runtime's `CrashPoints` do:
//   `chat-entry.launch.after-launching` (row written `launching`, `startInvestigation` not yet called - Flow 1, Flow 2),
//   `chat-entry.append.after-save` (answer message saved, row not yet `answered` - Flow 3, NFR-03, UC-5).
// - Isolation: a unique user per row (`x-user-id`); the file runs with fileParallelism false (the project config).
// - Time: `RUNTIME_POLL_MS`, `RESEARCH_LAUNCH_RECOVERY_MS` short for this file; "within the target" for recovery is the harness timeout of the wait for the end state. No latency assertions.
// - Support: test/support/chatEntryChild.ts (build freshness check, test-server check, leftover fence of scratch databases, spawn, wait for readiness, kill, restart without the crash point), test/support/chatEntryDoubles.ts.
//
// Budget: E2E 2 of 2 for the part - E2E-1 here, E2E-2 the L1 browser scenario in docs/features/deep-research/chat-entry/l1-browser-scenarios.md (executed by hand; the repo has no browser runner), the way chat-shell keeps its own.
// E2E-1 stays because nothing at a lower level can prove a real process death: the in-process rows prove the rule (INT-2 D1 redelivery, INT-2 D4 retry), not that the state a dying process leaves is the one the loop expects.
// ROI uses the raw skill formula like the sibling parts; no E2E test reaches a ">50" threshold with it. The PRD names this test: NFR-03 "проверяется тестом с убийством процесса".
// The no-source mode (PRD 1.12) adds no process-kill row: the mode is a stored value copied once (INT-1 A6) and stored in the answer message (INT-2 D1 and the engine builder row `model_knowledge with claims`), and a restart changes neither (the kill rows below keep the same launch and answer rows).
// It adds observations to the L1 scenario (L1-6 extended, L1-7 new), which is where the real boot without the fixture package, the log lines and the screen-reader reading can be seen.

import { randomUUID } from 'node:crypto';
import {
  type HistoryMessage,
  RESEARCH_METADATA_KEYS,
  ThreadMessagesResponseSchema,
  ThreadResearchResponseSchema,
  ThreadSummarySchema,
} from '@agent-os/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  aliveChildren,
  type ChatEntryChild,
  type ChatEntrySession,
  type ChildApi,
  dropLeftoverDatabases,
  withChatEntrySession,
} from './support/chatEntryChild.js';
import {
  type ChatEntryCrashPoint,
  CRASH_EXIT_CODE,
} from './support/chatEntryDoubles.js';
import { newUser } from './support/seed.js';

/** Harness timeout of one run: two boots, a recovery and a delivery; not a latency check. */
const RUN_TIMEOUT_MS = 240_000;

/** A launch row of the scratch database. */
interface LaunchRow {
  launchKey: string;
  state: string;
  mode: string;
  goal: string;
  tokenBudget: number;
  userMessageId: string | null;
  investigationId: string | null;
  sourceMode: string | null;
  finishedAt: Date | null;
  answeredAt: Date | null;
  appendFailedAt: Date | null;
  nextAppendAt: Date | null;
}

/** A stored message of the scratch database, past Memory. */
interface StoredRow {
  id: string;
  role: string;
  createdAt: Date;
  content: string;
}

/** What the run's rows were at a moment: the user's launches and investigations and the thread's messages. */
interface Rows {
  launches: LaunchRow[];
  investigations: { investigationId: string; status: string }[];
  stored: StoredRow[];
}

/** One scripted journey: a research mode message, the controller released, the answer delivered. */
interface Journey {
  /** Exit code of the child that met the crash point; absent in the reference run. */
  crashExitCode?: number | null;
  /** What the dead child left, read while no process ran; absent in the reference run. */
  atKill?: Rows;
  /** The rows once the launch is `answered`, and the thread as GET /messages and GET /research show it then. */
  end: Rows;
  history: HistoryMessage[];
  researchStates: string[];
  /** Exit code of the child that ran the journey to its end, after its stop. */
  lastExitCode: number | null;
}

async function rowsOf(
  session: ChatEntrySession,
  user: string,
  threadId: string,
): Promise<Rows> {
  const launches = await session.query<LaunchRow>(
    `SELECT launch_key AS "launchKey", state, mode, goal, token_budget AS "tokenBudget",
            user_message_id AS "userMessageId", investigation_id AS "investigationId", source_mode AS "sourceMode",
            finished_at AS "finishedAt", answered_at AS "answeredAt", append_failed_at AS "appendFailedAt",
            next_append_at AS "nextAppendAt"
       FROM app.research_chat_launches WHERE resource_id = $1 AND thread_id = $2
      ORDER BY created_at, launch_key`,
    [user, threadId],
  );
  const investigations = await session.query<{
    investigationId: string;
    status: string;
  }>(
    `SELECT investigation_id AS "investigationId", status FROM app.research_investigations
      WHERE resource_id = $1 ORDER BY created_at, investigation_id`,
    [user],
  );
  const stored = await session.query<StoredRow>(
    `SELECT id, role, "createdAt", content FROM mastra_messages
      WHERE thread_id = $1 ORDER BY "createdAt", id`,
    [threadId],
  );
  return { launches, investigations, stored };
}

/** The only launch row of the thread once it is in `state`; `undefined` before. */
function launchIn(rows: Rows, state: string): LaunchRow | undefined {
  const [launch] = rows.launches;
  return rows.launches.length === 1 && launch?.state === state
    ? launch
    : undefined;
}

/**
 * Sends the research mode message as the web does. The turn's SSE body is read to its end; a child that dies during
 * the turn breaks the response, which a crash row expects.
 */
async function sendResearchMessage(
  api: ChildApi,
  user: string,
  threadId: string,
): Promise<number | 'broken'> {
  const message = {
    id: `client-${randomUUID()}`,
    role: 'user',
    parts: [{ type: 'text', text: 'Разберись: почему падали платежи?' }],
    metadata: { [RESEARCH_METADATA_KEYS.deepResearch]: true },
  };
  try {
    const res = await api(user, '/api/chat/assistant', {
      method: 'POST',
      body: JSON.stringify({ id: threadId, messages: [message] }),
    });
    await res.text();
    return res.status;
  } catch {
    return 'broken';
  }
}

/**
 * The journey in its own scratch database. With `crashAt` the first child dies at that point: the harness waits for its
 * exit, reads what it left, and starts a fresh child without the point that takes the journey to its end.
 */
function runJourney(crashAt?: ChatEntryCrashPoint): Promise<Journey> {
  return withChatEntrySession(async (session) => {
    const user = newUser();
    let { child, api } = await session.start(crashAt);
    const created = await api(user, '/api/threads', { method: 'POST' });
    expect(created.status).toBe(201);
    const threadId = ThreadSummarySchema.parse(await created.json()).id;
    const rows = () => rowsOf(session, user, threadId);
    const reach = (current: ChatEntryChild, state: string) =>
      session.until(`a launch row ${state}`, current, async () =>
        launchIn(await rows(), state),
      );
    let crashExitCode: number | null | undefined;
    let atKill: Rows | undefined;
    const restart = async (dying: ChatEntryChild) => {
      crashExitCode = await dying.exit();
      atKill = await rows();
      ({ child, api } = await session.start());
    };

    const sent = await sendResearchMessage(api, user, threadId);
    if (crashAt === 'chat-entry.launch.after-launching') {
      expect(sent).toBe('broken');
      await restart(child);
    } else {
      expect(sent).toBe(200);
    }
    const running = await reach(child, 'running');
    child.release(String(running.investigationId));
    if (crashAt === 'chat-entry.append.after-save') await restart(child);
    await reach(child, 'answered');

    const end = await rows();
    const history = ThreadMessagesResponseSchema.parse(
      await (await api(user, `/api/threads/${threadId}/messages`)).json(),
    ).messages;
    const research = ThreadResearchResponseSchema.parse(
      await (await api(user, `/api/threads/${threadId}/research`)).json(),
    ).launches;
    const lastExitCode = await child.stop();
    return {
      ...(crashAt !== undefined && { crashExitCode, atKill }),
      end,
      history,
      researchStates: research.map((launch) => launch.state),
      lastExitCode,
    };
  });
}

const answerIdOf = (investigationId: string | null) =>
  `research-answer-${investigationId}`;

/** The run's ids in `value` replaced by their names, so two runs compare apart from ids. */
function withoutIds(value: unknown, launch: LaunchRow): unknown {
  let text = JSON.stringify(value);
  const ids: [string | null, string][] = [
    [launch.investigationId, '<investigationId>'],
    [launch.launchKey, '<launchKey>'],
    [launch.userMessageId, '<userMessageId>'],
  ];
  for (const [id, name] of ids) {
    if (id !== null) text = text.replaceAll(id, name);
  }
  return JSON.parse(text);
}

/**
 * The end of a journey apart from ids and times: the launch row, the answer as stored, how many times the answer is
 * stored and returned, and the thread's launches as GET /research shows them.
 */
function endStateOf(journey: Journey) {
  const [launch] = journey.end.launches;
  if (launch === undefined) throw new Error('the journey left no launch row');
  const answerId = answerIdOf(launch.investigationId);
  const answers = journey.end.stored.filter((row) => row.id === answerId);
  const [answer] = answers;
  return {
    launches: journey.end.launches.map((row) => ({
      state: row.state,
      mode: row.mode,
      goal: row.goal,
      tokenBudget: row.tokenBudget,
      sourceMode: row.sourceMode,
      started: row.investigationId !== null,
      fromUserMessage: row.userMessageId !== null,
      answered: row.answeredAt !== null,
      appendFailedAt: row.appendFailedAt,
      nextAppendAt: row.nextAppendAt,
    })),
    investigations: journey.end.investigations.map((row) => ({
      ofLaunch: row.investigationId === launch.investigationId,
      status: row.status,
    })),
    storedAnswers: answers.length,
    returnedAnswers: journey.history.filter(
      (message) => message.id === answerId,
    ).length,
    answer: answer && {
      role: answer.role,
      content: withoutIds(JSON.parse(answer.content), launch),
    },
    researchStates: journey.researchStates,
    lastExitCode: journey.lastExitCode,
  };
}

/** `[id, role, createdAt]` of the stored messages, in stored order. */
const positionsOf = (stored: StoredRow[]) =>
  stored.map((row) => [row.id, row.role, row.createdAt.toISOString()]);

describe('deep-research / chat-entry - E2E (built api process, real Postgres, scripted model)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // E2E-1  Restart in the middle of a launch or of an answer: one investigation, one answer, no lost row
  // ---------------------------------------------------------------------------------------------------------------
  // User journey: the user sends a question in research mode (or confirms a card) and the api process dies - once right after the launch row was written and before the investigation was started, once after the answer was saved and
  //   before it was marked delivered. The process is started again without the crash point; the user reloads the thread and finds one running or finished research and, at the end, one answer, having repeated nothing.
  // Verification: process-level recovery of the part on top of the runtime's recovery, across the launch row, the engine call and the answer write.
  // Covers (original statements):
  // NFR-03 (PRD, Reliability): "рестарт процесса посреди расследования не теряет и не дублирует его: расследование доходит до ответа, и ответ дописан в беседу ровно один раз; проверяется тестом с убийством процесса."
  // AC-19.1: "Given пользователь явно выбрал глубокое исследование для сообщения, When он его отправил, Then по нему запущено расследование этого пользователя в этой беседе, а беседа показывает, что оно идёт." (after the restart)
  // AC-20.2: "Given ответ дописан, When беседа перезагружена или открыта позже, Then ответ стоит в ней ровно один раз, на позиции, которую получил при завершении расследования."
  // Use cases: UC-5, UC-E6. Flow 1 (failure bullet "Процесс падает между launching и running"), Flow 3 (failure bullet "Сбой процесса между записью сообщения и отметкой answered"). KD-3, KD-4, Risks ("Процесс падает во время хода после старта расследования").
  //
  // Primary failure mode (turns red when): a row stuck in `launching` is never completed, or is completed with a second investigation; the restarted loop writes the answer a second time (a different id, or the same id moved to a later position);
  // the row is left `answer_pending` forever after the message was saved; the answer lands before the messages that were stored while the process was down.
  // Behavior: kill at crash point -> the process is started again without it -> the delivery loop finds the stale `launching` row after `RESEARCH_LAUNCH_RECOVERY_MS` and repeats `startInvestigation` with the same `launchKey`
  //   (the engine answers `existing` or `created`), or finds the `answer_pending` row whose message already exists and overwrites the same message id -> GET /research and GET /messages show the end state
  // @category: e2e
  // @dependency: full-system (built api, runtime, chat-entry module, Postgres, crash points)
  // @complexity: high
  //
  // Verification items (table of crash points; the end state of each is compared with an uninterrupted reference run of the same scripted journey):
  // - K1 after `launching`, before `startInvestigation` (UC-E6, AC-19.1): after the restart and `RESEARCH_LAUNCH_RECOVERY_MS` the thread has exactly one investigation of the user, the row is `running` and then `answered` when the controller is released,
  //   the answer is stored once; the stored reply of the killed turn may be missing (accepted residual risk of the Design Doc) and the test does not require it
  // - K2 after the answer was saved, before `answered` (UC-5, NFR-03, AC-20.2): after the restart one message `research-answer-<investigationId>` exists in the thread, at the position and with the `createdAt` it had before the kill
  //   (compare the pre-kill snapshot, read from the database while the process is down), the row is `answered`, GET /messages after a reload shows it once, and a message the user stored while the process was down is before it only if it was stored before the answer
  // - Both rows: final launch row and message list equal those of the reference run apart from ids and times; no launch row of the user remains in `launching` or `answer_pending`
  describe('E2E-1', () => {
    let reference: Journey;

    beforeAll(async () => {
      await dropLeftoverDatabases();
      reference = await runJourney();
    }, RUN_TIMEOUT_MS);

    afterAll(() => {
      // No child of the file outlives it.
      expect(aliveChildren()).toEqual([]);
    });

    /** The uninterrupted run, checked against literals: every row is compared with it. */
    function referenceEnd() {
      const end = endStateOf(reference);
      expect(end).toEqual({
        launches: [
          {
            state: 'answered',
            mode: 'explicit',
            goal: 'Почему падали платежи после релиза?',
            tokenBudget: 400_000,
            sourceMode: 'model_knowledge',
            started: true,
            fromUserMessage: true,
            answered: true,
            appendFailedAt: null,
            nextAppendAt: null,
          },
        ],
        investigations: [{ ofLaunch: true, status: 'completed' }],
        storedAnswers: 1,
        returnedAnswers: 1,
        answer: {
          role: 'assistant',
          content: {
            format: 2,
            parts: [
              {
                type: 'text',
                text: [
                  'Источники данных не подключены — ответ опирается только на знания модели и не проверен по данным.',
                  '',
                  '**Ответ ресерча** · Есть ответ',
                  'Цель: Почему падали платежи после релиза?',
                  '',
                  '### Предположения',
                  '- Платежи падали из-за просроченного сертификата. (из знаний модели, без источника)',
                ].join('\n'),
              },
            ],
            metadata: {
              researchAnswer: {
                goal: 'Почему падали платежи после релиза?',
                launchKey: '<launchKey>',
                launch: { messageId: '<userMessageId>' },
                outcome: 'answered',
                stopReason: null,
                summary: null,
                summaryItems: [],
                sourceMode: 'model_knowledge',
                established: [],
                assumed: [
                  {
                    text: 'Платежи падали из-за просроченного сертификата.',
                    footnotes: [],
                    verified: false,
                    confidence: null,
                    causal: false,
                  },
                ],
                unknown: [],
                sources: [],
              },
            },
          },
        },
        researchStates: ['completed'],
        lastExitCode: 0,
      });
      expect(reference.end.stored.map((row) => row.role)).toEqual([
        'user',
        'assistant',
        'assistant',
      ]);
      return end;
    }

    it(
      'E2E-1 K1: a kill after the launch row and before the engine call leaves one investigation and one delivered answer after the restart',
      async () => {
        const expected = referenceEnd();

        const run = await runJourney('chat-entry.launch.after-launching');

        expect(run.crashExitCode).toBe(CRASH_EXIT_CODE);
        // The dead process left the row `launching` and no investigation: the crash came before the engine call.
        expect(
          run.atKill?.launches.map((row) => [row.state, row.investigationId]),
        ).toEqual([['launching', null]]);
        expect(run.atKill?.investigations).toEqual([]);
        // The restarted loop finished the row with one investigation, released and answered like the reference run;
        // the reply of the killed turn may be missing, so the message list is not compared.
        expect(endStateOf(run)).toEqual(expected);
        expect(run.end.investigations).toHaveLength(1);
      },
      RUN_TIMEOUT_MS,
    );

    it(
      'E2E-1 K2: a kill after the answer message was saved and before the row was marked leaves the answer once, at its original position, after the restart',
      async () => {
        const expected = referenceEnd();

        const run = await runJourney('chat-entry.append.after-save');

        expect(run.crashExitCode).toBe(CRASH_EXIT_CODE);
        const atKill = run.atKill;
        if (atKill === undefined) throw new Error('the crash row read nothing');
        const [launch] = atKill.launches;
        // The dead process saved the answer and left the row `answer_pending`.
        expect(atKill.launches.map((row) => row.state)).toEqual([
          'answer_pending',
        ]);
        expect(
          atKill.stored.filter(
            (row) => row.id === answerIdOf(launch?.investigationId ?? null),
          ),
        ).toHaveLength(1);
        // After the restart: no second answer, the same position and `createdAt`, nothing else moved.
        expect(positionsOf(run.end.stored)).toEqual(positionsOf(atKill.stored));
        expect(run.history.map((message) => message.id)).toEqual(
          run.end.stored.map((row) => row.id),
        );
        expect(endStateOf(run)).toEqual(expected);
        // The whole thread equals the reference run's apart from ids and times.
        expect(run.end.stored.map((row) => row.role)).toEqual(
          reference.end.stored.map((row) => row.role),
        );
      },
      RUN_TIMEOUT_MS,
    );
  });
});
