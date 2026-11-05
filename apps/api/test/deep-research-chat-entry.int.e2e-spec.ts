// deep-research / chat-entry Integration Test Skeletons (api side) - Design Doc: docs/features/deep-research/design-chat-entry.md
// PRD: docs/features/deep-research/prd.md v1.12 (FR-19..FR-22, FR-26 (api share), FR-27, NFR-01, NFR-03). ADRs: ADR-0001 (runtime owner), ADR-0002 (app schema migrations), ADR-0003 (Drizzle data layer), ADR-0004 (api owns chat logic). UXRD: docs/features/deep-research/uxrd.md (only through DC-7 / MC-13 / MC-15 / MC-16 / MC-29 on the wire, and MC-31 / MC-32 / MC-33 as the text the server stores).
// Generated: 2026-11-01 | Updated: 2026-11-01 for the no-source mode (Design Doc v1.6: KD-8, DC-8, DC-9, UC-4, UC-12, UC-13, UC-E8) | Part: chat-entry | Test type: Integration (in-process Nest app + real runtime + real Postgres, scripted chat model, engine port double), CI job `e2e` of apps/api
// Implementation timing: created alongside the slice each test names (the `deepResearch` tool and ResearchLaunchService, the delivery loop, the tail/delete hooks).
//
// File name and placement. This follows the sibling api files (`research-runtime-wiring.e2e-spec.ts`, `threads.e2e-spec.ts`): `apps/api/test/*.e2e-spec.ts`, picked up by `vitest.config.e2e.ts`
// (include '**/*.e2e-spec.ts', fileParallelism false, RUNTIME_WORKERS default 'off'). The `.int.` infix separates these in-process tests from the process-level file `deep-research-chat-entry.e2e-spec.ts`
// (final phase), the way the engine part does. The plan adds an npm script next to `test:e2e:runtime` and turns RUNTIME_WORKERS on for this file only (the delivery loop needs it).
// The web half of the part is in apps/web/src/components/shell/shell.research-decisions.int.test.tsx and shell.research-delivery.int.test.tsx (INT-4, INT-5 below in the budget).
//
// Environment (Design Doc "Test Strategy", "Runtime settings"):
// - Postgres 16 from infra/docker-compose.yml, migrations applied once by test/support/migrate.global-setup.ts (`app.research_chat_launches` included). Real AppModule pieces: ChatController, ThreadsService with its
//   write lock, ThreadRunRegistry, Mastra Memory over PostgresStore, the real runtime (`createRuntime`) with InvestigationService and the EventConsumer registry, the part's ResearchLaunchService, the `deepResearch` tool,
//   ResearchAnswerConsumer, ResearchAnswerAppender, ResearchChatController. SessionGuard is real (users are told apart by `x-user-id`).
// - Boundaries that are doubled, and only these: (1) the chat model - the MockLanguageModel of test/support/mockModels.ts, scripted per turn (a `deepResearch` tool call with a goal and a token budget, or plain text);
//   it records the options of every call (the forced tool choice, the thinking setting) and the message list it received; (2) the engine port (`Engine.startInvestigation`, `Engine.readInvestigation`): a test double over the
//   real runtime that creates a real investigation whose controller task is a test handler held by a latch (wiring-handlers.ts `testHandler`), and answers `readInvestigation` with a scripted `InvestigationView`
//   (answer, claims, evidence records with provenance). The engine itself is proven in packages/engine; here its contract (design-engine.md, Contract Definitions) is the boundary.
//   The double also carries the source mode (design-engine.md v1.9): `Engine.sourceMode` is settable between steps of a test (the stand-in for restarting the process with another set of sources), the scripted `InvestigationView`
//   has its own `sourceMode` (set when the double starts the investigation, not changed afterwards, as the engine guarantees), and `EvidenceReader.get` is a counting spy so that "the loop reads no evidence" is observable.
// - Isolation (project convention, no truncate): a unique `resourceId = newUser()` per test as `x-user-id`, unique thread ids; afterAll removes the threads of every resourceId through ThreadsService.
// - Time: the delivery loop is driven by single passes (`runOnce`) instead of waiting for `RUNTIME_POLL_MS`; the clock behind `RESEARCH_APPEND_GIVE_UP_MS`, `RESEARCH_LAUNCH_RECOVERY_MS` and the retry pause is injected.
//   No sleeps for ordering.
// - Support to add with the slice (not created here): test/support/researchChatApp.ts (createTestApp + the part's module + the engine double + the clock + `runAppenderOnce`), test/support/researchChatDb.ts
//   (read-only snapshots of `research_chat_launches` and of a thread's stored messages with metadata, and a row-version snapshot for "nothing changed" checks).
//
// Budget (whole part): Integration 5 (limit 3; up to 5 under the integration-e2e-testing rule only when each extra test names the defect no other test catches).
//   INT-1..INT-3 (this file) are the core budget. INT-4 and INT-5 are the two web tests and the two extras; their unique defects are stated in their headers. Table-driven rows keep the ACs of one rule or one flow in one test.
//   E2E 2 (limit 2): E2E-1 in deep-research-chat-entry.e2e-spec.ts, E2E-2 the L1 browser scenario in docs/features/deep-research/chat-entry/l1-browser-scenarios.md.
//   The no-source mode (PRD 1.12) adds rows to these tests, not tests: INT-1 A6, INT-2 D5, an assertion block in INT-2 D1. The count stays 5 of 5 for the part and the extras are still INT-4 and INT-5 only.
//
// Proven elsewhere (not in this file; see the "AC -> proving test" table in the generation report and "Proven at unit level" at the end of this file):
// - the runtime primitives (cancel idempotence, purge of investigations, event delivery, EventConsumer contract) - packages/runtime and research-runtime-wiring.e2e-spec.ts
// - "after cancel no new model call and no source call" (AC-01.4, the second half of AC-21.1) - engine INT-2 L5 (packages/engine/test/deep-research-engine.int.e2e-spec.ts)
// - the deletion order of ThreadsService.delete and owner isolation of the runtime - research-runtime-wiring.e2e-spec.ts INT-5; here only what the part adds to it (the `purge` hook of launch rows, T4)
// - restart of the process between steps (NFR-03, UC-5, UC-E6) - deep-research-chat-entry.e2e-spec.ts
// - what an engine without sources does (plan then one synthesis, claims as `assumed`, the single start warning, the mode kept across a rebuild) - packages/engine (INT-1 C7, INT-2 L6, loader table); here only what the part does with the mode the engine reports
// - AC-26.1, service side (the process starts with no fixture package and `connectedSources` is empty): the api composition - extends apps/api/test/sources-wiring.e2e-spec.ts (named for the plan; not part of this skeleton set). The chat side of AC-26.1
//   (chat accepts messages, the research is proposed and launched, and the part adds no source check) is A6 below
// - AC-26.2, AC-26.3 (the start warning in the log): engine unit loader table; the log of a real boot is read by hand in L1-7 (docs/features/deep-research/chat-entry/l1-browser-scenarios.md)

import { randomUUID } from 'node:crypto';
import {
  ApiErrorSchema,
  DeepResearchToolResultSchema,
  RESEARCH_METADATA_KEYS,
  type EventEnvelope,
  type ResearchDecision,
  ThreadListResponseSchema,
  ThreadMessagesResponseSchema,
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
import type { EvidenceInput } from '@agent-os/contracts';
import type { DatabaseConnection } from '@agent-os/db';
import type { HandlerRegistry, Runtime } from '@agent-os/runtime';
import { ASSISTANT_INSTRUCTIONS } from '../src/mastra/agents/assistant.agent.js';
import {
  RESEARCH_ANSWER_CONSUMER,
  researchAnswerConsumer,
} from '../src/research-chat/research-answer.consumer.js';
import {
  HANDLER_REGISTRY,
  RESEARCH_DATABASE,
  RESEARCH_RUNTIME,
} from '../src/research/research.tokens.js';
import { ThreadRunRegistry } from '../src/threads/thread-run-registry.js';
import type { ScriptedAnswer } from './support/engineDouble.js';
import {
  deepResearchCallStep,
  DEEP_RESEARCH_TOOL,
  heldStep,
  type RecordedChatCall,
  textStep,
} from './support/mockModels.js';
import {
  createResearchChatApp,
  type ResearchChatApp,
} from './support/researchChatApp.js';
import {
  investigationsOf,
  type LaunchRow,
  launchesOf,
  launchOf,
  launchVersionsOf,
  storedMessagesOf,
} from './support/researchChatDb.js';
import {
  closeRuntimeDb,
  completed,
  evidenceInput,
  latch,
  query,
  taskSpec,
  testHandler,
  uniqueWorkflowType,
} from './support/wiring-handlers.js';

/** The model of the research mode and decision turns (design-chat-entry.md, KD-9, Runtime settings). */
const RESEARCH_TURN_MODEL = 'anthropic/claude-haiku-5-5';
/** The scripted chat model's id: the model of ordinary turns. */
const CHAT_MODEL = 'mock/chat';
/** `investigationTokens.default` of the shipped deep-research configuration. */
const DEFAULT_TOKEN_BUDGET = 3_000_000;
/** Above `high`: a research turn must still run with `high` (Haiku 5.5 turns thinking off only up to it, KD-9). */
const REASONING_EFFORT = 'max';
/** Long enough for a chat turn with the real Memory and lock; not a latency check. */
const TURN_TIMEOUT_MS = 30_000;
const BOOT_TIMEOUT_MS = 60_000;

let t: ResearchChatApp;

/** A user message as the web sends it; `metadata` carries the research mode or a decision. */
function userMessage(text: string, metadata?: Record<string, unknown>) {
  return {
    id: `client-${randomUUID()}`,
    role: 'user',
    parts: [{ type: 'text', text }],
    ...(metadata && { metadata }),
  };
}

/** The UI message chunks of a chat response's SSE body (`data: {...}` lines). */
function sseChunks(body: string): Record<string, unknown>[] {
  return body
    .split('\n')
    .filter((line) => line.startsWith('data: '))
    .map((line) => line.slice('data: '.length))
    .filter((data) => data !== '[DONE]')
    .map((data) => JSON.parse(data) as Record<string, unknown>);
}

/**
 * Sends one chat turn and waits until its run has ended (the run is released after Mastra's end-of-run save), so the
 * stored messages and launch rows are final. Returns the UI message chunks the turn streamed.
 */
async function chat(
  user: string,
  threadId: string,
  message: ReturnType<typeof userMessage>,
): Promise<Record<string, unknown>[]> {
  const res = await request(t.app.getHttpServer())
    .post('/api/chat/assistant')
    .set('x-user-id', user)
    .send({ id: threadId, messages: [message] })
    .expect(200);
  const runs = t.moduleRef.get(ThreadRunRegistry, { strict: false });
  await vi.waitFor(
    () => {
      if (runs.hasRuns(threadId))
        throw new Error(`chat run of ${threadId} still registered`);
    },
    { timeout: TURN_TIMEOUT_MS, interval: 25 },
  );
  return sseChunks(res.text);
}

/** The `deepResearch` result a research turn streamed: its one tool output. */
function toolResult(chunks: Record<string, unknown>[]) {
  const outputs = chunks.filter(
    (chunk) => chunk.type === 'tool-output-available',
  );
  if (outputs.length !== 1) {
    throw new Error(
      `a research turn streams one tool result, got ${outputs.length}`,
    );
  }
  return DeepResearchToolResultSchema.parse(outputs[0]?.output);
}

/** Labels of the card's buttons: the text of a decision message. */
const DECISION_LABELS: Record<ResearchDecision['action'], string> = {
  confirm: 'Запустить',
  decline: 'Не нужно',
  stop: 'Остановить',
};

/**
 * A plain turn where the model proposes research (the `deepResearch` call, then a text answer); returns the proposal's
 * `launchKey`.
 */
async function propose(
  user: string,
  threadId: string,
  input: { goal: string; tokenBudget?: number },
): Promise<string> {
  const call = deepResearchCallStep(input);
  t.chatModel.script(
    call.step,
    textStep('Могу запустить глубокое исследование.'),
  );
  await chat(user, threadId, userMessage(`Разберись: ${input.goal}`));
  return call.toolCallId;
}

/**
 * A decision turn as the card's button sends it. The model's `deepResearch` call carries a goal and a budget of its own,
 * which a decision must not read. Returns the tool result and the reply's metadata as streamed, and the options of the
 * turn's model call.
 */
async function decide(
  user: string,
  threadId: string,
  decision: ResearchDecision,
) {
  t.chatModel.script(
    deepResearchCallStep({
      goal: 'Цель из аргументов модели в ходе решения',
      tokenBudget: 900_000,
    }).step,
  );
  const callsBefore = t.chatModel.calls.length;
  const chunks = await chat(
    user,
    threadId,
    userMessage(DECISION_LABELS[decision.action], {
      [RESEARCH_METADATA_KEYS.researchDecision]: decision,
    }),
  );
  return {
    result: toolResult(chunks),
    streamedMetadata: chunks.find((chunk) => chunk.type === 'start')
      ?.messageMetadata,
    turns: t.chatModel.calls.slice(callsBefore).map(turnOptions),
  };
}

async function research(user: string, threadId: string) {
  const res = await request(t.app.getHttpServer())
    .get(`/api/threads/${threadId}/research`)
    .set('x-user-id', user)
    .expect(200);
  return ThreadResearchResponseSchema.parse(res.body).launches;
}

async function messages(user: string, threadId: string) {
  const res = await request(t.app.getHttpServer())
    .get(`/api/threads/${threadId}/messages`)
    .set('x-user-id', user)
    .expect(200);
  return ThreadMessagesResponseSchema.parse(res.body).messages;
}

/** A stored message as GET /messages returns it. */
type HistoryMessage = Awaited<ReturnType<typeof messages>>[number];

/** The metadata value of `key` on a returned message. */
function metadataValue(message: HistoryMessage | undefined, key: string) {
  const metadata = message?.metadata;
  return typeof metadata === 'object' && metadata !== null
    ? (metadata as Record<string, unknown>)[key]
    : undefined;
}

/**
 * Each stored decision message with the message that follows it: its role, its `researchDecisionReply` mark and how
 * many tool parts it kept.
 */
function decisionPairs(stored: HistoryMessage[]) {
  return stored.flatMap((message, index) => {
    const decision = metadataValue(
      message,
      RESEARCH_METADATA_KEYS.researchDecision,
    );
    if (decision === undefined) return [];
    const reply = stored[index + 1];
    return [
      {
        decision,
        reply: {
          role: reply?.role,
          mark: metadataValue(
            reply,
            RESEARCH_METADATA_KEYS.researchDecisionReply,
          ),
          toolParts: (reply?.parts ?? []).filter(
            (part) => part.type === `tool-${DEEP_RESEARCH_TOOL}`,
          ).length,
        },
      },
    ];
  });
}

/** The turn options of a research mode or decision turn (KD-1, KD-9). */
const RESEARCH_TURN_OPTIONS = {
  modelId: RESEARCH_TURN_MODEL,
  toolChoice: { type: 'tool', toolName: DEEP_RESEARCH_TOOL },
  tools: [DEEP_RESEARCH_TOOL],
  thinking: { type: 'disabled' },
  effort: 'high',
};

/** The turn options a model call received, without the prompt. */
function turnOptions(call: RecordedChatCall | undefined) {
  if (call === undefined) throw new Error('the chat model was not called');
  return {
    modelId: call.modelId,
    toolChoice: call.toolChoice,
    tools: call.tools,
    thinking: call.thinking,
    effort: call.providerOptions?.anthropic?.effort,
  };
}

/** `value`, or a failure naming `what` when it is null or undefined. */
function required<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined)
    throw new Error(`${what} is missing`);
  return value;
}

/** Waits until the launch row of `launchKey` is in `state` (moved by a turn, the consumer or the loop); returns it. */
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

/** A launch started by a mode turn: its key, investigation, controller task and the user message that carried the mode. */
interface StartedLaunch {
  launchKey: string;
  investigationId: string;
  controllerTaskId: string;
  messageId: string;
}

/** A mode turn whose `deepResearch` call starts an investigation in the thread. */
async function launchResearch(
  user: string,
  threadId: string,
  goal: string,
): Promise<StartedLaunch> {
  const call = deepResearchCallStep({ goal, tokenBudget: 400_000 });
  t.chatModel.script(call.step);
  const message = userMessage(`Разберись: ${goal}`, {
    [RESEARCH_METADATA_KEYS.deepResearch]: true,
  });
  await chat(user, threadId, message);
  const row = await launchReaching(call.toolCallId, 'running');
  return {
    launchKey: call.toolCallId,
    investigationId: required(row.investigationId, 'investigationId'),
    controllerTaskId: required(row.controllerTaskId, 'controllerTaskId'),
    messageId: message.id,
  };
}

/** Id of the answer message of an investigation (design-chat-entry.md, KD-4, invariant 4). */
const answerIdOf = (investigationId: string) =>
  `research-answer-${investigationId}`;

/** The delivery of the task's `TaskSucceeded` to the part's consumer; `undefined` while there is no such event. */
async function answerDelivery(taskId: string) {
  const [row] = await query<{ status: string }>(
    `SELECT d.status FROM app.research_event_deliveries d
       JOIN app.research_events e ON e.event_id = d.event_id
      WHERE e.task_id = $1 AND e.type = 'TaskSucceeded' AND d.consumer = $2`,
    [taskId, RESEARCH_ANSWER_CONSUMER],
  );
  return row;
}

/** Waits until the relay has handed the task's `TaskSucceeded` to the part's consumer. */
async function deliveredToConsumer(taskId: string): Promise<void> {
  await vi.waitFor(
    async () => {
      expect((await answerDelivery(taskId))?.status).toBe('done');
    },
    { timeout: TURN_TIMEOUT_MS, interval: 25 },
  );
}

/** A redelivery: the delivery row is pending again, so the relay hands the same event to the consumer once more. */
async function redeliver(taskId: string): Promise<void> {
  await query(
    `UPDATE app.research_event_deliveries d
        SET status = 'pending', next_attempt_at = now() - interval '1 minute'
       FROM app.research_events e
      WHERE e.event_id = d.event_id AND e.task_id = $1 AND e.type = 'TaskSucceeded' AND d.consumer = $2`,
    [taskId, RESEARCH_ANSWER_CONSUMER],
  );
  await deliveredToConsumer(taskId);
}

/** Evidence of a source page with the given provenance; a truncated result is partial. */
function sourceEvidence(
  evidenceKey: string,
  provenance: { sourceId: string; toolName: string; snapshot: string },
  truncated: boolean,
): EvidenceInput {
  const base = evidenceInput(
    evidenceKey,
    new TextEncoder().encode(evidenceKey),
  );
  return {
    ...base,
    provenance: { ...base.provenance, ...provenance },
    coverage: truncated
      ? { ...base.coverage, completeness: 'partial', truncated: true }
      : base.coverage,
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

/** The ids of the thread's stored messages, in stored order. */
async function storedIdsOf(threadId: string): Promise<string[]> {
  return (await storedMessagesOf(threadId)).map((message) => message.id);
}

/**
 * A regenerate the server refuses before streaming (Flow 5, Failure handling): 500 with a JSON error body, no SSE, and
 * no model call.
 */
async function refusedRegenerate(
  user: string,
  threadId: string,
  message: ReturnType<typeof userMessage>,
): Promise<void> {
  const callsBefore = t.chatModel.calls.length;
  const res = await request(t.app.getHttpServer())
    .post('/api/chat/assistant')
    .set('x-user-id', user)
    .send({ id: threadId, messages: [message] })
    .expect(500);
  expect(res.headers['content-type']).toMatch(/application\/json/);
  expect(t.chatModel.calls).toHaveLength(callsBefore);
}

/** How many times the runtime cancelled the investigation: its `InvestigationCancelled` events. */
async function cancellationsOf(investigationId: string): Promise<number> {
  const [row] = await query<{ count: number }>(
    `SELECT count(*)::int AS count FROM app.research_events
      WHERE investigation_id = $1 AND type = 'InvestigationCancelled'`,
    [investigationId],
  );
  return row?.count ?? 0;
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

/** The research mode message of {@link launchResearch} again, with its id: a regenerate resends it. */
function modeMessageOf(launch: StartedLaunch, goal: string) {
  return {
    ...userMessage(`Разберись: ${goal}`, {
      [RESEARCH_METADATA_KEYS.deepResearch]: true,
    }),
    id: launch.messageId,
  };
}

/** A launch finished by the engine double and its answer written by a pass of the loop after the thread's last message. */
async function answerLaunch(launch: StartedLaunch, text: string) {
  t.engine.succeed(launch.investigationId, {
    answer: () => assumedAnswer(text),
  });
  await launchReaching(launch.launchKey, 'answer_pending');
  await t.runAppenderOnce();
  await launchReaching(launch.launchKey, 'answered');
}

/** The thread answers 404 THREAD_NOT_FOUND and its owner's list does not show it. */
async function threadGone(user: string, threadId: string): Promise<void> {
  const res = await request(t.app.getHttpServer())
    .get(`/api/threads/${threadId}`)
    .set('x-user-id', user)
    .expect(404);
  expect(ApiErrorSchema.parse(res.body).errorCode).toBe('THREAD_NOT_FOUND');
  const list = await request(t.app.getHttpServer())
    .get('/api/threads')
    .set('x-user-id', user)
    .expect(200);
  expect(
    ThreadListResponseSchema.parse(list.body).threads.map(
      (thread) => thread.id,
    ),
  ).not.toContain(threadId);
}

/**
 * A `TaskSucceeded` of the launch's controller handed to the part's consumer in a transaction of the app's pool, as
 * the relay would hand an event it read before the investigation was purged (the purge deletes the stored event).
 */
async function deliverLateSuccess(launch: StartedLaunch): Promise<void> {
  const { db } = t.moduleRef.get<DatabaseConnection>(RESEARCH_DATABASE, {
    strict: false,
  });
  const event: EventEnvelope = {
    eventId: randomUUID(),
    type: 'TaskSucceeded',
    schemaVersion: 1,
    investigationId: launch.investigationId,
    taskId: launch.controllerTaskId,
    causationId: null,
    correlationId: randomUUID(),
    stateRevision: 1,
    payloadRef: null,
    payload: {},
    createdAt: new Date().toISOString(),
  };
  await db.transaction((tx) => researchAnswerConsumer.handle(tx, event));
}

describe('deep-research / chat-entry - integration (in-process Nest + real runtime + real Postgres, scripted chat model)', () => {
  beforeAll(async () => {
    t = await createResearchChatApp({ env: { REASONING_EFFORT } });
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
  // INT-1  Chat turns decide launches: only the mode or a confirmed card starts an investigation, and a decision is applied once
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-19.1: "Given пользователь явно выбрал глубокое исследование для сообщения, When он его отправил, Then по нему запущено расследование этого пользователя в этой беседе, а беседа показывает, что оно идёт."
  // AC-19.2: "Given пользователь не выбирал глубокое исследование и агент счёл, что вопрос его требует, Then агент предлагает запуск, показывая цель и оценку бюджета, а расследования у беседы нет, пока пользователь не подтвердил."
  // AC-19.3: "Given предложение показано, When пользователь подтвердил, Then запущено расследование с показанной целью и в пределах показанного бюджета, а беседа показывает, что оно идёт."
  // AC-19.4: "Given предложение показано, When пользователь отклонил его, Then расследование не запущено, а беседа продолжается как обычно."
  // AC-19.5: "Given пользователь не выбирал глубокое исследование и не подтверждал ни одного предложения, Then у беседы нет ни одного расследования, что бы ни решил агент."
  // AC-19.6: "Given расследование идёт, When пользователь пишет в беседу, Then главный агент отвечает как обычно."
  // AC-19.7: "Given предложение уже подтверждено, When пользователь подтверждает его повторно, Then новое расследование не запускается, и у этого предложения остаётся ровно одно расследование."
  // AC-20.5: "Given беседа и расследование пользователя U, Then другой пользователь не видит ни ответа, ни состояния расследования (бизнес-ограничение 2)."
  // AC-21.1 (first sentence, the stop half): "Given расследование идёт, When пользователь его остановил, Then ... беседа показывает, что расследование остановлено" (the "no new model or source call" half is engine AC-01.4; the "answer is not appended" half is INT-2 D3)
  // DC-1 (FR-19): "Когда пользователь нажимает «Запустить», «Не нужно» или «Остановить» на карточке, чья судьба уже решена, ход решения ничего не меняет, а карточка переходит в текущее состояние запуска без строки ошибки."
  // DC-2 (FR-19): "Когда пользователь отправляет следующее сообщение, открытые предложения беседы закрываются, и карточка показывает «Не запущен» с причиной MC-13 для продолжившейся беседы; нажатие кнопки карточки следующим сообщением не считается."
  // DC-7 (FR-19, server half): "ChatController помечает реплику хода решения метаданными researchDecisionReply с launchKey" - what the web hides is INT-4; here the marks are what is stored and returned by GET messages.
  // AC-26.1 (chat share): "Given в развёртывании не подключён ни один источник данных, When сервис запускается, Then он запускается без ошибки, чат принимает сообщения, а глубокое исследование можно запустить в режиме без источников."
  // AC-27.1 (server half): "Given в развёртывании не подключён ни один источник данных, When агент предлагает глубокое исследование, Then вместе с целью и оценкой бюджета предложение предупреждает, что источники данных не подключены и ответ будет опираться на знания модели." (the sentence MC-31 is drawn by the web; here the proposal's `sourceMode`)
  // AC-27.2 (server half): "Given в развёртывании не подключён ни один источник данных, When пользователь явно выбрал глубокое исследование и отправил сообщение, Then беседа показывает то же предупреждение там же, где показывает, что расследование идёт (AC-19.1), с момента запуска." (here: the first view the tool returns already has `sourceMode`)
  // AC-27.4 (server half): "Given подключён хотя бы один источник, Then беседа не показывает предупреждения режима без источников ни в предложении, ни в идущем расследовании, ни в ответе." (here: `sourceMode` `sources` in every view; the answer is INT-2 D1)
  // DC-8 (FR-27): "Пока у запуска нет расследования, карточка показывает MC-31 по режиму развёртывания в момент чтения; после старта — по режиму своего расследования, и рестарт с другим набором источников её не меняет."
  // Use cases: UC-1, UC-2, UC-3 (server half), UC-12 (launch half), UC-13, UC-E1 (the `decisionError` rows), UC-E2, UC-E5. Flow 1, Flow 2, Flow 4 (the branches that do not race with the answer). KD-1, KD-2, KD-8, Invariants 1, 2.
  //
  // Primary failure mode (turns red when): a turn without the mode or a decision starts an investigation (the agent launches itself); a mode turn runs without the forced `deepResearch` call or with reasoning on (the provider rejects it);
  // a confirm starts a second investigation, or starts one with the goal or budget the model passed in the decision turn instead of the recorded proposal; a decision on a settled launch changes it or answers an error; a decision turn
  // closes other proposals, or a plain follow-up does not; a decision with another user's `launchKey` changes that user's launch; the reply of a decision turn is stored without `researchDecisionReply`;
  // a deployment without sources refuses or does not offer the research (the part adds its own source check), or its proposal and first launch view lack the mode; a running launch follows the live engine mode after a restart with other sources
  // instead of keeping its investigation's mode, or a proposal keeps the old mode (the row stores what was read when it was proposed); a deployment with a source shows the no-source mode.
  // Behavior: POST /api/chat with message metadata (`deepResearch: true`, or `researchDecision` with action and `launchKey`) or without -> ChatController gives the turn its single forced tool and no reasoning, or none -> the scripted model calls
  //   `deepResearch` -> the tool reads the mode or decision from the turn context, not from model arguments -> ResearchLaunchService writes the `research_chat_launches` row under the thread lock and starts the investigation outside it ->
  //   the tool returns a ResearchLaunchView -> GET /api/threads/:threadId/research and GET /messages show the result
  // @category: core-functionality
  // @dependency: ChatController, deepResearch tool, ResearchLaunchService, ThreadsService (write lock), ThreadRunRegistry, Mastra Memory, runtime InvestigationService, engine port double, research_chat_launches, Postgres
  // @complexity: high
  //
  // Verification items (table of scenarios; each row names the AC it proves and shares the harness; every row ends by reading `research_chat_launches` and the runtime's investigations of the user, not logs):
  // - A1 explicit mode (UC-1, AC-19.1, AC-19.6): message with `deepResearch: true` -> the model double saw exactly one tool (`deepResearch`) forced, and reasoning off; the row is `running` with a `controllerTaskId` and one investigation of this
  //   user in this thread; the stored user message keeps `deepResearch: true` in GET /messages (the label survives a reload); a next message without the mode -> the double saw no forced tool, a text reply, still one investigation
  // - A2 proposal, no self-launch (UC-2 first half, AC-19.2, AC-19.5): a turn without mode where the double calls `deepResearch` with a goal and a budget -> the row is `proposed` and carries that goal and budget in GET /research; zero
  //   investigations of the user; a second proposal in the same thread is a second row with its own `launchKey`; nothing else (no later turn without a confirm) ever creates one
  // - A3 decisions (UC-2, UC-3 server half, UC-E1 rows, AC-19.3, AC-19.4, AC-19.7, AC-21.1 stop half, DC-1, DC-7): over two `proposed` rows and the table of actions:
  //     confirm, the double's tool call carrying a different goal and a bigger budget than the proposal -> one investigation started with the recorded goal and budget, row `running`
  //     decline -> `not_launched` with reason `declined`, no investigation
  //     confirm again, then decline, on the running one (the second tab) -> the same view, count of investigations still one, no `decisionError`
  //     stop on `running` -> `InvestigationService.cancel` called once, row `stopped`; stop again -> same view, no second effect
  //     engine double refuses the start -> row back in `proposed`, the tool result has `decisionError: launch_failed`; cancel refused on stop -> row unchanged, `decisionError: stop_failed`
  //     in every row the stored reply of the turn carries `researchDecisionReply` with the `launchKey`, the decision message carries `researchDecision`, and GET /messages returns both (the web hides them by these marks)
  // - A4 supersede (UC-E2, DC-2): proposal, then a plain next message -> row `not_launched` with reason `superseded`; a confirm on it afterwards -> same view, no investigation; a second proposal where a decision turn is sent for a different card
  //   leaves the other proposal `proposed`
  // - A5 another user (UC-E5, AC-20.5): user V reads GET /research of U's thread -> 404 THREAD_NOT_FOUND (ApiError schema); V sends a decision turn in V's own thread with U's `launchKey` -> `decisionError: not_found`, U's row version
  //   unchanged (row-version snapshot), no investigation for V
  // - A6 source mode of the launches (UC-12 launch half, UC-13, AC-26.1 chat share, AC-27.1, AC-27.2, AC-27.4, DC-8, KD-8; unique defect: the mode read from the wrong moment - the live engine mode for a running launch, or the mode stored at proposal time for a
  //   proposal - and a source check added by the part, which neither the web nor the engine suites can show): the double starts with `Engine.sourceMode` `model_knowledge` and the app is composed with no source adapter:
  //     a turn without the mode where the chat model double calls `deepResearch` -> the app takes the message, the double saw the same single tool and the same instruction text as in a `sources` run, the proposal is stored and GET /research shows it with `sourceMode` `model_knowledge`
  //     a turn with the mode -> one investigation started, the tool result (the first view) already has `sourceMode` `model_knowledge`, and the `research_chat_launches` row stores the investigation's mode copied at reconciliation
  //     rows with no investigation (declined, superseded, failed start, `launching`) show the current `Engine.sourceMode`
  //     then the double's `Engine.sourceMode` is set to `sources` (the restart with the fixture): the open proposal shows `sources`, the running launch keeps `model_knowledge`, a confirm of the proposal starts an investigation viewed as `sources`
  //   and in a run with `sources` from the start every view (proposal, running, completed) has `sourceMode` `sources`
  describe('INT-1', () => {
    it(
      'INT-1 A1: a turn with the research mode forces the deepResearch call without reasoning and starts one investigation; the next turn without the mode answers as usual and starts none',
      async () => {
        // Arrange: a mode turn whose model call is the deepResearch call.
        const user = t.user();
        const threadId = await t.createThread(user);
        const call = deepResearchCallStep({
          goal: 'Почему падает импорт заказов',
          tokenBudget: 400_000,
        });
        t.chatModel.script(call.step);
        const modeMessage = userMessage(
          'Разберись, почему падает импорт заказов',
          {
            [RESEARCH_METADATA_KEYS.deepResearch]: true,
          },
        );

        // Act
        await chat(user, threadId, modeMessage);

        // Assert (AC-19.1, KD-1, KD-9): one call on Haiku 5.5 with deepResearch as the only, forced tool, thinking off and
        // the effort capped at high — one step.
        expect(t.chatModel.calls.map(turnOptions)).toEqual([
          {
            modelId: RESEARCH_TURN_MODEL,
            toolChoice: { type: 'tool', toolName: DEEP_RESEARCH_TOOL },
            tools: [DEEP_RESEARCH_TOOL],
            thinking: { type: 'disabled' },
            effort: 'high',
          },
        ]);
        // The launch row is running with its controller task, and the user has one investigation, in this thread.
        const [investigation, ...moreInvestigations] =
          await investigationsOf(user);
        expect(moreInvestigations).toEqual([]);
        expect(investigation).toMatchObject({
          threadId,
          query: 'Почему падает импорт заказов',
        });
        expect(t.engine.started).toHaveLength(1);
        expect(await launchesOf(user, threadId)).toEqual([
          expect.objectContaining({
            launchKey: call.toolCallId,
            mode: 'explicit',
            state: 'running',
            goal: 'Почему падает импорт заказов',
            tokenBudget: 400_000,
            userMessageId: modeMessage.id,
            investigationId: investigation?.investigationId,
            controllerTaskId: t.engine.started[0]?.controllerTaskId,
            sourceMode: 'sources',
          }),
        ]);
        // The user message keeps the mode after a reload (the DR-02 label).
        const stored = await messages(user, threadId);
        expect(
          stored.find((message) => message.id === modeMessage.id)?.metadata,
        ).toMatchObject({
          [RESEARCH_METADATA_KEYS.deepResearch]: true,
        });

        // Act: the next turn without the mode (AC-19.6).
        t.chatModel.script(textStep('Импорт падает на проверке схемы.'));
        await chat(
          user,
          threadId,
          userMessage('А пока скажи, что ты думаешь?'),
        );

        // Assert: the chat model, the tool not forced but offered among the ordinary ones, thinking not turned off; a
        // text reply; still one investigation.
        expect(t.chatModel.calls).toHaveLength(2);
        expect(turnOptions(t.chatModel.calls[1])).toEqual({
          modelId: CHAT_MODEL,
          toolChoice: { type: 'auto' },
          tools: [DEEP_RESEARCH_TOOL],
          thinking: undefined,
          effort: undefined,
        });
        const reply = (await messages(user, threadId)).at(-1);
        expect(reply?.role).toBe('assistant');
        expect(reply?.parts).toEqual([
          expect.objectContaining({
            type: 'text',
            text: 'Импорт падает на проверке схемы.',
          }),
        ]);
        expect(await investigationsOf(user)).toHaveLength(1);
        expect(t.engine.started).toHaveLength(1);
        expect(t.chatModel.remaining()).toBe(0);
      },
      TURN_TIMEOUT_MS * 2,
    );

    it(
      'INT-1 A2: a turn without the mode only records a proposal with its goal and budget, and no later turn without a confirm starts an investigation',
      async () => {
        // Arrange: an ordinary turn where the model proposes research, then answers after the tool result.
        const user = t.user();
        const threadId = await t.createThread(user);
        const first = deepResearchCallStep({
          goal: 'Сравнить ошибки импорта за неделю',
          tokenBudget: 500_000,
        });
        t.chatModel.script(
          first.step,
          textStep('Предлагаю запустить глубокое исследование.'),
        );

        // Act
        await chat(
          user,
          threadId,
          userMessage('Почему импорт заказов падает всю неделю?'),
        );

        // Assert (AC-19.2, AC-19.5): the turn ran on the chat model with the tool not forced; the launch is a proposal
        // with the model's goal and budget, and nothing started.
        expect(turnOptions(t.chatModel.calls[0])).toMatchObject({
          modelId: CHAT_MODEL,
          toolChoice: { type: 'auto' },
        });
        expect(await research(user, threadId)).toEqual([
          {
            launchKey: first.toolCallId,
            mode: 'proposal',
            state: 'proposed',
            notLaunchedReason: null,
            goal: 'Сравнить ошибки импорта за неделю',
            tokenBudget: 500_000,
            createdAt: expect.any(String),
            answerMessageId: null,
            answerPending: false,
            sourceMode: 'sources',
          },
        ]);
        expect(await investigationsOf(user)).toEqual([]);
        expect(t.engine.startCalls).toEqual([]);

        // Act: a later turn without a confirm proposes again, without a budget.
        const second = deepResearchCallStep({
          goal: 'Найти первый сбой импорта',
        });
        t.chatModel.script(
          second.step,
          textStep('Могу запустить и это исследование.'),
        );
        await chat(user, threadId, userMessage('А когда это началось?'));

        // Assert: a second row with its own launchKey and the configuration's default budget; still no investigation.
        // The later message closed the first proposal (DC-2, INT-1 A4).
        expect(await research(user, threadId)).toEqual([
          expect.objectContaining({
            launchKey: first.toolCallId,
            state: 'not_launched',
            notLaunchedReason: 'superseded',
          }),
          expect.objectContaining({
            launchKey: second.toolCallId,
            mode: 'proposal',
            state: 'proposed',
            goal: 'Найти первый сбой импорта',
            tokenBudget: DEFAULT_TOKEN_BUDGET,
          }),
        ]);
        expect(await investigationsOf(user)).toEqual([]);
        expect(t.engine.startCalls).toEqual([]);
        expect(t.chatModel.remaining()).toBe(0);
      },
      TURN_TIMEOUT_MS * 2,
    );
    it(
      'INT-1 A3: confirm starts exactly one investigation with the recorded goal and budget, decline starts none, repeated and stale decisions change nothing and answer no error, stop cancels once, refused start or stop returns decisionError, and every decision reply is marked',
      async () => {
        // Arrange: a proposal of an ordinary turn.
        const user = t.user();
        const threadId = await t.createThread(user);
        const first = await propose(user, threadId, {
          goal: 'Сравнить ошибки импорта за неделю',
          tokenBudget: 400_000,
        });
        const decisions: Awaited<ReturnType<typeof decide>>[] = [];
        const send = async (decision: ResearchDecision) => {
          const sent = await decide(user, threadId, decision);
          decisions.push(sent);
          return sent;
        };

        // Act: confirm, the model's call carrying another goal and a bigger budget.
        const confirmed = await send({ action: 'confirm', launchKey: first });

        // Assert (AC-19.3): one investigation, started with the recorded goal and budget; the card is running.
        const [investigation, ...moreInvestigations] =
          await investigationsOf(user);
        expect(moreInvestigations).toEqual([]);
        expect(investigation).toMatchObject({
          threadId,
          query: 'Сравнить ошибки импорта за неделю',
        });
        expect(t.engine.startCalls).toEqual([
          expect.objectContaining({
            launchKey: first,
            threadId,
            query: 'Сравнить ошибки импорта за неделю',
            tokenBudget: 400_000,
          }),
        ]);
        expect(confirmed.result).toEqual({
          launch: expect.objectContaining({
            launchKey: first,
            mode: 'proposal',
            state: 'running',
            goal: 'Сравнить ошибки импорта за неделю',
            tokenBudget: 400_000,
          }),
        });
        expect(await launchesOf(user, threadId)).toEqual([
          expect.objectContaining({
            launchKey: first,
            state: 'running',
            investigationId: investigation?.investigationId,
          }),
        ]);

        // Act + Assert (AC-19.7, DC-1): confirm again and decline from a second tab — the same view, no error, still
        // one investigation.
        for (const action of ['confirm', 'decline'] as const) {
          const repeated = await send({ action, launchKey: first });
          expect(repeated.result).toEqual({ launch: confirmed.result.launch });
        }
        expect(await investigationsOf(user)).toHaveLength(1);
        expect(t.engine.startCalls).toHaveLength(1);

        // Act + Assert (AC-19.4): a second proposal declined — not launched, nothing started.
        const second = await propose(user, threadId, {
          goal: 'Найти первый сбой импорта',
          tokenBudget: 500_000,
        });
        const declined = await send({ action: 'decline', launchKey: second });
        expect(declined.result).toEqual({
          launch: expect.objectContaining({
            launchKey: second,
            state: 'not_launched',
            notLaunchedReason: 'declined',
          }),
        });
        expect(t.engine.startCalls).toHaveLength(1);

        // Act + Assert (AC-21.1 stop half): stop cancels the investigation once; a second stop changes nothing.
        const stopped = await send({ action: 'stop', launchKey: first });
        expect(t.cancels.calls).toEqual([
          { investigationId: investigation?.investigationId, resourceId: user },
        ]);
        expect(stopped.result).toEqual({
          launch: expect.objectContaining({
            launchKey: first,
            state: 'stopped',
          }),
        });
        const stoppedAgain = await send({ action: 'stop', launchKey: first });
        expect(stoppedAgain.result).toEqual({ launch: stopped.result.launch });
        expect(t.cancels.calls).toHaveLength(1);

        // Act + Assert (UC-E1): the engine refuses the start of a third proposal — back to proposed, launch_failed.
        const third = await propose(user, threadId, {
          goal: 'Проверить схему заказов',
          tokenBudget: 600_000,
        });
        t.engine.refuseStarts(new Error('engine unavailable'));
        const refused = await send({ action: 'confirm', launchKey: third });
        expect(refused.result).toEqual({
          launch: expect.objectContaining({
            launchKey: third,
            state: 'proposed',
          }),
          decisionError: 'launch_failed',
        });
        expect(await launchesOf(user, threadId)).toEqual([
          expect.objectContaining({ launchKey: first, state: 'stopped' }),
          expect.objectContaining({ launchKey: second, state: 'declined' }),
          expect.objectContaining({
            launchKey: third,
            state: 'proposed',
            investigationId: null,
          }),
        ]);

        // The card is active again: a confirm starts it; then the runtime refuses the cancel — row unchanged,
        // stop_failed.
        t.engine.refuseStarts(null);
        const retried = await send({ action: 'confirm', launchKey: third });
        expect(retried.result).toEqual({
          launch: expect.objectContaining({
            launchKey: third,
            state: 'running',
          }),
        });
        t.cancels.refuse(new Error('runtime unavailable'));
        const stopRefused = await send({ action: 'stop', launchKey: third });
        expect(stopRefused.result).toEqual({
          launch: retried.result.launch,
          decisionError: 'stop_failed',
        });
        expect(await launchOf(third)).toMatchObject({ state: 'running' });
        expect(await investigationsOf(user)).toHaveLength(2);

        // Assert (KD-9): every decision turn ran on Haiku 5.5 with the one forced tool, thinking off, effort at most
        // high.
        expect(decisions.flatMap((sent) => sent.turns)).toEqual(
          decisions.map(() => RESEARCH_TURN_OPTIONS),
        );
        // Assert (DC-7, KD-2): every reply carried the mark while it streamed, and GET /messages returns each decision
        // message followed by its marked reply, with the tool part kept.
        const sent: ResearchDecision[] = [
          { action: 'confirm', launchKey: first },
          { action: 'confirm', launchKey: first },
          { action: 'decline', launchKey: first },
          { action: 'decline', launchKey: second },
          { action: 'stop', launchKey: first },
          { action: 'stop', launchKey: first },
          { action: 'confirm', launchKey: third },
          { action: 'confirm', launchKey: third },
          { action: 'stop', launchKey: third },
        ];
        expect(decisions.map((d) => d.streamedMetadata)).toEqual(
          sent.map(({ launchKey }) => ({
            [RESEARCH_METADATA_KEYS.researchDecisionReply]: { launchKey },
          })),
        );
        expect(decisionPairs(await messages(user, threadId))).toEqual(
          sent.map((decision) => ({
            decision,
            reply: {
              role: 'assistant',
              mark: { launchKey: decision.launchKey },
              toolParts: 1,
            },
          })),
        );
        expect(t.chatModel.remaining()).toBe(0);
      },
      TURN_TIMEOUT_MS * 4,
    );

    it(
      'INT-1 A4: a plain follow-up message closes open proposals as superseded, a decision turn does not close the other proposals, and a confirm on a superseded card starts nothing',
      async () => {
        // Arrange: a proposal.
        const user = t.user();
        const threadId = await t.createThread(user);
        const first = await propose(user, threadId, {
          goal: 'Проверить задержки синхронизации',
          tokenBudget: 300_000,
        });

        // Act: a plain next message.
        t.chatModel.script(textStep('Хорошо, продолжим без исследования.'));
        await chat(user, threadId, userMessage('Давай пока без исследования'));

        // Assert (DC-2): the open proposal is closed as superseded.
        const superseded = {
          launchKey: first,
          state: 'not_launched',
          notLaunchedReason: 'superseded',
        };
        expect(await research(user, threadId)).toEqual([
          expect.objectContaining(superseded),
        ]);

        // Act: a new proposal, then a decision turn for the superseded card.
        const second = await propose(user, threadId, {
          goal: 'Сравнить задержки по регионам',
          tokenBudget: 350_000,
        });
        const late = await decide(user, threadId, {
          action: 'confirm',
          launchKey: first,
        });

        // Assert (UC-E2, DC-1, DC-2): the late confirm answers the superseded view and starts nothing, and the decision
        // turn leaves the other proposal open.
        expect(late.result).toEqual({
          launch: expect.objectContaining(superseded),
        });
        expect(await research(user, threadId)).toEqual([
          expect.objectContaining(superseded),
          expect.objectContaining({ launchKey: second, state: 'proposed' }),
        ]);
        expect(t.engine.startCalls).toEqual([]);
        expect(await investigationsOf(user)).toEqual([]);
        expect(t.chatModel.remaining()).toBe(0);
      },
      TURN_TIMEOUT_MS * 2,
    );

    it(
      'INT-1 A5: another user cannot read the launches of the thread (404) and a foreign launchKey in a decision turn changes nothing (not_found)',
      async () => {
        // Arrange: U's proposal and the versions of U's launch rows; V with a thread of their own.
        const owner = t.user();
        const ownerThread = await t.createThread(owner);
        const launchKey = await propose(owner, ownerThread, {
          goal: 'Разобрать отчёт о продажах',
          tokenBudget: 250_000,
        });
        const versions = await launchVersionsOf(owner);
        const other = t.user();
        const otherThread = await t.createThread(other);

        // Act + Assert (AC-20.5): V reads U's launches — the threads API's 404.
        const read = await request(t.app.getHttpServer())
          .get(`/api/threads/${ownerThread}/research`)
          .set('x-user-id', other)
          .expect(404);
        expect(ApiErrorSchema.parse(read.body)).toEqual({
          statusCode: 404,
          message: 'Thread not found',
          error: 'Not Found',
          errorCode: 'THREAD_NOT_FOUND',
        });

        // Act + Assert (UC-E5): decisions with U's launchKey in V's own thread — not_found.
        for (const action of ['confirm', 'decline'] as const) {
          const foreign = await decide(other, otherThread, {
            action,
            launchKey,
          });
          expect(foreign.result).toEqual({
            launch: null,
            decisionError: 'not_found',
          });
        }

        // Nothing of U changed, and V has no investigation.
        expect(await launchVersionsOf(owner)).toEqual(versions);
        expect(await research(owner, ownerThread)).toEqual([
          expect.objectContaining({ launchKey, state: 'proposed' }),
        ]);
        expect(await investigationsOf(other)).toEqual([]);
        expect(t.engine.startCalls).toEqual([]);
        expect(t.chatModel.remaining()).toBe(0);
      },
      TURN_TIMEOUT_MS * 2,
    );
    // INT-1 A6 needs an assembly without source adapters: it is in the describe after this one.
  });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2  Answer delivery: the answer is appended once, after the running chat turn, in completion order, and never after a stop or a give-up
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-20.1: "Given беседа открыта, When расследование завершено, Then ответ появляется в беседе без перезагрузки страницы (NFR-01), и беседа больше не показывает, что это расследование идёт." (server half: the stored message and GET /research; the live append is INT-5)
  // AC-20.2: "Given ответ дописан, When беседа перезагружена или открыта позже, Then ответ стоит в ней ровно один раз, на позиции, которую получил при завершении расследования." (position and uniqueness on redelivery; the kill case is E2E-1; the regenerate exception is INT-3 T2)
  // AC-20.3: "Given в момент завершения расследования в беседе стримится другой ответ, Then ответ расследования показан отдельным сообщением и не склеен со стримящимся ни вживую, ни после перезагрузки."
  // AC-20.4: "Given расследование завершилось ошибкой, Then беседа показывает, что оно не удалось, и больше не показывает, что оно идёт."
  // AC-20.6: "Given в беседе идут два расследования, When запущенное вторым завершилось первым, Then его ответ дописан раньше ответа первого, и каждый ответ ссылается на своё сообщение-запуск."
  // AC-20.7: "Given в развёртывании подключён хотя бы один источник данных, и ответ дописан, Then у каждого его утверждения в беседе видно, на какое evidence оно опирается (AC-09.2)." (server half: footnote numbers and source records in `researchAnswer`; the rendering is a component spec)
  // AC-27.3 (server half): "Given в беседу дописан ответ расследования в режиме без источников, Then беседа показывает предупреждение ответа и пометку знаний модели у каждого утверждения (AC-25.1, AC-25.2), в том числе после перезагрузки." (here: `sourceMode` in `researchAnswer`, MC-32 and MC-33 in the stored text, survival in GET /messages; the drawing is a component spec)
  // AC-27.4 (answer half): "Given подключён хотя бы один источник, Then беседа не показывает предупреждения режима без источников ни в предложении, ни в идущем расследовании, ни в ответе." (UC-4 with the fixture connected: asserted in D1)
  // DC-9 (FR-27): "Текстовая часть ответа в режиме без источников начинается с MC-32 и несёт MC-33 после каждого утверждения, поэтому «Копировать» и модель в следующих ходах получают ту же оговорку."
  // AC-21.1 (third part): "...а ответ не дописывается." (the stop wins over a finished controller)
  // DC-3 (FR-20): "Стримящийся ответ из NFR-01 - любой прогон чата беседы, зарегистрированный в ThreadRunRegistry этого процесса, в том числе ход решения; ответ ресерча дописывается после его конца."
  // DC-4 (FR-20): "Когда ответ не удаётся записать дольше RESEARCH_APPEND_GIVE_UP_MS с первой неудачи, запуск переходит в failed, и карточка показывает «Не удался»; так же кончается повторная запись ответа, убранного перегенерацией."
  // NFR-01 (server share only): "ответ завершённого расследования появляется в открытой беседе не позже чем через 5 с после завершения" - the measured end-to-end figure is E2E-2; here the answer is stored by the first pass after the event.
  // Use cases: UC-4 (server half, with a fixture connected), UC-6, UC-7, UC-12 (answer half), UC-E3, UC-E4, UC-E7 (server half). Flow 3, Flow 4 (race branch). KD-3, KD-4, KD-5, KD-8, Invariants 3, 4, 5, 6.
  //
  // Primary failure mode (turns red when): the answer is written in the middle of a chat turn or between the user message and its reply (DC-3); a later-finishing investigation's answer lands before an earlier one that is still retrying, or the
  // other way round for AC-20.6; a redelivered `TaskSucceeded` or a second pass writes a second message; a stopped or failed launch still gets an answer; a client copy of `research-answer-*` in the next chat request overwrites the stored answer;
  // the loop retries forever and the card stays "running", or gives up early; a child task or an investigation started outside a thread turns a row to `answer_pending`;
  // an answer of an investigation without sources is stored with footnotes, sources or `established` claims, or without `sourceMode` (the web then draws it as a checked answer), or its text carries no MC-32 / MC-33
  // (the copy and the next chat turn lose the caveat), or the loop reads evidence for it; an answer of an investigation with a source carries the no-source warning or marks.
  // Behavior: TaskSucceeded of the row's `controllerTaskId` -> consumer moves the row to `answer_pending` in the delivery transaction (no external call) -> the loop pass picks the rows in completion order, skips threads with a registered run, and under the
  //   thread lock re-reads the row, reads the answer and provenance through the engine port, saves `research-answer-<investigationId>` with Markdown text and `researchAnswer` metadata, marks `answered` -> GET /research and GET /messages show it
  // @category: core-functionality
  // @dependency: ResearchAnswerConsumer, ResearchAnswerAppender, ThreadRunRegistry, ThreadsService.withOwnedThread, ChatController (client copies of answers), engine port double (readInvestigation, EvidenceReader), Mastra Memory, injected clock, research_chat_launches, Postgres
  // @complexity: high
  //
  // Verification items (table; every row reads the stored messages of the thread with their metadata and `createdAt`, and the launch rows):
  // - D1 delivery and shape (UC-4 with a fixture connected, AC-20.1, AC-20.2 uniqueness, AC-20.4, AC-20.7, AC-27.4): TaskSucceeded of the controller task -> after one pass exactly one message `research-answer-<investigationId>` after the last message; its text is the
  //   whole answer in Markdown (header, groups, claims with `[n]`, source list); its `researchAnswer` metadata has goal, outcome, stop reason, the launch reference, claims with footnote numbers by first appearance and the source entries
  //   (sourceId, toolName, snapshot, truncated), and `sourceMode` `sources`; the text holds neither MC-32 nor MC-33 and the launch view has no no-source mode (AC-27.4); no `removed` section; GET /research shows `completed` with `answerMessageId`; the same event delivered again and a second pass change nothing (still one message, same position);
  //   a TaskSucceeded of a child task and of an investigation not started from a thread do not touch any row; TaskFailed -> row `failed` and TaskCancelled -> `stopped`, no message in both
  // - D2 order and running turns (UC-6, UC-E3, AC-20.3, AC-20.6, DC-3, UC-E7 server half): two launches in one thread, the second finishes first -> its answer is stored before the first one's, each with its own launch reference;
  //   a chat run registered in ThreadRunRegistry (a latch holds the model) -> passes write nothing for that thread; after the run ends, the next pass writes the answer after the run's reply, never between the user message and its reply;
  //   a decision turn that failed before its reply (stored: the decision message only) does not block the pass; the next chat request carries a client copy of the answer message with edited content -> the stored answer is unchanged
  // - D3 stop beats the answer (UC-7, AC-21.1): controller succeeded and row `answer_pending`, then the stop decision turn -> row `stopped`, cancel called, and passes before and after write no message; a stop on a row already `answered`
  //   changes nothing (the answer was delivered)
  // - D4 give-up window and queue (UC-E4, AC-20.6, DC-4): the memory write fails on every try -> the row stays `answer_pending`, the pauses between tries start at `RUNTIME_POLL_MS` and double up to 16 times that, a later finished
  //   investigation of the same thread writes nothing while the earlier one retries; at `RESEARCH_APPEND_GIVE_UP_MS` after the first failure the row is `failed` (GET /research: `failed`, no `answerMessageId`), the earlier-finished one is
  //   not retried again, and the next row is then written
  // - D5 answer without sources (UC-12 answer half, AC-27.3 server half, DC-9, KD-8; unique defect: the loop treating a no-source answer as a sourced one - reading evidence that does not exist, numbering footnotes, dropping the mode from the metadata - or
  //   storing the caveat only in the metadata so that the copy and the model lose it; the builder's rule table is a unit test): the double's `InvestigationView` has `sourceMode` `model_knowledge`, two claims in `assumed` with no evidence, `established` empty, outcome `answered`;
  //   one pass after TaskSucceeded -> one message `research-answer-<investigationId>`; `researchAnswer.sourceMode` is `model_knowledge`, `established` is empty, claims have no footnote numbers, the source list is empty; the text starts with MC-32 and has MC-33 after each of the two
  //   claims and no `[n]`; the counting spy on `EvidenceReader.get` has zero calls; GET /messages after a reload returns the same message once; the next plain chat turn of the thread: the message list the chat model double received contains that text with MC-32 and both MC-33
  //   (the model is not told the claims are checked); GET /research shows `completed` with `answerMessageId`.
  describe('INT-2', () => {
    it(
      'INT-2 D1: a finished controller task appends one answer message with Markdown text and researchAnswer metadata (mode sources, no no-source warning or mark) at the end of the thread, redelivery changes nothing, child and foreign events are ignored, and failure or cancel appends nothing',
      async () => {
        // Arrange: a running launch of a mode turn, its controller held.
        const user = t.user();
        const threadId = await t.createThread(user);
        const answered = await launchResearch(
          user,
          threadId,
          'Почему выросло время ответа API',
        );
        await t.engine.controllerRunning(answered.investigationId);
        const runtime = t.moduleRef.get<Runtime>(RESEARCH_RUNTIME, {
          strict: false,
        });

        // Act: a child task of the same investigation succeeds, and so does an investigation of the thread that no
        // launch started.
        const childWorkflow = uniqueWorkflowType('chat-entry-child');
        t.moduleRef
          .get<HandlerRegistry>(HANDLER_REGISTRY, { strict: false })
          .register(
            testHandler(childWorkflow, () => Promise.resolve(completed())),
          );
        const child = await runtime.scheduler.propose(
          taskSpec({
            investigationId: answered.investigationId,
            workflowType: childWorkflow,
            input: {},
          }),
          'chat-entry-int-d1',
        );
        if (child.outcome !== 'created') throw new Error('child task refused');
        const foreign = await t.engine.startInvestigation({
          resourceId: user,
          threadId,
          query: 'Расследование вне карточки',
          processId: 'deep-research',
          launchKey: `foreign-${randomUUID()}`,
          tokenBudget: 100_000,
        });
        if (foreign.outcome === 'rejected') {
          throw new Error('foreign start refused');
        }
        const versions = await launchVersionsOf(user);
        t.engine.succeed(foreign.investigationId, {
          answer: () => assumedAnswer('Чужой ответ'),
        });
        await deliveredToConsumer(child.taskId);
        await deliveredToConsumer(foreign.controllerTaskId);

        // Assert: neither event touched the launch row.
        expect(await launchVersionsOf(user)).toEqual(versions);
        expect(await launchOf(answered.launchKey)).toMatchObject({
          state: 'running',
        });

        // Act: the controller stores two evidence and succeeds; one pass.
        t.engine.succeed(answered.investigationId, {
          evidence: [
            sourceEvidence(
              'd1-latency',
              {
                sourceId: 'logs',
                toolName: 'aggregate_logs',
                snapshot: 'snap-a',
              },
              true,
            ),
            sourceEvidence(
              'd1-release',
              {
                sourceId: 'deploys',
                toolName: 'list_releases',
                snapshot: 'snap-b',
              },
              false,
            ),
          ],
          answer: ([latency = '', release = '']) => ({
            answerId: 'answer-d1',
            outcome: 'answered',
            stopReason: null,
            summary: 'Время ответа выросло после релиза 4.2.',
            established: [
              {
                claimId: 'c1',
                text: 'p95 вырос с 180 до 420 мс',
                evidenceIds: [release, latency],
                verified: true,
              },
            ],
            assumed: [
              {
                claimId: 'c2',
                text: 'Рост вызван новой политикой повторов',
                evidenceIds: [latency],
                verified: false,
              },
            ],
            unknown: [
              {
                claimId: 'c3',
                text: 'Затронуты ли мобильные клиенты',
                evidenceIds: [],
                verified: false,
              },
            ],
            removed: [
              {
                claimId: 'c4',
                text: 'Виновата база данных',
                reason: 'refuted',
              },
            ],
          }),
        });
        await launchReaching(answered.launchKey, 'answer_pending');
        await t.runAppenderOnce();

        // Assert (AC-20.1, AC-20.7, AC-27.4, DC-10): one answer message at the end of the thread; its text is the whole
        // answer in Markdown — summary and MC-34, footnotes by first appearance, no `removed`, no MC-32 or MC-33.
        const answerId = answerIdOf(answered.investigationId);
        const stored = await storedMessagesOf(threadId);
        expect(
          stored.filter((message) => message.id === answerId),
        ).toHaveLength(1);
        const answer = stored.at(-1);
        expect(answer).toMatchObject({ id: answerId, role: 'assistant' });
        expect(answer?.text).toBe(
          [
            '**Ответ ресерча** · Есть ответ',
            'Цель: Почему выросло время ответа API',
            '',
            'Время ответа выросло после релиза 4.2.',
            '',
            'Краткий пересказ — основания в утверждениях ниже',
            '',
            '### Установлено',
            '- p95 вырос с 180 до 420 мс [1][2]',
            '',
            '### Предположения',
            '- Рост вызван новой политикой повторов [2] (не проверено)',
            '',
            '### Не выяснено',
            '- Затронуты ли мобильные клиенты (не проверено)',
            '',
            '### Источники (2)',
            '1. deploys · list_releases · snap-b',
            '2. logs · aggregate_logs · snap-a · данные усечены',
          ].join('\n'),
        );
        expect(
          answer?.metadata?.[RESEARCH_METADATA_KEYS.researchAnswer],
        ).toEqual({
          launchKey: answered.launchKey,
          goal: 'Почему выросло время ответа API',
          summary: 'Время ответа выросло после релиза 4.2.',
          outcome: 'answered',
          stopReason: null,
          launch: { messageId: answered.messageId },
          established: [
            {
              text: 'p95 вырос с 180 до 420 мс',
              footnotes: [1, 2],
              verified: true,
            },
          ],
          assumed: [
            {
              text: 'Рост вызван новой политикой повторов',
              footnotes: [2],
              verified: false,
            },
          ],
          unknown: [
            {
              text: 'Затронуты ли мобильные клиенты',
              footnotes: [],
              verified: false,
            },
          ],
          sources: [
            {
              number: 1,
              sourceId: 'deploys',
              toolName: 'list_releases',
              snapshot: 'snap-b',
              truncated: false,
            },
            {
              number: 2,
              sourceId: 'logs',
              toolName: 'aggregate_logs',
              snapshot: 'snap-a',
              truncated: true,
            },
          ],
          sourceMode: 'sources',
        });
        expect(t.evidenceReads).toBe(2);
        // The card is completed with its answer link and no no-source mode; GET /messages returns the answer once.
        expect(await research(user, threadId)).toEqual([
          expect.objectContaining({
            launchKey: answered.launchKey,
            state: 'completed',
            answerMessageId: answerId,
            sourceMode: 'sources',
          }),
        ]);
        expect(
          (await messages(user, threadId)).filter(
            (message) => message.id === answerId,
          ),
        ).toHaveLength(1);

        // Act (AC-20.2, NFR-03): the same TaskSucceeded delivered again, then a second pass.
        const afterAnswer = await launchVersionsOf(user);
        await redeliver(answered.controllerTaskId);
        await t.runAppenderOnce();

        // Assert: nothing changed — the row, the one write, the message and its place.
        expect(await launchVersionsOf(user)).toEqual(afterAnswer);
        expect(t.memoryFaults.answerWrites).toBe(1);
        expect(await storedMessagesOf(threadId)).toEqual(stored);

        // Act (AC-20.4): one launch whose controller fails, one whose investigation is cancelled outside a stop.
        const failed = await launchResearch(
          user,
          threadId,
          'Почему падает экспорт',
        );
        const cancelled = await launchResearch(
          user,
          threadId,
          'Почему растёт очередь',
        );
        t.engine.fail(failed.investigationId);
        await runtime.investigations.cancel(cancelled.investigationId, user);
        await launchReaching(failed.launchKey, 'failed');
        await launchReaching(cancelled.launchKey, 'stopped');
        await t.runAppenderOnce();

        // Assert: failed and stopped, no answer for either, nothing written.
        expect(
          (await research(user, threadId)).map((view) => [
            view.launchKey,
            view.state,
            view.answerMessageId,
          ]),
        ).toEqual([
          [answered.launchKey, 'completed', answerId],
          [failed.launchKey, 'failed', null],
          [cancelled.launchKey, 'stopped', null],
        ]);
        const ids = await storedIdsOf(threadId);
        expect(ids).not.toContain(answerIdOf(failed.investigationId));
        expect(ids).not.toContain(answerIdOf(cancelled.investigationId));
        expect(t.memoryFaults.answerWrites).toBe(1);
        expect(t.chatModel.remaining()).toBe(0);
      },
      TURN_TIMEOUT_MS * 4,
    );

    it(
      'INT-2 D2: answers are appended in completion order, only after the running chat turn of the thread has ended, never between a user message and its reply, and a client copy of an answer does not overwrite the stored one',
      async () => {
        // Arrange: two launches of one thread; the one started second finishes first.
        const user = t.user();
        const threadId = await t.createThread(user);
        const first = await launchResearch(
          user,
          threadId,
          'Почему вырос отток',
        );
        const second = await launchResearch(
          user,
          threadId,
          'Почему упала конверсия',
        );
        t.engine.succeed(second.investigationId, {
          answer: () => assumedAnswer('Конверсия упала после смены цен'),
        });
        await launchReaching(second.launchKey, 'answer_pending');
        t.engine.succeed(first.investigationId, {
          answer: () => assumedAnswer('Отток вырос у новых клиентов'),
        });
        await launchReaching(first.launchKey, 'answer_pending');

        // Act (DC-3, UC-E3): a chat turn whose model call is held, so its run stays registered; a pass meanwhile.
        const gate = t.gate(threadId);
        t.chatModel.script(
          heldStep(gate.promise, textStep('Пока идёт ресерч, проверь цены.')),
        );
        const callsBefore = t.chatModel.calls.length;
        const question = userMessage('Что проверить, пока ждём?');
        const turn = chat(user, threadId, question);
        const runs = t.moduleRef.get(ThreadRunRegistry, { strict: false });
        await vi.waitFor(
          () => {
            expect(runs.hasRuns(threadId)).toBe(true);
            expect(t.chatModel.calls).toHaveLength(callsBefore + 1);
          },
          { timeout: TURN_TIMEOUT_MS, interval: 25 },
        );
        await t.runAppenderOnce();

        // Assert: nothing is written while the run is registered.
        expect(t.memoryFaults.answerWrites).toBe(0);
        expect((await launchOf(first.launchKey))?.state).toBe('answer_pending');
        expect((await launchOf(second.launchKey))?.state).toBe(
          'answer_pending',
        );

        // Act (UC-E7): the run ends; then a decision turn fails before its reply; then a pass.
        gate.release();
        await turn;
        t.chatModel.script(new Error('model unavailable'));
        const decision = userMessage(DECISION_LABELS.confirm, {
          [RESEARCH_METADATA_KEYS.researchDecision]: {
            action: 'confirm',
            launchKey: first.launchKey,
          },
        });
        await chat(user, threadId, decision);
        await t.runAppenderOnce();

        // Assert (AC-20.3, AC-20.6, DC-3): the answers follow the reply of the held turn and the failed decision
        // message, the second-finished one first, each with its own launch reference, in stored and createdAt order.
        const stored = await storedMessagesOf(threadId);
        const ids = stored.map((message) => message.id);
        const questionAt = ids.indexOf(question.id);
        expect(stored[questionAt + 1]).toMatchObject({
          role: 'assistant',
          text: 'Пока идёт ресерч, проверь цены.',
        });
        expect(ids.indexOf(decision.id)).toBeGreaterThan(questionAt + 1);
        // What Mastra kept of the failed decision turn's reply is marked, so the web hides it with the decision (KD-2).
        expect(stored[ids.indexOf(decision.id) + 1]).toMatchObject({
          role: 'assistant',
          metadata: {
            [RESEARCH_METADATA_KEYS.researchDecisionReply]: {
              launchKey: first.launchKey,
            },
          },
        });
        expect(ids.slice(-2)).toEqual([
          answerIdOf(second.investigationId),
          answerIdOf(first.investigationId),
        ]);
        const times = stored.map((message) => message.createdAt.getTime());
        expect(times).toEqual([...times].sort((a, b) => a - b));
        expect(
          stored
            .slice(-2)
            .map(
              (message) =>
                message.metadata?.[RESEARCH_METADATA_KEYS.researchAnswer],
            ),
        ).toEqual([
          expect.objectContaining({ launch: { messageId: second.messageId } }),
          expect.objectContaining({ launch: { messageId: first.messageId } }),
        ]);
        expect(await launchOf(first.launchKey)).toMatchObject({
          state: 'answered',
        });
        expect(await launchOf(second.launchKey)).toMatchObject({
          state: 'answered',
        });

        // Act (KD-5): the next request carries an edited client copy of the first answer.
        const original = stored.at(-1);
        t.chatModel.script(textStep('Дальше — сравнить с прошлым кварталом.'));
        const copyCallIndex = t.chatModel.calls.length;
        const res = await request(t.app.getHttpServer())
          .post('/api/chat/assistant')
          .set('x-user-id', user)
          .send({
            id: threadId,
            messages: [
              {
                id: answerIdOf(first.investigationId),
                role: 'assistant',
                parts: [
                  { type: 'text', text: 'Отредактированная копия ответа' },
                ],
              },
              userMessage('Что дальше?'),
            ],
          })
          .expect(200);
        expect(
          sseChunks(res.text).some((chunk) => chunk.type === 'error'),
        ).toBe(false);
        await vi.waitFor(
          () => {
            expect(runs.hasRuns(threadId)).toBe(false);
          },
          { timeout: TURN_TIMEOUT_MS, interval: 25 },
        );

        // Assert: the copy reached neither the model nor the store; the stored answer is unchanged.
        const prompt = JSON.stringify(
          t.chatModel.calls[copyCallIndex]?.messages,
        );
        expect(prompt).not.toContain('Отредактированная копия ответа');
        expect(prompt).toContain('Отток вырос у новых клиентов');
        const after = await storedMessagesOf(threadId);
        expect(after.filter((message) => message.id === original?.id)).toEqual([
          original,
        ]);
        expect(t.memoryFaults.answerWrites).toBe(2);
        expect(t.chatModel.remaining()).toBe(0);
      },
      TURN_TIMEOUT_MS * 4,
    );
    it(
      'INT-2 D3: a stop decision on a launch whose controller already finished leaves the launch stopped and appends no answer, while an already delivered answer is untouched',
      async () => {
        // Arrange: two finished launches of one user in two threads — `delivered` finished first, so a pass takes it
        // before `stoppable`.
        const user = t.user();
        const deliveredThread = await t.createThread(user);
        const stoppableThread = await t.createThread(user);
        const delivered = await launchResearch(
          user,
          deliveredThread,
          'Почему вырос средний чек',
        );
        const stoppable = await launchResearch(
          user,
          stoppableThread,
          'Почему растут жалобы на доставку',
        );
        t.engine.succeed(delivered.investigationId, {
          answer: () => assumedAnswer('Средний чек вырос после акции'),
        });
        await launchReaching(delivered.launchKey, 'answer_pending');
        t.engine.succeed(stoppable.investigationId, {
          answer: () => assumedAnswer('Жалобы растут из-за нового курьера'),
        });
        await launchReaching(stoppable.launchKey, 'answer_pending');

        // Act (Flow 4, race branch): a pass that already listed both rows `answer_pending` is held while it reads the
        // first answer, under the lock of the other thread; meanwhile the stop decision turn runs to its end.
        const hold = t.gate();
        const reached = latch();
        const readInvestigation = t.engine.readInvestigation.bind(t.engine);
        const reads = vi
          .spyOn(t.engine, 'readInvestigation')
          .mockImplementation(async (input) => {
            if (input.investigationId === delivered.investigationId) {
              reached.release();
              await hold.promise;
            }
            return readInvestigation(input);
          });
        let stop: Awaited<ReturnType<typeof decide>>;
        try {
          const pass = t.runAppenderOnce();
          await reached.promise;
          stop = await decide(user, stoppableThread, {
            action: 'stop',
            launchKey: stoppable.launchKey,
          });
          // The stop has won before the held pass reaches the row.
          expect(await launchOf(stoppable.launchKey)).toMatchObject({
            state: 'stopped',
          });
          hold.release();
          await pass;
        } finally {
          reads.mockRestore();
        }

        // Assert (AC-21.1): the stop cancelled the investigation once and the card says stopped; the pass that listed
        // the row before the stop wrote only the other thread's answer.
        expect(t.cancels.calls).toEqual([
          { investigationId: stoppable.investigationId, resourceId: user },
        ]);
        expect(stop.result).toEqual({
          launch: expect.objectContaining({
            launchKey: stoppable.launchKey,
            state: 'stopped',
          }),
        });
        expect(t.memoryFaults.answerWrites).toBe(1);
        expect(await storedIdsOf(stoppableThread)).not.toContain(
          answerIdOf(stoppable.investigationId),
        );
        expect(await launchOf(delivered.launchKey)).toMatchObject({
          state: 'answered',
        });

        // Act: a pass after the stop.
        await t.runAppenderOnce();

        // Assert: still no answer of the stopped launch; the card stays stopped with no answer link.
        expect(t.memoryFaults.answerWrites).toBe(1);
        expect(await storedIdsOf(stoppableThread)).not.toContain(
          answerIdOf(stoppable.investigationId),
        );
        expect(
          (await research(user, stoppableThread)).map((view) => [
            view.launchKey,
            view.state,
            view.answerMessageId,
          ]),
        ).toEqual([[stoppable.launchKey, 'stopped', null]]);

        // Act: a stop of the launch whose answer was already delivered.
        const deliveredAnswerId = answerIdOf(delivered.investigationId);
        const answerBefore = (await storedMessagesOf(deliveredThread)).find(
          (message) => message.id === deliveredAnswerId,
        );
        const rowBefore = await launchOf(delivered.launchKey);
        const late = await decide(user, deliveredThread, {
          action: 'stop',
          launchKey: delivered.launchKey,
        });
        await t.runAppenderOnce();

        // Assert: nothing changed — no cancel, the row, the completed card and the one stored answer are as they were.
        expect(t.cancels.calls).toHaveLength(1);
        expect(late.result).toEqual({
          launch: expect.objectContaining({
            launchKey: delivered.launchKey,
            state: 'completed',
            answerMessageId: deliveredAnswerId,
          }),
        });
        expect(await launchOf(delivered.launchKey)).toEqual(rowBefore);
        expect(answerBefore).toMatchObject({
          role: 'assistant',
          text: expect.stringContaining('Средний чек вырос после акции'),
        });
        expect(
          (await storedMessagesOf(deliveredThread)).filter(
            (message) => message.id === deliveredAnswerId,
          ),
        ).toEqual([answerBefore]);
        expect(t.memoryFaults.answerWrites).toBe(1);
        expect(t.chatModel.remaining()).toBe(0);
      },
      TURN_TIMEOUT_MS * 4,
    );
    it(
      'INT-2 D4: a write that keeps failing is retried with growing pauses and holds the later answers of its thread until RESEARCH_APPEND_GIVE_UP_MS, then the launch is failed and the queue moves on',
      async () => {
        // Arrange: two finished launches of one thread, the earlier-finished first; every answer write fails.
        const user = t.user();
        const threadId = await t.createThread(user);
        const earlier = await launchResearch(
          user,
          threadId,
          'Почему растут возвраты',
        );
        const later = await launchResearch(
          user,
          threadId,
          'Почему падают продажи',
        );
        t.engine.succeed(earlier.investigationId, {
          answer: () => assumedAnswer('Возвраты растут из-за брака'),
        });
        await launchReaching(earlier.launchKey, 'answer_pending');
        t.engine.succeed(later.investigationId, {
          answer: () => assumedAnswer('Продажи падают из-за сезона'),
        });
        await launchReaching(later.launchKey, 'answer_pending');
        t.memoryFaults.failAnswerWrites(new Error('memory unavailable'));
        // The process time stands still; only `clock.advance` moves the clock of the loop.
        vi.useFakeTimers({ toFake: ['Date'] });

        // Act: a pass, then a pass each time the pause has elapsed.
        const firstFailure = t.clock.now();
        const pauses: number[] = [];
        for (let attempt = 1; attempt <= 6; attempt += 1) {
          const at = t.clock.now();
          await t.runAppenderOnce();
          const row = required(await launchOf(earlier.launchKey), 'row');
          pauses.push(
            required(row.nextAppendAt, 'nextAppendAt').getTime() - at.getTime(),
          );
          // A pass before the pause has elapsed does not try again.
          await t.runAppenderOnce();
          t.clock.advance(pauses.at(-1) ?? 0);
        }

        // Assert (KD-4): pauses from RUNTIME_POLL_MS (50) doubling up to 16 times it; one write per try, all of the
        // earlier answer — the later one waits; the window counts from the first failure.
        expect(pauses).toEqual([50, 100, 200, 400, 800, 800]);
        expect(t.memoryFaults.answerWrites).toBe(6);
        expect(await launchOf(earlier.launchKey)).toMatchObject({
          state: 'answer_pending',
          appendFailedAt: firstFailure,
        });
        expect(await launchOf(later.launchKey)).toMatchObject({
          state: 'answer_pending',
          appendFailedAt: null,
        });

        // Act (DC-4): a try just before the give-up window ends.
        const giveUpAt = firstFailure.getTime() + 300_000;
        t.clock.advance(giveUpAt - 1 - t.clock.now().getTime());
        await t.runAppenderOnce();

        // Assert: not given up early, the later answer still waits.
        expect((await launchOf(earlier.launchKey))?.state).toBe(
          'answer_pending',
        );
        expect(t.memoryFaults.answerWrites).toBe(7);

        // Act: a pass at the end of the window, the pause of the last try not yet elapsed.
        t.clock.advance(1);
        await t.runAppenderOnce();

        // Assert (AC-20.6): the earlier launch is failed without another try, and the queue moved on to the later one.
        expect(await launchOf(earlier.launchKey)).toMatchObject({
          state: 'failed',
        });
        expect(await launchOf(later.launchKey)).toMatchObject({
          state: 'answer_pending',
          appendFailedAt: t.clock.now(),
        });
        expect(t.memoryFaults.answerWrites).toBe(8);

        // Act: the store heals; a pass after the later answer's pause.
        t.memoryFaults.failAnswerWrites(null);
        t.clock.advance(50);
        await t.runAppenderOnce();

        // Assert: the later answer is written, the failed one is not tried again; the cards say so.
        expect(t.memoryFaults.answerWrites).toBe(9);
        const ids = await storedIdsOf(threadId);
        expect(ids).toContain(answerIdOf(later.investigationId));
        expect(ids).not.toContain(answerIdOf(earlier.investigationId));
        expect(
          (await research(user, threadId)).map((view) => [
            view.launchKey,
            view.state,
            view.answerMessageId,
          ]),
        ).toEqual([
          [earlier.launchKey, 'failed', null],
          [later.launchKey, 'completed', answerIdOf(later.investigationId)],
        ]);
        expect(t.chatModel.remaining()).toBe(0);
      },
      TURN_TIMEOUT_MS * 4,
    );
    it(
      'INT-2 D5: the answer of an investigation without sources is stored with the mode, no footnotes or sources and no evidence read, its text opens with the warning and marks every claim so that the reload, the copy and the next chat turn keep the caveat',
      async () => {
        // Arrange: the engine runs without sources (the double's investigations take `model_knowledge`); the launch
        // answers with two assumed claims.
        t.engine.setSourceMode('model_knowledge');
        const user = t.user();
        const threadId = await t.createThread(user);
        const knowledge = await launchResearch(
          user,
          threadId,
          'Как снизить отток подписчиков',
        );
        t.engine.succeed(knowledge.investigationId, {
          answer: () => ({
            answerId: 'answer-d5',
            outcome: 'answered',
            stopReason: null,
            summary: null,
            established: [],
            assumed: [
              {
                claimId: 'c1',
                text: 'Отток снижают напоминания перед списанием',
                evidenceIds: [],
                verified: false,
              },
              {
                claimId: 'c2',
                text: 'Годовой тариф удерживает дольше месячного',
                evidenceIds: [],
                verified: false,
              },
            ],
            unknown: [],
            removed: [],
          }),
        });
        await launchReaching(knowledge.launchKey, 'answer_pending');

        // Act: one pass.
        await t.runAppenderOnce();

        // Assert (DC-9, AC-27.3): the text opens with MC-32 and marks each claim with MC-33 — no `[n]`, no
        // «не проверено», no source list; the metadata carries the mode with no footnotes or sources; no evidence read.
        const knowledgeId = answerIdOf(knowledge.investigationId);
        const knowledgeText = [
          'Источники данных не подключены — ответ опирается только на знания модели и не проверен по данным.',
          '',
          '**Ответ ресерча** · Есть ответ',
          'Цель: Как снизить отток подписчиков',
          '',
          '### Предположения',
          '- Отток снижают напоминания перед списанием (из знаний модели, без источника)',
          '- Годовой тариф удерживает дольше месячного (из знаний модели, без источника)',
        ].join('\n');
        const stored = await storedMessagesOf(threadId);
        expect(
          stored.slice(-1).map((message) => [message.id, message.text]),
        ).toEqual([[knowledgeId, knowledgeText]]);
        const answerMetadata = (id: string) =>
          stored.find((message) => message.id === id)?.metadata?.[
            RESEARCH_METADATA_KEYS.researchAnswer
          ];
        expect(answerMetadata(knowledgeId)).toEqual({
          launchKey: knowledge.launchKey,
          goal: 'Как снизить отток подписчиков',
          summary: null,
          outcome: 'answered',
          stopReason: null,
          launch: { messageId: knowledge.messageId },
          established: [],
          assumed: [
            {
              text: 'Отток снижают напоминания перед списанием',
              footnotes: [],
              verified: false,
            },
            {
              text: 'Годовой тариф удерживает дольше месячного',
              footnotes: [],
              verified: false,
            },
          ],
          unknown: [],
          sources: [],
          sourceMode: 'model_knowledge',
        });
        expect(t.evidenceReads).toBe(0);
        expect(
          (await research(user, threadId)).map((view) => [
            view.launchKey,
            view.state,
            view.answerMessageId,
            view.sourceMode,
          ]),
        ).toEqual([
          [knowledge.launchKey, 'completed', knowledgeId, 'model_knowledge'],
        ]);

        // Act + Assert (AC-27.3, reload): GET /messages returns the answer once with its text and mode.
        const history = await messages(user, threadId);
        expect(
          history
            .filter((message) => message.id.startsWith('research-answer-'))
            .map((message) => [
              message.id,
              message.parts,
              metadataValue(message, RESEARCH_METADATA_KEYS.researchAnswer),
            ]),
        ).toEqual([
          [
            knowledgeId,
            [expect.objectContaining({ type: 'text', text: knowledgeText })],
            answerMetadata(knowledgeId),
          ],
        ]);

        // Act (DC-9): the next plain chat turn of the thread.
        t.chatModel.script(textStep('Начните с напоминаний перед списанием.'));
        const nextCall = t.chatModel.calls.length;
        await chat(user, threadId, userMessage('С чего начать?'));

        // Assert: the model received the answer with the caveat — MC-32 and MC-33 after both claims, no footnotes.
        const prompt = JSON.stringify(t.chatModel.calls[nextCall]?.messages);
        expect(prompt).toContain(
          'Источники данных не подключены — ответ опирается только на знания модели и не проверен по данным.',
        );
        expect(prompt).toContain(
          '- Отток снижают напоминания перед списанием (из знаний модели, без источника)',
        );
        expect(prompt).toContain(
          '- Годовой тариф удерживает дольше месячного (из знаний модели, без источника)',
        );
        expect(prompt).not.toContain('[1]');
        expect(prompt).not.toContain('(не проверено)');
        expect(t.memoryFaults.answerWrites).toBe(1);
        expect(t.chatModel.remaining()).toBe(0);
      },
      TURN_TIMEOUT_MS * 4,
    );
  });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-3  Regenerate and delete: the tail drops its research with it, other research is re-appended once, and nothing is left behind
  // ---------------------------------------------------------------------------------------------------------------
  // Covers (original statements):
  // AC-22.1: "Given расследование беседы T идёт, When беседа T удалена, Then расследование остановлено и удалено (research-runtime/prd.md, FR-23), ответ не дописан, и беседа T не появилась снова."
  // AC-22.2: "Given перегенерирован ответ ассистента, который отвечает на сообщение-запуск расследования или сам им является, Then это расследование остановлено и его ответ не дописан; сразу за сообщением пользователя следует только перегенерированный ответ (chat-shell/prd.md, AC-14.6)."
  // AC-20.2 (the exception added by Design Doc KD-7): "...перегенерация удаляет сообщения после перегенерируемого ответа, среди них этот ответ, а его расследование перегенерация не останавливает. Тогда ответ дописывается заново после перегенерированного ответа и по-прежнему стоит в беседе ровно один раз."
  // DC-5 (FR-22): "Когда перегенерация удаляет хвост с ответом ресерча, чья карточка лежит вне хвоста, этот ответ дописывается снова после перегенерированного ответа, а его карточка остаётся «Завершён»."
  // DC-6 (FR-22, server half): GET /research of a thread answers the launches in `running` (the dialog counts them); the paragraph MC-22 itself is a component spec.
  // Use cases: UC-8 (server half), UC-9, UC-10 (server half), UC-11. Flow 5. KD-2 (tail and hidden pairs), KD-7, State Transitions (`discarded`, `answer_reappend`).
  //
  // Primary failure mode (turns red when): a regenerate leaves a card's investigation running or its answer alive; a hidden decision pair stays in the tail and sits between the user message and the new reply; the regenerate takes the decision
  // message for the last user message; the answer of another launch is deleted with the tail and never comes back, or comes back twice, or before the new reply; a failure of the tail selection still deletes the tail; a deleted thread leaves
  // `research_chat_launches` rows (proposals have no investigation to cascade from) or a later TaskSucceeded writes an answer into nothing.
  // Behavior: POST /api/chat repeating the last user message -> ChatController registers the run, `discardRepliesAfter` finds the last user message without `researchDecision` and the tail after it -> `beforeDelete` marks the launches of the tail
  //   `discarded` and cancels their investigations, marks the answers of launches whose card is outside the tail `answer_reappend` -> the tail is deleted whole -> the new reply streams -> after the run ends the loop writes the re-appended answers;
  //   DELETE /api/threads/:threadId -> runtime hook stops the investigations, `purge` hook deletes the launch rows
  // @category: core-functionality
  // @dependency: ChatController, ThreadsService.discardRepliesAfter (beforeDelete), ThreadsService.delete, ResearchLaunchService, ResearchChatModule purge hook, ResearchAnswerAppender, ThreadRunRegistry, runtime InvestigationService, Mastra Memory, research_chat_launches, Postgres
  // @complexity: high
  //
  // Verification items (table; thread contents are seeded through Memory.saveMessages, the way test/support/seed.ts does, with the part's metadata):
  // - T1 the tail takes its research with it (UC-9 first half, UC-10 server half, UC-11, AC-22.2): thread = user message U1, failed reply R1 carrying the card of launch X, then (a) a hidden decision pair from another tab and (b) in a second case X
  //   already `answered` with its answer message in the tail -> a repeated POST of U1 -> X is `discarded`, cancel called once, the whole tail including the pair and the answer is gone, the new reply directly follows U1; passes after the run
  //   never bring the answer back; GET /research no longer lists X
  // - T2 another launch's answer comes back once (UC-9 second half, AC-20.2 exception, DC-5): launch Y has its card above U1 and its answer after R1 in the tail -> regenerate marks Y `answer_reappend`; GET /research shows Y `completed` with
  //   `answerPending: true` and no `answerMessageId` target to a missing message; Y's investigation is not cancelled; while the new run is registered nothing is written; after it ends one pass writes `research-answer-<Y.investigationId>`
  //   after the new reply and Y is `answered`; a second pass changes nothing
  // - T3 failed selection or delete keeps the tail (Flow 5 failure bullets): `beforeDelete` made to throw (engine double cancel refuses) -> the request answers an error before streaming and the tail is intact; the delete made to fail after
  //   `beforeDelete` passed -> tail intact, rows already `discarded` / `answer_reappend`; a retry deletes the tail and the answers marked `answer_reappend` are rewritten in place if no retry comes (same message id, `createdAt` unchanged)
  // - T4 thread deletion (UC-8 server half, AC-22.1, DC-6 server half): thread with a `running` launch, a `proposed` launch (no investigation) and an `answered` one; GET /research counts one `running` -> DELETE /threads/:id -> the running
  //   investigation is cancelled and deleted by the runtime hook, all three launch rows are gone (the `purge` hook), a later TaskSucceeded of the deleted investigation writes nothing and GET /threads/:id answers 404, the thread does not reappear
  describe('INT-3', () => {
    it(
      'INT-3 T1: regenerating a reply whose tail holds a card, its hidden decision pair or its answer discards the launch, cancels its investigation, removes the whole tail and never brings the answer back',
      async () => {
        const user = t.user();

        // Arrange, row (a) (UC-9 first half, UC-10 server half): U1's reply proposes X, a second tab confirmed it, so the
        // hidden decision pair follows the reply and X runs.
        const decisionThread = await t.createThread(user);
        const proposal = deepResearchCallStep({
          goal: 'Почему вырос отток',
          tokenBudget: 500_000,
        });
        t.chatModel.script(
          proposal.step,
          textStep('Могу запустить глубокое исследование.'),
        );
        const question = userMessage('Разберись, почему вырос отток');
        await chat(user, decisionThread, question);
        await decide(user, decisionThread, {
          action: 'confirm',
          launchKey: proposal.toolCallId,
        });
        const confirmed = await launchReaching(proposal.toolCallId, 'running');
        const confirmedInvestigation = required(
          confirmed.investigationId,
          'investigationId',
        );
        expect(
          decisionPairs(await messages(user, decisionThread)),
        ).toHaveLength(1);

        // Act: a regenerate of U1; then a pass of the loop.
        t.chatModel.script(textStep('Отток вырос после смены тарифа.'));
        await chat(user, decisionThread, question);
        await t.runAppenderOnce();

        // Assert (AC-22.2, KD-2): the regenerate took U1, not the decision message, for the last user message; the
        // whole tail with the pair is gone and the new reply directly follows U1; X is discarded and its investigation
        // cancelled once; GET /research no longer lists X.
        expect(
          (await storedMessagesOf(decisionThread)).map((message) => [
            message.role,
            message.text,
          ]),
        ).toEqual([
          ['user', 'Разберись, почему вырос отток'],
          ['assistant', 'Отток вырос после смены тарифа.'],
        ]);
        expect((await storedIdsOf(decisionThread))[0]).toBe(question.id);
        expect(decisionPairs(await messages(user, decisionThread))).toEqual([]);
        expect((await launchOf(proposal.toolCallId))?.state).toBe('discarded');
        expect(await investigationStatus(user, confirmedInvestigation)).toBe(
          'cancelled',
        );
        expect(await cancellationsOf(confirmedInvestigation)).toBe(1);
        expect(await research(user, decisionThread)).toEqual([]);

        // Arrange, row (b) (UC-11): the reply of a mode message carries the card of X, X has finished and its answer
        // was written after that reply.
        const answerThread = await t.createThread(user);
        const goal = 'Почему упала выручка';
        const answered = await launchResearch(user, answerThread, goal);
        await answerLaunch(answered, 'Выручка упала из-за скидок');
        expect(await storedIdsOf(answerThread)).toContain(
          answerIdOf(answered.investigationId),
        );
        const cancelsBefore = t.cancels.calls.length;

        // Act: the regenerate resends the mode message; the new turn calls `deepResearch` again (a new launch Z); then
        // two passes of the loop.
        const relaunch = deepResearchCallStep({ goal, tokenBudget: 400_000 });
        t.chatModel.script(relaunch.step);
        await chat(user, answerThread, modeMessageOf(answered, goal));
        await launchReaching(relaunch.toolCallId, 'running');
        await t.runAppenderOnce();
        await t.runAppenderOnce();

        // Assert (AC-22.2, UC-11): X is discarded and its finished investigation got the cancel; the answer went with
        // the tail and the passes after the run do not bring it back; U1 is followed only by the new reply with Z's
        // card; GET /research lists Z only.
        expect((await launchOf(answered.launchKey))?.state).toBe('discarded');
        expect(t.cancels.calls.slice(cancelsBefore)).toEqual([
          { investigationId: answered.investigationId, resourceId: user },
        ]);
        expect(await cancellationsOf(answered.investigationId)).toBe(1);
        const stored = await storedMessagesOf(answerThread);
        expect(stored.map((message) => message.role)).toEqual([
          'user',
          'assistant',
        ]);
        expect(stored[0]?.id).toBe(answered.messageId);
        expect(JSON.stringify(stored[1]?.content)).toContain(
          relaunch.toolCallId,
        );
        expect(JSON.stringify(stored[1]?.content)).not.toContain(
          answered.launchKey,
        );
        expect(
          (await research(user, answerThread)).map((view) => view.launchKey),
        ).toEqual([relaunch.toolCallId]);
        expect(t.chatModel.remaining()).toBe(0);
      },
      TURN_TIMEOUT_MS * 4,
    );
    it(
      "INT-3 T2: regenerating while another launch's answer sits in the tail re-appends that answer exactly once after the new reply and keeps its launch completed",
      async () => {
        // Arrange (UC-9 second half): Y's card is above U1, U1 got a reply, then Y finished and its answer was written
        // after that reply, so it is in the tail of U1.
        const user = t.user();
        const threadId = await t.createThread(user);
        const other = await launchResearch(
          user,
          threadId,
          'Почему растут возвраты',
        );
        t.chatModel.script(textStep('Сначала проверь брак.'));
        const question = userMessage('Что проверить в первую очередь?');
        await chat(user, threadId, question);
        await answerLaunch(other, 'Возвраты растут из-за брака');
        const answerId = answerIdOf(other.investigationId);
        expect((await storedIdsOf(threadId)).at(-1)).toBe(answerId);

        // Act: the regenerate of U1, its model call held so the run stays registered; a pass meanwhile.
        const gate = t.gate(threadId);
        t.chatModel.script(
          heldStep(gate.promise, textStep('Проверь брак и логистику.')),
        );
        const callsBefore = t.chatModel.calls.length;
        const writesBefore = t.memoryFaults.answerWrites;
        const turn = chat(user, threadId, question);
        const runs = t.moduleRef.get(ThreadRunRegistry, { strict: false });
        await vi.waitFor(
          () => {
            expect(runs.hasRuns(threadId)).toBe(true);
            expect(t.chatModel.calls).toHaveLength(callsBefore + 1);
          },
          { timeout: TURN_TIMEOUT_MS, interval: 25 },
        );
        await t.runAppenderOnce();

        // Assert (DC-5, KD-4): Y waits to be re-appended and its card stays completed, without a link to the removed
        // answer; its investigation is not cancelled; nothing is written while the run is registered.
        expect((await launchOf(other.launchKey))?.state).toBe(
          'answer_reappend',
        );
        expect(await research(user, threadId)).toEqual([
          expect.objectContaining({
            launchKey: other.launchKey,
            state: 'completed',
            answerPending: true,
            answerMessageId: null,
          }),
        ]);
        expect(t.cancels.calls).toEqual([]);
        expect(await investigationStatus(user, other.investigationId)).toBe(
          'active',
        );
        expect(t.memoryFaults.answerWrites).toBe(writesBefore);
        expect(await storedIdsOf(threadId)).not.toContain(answerId);

        // Act: the run ends; a pass.
        gate.release();
        await turn;
        await t.runAppenderOnce();

        // Assert (AC-20.2 exception, DC-5): the answer comes back once, after the new reply, and the card links to it.
        const stored = await storedMessagesOf(threadId);
        const ids = stored.map((message) => message.id);
        expect(ids.filter((id) => id === answerId)).toHaveLength(1);
        const questionAt = ids.indexOf(question.id);
        expect(
          stored.slice(questionAt).map((message) => [message.id, message.text]),
        ).toEqual([
          [question.id, 'Что проверить в первую очередь?'],
          [expect.any(String), 'Проверь брак и логистику.'],
          [answerId, expect.stringContaining('Возвраты растут из-за брака')],
        ]);
        expect(await research(user, threadId)).toEqual([
          expect.objectContaining({
            launchKey: other.launchKey,
            state: 'completed',
            answerPending: false,
            answerMessageId: answerId,
          }),
        ]);

        // Act: a second pass.
        const versions = await launchVersionsOf(user);
        const writes = t.memoryFaults.answerWrites;
        await t.runAppenderOnce();

        // Assert: it changes nothing.
        expect(await launchVersionsOf(user)).toEqual(versions);
        expect(t.memoryFaults.answerWrites).toBe(writes);
        expect(await storedIdsOf(threadId)).toEqual(ids);
        expect(t.chatModel.remaining()).toBe(0);
      },
      TURN_TIMEOUT_MS * 4,
    );
    it(
      'INT-3 T3: a failure of the tail selection or of the delete leaves the tail in place, and a retry completes without a second effect',
      async () => {
        // Arrange (Flow 5): Y's card is above U1; U1 is a mode message whose reply carries the card of X; Y's answer
        // was written after that reply. The tail of U1 holds X's card and Y's answer.
        const user = t.user();
        const threadId = await t.createThread(user);
        const other = await launchResearch(
          user,
          threadId,
          'Почему растут возвраты',
        );
        const goal = 'Почему падают продажи';
        const current = await launchResearch(user, threadId, goal);
        await answerLaunch(other, 'Возвраты растут из-за брака');
        const answerId = answerIdOf(other.investigationId);
        const question = modeMessageOf(current, goal);
        const full = await storedIdsOf(threadId);
        expect(full.slice(-3)).toEqual([
          current.messageId,
          expect.any(String),
          answerId,
        ]);

        // Act: the selection fails (the runtime refuses the cancel).
        t.cancels.refuse(new Error('runtime unavailable'));
        await refusedRegenerate(user, threadId, question);

        // Assert: the request answered an error before streaming, the tail is intact and X still runs.
        expect(await storedIdsOf(threadId)).toEqual(full);
        expect(await investigationStatus(user, current.investigationId)).toBe(
          'active',
        );

        // Act: the cancel goes through, but the delete after the selection fails.
        t.cancels.refuse(null);
        t.memoryFaults.failNextDelete(new Error('delete failed'));
        await refusedRegenerate(user, threadId, question);

        // Assert: the tail is intact, the rows are already selected and X's investigation is cancelled.
        expect(await storedIdsOf(threadId)).toEqual(full);
        expect((await launchOf(current.launchKey))?.state).toBe('discarded');
        expect((await launchOf(other.launchKey))?.state).toBe(
          'answer_reappend',
        );
        expect(await investigationStatus(user, current.investigationId)).toBe(
          'cancelled',
        );

        // Act: no retry comes; a pass.
        const before = required(
          (await storedMessagesOf(threadId)).find(
            (message) => message.id === answerId,
          ),
          'stored answer',
        );
        const writes = t.memoryFaults.answerWrites;
        await t.runAppenderOnce();

        // Assert (KD-4): the answer is rewritten in place - same id, same position, `createdAt` unchanged.
        expect(t.memoryFaults.answerWrites).toBe(writes + 1);
        expect((await launchOf(other.launchKey))?.state).toBe('answered');
        expect(await storedIdsOf(threadId)).toEqual(full);
        const rewritten = (await storedMessagesOf(threadId)).find(
          (message) => message.id === answerId,
        );
        expect(rewritten?.createdAt).toEqual(before.createdAt);

        // Act: the regenerate is retried; the mode turn calls `deepResearch` again (a new launch Z); then a pass.
        const relaunch = deepResearchCallStep({ goal, tokenBudget: 400_000 });
        t.chatModel.script(relaunch.step);
        await chat(user, threadId, question);
        await launchReaching(relaunch.toolCallId, 'running');
        await t.runAppenderOnce();

        // Assert: the retry deleted the tail and finished without a second effect - X cancelled once in the runtime,
        // Y's answer once, after the new reply; GET /research lists Y and Z, not X.
        const ids = await storedIdsOf(threadId);
        const questionAt = ids.indexOf(current.messageId);
        expect(ids.slice(0, questionAt)).toEqual(full.slice(0, questionAt));
        expect(ids.slice(questionAt)).toEqual([
          current.messageId,
          expect.any(String),
          answerId,
        ]);
        expect(ids.filter((id) => id === answerId)).toHaveLength(1);
        expect(await cancellationsOf(current.investigationId)).toBe(1);
        expect((await launchOf(current.launchKey))?.state).toBe('discarded');
        expect(
          (await research(user, threadId)).map((view) => [
            view.launchKey,
            view.state,
          ]),
        ).toEqual([
          [other.launchKey, 'completed'],
          [relaunch.toolCallId, 'running'],
        ]);
        expect(t.chatModel.remaining()).toBe(0);
      },
      TURN_TIMEOUT_MS * 4,
    );
    it(
      'INT-3 T4: deleting a thread with running, proposed and answered launches stops the investigation, removes every launch row, and no later event writes an answer',
      async () => {
        // Arrange (UC-8 server half): an answered launch, a running one whose controller attempt is held, and an open
        // proposal without an investigation, all in one thread.
        const user = t.user();
        const threadId = await t.createThread(user);
        const answered = await launchResearch(
          user,
          threadId,
          'Почему выросла задержка',
        );
        await answerLaunch(answered, 'Задержка выросла из-за кэша');
        const running = await launchResearch(
          user,
          threadId,
          'Почему падает конверсия',
        );
        await t.engine.controllerRunning(running.investigationId);
        const proposalKey = await propose(user, threadId, {
          goal: 'Почему растут жалобы',
          tokenBudget: 500_000,
        });
        expect((await launchOf(proposalKey))?.investigationId).toBeNull();

        // Assert (DC-6 server half): the delete dialog's read counts one running launch.
        expect(
          (await research(user, threadId)).map((view) => [
            view.launchKey,
            view.state,
          ]),
        ).toEqual([
          [answered.launchKey, 'completed'],
          [running.launchKey, 'running'],
          [proposalKey, 'proposed'],
        ]);

        // Act: the thread is deleted.
        await request(t.app.getHttpServer())
          .delete(`/api/threads/${threadId}`)
          .set('x-user-id', user)
          .expect(204);

        // Assert (AC-22.1, KD-7): the runtime hook removed the thread's investigations, the `purge` hook every launch
        // row - the proposal without an investigation included - and the thread is gone.
        expect(
          (await investigationsOf(user)).filter(
            (investigation) => investigation.threadId === threadId,
          ),
        ).toEqual([]);
        expect(await launchesOf(user, threadId)).toEqual([]);
        await threadGone(user, threadId);

        // Act (Flow 3, Failure handling; regression guard): the deleted investigation's controller succeeds late, a
        // `TaskSucceeded` read before the purge reaches the part's consumer, then a pass of the loop. This block does not
        // prove the `purge` hook - the FK cascade from `research_investigations` already removed the running and answered
        // rows, and the hook is proven above by the proposal row in `launchesOf(...) == []`. It guards that nothing is
        // resurrected after the delete: a weakened FK, a consumer that upserts a missing row, or a loop that writes for
        // a missing row.
        const writes = t.memoryFaults.answerWrites;
        t.engine.succeed(running.investigationId, {
          answer: () => assumedAnswer('Конверсия падает из-за формы оплаты'),
        });
        await deliverLateSuccess(running);
        await t.runAppenderOnce();

        // Assert: no row came back, no answer was written, and the thread did not reappear.
        expect(await launchesOf(user, threadId)).toEqual([]);
        expect(t.memoryFaults.answerWrites).toBe(writes);
        expect(await storedMessagesOf(threadId)).toEqual([]);
        await threadGone(user, threadId);
        expect(t.chatModel.remaining()).toBe(0);
      },
      TURN_TIMEOUT_MS * 4,
    );
  });
});

// INT-1 A6 (verification items under INT-1 above): the app composed with no source adapter and the engine double in the
// mode `model_knowledge`. A describe of its own, after the first one's app is closed, so the two runtimes never run at
// once against one database (plan rule 2).
describe('deep-research / chat-entry - integration without source adapters (in-process Nest + real runtime + real Postgres, scripted chat model)', () => {
  beforeAll(async () => {
    t = await createResearchChatApp({
      env: { REASONING_EFFORT },
      sourceMode: 'model_knowledge',
      withoutSourceAdapters: true,
    });
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

  describe('INT-1', () => {
    it(
      "INT-1 A6: without sources the chat still proposes and launches research with no source check by the part, each launch view carries the mode (current engine mode until the investigation exists, the investigation's own mode after), a restart with a source changes proposals but not a running launch, and with a source no view carries the no-source mode",
      async () => {
        const user = t.user();

        // Act: proposals without sources — one closed by the next message, one declined, one left open.
        const proposals = await t.createThread(user);
        const superseded = await propose(user, proposals, {
          goal: 'Оценить риски миграции',
          tokenBudget: 200_000,
        });
        const noSourceTurn = t.chatModel.calls[0];
        const declined = await propose(user, proposals, {
          goal: 'Сравнить тарифы поставщиков',
          tokenBudget: 200_000,
        });
        await decide(user, proposals, {
          action: 'decline',
          launchKey: declined,
        });
        const open = await propose(user, proposals, {
          goal: 'Найти причины оттока',
          tokenBudget: 200_000,
        });

        // Assert (AC-26.1 chat share, AC-27.1): the chat took the message and offered the tool with the production
        // instruction; the same tool and instruction as with sources are compared below.
        expect(noSourceTurn?.tools).toEqual([DEEP_RESEARCH_TOOL]);
        expect(noSourceTurn?.system).toContain(ASSISTANT_INSTRUCTIONS);

        // Act: mode launches without sources — started, refused, and held at the start.
        const launches = await t.createThread(user);
        const running = deepResearchCallStep({
          goal: 'Почему растут возвраты',
          tokenBudget: 300_000,
        });
        t.chatModel.script(running.step);
        const runningTurn = await chat(
          user,
          launches,
          userMessage('Разберись, почему растут возвраты', {
            [RESEARCH_METADATA_KEYS.deepResearch]: true,
          }),
        );
        const failed = deepResearchCallStep({
          goal: 'Проверить отчёт по складу',
        });
        t.engine.refuseStarts(new Error('engine unavailable'));
        t.chatModel.script(failed.step);
        await chat(
          user,
          launches,
          userMessage('Проверь отчёт по складу', {
            [RESEARCH_METADATA_KEYS.deepResearch]: true,
          }),
        );
        t.engine.refuseStarts(null);
        const held = t.engine.holdStarts();
        const launching = deepResearchCallStep({
          goal: 'Сверить остатки',
          tokenBudget: 300_000,
        });
        t.chatModel.script(launching.step);
        const launchingTurn = chat(
          user,
          launches,
          userMessage('Сверь остатки', {
            [RESEARCH_METADATA_KEYS.deepResearch]: true,
          }),
        );
        await vi.waitFor(
          async () => {
            expect(await launchOf(launching.toolCallId)).toMatchObject({
              state: 'launching',
            });
          },
          { timeout: TURN_TIMEOUT_MS, interval: 25 },
        );

        // Assert (AC-27.2, DC-8): the first view of the mode turn already has the mode, the row stores the
        // investigation's mode, and rows without an investigation show the engine's current mode.
        expect(toolResult(runningTurn)).toEqual({
          launch: expect.objectContaining({
            launchKey: running.toolCallId,
            state: 'running',
            sourceMode: 'model_knowledge',
          }),
        });
        expect(await launchOf(running.toolCallId)).toMatchObject({
          state: 'running',
          sourceMode: 'model_knowledge',
        });
        expect(await research(user, proposals)).toEqual([
          expect.objectContaining({
            launchKey: superseded,
            notLaunchedReason: 'superseded',
            sourceMode: 'model_knowledge',
          }),
          expect.objectContaining({
            launchKey: declined,
            notLaunchedReason: 'declined',
            sourceMode: 'model_knowledge',
          }),
          expect.objectContaining({
            launchKey: open,
            state: 'proposed',
            sourceMode: 'model_knowledge',
          }),
        ]);
        expect(await research(user, launches)).toEqual([
          expect.objectContaining({
            launchKey: running.toolCallId,
            state: 'running',
            sourceMode: 'model_knowledge',
          }),
          expect.objectContaining({
            launchKey: failed.toolCallId,
            state: 'failed',
            sourceMode: 'model_knowledge',
          }),
          expect.objectContaining({
            launchKey: launching.toolCallId,
            state: 'running',
            sourceMode: 'model_knowledge',
          }),
        ]);
        expect(await launchOf(launching.toolCallId)).toMatchObject({
          state: 'launching',
          sourceMode: null,
        });
        held.release();
        await launchingTurn;
        expect(await launchOf(launching.toolCallId)).toMatchObject({
          state: 'running',
          sourceMode: 'model_knowledge',
        });

        // Act: the restart with a source.
        t.engine.setSourceMode('sources');

        // Assert (DC-8): rows without an investigation follow the new mode, started ones keep their investigation's.
        expect(
          (await research(user, proposals)).map((view) => view.sourceMode),
        ).toEqual(['sources', 'sources', 'sources']);
        expect(
          (await research(user, launches)).map((view) => [
            view.launchKey,
            view.sourceMode,
          ]),
        ).toEqual([
          [running.toolCallId, 'model_knowledge'],
          [failed.toolCallId, 'sources'],
          [launching.toolCallId, 'model_knowledge'],
        ]);

        // Act + Assert: a confirm of the open proposal starts an investigation viewed and stored as `sources`.
        const confirmed = await decide(user, proposals, {
          action: 'confirm',
          launchKey: open,
        });
        expect(confirmed.result).toEqual({
          launch: expect.objectContaining({
            launchKey: open,
            state: 'running',
            sourceMode: 'sources',
          }),
        });
        expect(await launchOf(open)).toMatchObject({
          state: 'running',
          sourceMode: 'sources',
        });

        // Act: with a source from the start — a proposal, then a mode launch.
        const withSources = await t.createThread(user);
        const callsBefore = t.chatModel.calls.length;
        const proposal = await propose(user, withSources, {
          goal: 'Сравнить выручку по кварталам',
          tokenBudget: 200_000,
        });
        const sourcesTurn = t.chatModel.calls[callsBefore];
        const explicit = deepResearchCallStep({
          goal: 'Почему упала выручка',
          tokenBudget: 300_000,
        });
        t.chatModel.script(explicit.step);
        const explicitTurn = await chat(
          user,
          withSources,
          userMessage('Разберись, почему упала выручка', {
            [RESEARCH_METADATA_KEYS.deepResearch]: true,
          }),
        );

        // Assert (AC-27.1, AC-27.4): the same tool and instruction as without sources, and no view has the no-source
        // mode.
        expect(sourcesTurn?.tools).toEqual(noSourceTurn?.tools);
        expect(sourcesTurn?.system).toBe(noSourceTurn?.system);
        expect(toolResult(explicitTurn)).toEqual({
          launch: expect.objectContaining({
            launchKey: explicit.toolCallId,
            sourceMode: 'sources',
          }),
        });
        expect(
          (await research(user, withSources)).map((view) => [
            view.launchKey,
            view.sourceMode,
          ]),
        ).toEqual([
          [proposal, 'sources'],
          [explicit.toolCallId, 'sources'],
        ]);

        // Act: the launch with a source completes and its answer is delivered. The controllers held so far fail first:
        // they occupy the runtime's slots (RUNTIME_CONCURRENCY 2), and this controller would never run.
        for (const launchKey of [
          running.toolCallId,
          launching.toolCallId,
          open,
        ]) {
          const heldRow = await launchOf(launchKey);
          t.engine.fail(required(heldRow?.investigationId, 'investigationId'));
          await launchReaching(launchKey, 'failed');
        }
        const explicitRow = await launchReaching(
          explicit.toolCallId,
          'running',
        );
        t.engine.succeed(
          required(explicitRow.investigationId, 'investigationId'),
          {
            answer: () => assumedAnswer('Выручка упала из-за сезона'),
          },
        );
        await launchReaching(explicit.toolCallId, 'answer_pending');
        await t.runAppenderOnce();

        // Assert (AC-27.4): the completed launch has the mode `sources` too.
        expect(
          (await research(user, withSources)).map((view) => [
            view.launchKey,
            view.state,
            view.sourceMode,
          ]),
        ).toEqual([
          [proposal, 'not_launched', 'sources'],
          [explicit.toolCallId, 'completed', 'sources'],
        ]);
        expect(await investigationsOf(user)).toHaveLength(4);
        expect(t.chatModel.remaining()).toBe(0);
      },
      TURN_TIMEOUT_MS * 4,
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Proven at unit level (named for the plan; generated as specs next to the code, not here). One table-driven spec per rule, cases as rows; fast-check where noted.
// ---------------------------------------------------------------------------------------------------------------
// - Launch state machine of ResearchLaunchService (table over State Transitions): for every state x action (confirm, decline, stop, supersede, discard, TaskSucceeded, TaskFailed, TaskCancelled, write window expired) the next state or "no change",
//   and the ResearchLaunchView mapping (`launching` and `answer_pending` shown as `running`, `answered` and `answer_reappend` as `completed`, `declined` and `superseded` as `not_launched` with the reason, `answerPending` only for `answer_reappend`).
//   The `sourceMode` of the view (rows of the same table): a row with an investigation shows the mode copied from its `InvestigationView` at reconciliation whatever `Engine.sourceMode` is now; a row without one (`proposed`, `not_launched`, `failed` at start,
//   `launching`) shows the current `Engine.sourceMode`; reconciliation copies the mode once and never overwrites it. DC-8 (rule), KD-8.
//   AC-19.7 (rule), DC-1 (rule), DC-2 (rule), Invariants 1 and 2. The integration rows prove only that the real tool and the real lock reach this machine once.
// - `discardRepliesAfter` (extends threads.service.spec.ts): last user message is the last one without `researchDecision`, the tail may hold hidden pairs and answers, `repeated` is true only when the request's last message equals the stored one,
//   `beforeDelete` sees the tail before the delete and its exception cancels it. AC-22.2 (rule), KD-7.
// - `ThreadRunRegistry.hasRuns` (extends thread-run-registry.spec.ts).
// - Answer message builder (table + fast-check property): footnote numbers follow the first appearance of a source and are stable for the same input; the Markdown text and the `researchAnswer` metadata agree on the numbers; the section `removed`
//   never appears; outcome and stop reason pass through. AC-20.7 (server share).
//   Rows added for the mode `model_knowledge` (UC-12, UC-E8): the text starts with MC-32 and carries MC-33 after every claim (and after none when there are no claims), no `[n]` and no source section; `established` is empty and no claim has a footnote number;
//   the Markdown text and the metadata agree on the claims; in the mode `sources` neither MC-32 nor MC-33 appears. AC-27.3 (server share), DC-9 (rule).
// - Message-metadata schemas of `@agent-os/contracts` (`deepResearch`, `researchDecision`, `researchDecisionReply`, `researchAnswer`, `ResearchLaunchView`, `ThreadResearchResponse`): the part's own rules only (an unknown action is refused, `answerMessageId`
//   only with `completed`, a `researchAnswer` with `sourceMode` `model_knowledge` has an empty `established`, no footnote numbers and no source entries), not that zod parses.
// - Deterministic id and retry pause: `research-answer-<investigationId>`; pause doubling from `RUNTIME_POLL_MS` capped at 16x (fast-check property).
// - Settings parsing of `RESEARCH_APPEND_GIVE_UP_MS` and `RESEARCH_LAUNCH_RECOVERY_MS` (extends runtime-settings.spec.ts): defaults 300000 and 60000, invalid values refused.
