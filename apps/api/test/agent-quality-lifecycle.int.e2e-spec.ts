// agent-quality / lifecycle Integration Test Skeletons (api side) - Design Doc: docs/features/agent-quality/design-lifecycle.md
// PRD: docs/features/agent-quality/prd.md (FR-19 delivery order, FR-21, FR-22). ADRs: ADR-0001 (runtime owner), ADR-0002 (app schema migrations), ADR-0003 (Drizzle data layer).
// Generated: 2026-11-06 | Part: lifecycle | Test type: Integration (in-process Nest app(s) + real runtime + real Postgres, scripted chat model, engine double)
// Implementation timing: created alongside the slice each test names (stop operation and route + `stopResearch` tool; shared thread lock + run marks).
//
// File name and placement. Same as the sibling api files (`deep-research-chat-entry.int.e2e-spec.ts`): `apps/api/test/*.e2e-spec.ts`, picked up by `vitest.config.e2e.ts`; not part of the default
// `vitest run` (its include is `**/*.spec.ts`). The part's other tests live next to the code they exercise: packages/engine (INT-3, E2E-1), packages/runtime (INT-4), packages/db (INT-5).
// Test numbering is global for the part: INT-1 and INT-2 are in this file. The browser half (the card calls the route instead of a hidden turn) belongs to the separate part `web`; no browser test is here.
//
// Environment (Design Doc "Test Strategy", "Contract Definitions"):
// - Postgres 16 from infra/docker-compose.yml, migrations applied once by test/support/migrate.global-setup.ts (`app.chat_thread_runs` included). Real AppModule pieces: ChatController,
//   ResearchChatController (the new stop route), ThreadsService, ThreadWriteLock, ThreadRunRegistry, Mastra Memory over PostgresStore, the real runtime with InvestigationService and the event consumers,
//   ResearchLaunchService, ResearchAnswerAppender, AuditInterceptor, SessionGuard (users are told apart by `x-user-id`).
// - Doubles are the same two as in the chat-entry file and only these: the chat model (scripted per turn through test/support/mockModels.ts, calls counted) and the engine port (test/support/engineDouble.ts over
//   a real investigation whose controller task is a latch-held test handler).
// - Harness changes that this part makes necessary (to add with the slices, not created here):
//   (a) the engine double must close the investigation the way `engine.lifecycle` does (register the real consumer, or call `InvestigationService.closeInTx` on the controller's end), because the delivery loop now
//       writes an answer only for a `completed` investigation (DC-2); the EXISTING chat-entry tests that deliver answers (deep-research-chat-entry.int.e2e-spec.ts INT-2, the e2e file) depend on this change;
//   (b) `createResearchChatApp` is called twice over one database to get two instances (`instance` label for log/diagnostics, separate pools, separate in-memory `ThreadRunRegistry`, shared Postgres): the
//       advisory lock and the run marks must be the only things the two instances share (KD-5, KD-6);
//   (c) a `pauseMarkRenewal(instance)` hook on the registry's renewal timer for INT-2 M5. The "no model-call row after the stop" check over `research_llm_calls` is not here: it moved to
//       packages/engine INT-3, where the ledger is written.
// - Isolation (project convention, no truncate): a unique `resourceId = newUser()` per test as `x-user-id`, unique thread ids; afterAll removes the threads through ThreadsService.
// - Time: the delivery loop is driven by single passes (`runAppenderOnce`); the lease of a run mark (30 s) is crossed by `clock.advance`, never by waiting. A concurrent step is ordered by holding the
//   thread lock with a latch (`gate`) on one instance, never by a sleep.
//
// Budget (whole part, five files): Integration 5 (limit 3; up to 5 only when each extra test names the defect no other test catches), E2E 1 (limit 2).
//   Core: INT-1 (stop), INT-2 (shared guarantees across instances), INT-3 (closure and the ban on new model calls, packages/engine).
//   Extras: INT-4 (task time limits, packages/runtime: the origin of each timer is visible only against a real Postgres and a real dispatcher + sweeper) and INT-5 (the backfill of the migration, packages/db:
//   only a migrated real Postgres shows a wrong mapping of already-finished investigations). Rows of one rule or one flow are table rows of one INT, not tests.
//
// Proven elsewhere (not in this file):
// - closure of the investigation when the controller ends, and `stopping` of the model-call reserve: packages/engine INT-3, E2E-1 (kill between the controller's result and the closure).
// - the api wiring of `engine.lifecycle` (AC-19.1 in the composition): no test; `createEngine` takes `runtime.eventConsumers` as a REQUIRED parameter, so a composition that forgets it does not typecheck.
// - unit tables (named for the plan, not skeletons): the stop decision per launch state (`launch-state.spec.ts`: only `running` and `answer_pending` stop, every other state is returned as is - INT-1 S2 keeps
//   just two wired cases of it, the repeated stop of a `stopped` launch included there); the `stopResearch` target choice (`stop-target.spec.ts`: key present and owned / key foreign or unknown / no key with
//   none, one or several running - INT-1 S5 keeps the wired rows "ambiguous", "named key", "lock refused" and the legacy turn; "no key, one running" and "a key of another owner" are the table's and S4's);
//   the appender's "write only when completed, otherwise count the try as failed" (`research-answer.appender.spec.ts`, DC-2); `ThreadRunRegistry` renewal every 10 s, release and removal of expired rows
//   against a database port (`thread-run-registry.spec.ts`); `RUNTIME_QUEUE_WAIT_MS` / `RUNTIME_ATTEMPT_MS` allowlist and parse (`runtime-settings.spec.ts`).
// - the 15 s `lock_timeout` is Postgres behaviour; INT-1 S3 scripts "the lock was not obtained" as a failure of the lock and does not wait 15 s.
// - UC-N2 (time to first token with the run mark): a manual acceptance check (the repo has no automatic measurement of it), not a test.

import { randomUUID } from 'node:crypto';
import {
  ApiErrorSchema,
  DeepResearchToolResultSchema,
  RESEARCH_METADATA_KEYS,
  type ResearchDecision,
  ResearchStopResponseSchema,
  StopResearchToolResultSchema,
  ThreadResearchResponseSchema,
} from '@agent-os/contracts';
import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { ThreadRunRegistry } from '../src/threads/thread-run-registry.js';
import type { ScriptedAnswer } from './support/engineDouble.js';
import {
  deepResearchCallStep,
  heldStep,
  type RecordedChatCall,
  STOP_RESEARCH_TOOL,
  stopResearchCallStep,
  textStep,
} from './support/mockModels.js';
import {
  createResearchChatApp,
  type ResearchChatApp,
  runMarksOf,
  threadLockWaiters,
} from './support/researchChatApp.js';
import {
  investigationsOf,
  type LaunchRow,
  launchOf,
  launchVersionsOf,
  storedMessagesOf,
} from './support/researchChatDb.js';
import { closeRuntimeDb } from './support/wiring-handlers.js';

/** Long enough for a chat turn with the real Memory and lock; not a latency check. */
const TURN_TIMEOUT_MS = 30_000;
const BOOT_TIMEOUT_MS = 60_000;
/** The audit `type` of a stop request: method and route path (AuditInterceptor). */
const STOP_AUDIT_TYPE = 'POST /api/threads/:threadId/research/:launchKey/stop';

let t: ResearchChatApp;

/** A user message as the web sends it; `metadata` carries the research mode. */
function userMessage(text: string, metadata?: Record<string, unknown>) {
  return {
    id: `client-${randomUUID()}`,
    role: 'user',
    parts: [{ type: 'text', text }],
    ...(metadata && { metadata }),
  };
}

/**
 * Sends one chat turn to `on` (default: the first instance) and waits until its run has ended there, so the stored
 * messages and launch rows are final. Returns the SSE body.
 */
async function chat(
  user: string,
  threadId: string,
  message: ReturnType<typeof userMessage>,
  on: ResearchChatApp = t,
): Promise<string> {
  const res = await request(on.app.getHttpServer())
    .post('/api/chat/assistant')
    .set('x-user-id', user)
    .send({ id: threadId, messages: [message] })
    .expect(200);
  const runs = on.moduleRef.get(ThreadRunRegistry, { strict: false });
  await vi.waitFor(
    async () => {
      if (await runs.hasRuns(threadId))
        throw new Error(`chat run of ${threadId} still registered`);
    },
    { timeout: TURN_TIMEOUT_MS, interval: 25 },
  );
  return res.text;
}

/** `value`, or a failure naming `what` when it is null or undefined. */
function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined)
    throw new Error(`${what} is missing`);
  return value;
}

/** Waits until the launch row of `launchKey` is in `state`; returns it. */
async function launchReaching(
  launchKey: string,
  state: string,
): Promise<LaunchRow> {
  let row: LaunchRow | undefined;
  await vi.waitFor(
    async () => {
      row = await launchOf(launchKey);
      expect(row?.state).toBe(state);
    },
    { timeout: TURN_TIMEOUT_MS, interval: 25 },
  );
  return required(row, `launch ${launchKey}`);
}

/** A launch started by a mode turn: its key, its investigation and the id of the mode message. */
interface StartedLaunch {
  launchKey: string;
  investigationId: string;
  messageId: string;
}

/** The research mode message of a goal. */
function modeMessage(goal: string) {
  return userMessage(`Разберись: ${goal}`, {
    [RESEARCH_METADATA_KEYS.deepResearch]: true,
  });
}

/**
 * A mode turn on `on` (default: the first instance) whose `deepResearch` call starts an investigation in the thread;
 * returns once the launch is `running`. The investigation's controller is held by the engine double of `on`.
 */
async function launchResearch(
  user: string,
  threadId: string,
  goal: string,
  on: ResearchChatApp = t,
): Promise<StartedLaunch> {
  const call = deepResearchCallStep({ goal, tokenBudget: 400_000 });
  on.chatModel.script(call.step);
  const message = modeMessage(goal);
  await chat(user, threadId, message, on);
  const row = await launchReaching(call.toolCallId, 'running');
  return {
    launchKey: call.toolCallId,
    investigationId: required(row.investigationId, 'investigationId'),
    messageId: message.id,
  };
}

/** An answer with one claim the model assumed without evidence. */
function assumedAnswer(text: string): ScriptedAnswer {
  return {
    answerId: `answer-${randomUUID()}`,
    outcome: 'answered',
    stopReason: null,
    summary: null,
    established: [],
    assumed: [{ claimId: 'c1', text, evidenceIds: [], verified: false }],
    unknown: [],
    removed: [],
  };
}

/** A launch finished by the engine double and its answer written by a pass of the delivery loop. */
async function answerLaunch(launch: StartedLaunch, text: string) {
  t.engine.succeed(launch.investigationId, {
    answer: () => assumedAnswer(text),
  });
  await launchReaching(launch.launchKey, 'answer_pending');
  await t.runAppenderOnce();
  await launchReaching(launch.launchKey, 'answered');
}

/** The stop route as the card calls it, on `on` (default: the first instance): no body. */
function stopRequest(
  user: string,
  threadId: string,
  launchKey: string,
  on: ResearchChatApp = t,
) {
  return request(on.app.getHttpServer())
    .post(`/api/threads/${threadId}/research/${launchKey}/stop`)
    .set('x-user-id', user);
}

/** A stop answered 200; returns the launch of the parsed `ResearchStopResponse`. */
async function stopped(
  user: string,
  threadId: string,
  launchKey: string,
  on: ResearchChatApp = t,
) {
  const res = await stopRequest(user, threadId, launchKey, on).expect(200);
  return ResearchStopResponseSchema.parse(res.body).launch;
}

/** A stop refused with `status`; returns the `errorCode` of the error body. */
async function refusedStop(
  user: string,
  threadId: string,
  launchKey: string,
  status: number,
): Promise<string | undefined> {
  const res = await stopRequest(user, threadId, launchKey).expect(status);
  return ApiErrorSchema.parse(res.body).errorCode;
}

async function research(user: string, threadId: string) {
  const res = await request(t.app.getHttpServer())
    .get(`/api/threads/${threadId}/research`)
    .set('x-user-id', user)
    .expect(200);
  return ThreadResearchResponseSchema.parse(res.body).launches;
}

/** The runtime status of the user's investigation. */
async function investigationStatus(
  user: string,
  investigationId: string,
): Promise<string | undefined> {
  return (await investigationsOf(user)).find(
    (investigation) => investigation.investigationId === investigationId,
  )?.status;
}

/**
 * The `stopResearch` result of one ordinary turn: the turn makes two model calls (the tool call, then the reply), and
 * the reply call's prompt carries the tool result after the turn's user message. Earlier turns' results in the
 * history come before that message and are not read.
 */
function stopToolResult(turn: readonly RecordedChatCall[]) {
  if (turn.length !== 2) {
    throw new Error(
      `a stop turn makes two model calls (tool call, reply), got ${turn.length}`,
    );
  }
  const messages = required(turn.at(-1), 'reply call').messages;
  const lastUser = messages.findLastIndex((message) => message.role === 'user');
  const outputs = messages
    .slice(lastUser + 1)
    .flatMap((message) => (message.role === 'tool' ? message.content : []))
    .flatMap((part) =>
      part.type === 'tool-result' && part.toolName === STOP_RESEARCH_TOOL
        ? [part.output]
        : [],
    );
  const output = required(outputs.at(-1), 'stopResearch result of this turn');
  if (output.type !== 'json') {
    throw new Error(`stopResearch returned a ${output.type} output`);
  }
  return StopResearchToolResultSchema.parse(output.value);
}

/**
 * An ordinary turn "Останови ресерч": the model calls `stopResearch` with `input`, then replies. Returns the tool
 * result as the model received it in its reply call. With `refuseLock`, the thread lock is refused only while the tool
 * runs (from the tool-call step to the reply step), so the turn's own writes still take the lock.
 */
async function askToStop(
  user: string,
  threadId: string,
  input: { launchKey?: string },
  options: { refuseLock?: boolean } = {},
) {
  const call = stopResearchCallStep(input);
  const reply = textStep('Готово, проверил ресерч.');
  t.chatModel.script(
    options.refuseLock
      ? () => {
          t.stopFaults.refuseThreadLock(threadId);
          return call;
        }
      : call,
    options.refuseLock
      ? () => {
          t.stopFaults.refuseThreadLock(null);
          return reply;
        }
      : reply,
  );
  const callsBefore = t.chatModel.calls.length;
  await chat(user, threadId, userMessage('Останови ресерч'));
  return stopToolResult(t.chatModel.calls.slice(callsBefore));
}

/** A thread of a new user with one running research. */
async function runningResearch(goal: string) {
  const user = t.user();
  const threadId = await t.createThread(user);
  const launch = await launchResearch(user, threadId, goal);
  return { user, threadId, launch };
}

/** How long a request may take to reach the thread lock; well under the 15 s lock wait, so a wait is never mistaken. */
const REACH_LOCK_TIMEOUT_MS = 10_000;

/**
 * Waits until `count` requests wait in Postgres for the thread lock of `threadId`: the order point of INT-2. A lock
 * local to a process never shows a waiter, so the wait fails instead.
 */
async function waitersAtLock(threadId: string, count: number): Promise<void> {
  await vi.waitFor(
    async () => expect(await threadLockWaiters(threadId)).toBe(count),
    { timeout: REACH_LOCK_TIMEOUT_MS, interval: 25 },
  );
}

/** Waits until the user's investigation has `status` (a closure is delivered by the relay of either instance). */
async function investigationReaching(
  user: string,
  investigationId: string,
  status: string,
): Promise<void> {
  await vi.waitFor(
    async () =>
      expect(await investigationStatus(user, investigationId)).toBe(status),
    { timeout: TURN_TIMEOUT_MS, interval: 25 },
  );
}

/**
 * A decision turn on `on` as the card's button sends it; the model's `deepResearch` call carries a goal of its own,
 * which the decision does not read. Returns the tool result the turn streamed.
 */
async function decisionTurn(
  on: ResearchChatApp,
  user: string,
  threadId: string,
  decision: ResearchDecision,
) {
  on.chatModel.script(
    deepResearchCallStep({ goal: 'Цель из аргументов модели' }).step,
  );
  const body = await chat(
    user,
    threadId,
    userMessage('Запустить', {
      [RESEARCH_METADATA_KEYS.researchDecision]: decision,
    }),
    on,
  );
  const outputs = body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length))
    .filter((data) => data !== '[DONE]')
    .map((data) => JSON.parse(data) as Record<string, unknown>)
    .filter((chunk) => chunk.type === 'tool-output-available');
  if (outputs.length !== 1) {
    throw new Error(
      `a decision turn streams one tool result, got ${outputs.length}`,
    );
  }
  return DeepResearchToolResultSchema.parse(outputs[0]?.output);
}

/** A research of `on` whose investigation has `completed` and whose launch waits for its answer (`answer_pending`). */
async function readyAnswer(
  user: string,
  threadId: string,
  goal: string,
  on: ResearchChatApp,
): Promise<StartedLaunch> {
  const launch = await launchResearch(user, threadId, goal, on);
  on.engine.succeed(launch.investigationId, {
    answer: () => assumedAnswer(`Ответ: ${goal}`),
  });
  await launchReaching(launch.launchKey, 'answer_pending');
  await investigationReaching(user, launch.investigationId, 'completed');
  return launch;
}

/** The ids of the thread's stored answer messages of `investigationId`. */
async function answerMessagesOf(threadId: string, investigationId: string) {
  return (await storedMessagesOf(threadId))
    .map((message) => message.id)
    .filter((id) => id === `research-answer-${investigationId}`);
}

/** Waits until `on` sees a live run mark of `threadId` (a chat run of any instance). */
async function markSeenBy(on: ResearchChatApp, threadId: string) {
  const runs = on.moduleRef.get(ThreadRunRegistry, { strict: false });
  await vi.waitFor(
    async () => expect(await runs.hasRuns(threadId)).toBe(true),
    { timeout: TURN_TIMEOUT_MS, interval: 25 },
  );
}

describe('agent-quality / lifecycle - integration (in-process Nest + real runtime + real Postgres, scripted chat model)', () => {
  beforeAll(async () => {
    t = await createResearchChatApp({ instance: 'instance-1' });
  }, BOOT_TIMEOUT_MS);

  afterAll(async () => {
    try {
      await t?.close();
    } finally {
      await closeRuntimeDb();
    }
  }, BOOT_TIMEOUT_MS);

  beforeEach(() => t.reset());
  afterEach(() => t.reset());

  // ---------------------------------------------------------------------------------------------------------------
  // INT-1  Stop without a model: the route, the agent tool and the legacy turn are one operation, scoped to the caller's thread
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-21.1: "Given провайдер модели недоступен, When сотрудник подтверждает остановку на карточке, Then сотрудник видит расследование остановленным, и новые вызовы модели не начинаются."
  // AC-21.2: "Given сотрудник просит чат-агента остановить расследование, Then оно останавливается той же операцией."
  // DC-8 (FR-21): "Остановка уже завершённого, упавшего или остановленного ресерча ничего не меняет и возвращает его состояние без ошибки."
  // DC-9 (FR-21): "Остановка с карточки не ждёт конца ответа агента в беседе."
  // DC-10 (FR-21): "Агент без названного `launchKey` останавливает ресерч, только если в беседе идёт ровно один; при нескольких идущих он ничего не меняет и получает их список."
  // Business constraint 2 (data isolation): "Маршрут остановки находит запуск только в беседе вызывающего и покрыт тестом с двумя пользователями (UC-E3)."
  // Use cases: UC-7, UC-8, UC-E1, UC-E2, UC-E3, UC-E7. Flow 1, Flow 2. KD-4. Invariant 5.
  //
  // Primary failure mode (turns red when): the stop goes through the chat agent and fails or waits when the model is down or an answer is streaming; the stop of a settled or still-launching card answers an error or
  // changes it; a failed stop leaves the card in a state the retry cannot finish, or leaks the thread lock; a user stops another user's research (by thread or by `launchKey`); the agent stops the wrong one of two
  // running researches; the legacy hidden `stop` turn of a tab opened before the update no longer stops.
  // Behavior: POST /api/threads/:threadId/research/:launchKey/stop (or a `stopResearch` call of the scripted chat model, or a legacy decision turn) -> ResearchLaunchService.stopLaunch under the thread lock ->
  //   InvestigationService.cancel -> launch `stopped` -> 200 ResearchStopResponse / tool result -> GET /api/threads/:threadId/research shows the stopped card
  // @category: core-functionality
  // @dependency: ResearchChatController, ResearchLaunchService.stopLaunch, stopResearch tool, ThreadWriteLock, InvestigationService.cancel (through the CancelObserver), AuditInterceptor, ChatController, Postgres
  // @complexity: high
  //
  // Verification items (table; every row reads the launch row and the investigation status of the user, and a row-version snapshot where it says "nothing changed"):
  // - S1 no model, no wait (UC-7, AC-21.1, DC-9): the chat model double fails on any call, a research is `running`, and a chat run of the same thread is held by a latch (an answer is streaming) -> POST stop answers 200
  //   with the launch `stopped` BEFORE the latch is released; the chat model double was called zero times by the stop; GET /research shows `stopped`; the investigation is `cancelled`; the ledger of the investigation
  //   gets no row after the stop; exactly one audit record (user, thread, route) is written for the request
  // - S2 settled and starting cards (UC-E1, UC-E7, DC-8): a launch `answered` -> 200, launch unchanged, no error, investigation untouched (row-version snapshot); a launch `launching` (held start) -> 200 with the
  //   launch as it is ("Идёт"), nothing cancelled; the start is then released and the same stop now stops it (`stopped`, investigation `cancelled`). A second stop of a `stopped` launch is a `launch-state.spec.ts`
  //   row and is not wired here
  // - S3 failures and the retry (UC-E2, AC-21.1): table of (cancel refused through `cancels.refuse` | transition to `stopped` refused after the cancel committed | lock not obtained, scripted) -> 500
  //   `RESEARCH_STOP_FAILED`, launch still `running`, investigation `active` in the first and third rows and `cancelled` in the second; after the fault is healed the same request returns 200 `stopped` with the
  //   investigation `cancelled` in all three rows; the retry does not wait for a leaked lock
  // - S4 isolation (UC-E3, business constraint 2): user B stops with A's threadId -> 404 `THREAD_NOT_FOUND`; B stops with B's own thread and A's `launchKey` -> 404 `RESEARCH_LAUNCH_NOT_FOUND`; A's launch and
  //   investigation are unchanged (row-version snapshot) and A's research is still `running`
  // - S5 the agent tool (UC-8, AC-21.2, DC-10, business constraint 2): the scripted chat model answers "останови ресерч" with a `stopResearch` call -> row without a key and two running researches in the
  //   thread, while another owner's research and one in another thread of the same owner run too: nothing changes (row-version snapshots of both owners) and the tool result the model receives is `ambiguous`
  //   with exactly the two candidates of this thread (`launchKey` and goal each); row with the key of one of the two: that one `stopped`, investigation `cancelled`, the other still `running`, the two outside
  //   researches still `running`/`active`; row with the thread lock refused while the tool runs: `stop_failed` with the launch as the choice read it (`running`), investigation `active`, no cancel; row with a
  //   legacy hidden `researchDecision` turn carrying `stop` (a tab opened before the update): the same end state as the route. Rows "no key, one running" and "a key of another owner's research" are the
  //   `stop-target.spec.ts` table and S4, not wired again here
  describe('INT-1', () => {
    it('INT-1 S1: the stop route answers 200 stopped while the model provider fails and an answer is still streaming in the thread, calls no model and writes one audit record', async () => {
      // Arrange (UC-7, DC-9): a running research, then a chat turn of the same thread held in its model call (an
      // answer is streaming); every later model call fails (the provider is down).
      const { user, threadId, launch } =
        await runningResearch('Почему вырос отток');
      const streaming = t.gate(threadId);
      t.chatModel.script(
        heldStep(streaming.promise, textStep('Отвечаю, пока идёт ресерч.')),
        new Error('model provider unavailable'),
      );
      const callsBefore = t.chatModel.calls.length;
      const turn = chat(user, threadId, userMessage('Что пока известно?'));
      const runs = t.moduleRef.get(ThreadRunRegistry, { strict: false });
      await vi.waitFor(
        async () => {
          expect(await runs.hasRuns(threadId)).toBe(true);
          expect(t.chatModel.calls).toHaveLength(callsBefore + 1);
        },
        { timeout: TURN_TIMEOUT_MS, interval: 25 },
      );
      const auditBefore = t.auditRecords.length;

      // Act (AC-21.1): the card's stop while the answer is still streaming.
      const view = await stopped(user, threadId, launch.launchKey);
      const stopAudit = t.auditRecords.slice(auditBefore);

      // Assert: stopped before the stream ended, with no model call; the card and the runtime agree.
      expect(view).toMatchObject({
        launchKey: launch.launchKey,
        state: 'stopped',
      });
      expect(await runs.hasRuns(threadId)).toBe(true);
      expect(t.chatModel.calls).toHaveLength(callsBefore + 1);
      expect(t.chatModel.remaining()).toBe(1);
      expect(await launchOf(launch.launchKey)).toMatchObject({
        state: 'stopped',
        finishedAt: expect.any(Date),
      });
      expect(await research(user, threadId)).toEqual([view]);
      expect(await investigationStatus(user, launch.investigationId)).toBe(
        'cancelled',
      );
      // The ledger check of the skeleton is packages/engine INT-3: the engine double here writes no ledger rows.
      // Assert (Contract, the route): one audit record of the request, by the real AuditInterceptor.
      expect(stopAudit).toEqual([
        {
          type: STOP_AUDIT_TYPE,
          userId: user,
          agentId: undefined,
          threadId,
          at: expect.any(String),
        },
      ]);

      streaming.release();
      await turn;
    });

    it('INT-1 S2: stopping an answered card or a card still launching returns it as it is without an error, and the launching card stops once its start has finished', async () => {
      // Row "answered" (UC-E1, DC-8): the answer is in the thread.
      const answered = await runningResearch('Сравнить тарифы');
      await answerLaunch(answered.launch, 'Тариф Б дешевле');
      const answeredVersions = await launchVersionsOf(answered.user);

      const answeredView = await stopped(
        answered.user,
        answered.threadId,
        answered.launch.launchKey,
      );

      expect(answeredView).toMatchObject({ state: 'completed' });
      expect(await launchVersionsOf(answered.user)).toEqual(answeredVersions);
      expect(
        await investigationStatus(
          answered.user,
          answered.launch.investigationId,
        ),
      ).toBe('completed');
      expect(t.cancels.calls).toHaveLength(0);

      // Row "launching" (UC-E7): the start is held, so the launch stays `launching`.
      const user = t.user();
      const threadId = await t.createThread(user);
      const held = t.engine.holdStarts();
      const call = deepResearchCallStep({
        goal: 'Сверить остатки',
        tokenBudget: 400_000,
      });
      t.chatModel.script(call.step);
      const turn = chat(user, threadId, modeMessage('Сверить остатки'));
      await launchReaching(call.toolCallId, 'launching');
      const launchingVersions = await launchVersionsOf(user);

      const launchingView = await stopped(user, threadId, call.toolCallId);

      expect(launchingView).toMatchObject({ state: 'running' });
      expect(await launchVersionsOf(user)).toEqual(launchingVersions);
      expect(t.cancels.calls).toHaveLength(0);

      // The start finishes; the same stop now stops it.
      held.release();
      await turn;
      const running = await launchReaching(call.toolCallId, 'running');
      const investigationId = required(
        running.investigationId,
        'investigationId',
      );

      const stoppedView = await stopped(user, threadId, call.toolCallId);

      expect(stoppedView).toMatchObject({ state: 'stopped' });
      expect(await investigationStatus(user, investigationId)).toBe(
        'cancelled',
      );
      expect(t.cancels.calls).toEqual([{ investigationId, resourceId: user }]);
      // A repeated stop of a `stopped` launch is the `launch-state.spec.ts` table's row: not wired again here.
    });

    it('INT-1 S3: a refused lock, cancel or transition to stopped answers 500 RESEARCH_STOP_FAILED with the documented state left behind, and the retry finishes the stop in all three cases', async () => {
      const rows: {
        fault: string;
        refuse: (threadId: string, launchKey: string) => Promise<void>;
        heal: () => Promise<void>;
        investigationAfterFailure: string;
      }[] = [
        {
          fault: 'cancel refused',
          refuse: async () =>
            t.cancels.refuse(new Error('scripted cancel refusal')),
          heal: async () => t.cancels.refuse(null),
          investigationAfterFailure: 'active',
        },
        {
          fault: 'transition to stopped refused after the cancel committed',
          refuse: (_threadId, launchKey) =>
            t.stopFaults.refuseStopTransition(launchKey),
          heal: () => t.stopFaults.refuseStopTransition(null),
          investigationAfterFailure: 'cancelled',
        },
        {
          fault: 'lock not obtained, scripted',
          refuse: async (threadId) => t.stopFaults.refuseThreadLock(threadId),
          heal: async () => t.stopFaults.refuseThreadLock(null),
          investigationAfterFailure: 'active',
        },
      ];
      for (const row of rows) {
        // Arrange (UC-E2): a running research and the row's fault.
        const { user, threadId, launch } = await runningResearch(
          `Остановка при отказе: ${row.fault}`,
        );
        await row.refuse(threadId, launch.launchKey);

        // Act + Assert: 500 with the code only; the launch is still running, the investigation as documented.
        expect(
          await refusedStop(user, threadId, launch.launchKey, 500),
          row.fault,
        ).toBe('RESEARCH_STOP_FAILED');
        expect((await launchOf(launch.launchKey))?.state, row.fault).toBe(
          'running',
        );
        expect(
          await investigationStatus(user, launch.investigationId),
          row.fault,
        ).toBe(row.investigationAfterFailure);

        // Act + Assert: the fault is healed and the same request finishes the stop.
        await row.heal();
        expect(
          await stopped(user, threadId, launch.launchKey),
          row.fault,
        ).toMatchObject({ state: 'stopped' });
        expect((await launchOf(launch.launchKey))?.state, row.fault).toBe(
          'stopped',
        );
        expect(
          await investigationStatus(user, launch.investigationId),
          row.fault,
        ).toBe('cancelled');
      }
    });

    it('INT-1 S4: another user cannot stop a research by thread (THREAD_NOT_FOUND) or by a launchKey of another thread (RESEARCH_LAUNCH_NOT_FOUND), and the research keeps running', async () => {
      // Arrange (UC-E3): user A has a running research; user B has a thread of their own.
      const a = await runningResearch('Проверить договор поставки');
      const b = t.user();
      const bThread = await t.createThread(b);
      const versionsOfA = await launchVersionsOf(a.user);

      // Act + Assert (business constraint 2): by A's thread, then by B's thread with A's launchKey.
      expect(await refusedStop(b, a.threadId, a.launch.launchKey, 404)).toBe(
        'THREAD_NOT_FOUND',
      );
      expect(await refusedStop(b, bThread, a.launch.launchKey, 404)).toBe(
        'RESEARCH_LAUNCH_NOT_FOUND',
      );

      // Assert: A's launch and investigation are untouched and the research is still running.
      expect(await launchVersionsOf(a.user)).toEqual(versionsOfA);
      expect((await launchOf(a.launch.launchKey))?.state).toBe('running');
      expect(await investigationStatus(a.user, a.launch.investigationId)).toBe(
        'active',
      );
      expect(t.cancels.calls).toHaveLength(0);
    });

    it('INT-1 S5: the agent refuses to guess between two running researches and returns only the list of this thread, stops the named one, answers stop_failed with the unchanged launch when the lock is refused, and the legacy hidden stop turn ends in the same state as the route', async () => {
      // Arrange: two researches running in one thread, and two running researches that must stay out of the agent's
      // choice: one of another owner, and one in another thread of the same owner.
      const {
        user,
        threadId,
        launch: churn,
      } = await runningResearch('Почему вырос отток');
      const revenue = await launchResearch(
        user,
        threadId,
        'Сверить выручку за квартал',
      );
      const other = await runningResearch('Проверить договор поставки');
      const otherThread = await t.createThread(user);
      const elsewhere = await launchResearch(
        user,
        otherThread,
        'Сверить остатки в другой беседе',
      );
      const versions = await launchVersionsOf(user);
      const otherVersions = await launchVersionsOf(other.user);

      // Row "no key, two running" (DC-10, business constraint 2): nothing changes, and the model gets exactly the two
      // researches of this thread to ask about - neither the other owner's nor the other thread's one.
      expect(await askToStop(user, threadId, {})).toEqual({
        launch: null,
        error: 'ambiguous',
        candidates: [
          { launchKey: churn.launchKey, goal: 'Почему вырос отток' },
          { launchKey: revenue.launchKey, goal: 'Сверить выручку за квартал' },
        ],
      });
      expect(await launchVersionsOf(user)).toEqual(versions);
      expect(await launchVersionsOf(other.user)).toEqual(otherVersions);
      expect(t.cancels.calls).toHaveLength(0);

      // Row "the named key" (AC-21.2): the named research stops, the other one keeps running.
      expect(
        await askToStop(user, threadId, { launchKey: revenue.launchKey }),
      ).toEqual({
        launch: expect.objectContaining({
          launchKey: revenue.launchKey,
          state: 'stopped',
        }),
      });
      expect(await launchOf(revenue.launchKey)).toMatchObject({
        state: 'stopped',
        finishedAt: expect.any(Date),
      });
      expect(await investigationStatus(user, revenue.investigationId)).toBe(
        'cancelled',
      );
      expect((await launchOf(churn.launchKey))?.state).toBe('running');
      expect(await investigationStatus(user, churn.investigationId)).toBe(
        'active',
      );
      expect((await launchOf(elsewhere.launchKey))?.state).toBe('running');
      expect(
        await investigationStatus(other.user, other.launch.investigationId),
      ).toBe('active');
      // Rows "no key, one running" and "a key of another owner's research" are the `stop-target.spec.ts` table and S4.

      // Row "the lock refused" (UC-E2 through the agent): `stop_failed` with the launch as the choice read it, unchanged.
      const locked = await runningResearch('Проверить остатки на складе');
      const cancelsBefore = t.cancels.calls.length;
      expect(
        await askToStop(
          locked.user,
          locked.threadId,
          { launchKey: locked.launch.launchKey },
          { refuseLock: true },
        ),
      ).toEqual({
        launch: expect.objectContaining({
          launchKey: locked.launch.launchKey,
          state: 'running',
        }),
        error: 'stop_failed',
      });
      expect((await launchOf(locked.launch.launchKey))?.state).toBe('running');
      expect(
        await investigationStatus(locked.user, locked.launch.investigationId),
      ).toBe('active');
      expect(t.cancels.calls).toHaveLength(cancelsBefore);
      t.stopFaults.refuseThreadLock(null);

      // Row "legacy hidden stop turn" (KD-4, a tab opened before the update): the same end state as the route.
      const delays = await launchResearch(
        user,
        threadId,
        'Найти причины задержек',
      );
      t.chatModel.script(
        deepResearchCallStep({ goal: 'Цель из аргументов модели' }).step,
      );
      await chat(
        user,
        threadId,
        userMessage('Остановить', {
          [RESEARCH_METADATA_KEYS.researchDecision]: {
            action: 'stop',
            launchKey: delays.launchKey,
          },
        }),
      );
      expect(await launchOf(delays.launchKey)).toMatchObject({
        state: 'stopped',
        finishedAt: expect.any(Date),
      });
      expect(await investigationStatus(user, delays.investigationId)).toBe(
        'cancelled',
      );
      expect(
        (await research(user, threadId)).map(({ launchKey, state }) => ({
          launchKey,
          state,
        })),
      ).toEqual([
        { launchKey: churn.launchKey, state: 'running' },
        { launchKey: revenue.launchKey, state: 'stopped' },
        { launchKey: delays.launchKey, state: 'stopped' },
      ]);
      expect(t.chatModel.remaining()).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2  Two instances: the thread lock and the run marks are shared, so stop, regenerate, double confirm and answer order hold across instances
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-22.1: "Given агент предложил запуск расследования, When сотрудник подтвердил предложение, а подтверждение пришло дважды и два запроса обработали разные экземпляры сервера, Then по этому предложению запущено ровно одно расследование, и беседа показывает одно идущее расследование."
  // AC-22.2: "Given ответ расследования готов, но ещё не дописан в беседу, When сотрудник останавливает расследование, а остановку и запись ответа обрабатывают разные экземпляры сервера, Then ответ в беседу не дописан, и беседа показывает расследование остановленным."
  // AC-22.3: "Given в беседе стримится ответ чат-агента с одного экземпляра сервера, When на другом экземпляре готовы ответы двух расследований этой беседы, Then каждый ответ расследования стоит отдельным сообщением, не склеен со стримящимся ответом, и ответы стоят в порядке завершения расследований."
  // AC-22.4: "Given сотрудник перегенерировал ответ ассистента, который отвечает на сообщение-запуск расследования, When ответ этого расследования готов к записи на другом экземпляре сервера, Then расследование остановлено, и его ответ в беседу не дописан."
  // DC-11 (FR-22): "Экземпляр, упавший посреди ответа агента, задерживает ответы ресерчей своей беседы не дольше одной аренды отметки прогона."
  // Use cases: UC-9, UC-10, UC-11, UC-12, UC-E6. Flow 5, Flow 6. KD-5, KD-6. Invariants 6, 7.
  //
  // Primary failure mode (turns red when): the lock is still local to a process, so instance 2 writes an answer after instance 1 stopped (or discarded) the launch, or both instances start a research for one proposal;
  // the run mark is still in the memory of instance 1, so instance 2 writes a research answer into the middle of a streaming reply or in the wrong order; a mark of a dead instance is never released and the
  // researches of its thread wait forever, or it is ignored before its lease ends; a failing locked write leaks the advisory lock and freezes the thread.
  // Behavior: instance 1 and instance 2 are two compiled apps over one database; a request on one and a delivery pass on the other are ordered by holding the thread lock (or a chat run) with a latch ->
  //   the second instance re-reads the launch under the lock / sees the run mark in `chat_thread_runs` -> writes or withholds the answer -> GET /messages and GET /research show the result
  // @category: core-functionality
  // @dependency: two apps of AppModule pieces, ThreadWriteLock (advisory lock), ThreadRunRegistry + app.chat_thread_runs, ResearchLaunchService, ResearchAnswerAppender, ThreadsService (regenerate), Mastra Memory, Postgres
  // @complexity: high
  //
  // Verification items (table; every row names which instance receives which request, and ends by reading the launch rows, the investigations and the stored messages with their order):
  // - M1 double confirm (UC-9, AC-22.1): a `proposed` launch; the confirm arrives on instance 1 and instance 2 at the same time (both held at the lock by one latch, then released) -> one investigation for the
  //   `launchKey`, one launch `running`, one card in GET /research; the second request returns the started launch without an error
  // - M2 stop against the answer write (UC-10, AC-22.2): a launch `answer_pending` whose investigation is `completed`; (a) the stop on instance 1 holds the lock while the delivery pass on instance 2 waits ->
  //   the stop commits `stopped`, the pass re-reads the launch, writes nothing; no answer message, the card is "Остановлен", the investigation row stays `completed`; (b) the pass on instance 2 takes the lock first ->
  //   the answer is written once, the launch is `answered`, and the stop on instance 1 returns that launch with 200 and no error
  // - M3 regenerate against the answer write (UC-12, AC-22.4): a launch `answer_pending` whose answer is ready on instance 2; the user regenerates the assistant reply that answers the launch message through
  //   instance 1 -> the tail selection under the lock sets the launch `discarded` and cancels its investigation; the pass on instance 2 re-reads the launch and writes no answer; GET /research no longer lists the card
  // - M4 stream on one instance, answers on the other (UC-11, AC-22.3): dropped - M5 proves that a mark of another instance holds the passes of this one, and chat-entry INT-2 D2 proves the order of the answers
  //   after the reply once the run ends; the two together cover what M4 repeated
  // - M5 a dead instance's mark (UC-E6, DC-11): instance 1 registers a run and its renewal is paused (it will not renew or release, as after a crash); one answer is `answer_pending` on instance 2 -> a pass writes
  //   nothing just before the 30 s lease ends and writes the answer after it (`clock.advance`); the expired row is removed by the next mark write of any run in any thread
  // - M6 a failed locked write frees the lock (UC-E2 across instances): dropped - chat-entry INT-3 T3 proves it on the real advisory lock, and `thread-write-lock.spec.ts` ("a rejected task ends with ROLLBACK
  //   then release()") is the lower-level proof that the lock's connection is handed back only after the rollback
  describe('INT-2', () => {
    /** The second instance: its own pools, registry, doubles and workers over the same database. */
    let t2: ResearchChatApp;

    beforeAll(async () => {
      t2 = await createResearchChatApp({ instance: 'instance-2' });
    }, BOOT_TIMEOUT_MS);

    afterAll(async () => {
      await t2?.close();
    }, BOOT_TIMEOUT_MS);

    beforeEach(() => t2.reset());
    afterEach(() => t2.reset());

    it(
      'INT-2 M1: a confirm delivered at the same moment to two instances starts exactly one investigation and shows one running card',
      async () => {
        // Arrange (UC-9): a proposal of an ordinary turn on instance 1.
        const user = t.user();
        const threadId = await t.createThread(user);
        const proposal = deepResearchCallStep({
          goal: 'Сравнить ошибки импорта за неделю',
          tokenBudget: 400_000,
        });
        t.chatModel.script(
          proposal.step,
          textStep('Могу запустить глубокое исследование.'),
        );
        await chat(user, threadId, userMessage('Разберись с ошибками импорта'));
        const launchKey = proposal.toolCallId;
        expect((await launchOf(launchKey))?.state).toBe('proposed');

        // Act (AC-22.1): the thread lock is held outside both instances; the confirm reaches each instance and both
        // wait at the lock in Postgres; then the lock is released.
        const held = await t.holdThreadLock(threadId);
        const confirm = { action: 'confirm', launchKey } as const;
        const onFirst = decisionTurn(t, user, threadId, confirm);
        void onFirst.catch(() => undefined);
        const onSecond = decisionTurn(t2, user, threadId, confirm);
        void onSecond.catch(() => undefined);
        await waitersAtLock(threadId, 2);
        expect((await launchOf(launchKey))?.state).toBe('proposed');
        await held.release();
        const results = await Promise.all([onFirst, onSecond]);

        // Assert: both requests answer the started launch without an error; one start, one investigation, one card.
        const started = {
          launch: expect.objectContaining({ launchKey, state: 'running' }),
        };
        expect(results).toEqual([started, started]);
        expect(t.engine.startCalls.length + t2.engine.startCalls.length).toBe(
          1,
        );
        await launchReaching(launchKey, 'running');
        expect(await investigationsOf(user)).toHaveLength(1);
        expect(
          (await research(user, threadId)).map(({ launchKey: key, state }) => ({
            launchKey: key,
            state,
          })),
        ).toEqual([{ launchKey, state: 'running' }]);
      },
      TURN_TIMEOUT_MS * 2,
    );

    it(
      'INT-2 M2: a stop on one instance and the answer write on the other leave either a stopped card with no answer or one answer with a no-error stop, never both an answer and a stopped card',
      async () => {
        const user = t.user();

        // Row (a), the stop takes the lock first (UC-10, AC-22.2): the stop on instance 1 holds the lock in its cancel
        // while the pass of instance 2 waits at the lock.
        const stopFirstThread = await t.createThread(user);
        const stopFirst = await readyAnswer(
          user,
          stopFirstThread,
          'Почему вырос отток',
          t2,
        );
        const stopHeld = t.gate();
        t.cancels.beforeCancel(() => stopHeld.promise);
        const stopping = stopRequest(
          user,
          stopFirstThread,
          stopFirst.launchKey,
        ).then((res) => res);
        void stopping.catch(() => undefined);
        await vi.waitFor(() => expect(t.cancels.calls).toHaveLength(1), {
          timeout: TURN_TIMEOUT_MS,
          interval: 25,
        });
        const waitingPass = t2.runAppenderOnce();
        void waitingPass.catch(() => undefined);
        await waitersAtLock(stopFirstThread, 1);
        stopHeld.release();
        const stopResponse = await stopping;
        await waitingPass;
        t.cancels.beforeCancel(null);

        expect(stopResponse.status).toBe(200);
        expect(
          ResearchStopResponseSchema.parse(stopResponse.body).launch,
        ).toMatchObject({ launchKey: stopFirst.launchKey, state: 'stopped' });
        expect((await launchOf(stopFirst.launchKey))?.state).toBe('stopped');
        expect(
          await answerMessagesOf(stopFirstThread, stopFirst.investigationId),
        ).toEqual([]);
        expect(t2.memoryFaults.answerWrites).toBe(0);
        expect(await research(user, stopFirstThread)).toEqual([
          expect.objectContaining({ state: 'stopped' }),
        ]);
        expect(await investigationStatus(user, stopFirst.investigationId)).toBe(
          'completed',
        );

        // Row (b), the pass takes the lock first: the pass of instance 2 holds the lock in its answer write while the
        // stop on instance 1 waits at the lock -> one answer, and the stop returns the answered launch with no error.
        const writeFirstThread = await t.createThread(user);
        const writeFirst = await readyAnswer(
          user,
          writeFirstThread,
          'Почему выросли возвраты',
          t2,
        );
        const writeHeld = t2.gate();
        t2.memoryFaults.holdAnswerWrites(writeHeld.promise);
        const writingPass = t2.runAppenderOnce();
        void writingPass.catch(() => undefined);
        await vi.waitFor(() => expect(t2.memoryFaults.answerWrites).toBe(1), {
          timeout: TURN_TIMEOUT_MS,
          interval: 25,
        });
        const cancelsBefore = t.cancels.calls.length;
        const waitingStop = stopRequest(
          user,
          writeFirstThread,
          writeFirst.launchKey,
        ).then((res) => res);
        void waitingStop.catch(() => undefined);
        await waitersAtLock(writeFirstThread, 1);
        writeHeld.release();
        await writingPass;
        const lateStop = await waitingStop;
        t2.memoryFaults.holdAnswerWrites(null);

        expect(lateStop.status).toBe(200);
        expect(lateStop.body).toEqual({
          launch: expect.objectContaining({
            launchKey: writeFirst.launchKey,
            state: 'completed',
          }),
        });
        expect((await launchOf(writeFirst.launchKey))?.state).toBe('answered');
        expect(
          await answerMessagesOf(writeFirstThread, writeFirst.investigationId),
        ).toHaveLength(1);
        expect(t.cancels.calls).toHaveLength(cancelsBefore);

        // Row (c), the answer gets ready between the stop's read and its move: the stop on instance 1 has read the
        // launch `running`; before its cancel goes on, the investigation completes and the launch becomes
        // `answer_pending` (the answer consumer takes no lock). The stop still ends the launch `stopped`, and the pass
        // of instance 2 writes no answer.
        const raceThread = await t.createThread(user);
        const racing = await launchResearch(
          user,
          raceThread,
          'Почему упали продажи',
          t2,
        );
        t.cancels.beforeCancel(async () => {
          t.cancels.beforeCancel(null);
          t2.engine.succeed(racing.investigationId, {
            answer: () => assumedAnswer('Продажи упали из-за сезона'),
          });
          await launchReaching(racing.launchKey, 'answer_pending');
          await investigationReaching(
            user,
            racing.investigationId,
            'completed',
          );
        });
        const raced = await stopped(user, raceThread, racing.launchKey);
        await t2.runAppenderOnce();

        expect(raced).toMatchObject({
          launchKey: racing.launchKey,
          state: 'stopped',
        });
        expect((await launchOf(racing.launchKey))?.state).toBe('stopped');
        expect(
          await answerMessagesOf(raceThread, racing.investigationId),
        ).toEqual([]);
      },
      TURN_TIMEOUT_MS * 4,
    );

    it(
      'INT-2 M3: regenerating the reply to the launch message on one instance discards the launch, stops its investigation and keeps its ready answer out of the thread on the other instance',
      async () => {
        // Arrange (UC-12): the answer of a mode turn's launch is ready on instance 2.
        const user = t.user();
        const threadId = await t.createThread(user);
        const goal = 'Почему упала выручка';
        const ready = await readyAnswer(user, threadId, goal, t2);

        // Act (AC-22.4): the pass of instance 2 reads the launch `answer_pending`, finds no run mark and is held before
        // the thread lock (once the regenerate registers its run, a later pass would wait for the mark instead). The
        // thread lock is held outside both instances; the regenerate of the mode message on instance 1 waits at it
        // first, then the pass; the lock is released and Postgres grants it in that order. The new turn calls
        // `deepResearch` again.
        const passEntry = t2.gate();
        const passRead = t2.holdLockEntry(threadId, passEntry.promise);
        const waitingPass = t2.runAppenderOnce();
        void waitingPass.catch(() => undefined);
        await passRead;
        const held = await t.holdThreadLock(threadId);
        const relaunch = deepResearchCallStep({ goal, tokenBudget: 400_000 });
        t.chatModel.script(relaunch.step);
        const regenerate = chat(user, threadId, {
          ...modeMessage(goal),
          id: ready.messageId,
        });
        void regenerate.catch(() => undefined);
        await waitersAtLock(threadId, 1);
        passEntry.release();
        await waitersAtLock(threadId, 2);
        await held.release();
        await regenerate;
        await waitingPass;
        expect(t.cancels.calls).toEqual([
          { investigationId: ready.investigationId, resourceId: user },
        ]);
        await launchReaching(relaunch.toolCallId, 'running');

        // Assert: the launch is discarded and its investigation got the cancel (a completed one stays `completed`);
        // the pass wrote nothing; the card is gone and only the new launch is listed.
        expect((await launchOf(ready.launchKey))?.state).toBe('discarded');
        expect(await investigationStatus(user, ready.investigationId)).toBe(
          'completed',
        );
        expect(await answerMessagesOf(threadId, ready.investigationId)).toEqual(
          [],
        );
        expect(t2.memoryFaults.answerWrites).toBe(0);
        expect(
          (await research(user, threadId)).map((view) => view.launchKey),
        ).toEqual([relaunch.toolCallId]);
      },
      TURN_TIMEOUT_MS * 2,
    );
    // M4 (answers wait for another instance's stream, then stand in completion order) is M5 plus chat-entry INT-2 D2: not repeated here.
    it(
      'INT-2 M5: the run mark of a crashed instance holds the research answers of its thread until its lease ends and not longer, and is cleaned by the next registration',
      async () => {
        // Arrange (UC-E6): an answer ready on instance 2; instance 1 starts a reply and stops renewing its mark, as
        // after a crash in the middle of the stream (its model call does not return before the test ends).
        const user = t.user();
        const threadId = await t.createThread(user);
        const ready = await readyAnswer(
          user,
          threadId,
          'Почему упала конверсия',
          t2,
        );
        const crashed = t.gate(threadId);
        t.chatModel.script(
          heldStep(crashed.promise, textStep('Ответ, который не дойдёт.')),
        );
        t.pauseMarkRenewal();
        const turn = chat(user, threadId, userMessage('Что с конверсией?'));
        void turn.catch(() => undefined);
        await markSeenBy(t2, threadId);
        const [mark] = await runMarksOf(threadId);
        const leaseEnd = required(mark, 'run mark').leaseExpiresAt.getTime();

        // Act (DC-11): the clock of instance 2 two seconds before the lease ends; a pass.
        t2.clock.advance(leaseEnd - t2.clock.now().getTime() - 2_000);
        await t2.runAppenderOnce();

        // Assert: the mark still holds the thread.
        expect(t2.memoryFaults.answerWrites).toBe(0);
        expect((await launchOf(ready.launchKey))?.state).toBe('answer_pending');

        // Act: the clock 1 ms past the end of the lease; a pass.
        t2.clock.advance(leaseEnd - t2.clock.now().getTime() + 1);
        await t2.runAppenderOnce();

        // Assert: the answer is written once, while the expired mark is still in the table.
        expect((await launchOf(ready.launchKey))?.state).toBe('answered');
        expect(
          await answerMessagesOf(threadId, ready.investigationId),
        ).toHaveLength(1);
        expect(await runMarksOf(threadId)).toHaveLength(1);

        // Act: the next registration of a run, on instance 2 in another thread.
        const otherThread = await t.createThread(user);
        t2.chatModel.script(textStep('Готово.'));
        await chat(user, otherThread, userMessage('Привет'), t2);

        // Assert: that registration removed the crashed instance's mark.
        expect(await runMarksOf(threadId)).toEqual([]);

        // Cleanup: let the held turn of instance 1 end, so no turn outlives the test.
        crashed.release();
        await turn;
      },
      TURN_TIMEOUT_MS * 2,
    );
    // M6 (a failed locked write frees the advisory lock) is chat-entry INT-3 T3 on the real lock, with the ROLLBACK-then-release row of thread-write-lock.spec.ts beneath it: not repeated here.
  });
});
