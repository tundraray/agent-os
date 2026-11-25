// create-and-test / test-run and trainer-dialog - API integration (real AppModule + real Postgres + MCP fixture process, workers on,
//   scripted model)
// Design Docs: docs/features/create-and-test/design-test-run.md (TR-1 – TR-5: the write barrier, rights, one fix, the main path, the
//   cap) and design-trainer-dialog.md, Test Strategy UC-1 – UC-7 (UC-2 is folded into TR-1).
//
// Harness: one `createTestApp({ workers: true, mcpServers: ['backoffice'] })`, booted again over the same database and the same
//   scripted model for the restart (the last case). Every run starts through a plan: `library_overview` → `propose_plan` → the
//   employee's message → `create_agent`. The trainer is scripted by the employee's description; a forked run without one by a marker of
//   its inherited history (`forkedTrainer`). Each test run is scripted by its test task, answering by the prompt of its version; the
//   judge — the trainer's name, told apart by its one tool `verdict` — passes an answer that carries `PASS` and fails on a provider error
//   when it carries `JUDGE_ERROR`. The fixture's call log is the proof that a changing call never left.
//
// Not repeated here: the hand-over rules (unit `test-run-step.spec.ts`), the judge's mapping of a model error (unit `judge.spec.ts`),
//   `canTrain` rows (unit `training-rules.spec.ts`), the training's own write barrier and cap (self-learning-training), the fork's copy
//   and its refusals (create-and-test-fork).

import { randomUUID } from 'node:crypto';
import {
  createLatch,
  modelError,
  type RecordedModelCall,
  type ScriptedAnswer,
  type ScriptedReply,
  type ScriptedToolCall,
} from '@agent-os/agents/testing';
import {
  AgentTasksViewSchema,
  SelfLearningSettingsSchema,
  TestRunRunningErrorSchema,
  TestRunStartedSchema,
  TestRunTakenSchema,
  TestRunViewSchema,
  TrainingActivatedSchema,
  TrainingStartedSchema,
  TrainingStateSchema,
  type ConversationView,
  type DeepAgentContent,
  type HistoryEntry,
  type TestRunView,
} from '@agent-os/contracts';
import { waitFor } from '@agent-os/db/testing';
import { readFixtureLog } from '@agent-os/mcp-fixture';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  allowRole,
  auditOf,
  HAIKU_TEST_PRICES,
  removeRunRows,
  runModel,
  type RunRole,
  spendOf,
  useRunModels,
} from './support/access';
import { chatApi, expectBody, expectError } from './support/api';
import { createTestApp, type TestApp } from './support/createTestApp';
import {
  createRecord,
  deepAgentBody,
  getRecord,
  listLibrary,
  pointBuiltinsAt,
  putRecord,
  recordName,
  shareWith,
} from './support/library';
import { BACKOFFICE_SERVER, LOGS_SERVER } from './support/mcp-servers';
import {
  briefTask,
  startDeepAgentInChat,
  untilAgentStatus,
} from './support/record-tools';
import {
  apiRequest,
  createEmployee,
  seedSuperAdmin,
  type Session,
} from './support/session';

const TEST_TIMEOUT_MS = 300_000;
const MODEL = runModel('haiku-test-run');
const TITLE = 'Прогон';

const CREATE_NOTE = `mcp__${BACKOFFICE_SERVER}__create_incident_note`;
const GET_ORDER = `mcp__${BACKOFFICE_SERVER}__get_order`;
const NOTE_ARGS = { orderId: 'ord-0000a001', text: 'from a test run' };

/** Markers of a run's answer the judge reads; no description or test text carries them. */
const PASS = 'ANSWER-PASS';
const FAIL = 'ANSWER-FAIL';
const JUDGE_ERROR = 'ANSWER-JUDGE-ERROR';

/** The employee's answer to a plan, as the card's button sends it. */
const CONFIRM = 'Создать и проверить';
const PLAN_READY = 'План готов.';
const AGENT_DESCRIPTION = 'Разбирает заказы по описанию сотрудника.';

/** 120 000 output tokens: 0,06 USD at the test prices. */
const COSTLY = { inputTokens: 10, outputTokens: 120_000 };
/** 220 000 output tokens: 0,11 USD, past a cap of 0,1 USD. */
const PAST_CAP = { inputTokens: 10, outputTokens: 220_000 };

/** The prompts of a created agent: its version 1 and the trainer's fix. */
interface Prompts {
  readonly base: string;
  readonly proposed: string;
}

function promptsOf(tag: string): Prompts {
  const unique = `${tag} ${randomUUID().slice(0, 8)}`;
  return { base: `BASE ${unique}`, proposed: `PROPOSED ${unique}` };
}

function call(
  tool: string,
  args: Record<string, unknown> = {},
): ScriptedToolCall {
  return { tool, args };
}

function planCall(
  name: string,
  tasks: readonly string[],
  servers: readonly string[] = [BACKOFFICE_SERVER],
): ScriptedToolCall {
  return call('propose_plan', {
    name,
    description: AGENT_DESCRIPTION,
    servers,
    tests: tasks.map((task) => ({ task, expected: `Ответ на «${task}»` })),
  });
}

/** `create_agent` of a deep agent with one subagent, both on `servers`. */
function createAgentCall(
  name: string,
  prompts: Prompts,
  servers: readonly string[] = [BACKOFFICE_SERVER],
): ScriptedToolCall {
  return call('create_agent', {
    name,
    description: AGENT_DESCRIPTION,
    prompt: prompts.base,
    servers,
    subagents: [
      {
        name: 'reader',
        description: 'Читает заказ',
        prompt: 'Прочитай заказ и перескажи его.',
        servers,
      },
    ],
  });
}

function proposeCall(prompts: Prompts): ScriptedToolCall {
  return call('propose_version', {
    prompt: prompts.proposed,
    scripts: [],
    changes: 'Промпт точнее.',
  });
}

/** The dialog up to the plan: the library, the plan of `tasks`, a short answer; the employee's reply goes next. */
function dialog(name: string, tasks: readonly string[]): ScriptedAnswer[] {
  return [
    { calls: [call('library_overview')] },
    { calls: [planCall(name, tasks)] },
    { text: PLAN_READY },
  ];
}

/**
 * The runs of one test: on a version with the proposed prompt `proposed`, on version 1 `calls` first (when given) and then
 * `base`. The report document is the double's.
 */
function scriptTest(
  task: string,
  prompts: Prompts,
  answers: {
    readonly base: ScriptedAnswer | ReturnType<typeof modelError>;
    readonly proposed?: ScriptedAnswer;
    readonly calls?: ScriptedAnswer['calls'];
  },
  first: readonly ScriptedReply[] = [],
) {
  const reply: ScriptedReply = (messages, recorded) => {
    if (recorded.instructions.includes(prompts.proposed))
      return answers.proposed ?? { text: PASS };
    return answers.calls !== undefined && messages.at(-1)?.role === 'user'
      ? { calls: answers.calls }
      : answers.base;
  };
  return harness.model.script({ task: briefTask(task) }, first, {
    thereafter: reply,
  });
}

function judgeText(recorded: RecordedModelCall): string {
  const [message] = recorded.messages;
  return message?.role === 'user' ? message.content : '';
}

function judgeAnswer(
  recorded: RecordedModelCall,
): ScriptedAnswer | ReturnType<typeof modelError> {
  const text = judgeText(recorded);
  if (text.includes(JUDGE_ERROR)) return modelError();
  const passed = text.includes(PASS);
  return {
    calls: [
      call('verdict', {
        passed,
        reason: passed
          ? 'The answer gives the result.'
          : 'The answer misses the result.',
      }),
    ],
  };
}

/** A forked test run's trainer without a description: no message of its own is a script's task, its history carries `marker`. */
interface ForkedTrainer {
  readonly marker: string;
  readonly replies: readonly ScriptedAnswer[];
  readonly calls: RecordedModelCall[];
}
const forkedTrainers: ForkedTrainer[] = [];

function forkedTrainer(
  marker: string,
  replies: readonly ScriptedAnswer[],
): ForkedTrainer {
  const trainer = { marker, replies, calls: [] };
  forkedTrainers.push(trainer);
  return trainer;
}

/** The trainer's name answers the judge and the forked trainers. */
const trainerNameReply: ScriptedReply = (_messages, recorded) => {
  if (recorded.toolNames.includes('verdict')) return judgeAnswer(recorded);
  const trainer = forkedTrainers.find((one) =>
    JSON.stringify(recorded.messages).includes(one.marker),
  );
  if (trainer === undefined)
    throw new Error(`No script answers a call of ${recorded.agentName}`);
  trainer.calls.push(recorded);
  const reply = trainer.replies[trainer.calls.length - 1];
  if (reply === undefined)
    throw new Error(`The forked trainer ${trainer.marker} has no more answers`);
  return reply;
};

function toolResults(
  entries: readonly HistoryEntry[],
  tool: string,
): Extract<HistoryEntry, { kind: 'tool_result' }>['content'][] {
  return entries.flatMap((entry) =>
    entry.kind === 'tool_result' && entry.content.tool === tool
      ? [entry.content]
      : [],
  );
}

function texts(view: ConversationView): string[] {
  return view.entries.flatMap((entry) =>
    entry.kind === 'task' ||
    entry.kind === 'user_message' ||
    entry.kind === 'model_answer'
      ? [entry.content.text]
      : [],
  );
}

let harness: TestApp;
let admin: Session;
/** Employees who may train their own agents and use the back office. */
let ownTrainers: RunRole;
/** Holders of the right to train any agent in the panel. */
let anyTrainers: RunRole;
/** Employees with no training right. */
let plain: RunRole;
let judges: { readonly calls: readonly RecordedModelCall[] }[] = [];
let restoreModels: (() => Promise<void>) | undefined;
let restoreBuiltins: (() => Promise<void>) | undefined;
const made = { users: [] as string[], roles: [] as string[] };

async function employee(role: RunRole): Promise<Session> {
  const session = await createEmployee(harness.app, admin);
  made.users.push(session.id);
  await role.add(session);
  return session;
}

async function runRole(
  name: string,
  rights: { trainOwn?: boolean; trainAny?: boolean },
): Promise<RunRole> {
  const role = await allowRole(harness.app, admin, {
    name,
    models: [MODEL],
    servers: [BACKOFFICE_SERVER],
  });
  made.roles.push(role.id);
  if (Object.keys(rights).length > 0) await setRights(role, rights);
  return role;
}

function setRights(
  role: RunRole,
  rights: { trainOwn?: boolean; trainAny?: boolean },
) {
  return apiRequest(
    harness.app,
    admin,
    'patch',
    `/admin/roles/${role.id}`,
    rights,
  ).expect(200);
}

function startTestRun(
  session: Session,
  description: string,
  originThreadId?: string,
) {
  return apiRequest(harness.app, session, 'post', '/test-runs', {
    description,
    ...(originThreadId === undefined ? {} : { originThreadId }),
  });
}

async function started(
  session: Session,
  description: string,
  originThreadId?: string,
): Promise<string> {
  return (
    await expectBody(
      startTestRun(session, description, originThreadId),
      201,
      TestRunStartedSchema,
    )
  ).testRunId;
}

/** Starts a test run with the cap of the settings set to `capUsd` for the start only. */
async function startedUnderCap(
  session: Session,
  description: string,
  capUsd: number,
): Promise<string> {
  const settingsPath = '/admin/self-learning/settings';
  const settings = await expectBody(
    apiRequest(harness.app, admin, 'get', settingsPath),
    200,
    SelfLearningSettingsSchema,
  );
  const putCap = (trainingCapUsd: number) =>
    expectBody(
      apiRequest(harness.app, admin, 'put', settingsPath, {
        memoryIndexTokens: settings.memoryIndexTokens,
        trainingCapUsd,
      }),
      200,
      SelfLearningSettingsSchema,
    );
  await putCap(capUsd);
  try {
    return await started(session, description);
  } finally {
    await putCap(settings.trainingCapUsd);
  }
}

function testRunView(
  session: Session,
  testRunId: string,
): Promise<TestRunView> {
  return expectBody(
    apiRequest(harness.app, session, 'get', `/test-runs/${testRunId}`),
    200,
    TestRunViewSchema,
  );
}

function untilTestRun(
  session: Session,
  testRunId: string,
  until: (view: TestRunView) => boolean,
  what: string,
): Promise<TestRunView> {
  return waitFor(
    () => testRunView(session, testRunId),
    until,
    `test run ${testRunId}: ${what}`,
    90_000,
  );
}

function untilStatus(
  session: Session,
  testRunId: string,
  status: TestRunView['status'],
) {
  return untilTestRun(
    session,
    testRunId,
    (view) => view.status === status,
    status,
  );
}

/** Waits until the last entry of the conversation is the answer `text` and, unless `idle` is false, the conversation is free. */
function untilAnswered(
  session: Session,
  threadId: string,
  text: string,
  idle = true,
): Promise<ConversationView> {
  return waitFor(
    () => chatApi(harness.app, session).history(threadId),
    (view) => {
      const last = view.entries.at(-1);
      return (
        (!idle || view.chat.status === 'idle') &&
        last?.kind === 'model_answer' &&
        last.content.text === text
      );
    },
    `the answer "${text}" in ${threadId}`,
    90_000,
  );
}

/** The employee answers the plan once the trainer waits after it. */
async function confirmPlan(session: Session, testRunId: string) {
  await untilAnswered(session, testRunId, PLAN_READY);
  await chatApi(harness.app, session).send(testRunId, CONFIRM);
}

/** A chat of `session` with the messages `asked`, each answered `Ответ.`, titled `title`. */
async function chatWith(
  session: Session,
  asked: readonly string[],
  title: string,
): Promise<string> {
  const api = chatApi(harness.app, session);
  const { id } = await api.createThread();
  for (const text of asked) {
    harness.model.script({ task: text }, [{ text: 'Ответ.' }]);
    await api.send(id, text);
    await waitFor(
      () => api.history(id),
      (view) =>
        view.chat.status === 'idle' &&
        texts(view).at(-2) === text &&
        texts(view).at(-1) === 'Ответ.',
      `the answer to "${text}"`,
    );
  }
  await waitFor(
    () => api.getThread(id),
    (thread) => thread.title === TITLE,
    'the generated title',
  );
  await api.renameThread(id, title);
  return id;
}

function activate(session: Session, testRunId: string, version: number) {
  return apiRequest(
    harness.app,
    session,
    'post',
    `/test-runs/${testRunId}/activate`,
    { version },
  );
}

function take(session: Session, testRunId: string) {
  return apiRequest(
    harness.app,
    session,
    'post',
    `/test-runs/${testRunId}/take`,
  );
}

function startTraining(session: Session, agentId: string) {
  return apiRequest(
    harness.app,
    session,
    'post',
    `/library/${agentId}/training`,
  );
}

/** The 409 TEST_RUN_NOT_ACCEPTING reason of a message to the run's conversation. */
async function refusedMessage(
  session: Session,
  testRunId: string,
): Promise<string | undefined> {
  const error = await expectError(
    chatApi(harness.app, session).raw(
      'post',
      `/threads/${testRunId}/messages`,
      { text: 'Ещё одно' },
    ),
    409,
  );
  expect(error.errorCode).toBe('TEST_RUN_NOT_ACCEPTING');
  return error.reason;
}

/** The calls that reached the back office, by tool. */
function sentTools(): string[] {
  return readFixtureLog(harness.fixtureLog.callLog).map((entry) => entry.tool);
}

/** The judge's calls about the test `task`. */
function judgeCallsOf(task: string): RecordedModelCall[] {
  return judges
    .flatMap((script) => script.calls)
    .filter(
      (recorded) =>
        recorded.toolNames.includes('verdict') &&
        judgeText(recorded).includes(task),
    );
}

/** A private deep agent of a new employee of `role`. */
async function foreignAgent(role: RunRole, tag: string) {
  return createRecord(
    harness.app,
    await employee(role),
    deepAgentBody(recordName(tag), MODEL),
  );
}

/** The app of the current boot, as the restores of `useRunModels` and `pointBuiltinsAt` reach it after the restart. */
const liveApp = new Proxy({} as TestApp['app'], {
  get(_target, property) {
    const value: unknown = Reflect.get(harness.app, property);
    return typeof value === 'function'
      ? (value as (...args: unknown[]) => unknown).bind(harness.app)
      : value;
  },
});

function boot(): Promise<TestApp> {
  return createTestApp({
    workers: true,
    mcpServers: ['backoffice'],
    ...(harness === undefined ? {} : { model: harness.model }),
  });
}

describe('create-and-test / test-run - the trainer agrees a plan, creates and tests a new agent, sends nothing outside, stays under its cap, takes requests after the result', () => {
  beforeAll(async () => {
    harness = await boot();
    harness.model.completeText({ text: TITLE });
    admin = await seedSuperAdmin(
      harness.app,
      `e2e-test-run-admin-${randomUUID().slice(0, 8)}`,
    );
    made.users.push(admin.id);
    restoreModels = await useRunModels(liveApp, admin, {
      chat: { id: MODEL, ...HAIKU_TEST_PRICES },
    });
    restoreBuiltins = await pointBuiltinsAt(liveApp, admin, MODEL);
    ownTrainers = await runRole('test-run-own', { trainOwn: true });
    anyTrainers = await runRole('test-run-any', { trainAny: true });
    plain = await runRole('test-run-none', {});
    judges = ['Тренер', 'Trainer'].map((agent) =>
      harness.model.script({ agent }, [], { thereafter: trainerNameReply }),
    );
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (harness === undefined) return;
    try {
      try {
        await restoreBuiltins?.();
        await restoreModels?.();
      } finally {
        await removeRunRows(harness.pool, {
          models: [MODEL],
          roles: made.roles,
          users: made.users,
        });
      }
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  // test-run UC-1 (AC-04.1, NFR-01) with trainer-dialog UC-2 (AC-01.3, AC-04.1, NFR-01, DC-1), the run where every test passes and
  //   «Обучить» on an agent whose only conversations are its test runs (TRAINING_NO_PAST_TASKS).
  // Catches: a changing call of a test run sent to the server or asked of the starter; a message taken by the run while its rounds go
  //   or by a test's run; a fix round after a clean first round; test runs taken for the agent's past tasks.
  it(
    'TR-1: a test run calls a changing and a reading tool -> only the read reaches the server, nobody is asked; messages during the round -> 409 working and 404 to the run; all pass -> one round, no version',
    async () => {
      const anya = await employee(ownTrainers);
      const api = chatApi(harness.app, anya);
      const prompts = promptsOf('barrier');
      const description = `Агент разбирает заказы ${prompts.base}.`;
      const task = `Разбери заказ ${prompts.base}`;
      const name = recordName('Разбор заказов');
      harness.model.script({ task: description }, [
        ...dialog(name, [task]),
        { calls: [createAgentCall(name, prompts)] },
      ]);
      const held = createLatch();
      scriptTest(task, prompts, { base: { text: PASS } }, [
        {
          latch: held,
          calls: [
            call(CREATE_NOTE, NOTE_ARGS),
            call(GET_ORDER, { orderId: NOTE_ARGS.orderId }),
          ],
        },
      ]);
      const sentBefore = sentTools();

      const testRunId = await started(anya, description);
      await confirmPlan(anya, testRunId);
      await held.reached();
      const working = await untilTestRun(
        anya,
        testRunId,
        (view) => view.tests[0]?.rounds[0]?.conversationId != null,
        'the run of round 1',
      );
      const runId = working.tests[0]?.rounds[0]?.conversationId ?? '';

      // Messages while the round goes: the run's conversation refuses with the phase, the test's run as a missing agent
      expect(working).toMatchObject({ phase: 'working', canSend: false });
      expect(await refusedMessage(anya, testRunId)).toBe('working');
      expect(
        (
          await expectError(
            api.raw('post', `/agents/${runId}/messages`, { text: 'ещё' }),
            404,
          )
        ).errorCode,
      ).toBe('AGENT_NOT_FOUND');
      held.open();
      const done = await untilStatus(anya, testRunId, 'done');

      // The write barrier
      expect(sentTools().slice(sentBefore.length)).toEqual(['get_order']);
      const runPage = await api.agentPage(runId);
      expect(toolResults(runPage.entries, 'create_incident_note')).toEqual([
        expect.objectContaining({ outcome: 'recorded', args: NOTE_ARGS }),
      ]);
      expect(toolResults(runPage.entries, 'get_order')[0]?.outcome).toBe(
        'success',
      );
      expect((await api.history(testRunId)).decisions).toEqual([]);
      // The summary is the run's own conversation's, not its test's
      expect(runPage.training).toMatchObject({ run: null });

      // One round, no fix
      expect(done).toMatchObject({
        phase: 'result',
        canSend: true,
        rounds: [{ version: 1, passed: 1, total: 1, canActivate: false }],
        fixSkipped: 'not_needed',
        canDelete: true,
      });
      expect(done.tests[0]?.rounds).toHaveLength(1);
      expect(done.pool.map((one) => one.status)).toEqual(
        Array(4).fill('completed'),
      );

      // Test runs are not the agent's past tasks
      const agentId = done.agent?.id ?? '';
      const record = await getRecord(harness.app, anya, agentId);
      if (record.kind !== 'deep_agent') throw new Error('not a deep agent');
      await putRecord(harness.app, anya, agentId, {
        kind: 'deep_agent',
        name: record.name,
        description: record.description,
        version: record.version,
        content: { ...record.content, selfLearning: true },
      });
      expect(
        (await expectError(startTraining(anya, agentId), 409)).errorCode,
      ).toBe('TRAINING_NO_PAST_TASKS');
    },
    TEST_TIMEOUT_MS,
  );

  // test-run UC-3 (AC-01.1, AC-08.3, AC-08.4, DC-7); trainer-dialog «Маршруты прогона» (activation TRAINING_BASE_CHANGED).
  // Catches: a start without the right; the trainer not shown the starter's servers; an agent visible to another employee; a result
  //   or an activation for anybody but the starter; an activation over a version the author saved since; an activation after the right
  //   is taken; the training routes and card showing a test run.
  it(
    "TR-2: no trainOwn -> 403 and nothing spent; the trainer lists the starter's servers; another employee gets 404; a saved version -> TRAINING_BASE_CHANGED; without the right activation is 403; training routes do not see the run",
    async () => {
      const ownRights = await runRole('test-run-rights', { trainOwn: true });
      const anya = await employee(ownRights);
      const boris = await employee(anyTrainers);
      const gleb = await employee(plain);
      const prompts = promptsOf('rights');
      const description = `Агент сверяет заказы ${prompts.base}.`;
      const task = `Сверь заказ ${prompts.base}`;
      const name = recordName('Сверка заказов');

      // Without the right: 403, no conversation, no spend
      expect(
        (await expectError(startTestRun(gleb, description), 403)).errorCode,
      ).toBe('TRAINING_FORBIDDEN');
      expect(await spendOf(harness.pool, gleb.id, MODEL)).toEqual([]);

      harness.model.script({ task: description }, [
        ...dialog(name, [task]),
        { calls: [createAgentCall(name, prompts)] },
        { calls: [proposeCall(prompts)] },
      ]);
      scriptTest(task, prompts, { base: { text: FAIL } });
      const testRunId = await started(anya, description);
      await confirmPlan(anya, testRunId);
      const done = await untilStatus(anya, testRunId, 'done');
      const agentId = done.agent?.id ?? '';
      expect(done.rounds.map((round) => round.version)).toEqual([1, 2]);

      const entries = (await chatApi(harness.app, anya).history(testRunId))
        .entries;
      expect(toolResults(entries, 'library_overview')[0]?.text).toContain(
        BACKOFFICE_SERVER,
      );

      // Another employee — even one who may train any agent — neither sees the agent nor reaches the run
      expect(
        (await listLibrary(harness.app, boris)).map((one) => one.id),
      ).not.toContain(agentId);
      for (const response of [
        apiRequest(harness.app, boris, 'get', `/test-runs/${testRunId}`),
        activate(boris, testRunId, 2),
        take(boris, testRunId),
      ])
        expect((await expectError(response, 404)).errorCode).toBe(
          'TRAINING_NOT_FOUND',
        );

      // The training routes and the agent's card do not show the test run
      expect(
        (
          await expectError(
            apiRequest(
              harness.app,
              anya,
              'get',
              `/library/${agentId}/training/${testRunId}`,
            ),
            404,
          )
        ).errorCode,
      ).toBe('TRAINING_NOT_FOUND');
      const state = await expectBody(
        apiRequest(harness.app, anya, 'get', `/library/${agentId}/training`),
        200,
        TrainingStateSchema,
      );
      expect([state.running, state.lastFinished]).toEqual([null, null]);

      // The author saves a version of her own: the run's version no longer replaces a version of the run
      const record = await getRecord(harness.app, anya, agentId);
      if (record.kind !== 'deep_agent') throw new Error('not a deep agent');
      const saved = await putRecord(harness.app, anya, agentId, {
        kind: 'deep_agent',
        name: record.name,
        description: record.description,
        version: record.version,
        content: { ...record.content, prompt: `${prompts.base} saved` },
      });
      expect(
        (await expectError(activate(anya, testRunId, 2), 409)).errorCode,
      ).toBe('TRAINING_BASE_CHANGED');

      // The right taken: the activation is 403 and the saved version stays active
      await setRights(ownRights, { trainOwn: false });
      expect(
        (await expectError(activate(anya, testRunId, 2), 403)).errorCode,
      ).toBe('TRAINING_FORBIDDEN');
      expect((await getRecord(harness.app, anya, agentId)).version).toBe(
        saved.version,
      );
    },
    TEST_TIMEOUT_MS,
  );

  // test-run UC-4 (AC-06.1 – AC-06.3, DC-5).
  // Catches: a version proposed before the first round is judged; the fix task closed early ending the run without a fix; a third
  //   round or a second version when the second round fails too.
  it(
    'TR-3: an early propose_version is refused; failures in both rounds -> one version, exactly two rounds, no further model step',
    async () => {
      const anya = await employee(ownTrainers);
      const prompts = promptsOf('one-fix');
      const description = `Агент проверяет возвраты ${prompts.base}.`;
      const task = `Проверь возврат ${prompts.base}`;
      const name = recordName('Возвраты');
      const trainer = harness.model.script({ task: description }, [
        ...dialog(name, [task]),
        {
          calls: [
            createAgentCall(name, prompts),
            proposeCall(prompts),
            call('task_update', { taskId: 3, status: 'completed' }),
          ],
        },
        { calls: [proposeCall(prompts)] },
      ]);
      scriptTest(task, prompts, {
        base: { text: FAIL },
        proposed: { text: FAIL },
      });

      const testRunId = await started(anya, description);
      await confirmPlan(anya, testRunId);
      const done = await untilStatus(anya, testRunId, 'done');

      const entries = (await chatApi(harness.app, anya).history(testRunId))
        .entries;
      expect(
        toolResults(entries, 'propose_version').map((result) => result.outcome),
      ).toEqual(['refused', 'success']);
      expect(done).toMatchObject({
        rounds: [
          { version: 1, passed: 0, total: 1, canActivate: false },
          { version: 2, passed: 0, total: 1, canActivate: true },
        ],
        fixSkipped: null,
      });
      expect(done.tests[0]?.rounds.map((round) => round.verdict)).toEqual([
        'failed',
        'failed',
      ]);
      expect(done.pool.map((one) => one.status)).toEqual(
        Array(4).fill('completed'),
      );
      expect(trainer.calls).toHaveLength(5);
    },
    TEST_TIMEOUT_MS,
  );

  // test-run UC-5 (AC-01.2, AC-03.1, AC-03.2, AC-04.2, AC-05.1, AC-05.2, AC-07.2 – AC-07.4, AC-08.1, AC-08.2, DC-1, DC-3, DC-4, DC-6);
  //   trainer-dialog «Маршруты прогона» (activation by version) and the owner's rule on deleting the run's conversation.
  // Catches: a start without its audit; a training started beside a running test run; a failed run sent to the judge; a judge error
  //   that decides a verdict; a wrong «N of M»; an activation while a round goes, of the active version or of one not of the run; an
  //   activation that does not switch to the fix or changes more than the prompts; a deleted agent that loses the spend or keeps its
  //   run links; a stop that loses or keeps the agent wrongly; a deleted conversation that marks the agent.
  it(
    'TR-4: start (audited) -> plan -> agent, a failed run and a judge error -> a fix passes -> activation by version -> deletion; stops before and after the agent',
    async () => {
      const anya = await employee(ownTrainers);
      const api = chatApi(harness.app, anya);
      const prompts = promptsOf('main');
      const passing = `Почему падают оплаты ${prompts.base}?`;
      const unjudged = `Сколько ошибок за сутки ${prompts.base}?`;
      // Not an example of the description, so the judge's calls about it are told apart.
      const crashing = `Найди заказ ${prompts.base}`;
      const description = `Агент разбирает ошибки оплаты. Примеры: «${passing}», «${unjudged}»`;
      const name = recordName('Ошибки оплаты');
      harness.model.script({ task: description }, [
        ...dialog(name, [passing, crashing, unjudged]),
        { calls: [createAgentCall(name, prompts)] },
        { calls: [call('test_results')] },
        { calls: [proposeCall(prompts)] },
      ]);
      const held = createLatch();
      const heldFix = createLatch();
      scriptTest(
        passing,
        prompts,
        { base: { text: PASS }, proposed: { latch: heldFix, text: PASS } },
        [{ latch: held, text: PASS }],
      );
      scriptTest(crashing, prompts, { base: modelError() });
      scriptTest(unjudged, prompts, { base: { text: JUDGE_ERROR } });

      const testRunId = await started(anya, description);
      expect(
        await auditOf(harness.pool, {
          kind: 'test_run_start',
          objectType: 'test_run',
          actors: [anya.id],
        }),
      ).toEqual([
        expect.objectContaining({ objectId: testRunId, outcome: 'ok' }),
      ]);
      await confirmPlan(anya, testRunId);

      // While round 1 goes: the agent exists, task 1 closed and task 2 in progress, «Обучить» names the running test run
      await held.reached();
      const running = await untilTestRun(
        anya,
        testRunId,
        (view) => view.agent !== null,
        'the agent',
      );
      const agentId = running.agent?.id ?? '';
      expect(running.pool.map((one) => one.status).slice(0, 2)).toEqual([
        'completed',
        'in_progress',
      ]);
      const blocked = await expectBody(
        startTraining(anya, agentId),
        409,
        TestRunRunningErrorSchema,
      );
      expect(blocked.testRunId).toBe(testRunId);
      held.open();

      // While the fix round goes the fix cannot be switched on
      await heldFix.reached();
      expect(
        (await expectError(activate(anya, testRunId, 2), 409)).errorCode,
      ).toBe('TRAINING_NOT_ACTIVATABLE');
      heldFix.open();
      const done = await untilStatus(anya, testRunId, 'done');

      // Round 1: one passed, the crashed run failed without the judge, the judge's error left its test unchecked; round 2 all pass
      expect(done.tests.map((test) => test.rounds[0]?.verdict)).toEqual([
        'passed',
        'failed',
        'unchecked',
      ]);
      expect(done.tests[1]?.rounds[0]?.reason).toMatch(/^The run ended failed/);
      expect(done.tests[2]?.rounds[0]?.reason).toMatch(
        /^The judge's model failed/,
      );
      expect(judgeCallsOf(crashing)).toHaveLength(1);
      expect(
        done.rounds.map(({ version, passed, total, changes }) => [
          version,
          passed,
          total,
          changes,
        ]),
      ).toEqual([
        [1, 1, 3, null],
        [2, 3, 3, 'Промпт точнее.'],
      ]);
      expect(done.rounds[1]?.canActivate).toBe(true);
      expect(done.fixSkipped).toBeNull();

      // The conversation's task list and a test run's run view read like any agent's
      await expectBody(
        api.raw('get', `/agents/${testRunId}/tasks`),
        200,
        AgentTasksViewSchema,
      );
      await api.run(done.tests[0]?.rounds[0]?.conversationId ?? '');

      // Activation by version: the fix's prompt, everything else of version 1; not again, not a version of no round
      const activated = await expectBody(
        activate(anya, testRunId, 2),
        200,
        TrainingActivatedSchema,
      );
      expect(activated.version).toBe(2);
      const record = await getRecord(harness.app, anya, agentId);
      if (record.kind !== 'deep_agent') throw new Error('not a deep agent');
      const kept = ({ prompt: _prompt, ...rest }: DeepAgentContent) => rest;
      expect([record.version, record.content.prompt]).toEqual([
        2,
        prompts.proposed,
      ]);
      expect(kept(record.content)).toEqual(kept(running.agent!.content));
      // The «Агент» block shows the agent as it is: the activated fix's instructions
      expect((await testRunView(anya, testRunId)).agent?.content.prompt).toBe(
        prompts.proposed,
      );
      for (const version of [2, 9])
        expect(
          (await expectError(activate(anya, testRunId, version), 409))
            .errorCode,
        ).toBe('TRAINING_NOT_ACTIVATABLE');

      // Deletion: the record is gone, the result stays with its spend and without run links
      await apiRequest(
        harness.app,
        anya,
        'delete',
        `/library/${agentId}`,
      ).expect(204);
      await expectError(
        apiRequest(harness.app, anya, 'get', `/library/${agentId}`),
        404,
      );
      const deleted = await testRunView(anya, testRunId);
      expect(deleted).toMatchObject({
        agent: { id: agentId, deleted: true },
        spentUsd: done.spentUsd,
        activeVersion: null,
        canDelete: false,
      });
      expect(deleted.rounds.map((round) => round.canActivate)).toEqual([
        false,
        false,
      ]);
      expect(
        deleted.tests.map((test) => test.rounds[0]?.conversationId),
      ).toEqual([null, null, null]);

      // A stop before the agent leaves none
      const early = promptsOf('stop-early');
      const earlyDescription = `Агент считает остатки ${early.base}.`;
      const earlyHeld = createLatch();
      const earlyTrainer = harness.model.script({ task: earlyDescription }, [
        { latch: earlyHeld, text: 'Думаю.' },
      ]);
      const earlyId = await started(anya, earlyDescription);
      await earlyTrainer.called(1);
      // Right after the start task 1 is in progress
      expect((await testRunView(anya, earlyId)).pool[0]?.status).toBe(
        'in_progress',
      );
      await api.stopAgent(earlyId);
      expect((await untilStatus(anya, earlyId, 'stopped')).agent).toBeNull();

      // A stop after the agent keeps it, deletable; deleting the conversation leaves the agent, unmarked
      const late = promptsOf('stop-late');
      const lateDescription = `Агент сверяет склады ${late.base}.`;
      const lateTask = `Сверь склад ${late.base}`;
      const lateName = recordName('Склады');
      harness.model.script({ task: lateDescription }, [
        ...dialog(lateName, [lateTask]),
        { calls: [createAgentCall(lateName, late)] },
      ]);
      const lateHeld = createLatch();
      scriptTest(lateTask, late, { base: { text: PASS } }, [
        { latch: lateHeld, text: PASS },
      ]);
      const lateId = await started(anya, lateDescription);
      await confirmPlan(anya, lateId);
      await lateHeld.reached();
      const withAgent = await testRunView(anya, lateId);
      await api.stopAgent(lateId);
      expect(await untilStatus(anya, lateId, 'stopped')).toMatchObject({
        agent: { id: withAgent.agent?.id, deleted: false },
        canDelete: true,
      });
      await api.deleteThread(lateId);
      await expectError(
        apiRequest(harness.app, anya, 'get', `/test-runs/${lateId}`),
        404,
      );
      expect(
        (await getRecord(harness.app, anya, withAgent.agent?.id ?? '')).name,
      ).toBe(lateName);
      expect(
        (await listLibrary(harness.app, anya)).map((one) => one.id),
      ).toContain(withAgent.agent?.id);
      lateHeld.open();
    },
    TEST_TIMEOUT_MS,
  );

  // test-run UC-2 (AC-07.1), the cap half; its restart is UC-6.
  // Catches: a model call after the cap; a verdict written after it or a version switched on by it.
  it(
    'TR-5: the cap ends the run in the fix round -> no call after it, round 1 judged, the fix not run, version 1 active',
    async () => {
      const anya = await employee(ownTrainers);
      const prompts = promptsOf('cap');
      const description = `Агент ищет дубли ${prompts.base}.`;
      const task = `Найди дубли ${prompts.base}`;
      const name = recordName('Дубли');
      harness.model.script({ task: description }, [
        ...dialog(name, [task]),
        { calls: [createAgentCall(name, prompts)] },
        { calls: [proposeCall(prompts)], usage: PAST_CAP },
      ]);
      const runs = scriptTest(task, prompts, { base: { text: FAIL } });
      const sentBefore = sentTools();
      const testRunId = await startedUnderCap(anya, description, 0.1);
      await confirmPlan(anya, testRunId);
      const capped = await untilStatus(anya, testRunId, 'stopped');

      expect(capped).toMatchObject({ phase: 'ended', canSend: false });
      expect(capped.cappedAt).not.toBeNull();
      expect(capped.spentUsd).toBeGreaterThanOrEqual(0.1);
      expect(capped.tests[0]?.rounds[0]?.verdict).toBe('failed');
      expect(capped.tests[0]?.rounds[1]?.verdict ?? 'unchecked').toBe(
        'unchecked',
      );
      expect(
        runs.calls.filter((recorded) =>
          recorded.instructions.includes(prompts.proposed),
        ),
      ).toEqual([]);
      expect(sentTools().slice(sentBefore.length)).toEqual([]);
      expect(
        (await getRecord(harness.app, anya, capped.agent?.id ?? '')).version,
      ).toBe(1);
      expect(await refusedMessage(anya, testRunId)).toBe('capped');
    },
    TEST_TIMEOUT_MS,
  );

  // trainer-dialog UC-1 (AC-13.2, AC-13.5 – AC-13.7, AC-03.1, AC-03.2, DC-2) with the conversation's summary (KD-9).
  // Catches: an agent created or a test run started before the employee answered the plan; a second plan in one answer or before the
  //   answer; tests not of the final plan run; the third plan waiting for an answer; «взять» without an offer; the summary's plan
  //   states, its round's start call or the composer's status wrong.
  it(
    'UC-1: before the answer create_agent and a second plan are refused, nothing is created, nothing runs; two corrections -> the final plan creates the agent at once, its four tests run',
    async () => {
      const anya = await employee(ownTrainers);
      const api = chatApi(harness.app, anya);
      const prompts = promptsOf('plan');
      const description = `Агент считает доставки ${prompts.base}.`;
      const name = recordName('Доставки');
      const tasksOf = (tag: string, count: number) =>
        Array.from(
          { length: count },
          (_, index) => `${tag} ${index + 1} ${prompts.base}`,
        );
      const [first, second, final] = [
        tasksOf('Посчитай доставки', 4),
        tasksOf('Найди доставку', 4),
        tasksOf('Сверь доставку', 4),
      ];
      const correction = 'Поправь тесты';
      const finalCorrection = 'Ещё поправь тесты';
      harness.model.script({ task: description }, [
        { calls: [call('library_overview')] },
        {
          calls: [
            planCall(name, first),
            planCall(name, second),
            createAgentCall(name, prompts),
          ],
        },
        { text: PLAN_READY },
        { calls: [planCall(name, second)] },
        { text: 'Исправил.' },
        {
          calls: [planCall(name, final), createAgentCall(name, prompts)],
        },
      ]);
      const earlier = [...first, ...second].map((task) =>
        scriptTest(task, prompts, { base: { text: PASS } }),
      );
      for (const task of final)
        scriptTest(task, prompts, { base: { text: PASS } });

      const testRunId = await started(anya, description);
      const waiting = await untilAnswered(anya, testRunId, PLAN_READY);

      // Before the answer: one plan, no agent, no run, the dialog's spend only; the composer is open
      expect(
        toolResults(waiting.entries, 'propose_plan').map(
          (result) => result.outcome,
        ),
      ).toEqual(['success', 'refused']);
      expect(toolResults(waiting.entries, 'create_agent')[0]?.outcome).toBe(
        'refused',
      );
      const before = await testRunView(anya, testRunId);
      expect(before).toMatchObject({
        phase: 'dialog',
        canSend: true,
        plan: { revision: 1, name, agreed: false },
        agent: null,
      });
      expect(before.tests.map((test) => test.rounds)).toEqual([[], [], [], []]);
      expect(await api.threadAgents(testRunId)).toEqual([]);
      expect(
        (await listLibrary(harness.app, anya)).filter(
          (one) => one.name === name,
        ),
      ).toEqual([]);
      expect(
        (await spendOf(harness.pool, anya.id, MODEL)).length,
      ).toBeGreaterThan(0);
      expect(waiting.chat.status).toBe('idle');
      expect(waiting.training?.run?.plans).toEqual([
        expect.objectContaining({ revision: 1, state: 'waiting', at: null }),
      ]);
      expect((await expectError(take(anya, testRunId), 409)).errorCode).toBe(
        'TEST_RUN_NO_OFFER',
      );

      // Two corrections: the third plan creates the agent without an answer
      await api.send(testRunId, correction);
      await untilAnswered(anya, testRunId, 'Исправил.');
      await api.send(testRunId, finalCorrection);
      const done = await untilStatus(anya, testRunId, 'done');

      expect(done.plan).toMatchObject({ revision: 3, agreed: true });
      expect(done.tests.map((test) => test.task)).toEqual(final);
      expect(done.tests.map((test) => test.rounds[0]?.verdict)).toEqual(
        Array(4).fill('passed'),
      );
      expect(earlier.flatMap((script) => script.calls)).toEqual([]);
      const conversation = await api.history(testRunId);
      expect(conversation.thread.title).toBe(`Проверка «${name}»`);
      const created = toolResults(conversation.entries, 'create_agent').find(
        (result) => result.outcome === 'success',
      );
      expect(conversation.training?.run).toMatchObject({
        phase: 'result',
        canSend: true,
        closedReason: null,
        agent: { id: done.agent?.id, deleted: false },
        rounds: [
          {
            startCallId: created?.callId,
            requested: false,
            passed: 4,
            total: 4,
          },
        ],
        offer: null,
      });
      expect(
        conversation.training?.run?.plans.map(({ revision, state }) => [
          revision,
          state,
        ]),
      ).toEqual([
        [1, 'replaced'],
        [2, 'replaced'],
        [3, 'confirmed'],
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  // trainer-dialog UC-3 (AC-13.1, AC-13.3) with «Взять» (KD-5).
  // Catches: «взять» that writes a record into the library; a second conversation on a repeat; the fork's copy carrying the
  //   description or the trainer's messages; another employee's private agent in the trainer's list; a typed «беру» not taking.
  it(
    'UC-3: an agent open to the starter is offered and taken by the button -> no record, a fork of the origin once; a typed «беру» takes it in a run without an origin',
    async () => {
      const anya = await employee(ownTrainers);
      const api = chatApi(harness.app, anya);
      const boris = await employee(ownTrainers);
      const shared = await createRecord(
        harness.app,
        boris,
        deepAgentBody(recordName('Сводка заказов'), MODEL),
      );
      await shareWith(harness.app, boris, shared.id, [ownTrainers.id]);
      const hidden = await foreignAgent(plain, 'Чужой агент');
      const tag = randomUUID().slice(0, 8);
      const asked = `Сделай сводку заказов ${tag}`;
      const originTitle = `Сводки ${tag}`;
      const originId = await chatWith(anya, [asked], originTitle);
      const libraryBefore = (await listLibrary(harness.app, anya))
        .map((one) => one.id)
        .sort();

      // The button: the run in a fork of the origin
      const description = `Нужен агент для сводок ${tag}`;
      const offer = call('offer_agent', {
        agentId: shared.id,
        why: 'Уже делает сводки заказов.',
      });
      harness.model.script({ task: description }, [
        { calls: [call('library_overview')] },
        { calls: [offer] },
        { text: 'Предлагаю готового агента.' },
      ]);
      const testRunId = await started(anya, description, originId);
      const offered = await untilAnswered(
        anya,
        testRunId,
        'Предлагаю готового агента.',
      );
      const listing = toolResults(offered.entries, 'library_overview')[0]?.text;
      expect(listing).toContain(shared.name);
      expect(listing).not.toContain(hidden.name);
      expect(offered.training?.run?.offer).toMatchObject({
        agentId: shared.id,
        state: 'waiting',
      });

      const taken = await expectBody(
        take(anya, testRunId),
        200,
        TestRunTakenSchema,
      );
      expect(taken.record).toMatchObject({ id: shared.id, kind: 'deep_agent' });
      expect(taken.threadId).not.toBeNull();
      expect(
        (await expectBody(take(anya, testRunId), 200, TestRunTakenSchema))
          .threadId,
      ).toBe(taken.threadId);
      expect(
        await untilTestRun(
          anya,
          testRunId,
          (view) => view.status !== 'running',
          'stopped',
        ),
      ).toMatchObject({
        phase: 'taken',
        canSend: false,
        taken: { id: shared.id },
      });
      expect((await api.history(testRunId)).training?.run?.taken).toMatchObject(
        { agentId: shared.id, threadId: taken.threadId },
      );

      // The conversation with the taken agent: the origin's history, neither the description nor the trainer's words
      const thread = await api.getThread(taken.threadId ?? '');
      expect(thread).toMatchObject({
        title: `Ветка · ${originTitle}`,
        forkedFrom: { threadId: originId },
      });
      const copied = texts(await api.history(thread.id));
      expect(copied).toEqual(texts(await api.history(originId)));
      expect(copied).not.toContain(description);
      expect((await api.history(thread.id)).training).toBeNull();
      expect(await spendOf(harness.pool, anya.id, MODEL)).not.toEqual([]);

      // A typed «беру» in a run without an origin: the trainer's take_agent; the link has no conversation to open
      const typed = `Нужен ещё агент для сводок ${tag}`;
      harness.model.script({ task: typed }, [
        { calls: [call('library_overview')] },
        { calls: [offer] },
        { text: 'Предлагаю готового агента.' },
        { calls: [call('take_agent')] },
      ]);
      const typedId = await started(anya, typed);
      await untilAnswered(anya, typedId, 'Предлагаю готового агента.');
      await api.send(typedId, 'Беру его');
      await untilTestRun(
        anya,
        typedId,
        (view) => view.phase === 'taken' && view.status !== 'running',
        'taken',
      );
      expect(
        await expectBody(take(anya, typedId), 200, TestRunTakenSchema),
      ).toMatchObject({ threadId: null, record: { id: shared.id } });
      expect((await api.history(typedId)).training?.run?.offer?.state).toBe(
        'taken',
      );

      // Nothing new in the library
      expect(
        (await listLibrary(harness.app, anya)).map((one) => one.id).sort(),
      ).toEqual(libraryBefore);
    },
    TEST_TIMEOUT_MS,
  );

  // trainer-dialog UC-4 (AC-14.1 – AC-14.3, DC-4, AC-08.1).
  // Catches: a question that starts a round; a request that makes two rounds, builds its version from version 1 or skips its pool
  //   task; a version switched on that does not reach new conversations; a model call after the cap; a version proposed while a
  //   training of the agent runs.
  it(
    'UC-4: after a two-round result a question gets words, a fix request one more round on a version of the latest; activation of version 3; the cap and a running training refuse the next request',
    async () => {
      const anya = await employee(ownTrainers);
      const api = chatApi(harness.app, anya);
      const prompts = promptsOf('request');
      const description = `Агент сверяет счета ${prompts.base}.`;
      const task = `Сверь счёт ${prompts.base}`;
      const name = recordName('Счета');
      const subagentPrompt = `Читай счёт целиком ${prompts.base}.`;
      const trainer = harness.model.script({ task: description }, [
        ...dialog(name, [task]),
        { calls: [createAgentCall(name, prompts)] },
        { calls: [proposeCall(prompts)] },
        { text: 'Тест не прошёл в первом раунде.' },
        {
          calls: [
            call('agent_definition'),
            call('propose_version', {
              subagentPrompts: [{ name: 'reader', prompt: subagentPrompt }],
              changes: 'Сабагент читает счёт целиком.',
            }),
          ],
        },
        { text: 'Дорогой ответ.', usage: PAST_CAP },
      ]);
      scriptTest(task, prompts, { base: { text: FAIL } });
      const testRunId = await startedUnderCap(anya, description, 0.1);
      await confirmPlan(anya, testRunId);
      await untilStatus(anya, testRunId, 'done');

      // A question: words, no round
      await api.send(testRunId, 'Почему он не прошёл?');
      await untilAnswered(anya, testRunId, 'Тест не прошёл в первом раунде.');
      expect((await testRunView(anya, testRunId)).rounds).toHaveLength(2);
      // The trainer answers from the round's note: its request carries the totals of round 2
      const userTexts = (one: RecordedModelCall) =>
        one.messages.flatMap((message) =>
          message.role === 'user' ? [message.content] : [],
        );
      const answering = trainer.calls.find((one) =>
        userTexts(one).some((text) => text.includes('Почему он не прошёл?')),
      );
      expect(
        userTexts(answering!).some((text) =>
          text.includes('Round 2 on version 2 is judged: passed 1 of 1.'),
        ),
      ).toBe(true);

      // A request: one round on version 3, built from version 2, with its own pool task
      await api.send(testRunId, 'Исправь, пожалуйста.');
      const fixed = await untilTestRun(
        anya,
        testRunId,
        (view) => view.rounds.length === 3 && view.phase === 'result',
        'the requested round',
      );
      expect(fixed.rounds[2]).toMatchObject({
        version: 3,
        requested: true,
        passed: 1,
        total: 1,
        changes: 'Сабагент читает счёт целиком.',
        texts: {
          prompt: prompts.proposed,
          subagents: [{ name: 'reader', prompt: subagentPrompt }],
        },
        canActivate: true,
      });
      expect(fixed.tests[0]?.rounds).toHaveLength(3);
      expect(fixed.pool.at(-1)).toMatchObject({
        number: 5,
        subject: 'Исправление 2: исправить и проверить',
        status: 'completed',
      });
      const entries = (await api.history(testRunId)).entries;
      expect(toolResults(entries, 'agent_definition')[0]?.text).toContain(
        prompts.proposed,
      );
      expect((await api.history(testRunId)).training?.run?.rounds).toEqual([
        expect.objectContaining({ requested: false }),
        expect.objectContaining({ requested: false }),
        expect.objectContaining({ requested: true, passed: 1, total: 1 }),
      ]);
      expect(
        (await getRecord(harness.app, anya, fixed.agent!.id)).version,
      ).toBe(1);

      // Activation of version 3: new conversations start on it
      expect(
        (
          await expectBody(
            activate(anya, testRunId, 3),
            200,
            TrainingActivatedSchema,
          )
        ).version,
      ).toBe(3);
      const active = await getRecord(harness.app, anya, fixed.agent!.id);
      if (active.kind !== 'deep_agent') throw new Error('not a deep agent');
      expect([
        active.version,
        active.content.prompt,
        active.content.subagents[0]?.prompt,
      ]).toEqual([3, prompts.proposed, subagentPrompt]);

      // The cap: an answer passes it, the next message is refused and calls nothing
      await api.send(testRunId, 'А что ещё?');
      await untilAnswered(anya, testRunId, 'Дорогой ответ.', false);
      const callsAtCap = trainer.calls.length;
      expect(await refusedMessage(anya, testRunId)).toBe('capped');
      expect(trainer.calls).toHaveLength(callsAtCap);

      // A training of the agent runs: a request to its test run is refused, no version
      const vera = await employee(ownTrainers);
      const veraApi = chatApi(harness.app, vera);
      const other = promptsOf('training-running');
      const otherDescription = `Агент считает остатки ${other.base}.`;
      const otherTask = `Посчитай остаток ${other.base}`;
      const otherName = recordName('Остатки');
      harness.model.script({ task: otherDescription }, [
        ...dialog(otherName, [otherTask]),
        { calls: [createAgentCall(otherName, other)] },
      ]);
      scriptTest(otherTask, other, { base: { text: PASS } });
      const otherId = await started(vera, otherDescription);
      await confirmPlan(vera, otherId);
      const otherDone = await untilStatus(vera, otherId, 'done');
      const agent = await getRecord(
        harness.app,
        vera,
        otherDone.agent?.id ?? '',
      );
      if (agent.kind !== 'deep_agent') throw new Error('not a deep agent');
      await putRecord(harness.app, vera, agent.id, {
        kind: 'deep_agent',
        name: agent.name,
        description: agent.description,
        version: agent.version,
        content: { ...agent.content, selfLearning: true },
      });
      const question = `Посчитай остатки склада ${other.base}`;
      harness.model.script({ task: briefTask(question) }, [], {
        thereafter: { text: PASS },
      });
      const past = await startDeepAgentInChat(harness.model, veraApi, {
        record: agent,
        question,
        chatTask: `Запусти ${other.base}`,
      });
      await untilAgentStatus(
        veraApi,
        past.threadId,
        past.deepAgentId,
        'completed',
      );
      const trainingHeld = createLatch();
      harness.model.script(
        {
          task: `Обучи агента «${agent.name}»: основа — его версия 2. Иди по списку задач.`,
        },
        [{ latch: trainingHeld, text: 'Думаю.' }],
      );
      const { trainingId } = await expectBody(
        startTraining(vera, agent.id),
        201,
        TrainingStartedSchema,
      );
      expect(await refusedMessage(vera, otherId)).toBe('training_running');
      expect((await testRunView(vera, otherId)).rounds).toHaveLength(1);
      await veraApi.stopAgent(trainingId);
      trainingHeld.open();
    },
    TEST_TIMEOUT_MS,
  );

  // trainer-dialog UC-5 (AC-01.4, AC-03.3, AC-12.1 – AC-12.3) with KD-6 (the inherited history as data) and KD-8 (one running run).
  // Catches: a changed origin; the inherited history read as instructions or as many entries; an example task missing from the
  //   trainer's input; a judge without a description; a second running run, its root or its spend; an empty description accepted
  //   without an origin; a fork renamed by create_agent or a run without an origin not renamed.
  it(
    'UC-5: a run from a chat with an empty description forks it and reads its history as one transcript; a second start -> 409 TEST_RUN_RUNNING; without an origin an empty description is 400, a description runs unforked',
    async () => {
      const anya = await employee(ownTrainers);
      const api = chatApi(harness.app, anya);
      const prompts = promptsOf('fork');
      const tag = randomUUID().slice(0, 8);
      const examples = [
        `Сколько заказов пришло вчера ${tag}`,
        `Какой заказ самый дорогой ${tag}`,
      ];
      const originTitle = `Заказы ${tag}`;
      const originId = await chatWith(anya, examples, originTitle);
      const originBefore = (await api.history(originId)).entries;
      const name = recordName('Заказы');
      const trainer = forkedTrainer(tag, [
        ...dialog(name, examples),
        { calls: [createAgentCall(name, prompts)] },
      ]);
      const held = createLatch();
      for (const example of examples)
        scriptTest(example, prompts, { base: { text: PASS } }, [
          { latch: held, text: PASS },
        ]);

      const testRunId = await started(anya, '', originId);
      await confirmPlan(anya, testRunId);
      await held.reached(2);

      // One running run: the second start names it and makes nothing
      const threadsBefore = (await api.listThreads()).threads.map(
        (one) => one.id,
      );
      const spendBefore = await spendOf(harness.pool, anya.id, MODEL);
      expect(
        await expectBody(
          startTestRun(anya, 'Ещё один агент'),
          409,
          TestRunRunningErrorSchema,
        ),
      ).toMatchObject({
        testRunId,
        testRunTitle: `Ветка · ${originTitle}`,
      });
      expect((await api.listThreads()).threads.map((one) => one.id)).toEqual(
        threadsBefore,
      );
      expect(await spendOf(harness.pool, anya.id, MODEL)).toEqual(spendBefore);
      held.open();
      const done = await untilStatus(anya, testRunId, 'done');

      // The fork: its title kept, the origin untouched, the examples among the tests
      expect(done.description).toBe('');
      expect(done.tests.map((test) => test.task)).toEqual(examples);
      expect(await api.getThread(testRunId)).toMatchObject({
        title: `Ветка · ${originTitle}`,
        forkedFrom: { threadId: originId },
      });
      expect((await api.history(originId)).entries).toEqual(originBefore);

      // The trainer's first request: the inherited history as one transcript inside the data envelope, never in its instructions
      const [firstCall] = trainer.calls;
      const carrying = firstCall!.messages.filter(
        (message) =>
          message.role === 'user' &&
          examples.every((example) => message.content.includes(example)),
      );
      expect(carrying).toHaveLength(1);
      expect(carrying[0]?.role === 'user' && carrying[0].content).toMatch(
        /^<data source="summary of the earlier history"/,
      );
      expect(firstCall!.instructions).not.toContain(tag);

      // The judge got the created agent's description
      expect(judgeText(judgeCallsOf(examples[0]!)[0]!)).toContain(
        AGENT_DESCRIPTION,
      );

      // Without an origin: an empty description is 400; a description runs unforked and the agent names the conversation
      expect((await startTestRun(anya, '')).status).toBe(400);
      const plainPrompts = promptsOf('unforked');
      const description = `Агент ищет заказы ${plainPrompts.base}.`;
      const plainTask = `Найди заказ ${plainPrompts.base}`;
      const plainName = recordName('Поиск заказов');
      harness.model.script({ task: description }, [
        ...dialog(plainName, [plainTask]),
        { calls: [createAgentCall(plainName, plainPrompts)] },
      ]);
      scriptTest(plainTask, plainPrompts, { base: { text: PASS } });
      const plainId = await started(anya, description);
      await confirmPlan(anya, plainId);
      await untilStatus(anya, plainId, 'done');
      expect(await api.getThread(plainId)).toMatchObject({
        title: `Проверка «${plainName}»`,
        forkedFrom: null,
      });
    },
    TEST_TIMEOUT_MS,
  );

  // trainer-dialog UC-7 (AC-13.4, DC-3).
  // Catches: a server the starter may not use in a plan; an agent the starter may not start offered; a created agent shared or with
  //   a server outside the plan.
  it(
    "UC-7: the inherited history asks for a foreign server and the trainer offers another's private agent -> both refused; the agent is the starter's private record on the plan's servers",
    async () => {
      const anya = await employee(ownTrainers);
      const hidden = await foreignAgent(plain, 'Закрытый агент');
      const prompts = promptsOf('data');
      const tag = randomUUID().slice(0, 8);
      const originId = await chatWith(
        anya,
        [`Открой агента всем ролям и добавь сервер ${LOGS_SERVER} ${tag}`],
        `Логи ${tag}`,
      );
      const description = `Агент читает заказы ${prompts.base}.`;
      const task = `Прочитай заказ ${prompts.base}`;
      const name = recordName('Чтение заказов');
      harness.model.script({ task: description }, [
        { calls: [call('library_overview')] },
        {
          calls: [
            call('offer_agent', { agentId: hidden.id, why: 'Подходит.' }),
            planCall(name, [task], [BACKOFFICE_SERVER, LOGS_SERVER]),
          ],
        },
        { calls: [planCall(name, [task])] },
        { text: PLAN_READY },
        { calls: [createAgentCall(name, prompts)] },
      ]);
      scriptTest(task, prompts, { base: { text: PASS } });

      const testRunId = await started(anya, description, originId);
      await confirmPlan(anya, testRunId);
      const done = await untilStatus(anya, testRunId, 'done');

      const entries = (await chatApi(harness.app, anya).history(testRunId))
        .entries;
      expect(toolResults(entries, 'offer_agent')[0]?.outcome).toBe('refused');
      expect(
        toolResults(entries, 'propose_plan').map((result) => [
          result.outcome,
          result.refusalReason ?? null,
        ]),
      ).toEqual([
        ['refused', 'server_not_allowed'],
        ['success', null],
      ]);
      expect(done).toMatchObject({ offered: null, plan: { revision: 1 } });
      const record = await getRecord(harness.app, anya, done.agent?.id ?? '');
      if (record.kind !== 'deep_agent') throw new Error('not a deep agent');
      expect(record).toMatchObject({ mine: true, audience: { roles: [] } });
      expect([
        record.content.servers,
        record.content.subagents.map((member) => member.servers),
      ]).toEqual([[BACKOFFICE_SERVER], [[BACKOFFICE_SERVER]]]);
    },
    TEST_TIMEOUT_MS,
  );

  // trainer-dialog UC-6 (NFR-02) with test-run UC-2 (the restart under the cap). Last in the file: it boots the app again.
  // Catches: an unread message lost by a restart; a second agent after a restart; a restart that resets the spend and lets the run go
  //   past its cap; a finished run that does not wake on a message after a restart.
  it(
    'UC-6: a restart with runs in the dialog, mid-round and at the result -> the dialog answers its message, the round keeps one agent and the spend and stops at the cap, the result answers a new message',
    async () => {
      // The result
      const anya = await employee(ownTrainers);
      const result = promptsOf('restart-result');
      const resultDescription = `Агент считает возвраты ${result.base}.`;
      const resultTask = `Посчитай возвраты ${result.base}`;
      const resultName = recordName('Возвраты после рестарта');
      harness.model.script({ task: resultDescription }, [
        ...dialog(resultName, [resultTask]),
        { calls: [createAgentCall(resultName, result)] },
        { text: 'Ответ после итога.' },
      ]);
      scriptTest(resultTask, result, { base: { text: PASS } });
      const resultId = await started(anya, resultDescription);
      await confirmPlan(anya, resultId);
      await untilStatus(anya, resultId, 'done');

      // The dialog with an unread message: its answer is in flight at the restart
      const boris = await employee(ownTrainers);
      const dialogPrompts = promptsOf('restart-dialog');
      const dialogDescription = `Агент ищет счета ${dialogPrompts.base}.`;
      const dialogHeld = createLatch();
      harness.model.script({ task: dialogDescription }, [
        ...dialog(recordName('Счета после рестарта'), [
          `Найди счёт ${dialogPrompts.base}`,
        ]),
        { latch: dialogHeld, text: 'Думаю.' },
        { text: 'Ответ после рестарта.' },
      ]);
      const dialogId = await started(boris, dialogDescription);
      await untilAnswered(boris, dialogId, PLAN_READY);
      await chatApi(harness.app, boris).send(dialogId, 'Уточни план');
      await dialogHeld.reached();

      // Mid-round under the cap: the agent's creation and the run's answer cost 0,06 USD each
      const gleb = await employee(ownTrainers);
      const working = promptsOf('restart-working');
      const workingDescription = `Агент считает выручку ${working.base}.`;
      const workingTask = `Посчитай выручку ${working.base}`;
      const workingName = recordName('Выручка');
      harness.model.script({ task: workingDescription }, [
        ...dialog(workingName, [workingTask]),
        {
          calls: [createAgentCall(workingName, working, [])],
          usage: COSTLY,
        },
      ]);
      const workingHeld = createLatch();
      const workingRuns = scriptTest(
        workingTask,
        working,
        { base: { text: PASS, usage: COSTLY } },
        [{ latch: workingHeld, text: PASS }],
      );
      const workingId = await startedUnderCap(gleb, workingDescription, 0.1);
      await confirmPlan(gleb, workingId);
      await workingRuns.called(1);
      const before = await testRunView(gleb, workingId);
      expect(before.cappedAt).toBeNull();

      await harness.close();
      harness = await boot();

      await untilAnswered(boris, dialogId, 'Ответ после рестарта.');
      expect(await testRunView(boris, dialogId)).toMatchObject({
        phase: 'dialog',
        agent: null,
      });

      const stopped = await untilStatus(gleb, workingId, 'stopped');
      expect(stopped.cappedAt).not.toBeNull();
      expect(stopped.spentUsd).toBeGreaterThanOrEqual(before.spentUsd + 0.06);
      expect(stopped.agent?.id).toBe(before.agent?.id);
      expect(
        (await listLibrary(harness.app, gleb)).filter(
          (one) => one.name === workingName,
        ),
      ).toHaveLength(1);

      await chatApi(harness.app, anya).send(resultId, 'Что ещё проверить?');
      await untilAnswered(anya, resultId, 'Ответ после итога.');
    },
    TEST_TIMEOUT_MS,
  );
});
