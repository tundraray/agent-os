// schedules-search-memory / schedules - API integration (real AppModule + real Postgres, two employees, scripted model)
// Design Doc: docs/features/schedules-search-memory/design-schedules.md, Test Strategy UC-1 .. UC-6.
// PRD: docs/features/schedules-search-memory/prd.md. UXRD: docs/features/schedules-search-memory/uxrd.md.
//
// Harness: `createTestApp({ workers: true, mcpServers: ['backoffice'], clock })` as in create-and-test-fork: the scripted model double of
//   `@agent-os/agents/testing` behind the model, the MCP fixture for the changing call of UC-2. Time is the replaced runtime `CLOCK`, a
//   clock the test sets; it only moves forward, each case in its own month. The test calls the schedule pass directly
//   (`SchedulesService.pass`); with workers on the background pass also runs on its own timer, so the cases check the result (rows,
//   conversations), not which pass claimed a term. A restart is `close()` and a new `createTestApp()` over the same clock and model.
//   Rows a crashed process would leave (a `starting` row) are written through `SchedulesRepository`. Blocking an employee ends their
//   sessions, so their rows are read from the database. Run only against a test database (DATABASE_URL): this config migrates it on load.
//
// Not repeated here (one proof per rule, lower level):
//   - the due-time rule (four kinds, week, DST zone, skipped terms): ONE table-driven unit test of the pure function in apps/api
//     (schedule-rule.spec.ts). Wiring is proven here by one case per scenario.
//   - the run decision order when several skip reasons hold at once: ONE table-driven unit test (schedule-decision.spec.ts); UC-2 and
//     UC-3 prove its wiring with one reason at a time.
//   - the run status function: a pure function; UC-1 .. UC-3 reach its statuses through the API, it has no unit test of its own.
//   - NFR-03 (pass period under a minute) is a constant, not tested; NFR-05 (360 px) is checked in a browser during the screens.

import { randomUUID } from 'node:crypto';
import { createLatch, type ScriptedToolCall } from '@agent-os/agents/testing';
import {
  type ConversationView,
  type ScheduleBody,
  ScheduleListResponseSchema,
  type ScheduleRule,
  ScheduleRunViewSchema,
  type ScheduleRunsPage,
  ScheduleRunsPageSchema,
  ScheduleViewSchema,
  TestRunStartedSchema,
} from '@agent-os/contracts';
import { SchedulesRepository } from '@agent-os/db';
import { waitFor } from '@agent-os/db/testing';
import { fixtureCallsOf } from '@agent-os/mcp-fixture';
import { type Clock, systemClock } from '@agent-os/runtime';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SchedulesService } from '../src/schedules/schedules.service';
import {
  allowRole,
  grantTo,
  HAIKU_TEST_PRICES,
  removeRunRows,
  runModel,
  type RunRole,
  useRunModels,
} from './support/access';
import { type ChatApi, chatApi, expectBody, expectError } from './support/api';
import {
  createTestApp,
  type TestApp,
  type TestAppOptions,
} from './support/createTestApp';
import {
  agentBody,
  BUILTIN,
  createRecord,
  createSystemRecord,
  pointBuiltinsAt,
  recordName,
  setSystemAudience,
} from './support/library';
import { BACKOFFICE_SERVER } from './support/mcp-servers';
import {
  apiRequest,
  createEmployee,
  seedSuperAdmin,
  type Session,
} from './support/session';

const TEST_TIMEOUT_MS = 180_000;
const MODEL = runModel('haiku-schedules');
const GENERATED_TITLE = 'Conversation title';
const HOUR_MS = 3_600_000;
const CREATE_NOTE = `mcp__${BACKOFFICE_SERVER}__create_incident_note`;

/** A clock whose `now` the test sets; timers and randomness are the system's. */
interface SettableClock extends Clock {
  set(now: Date): void;
}

function settableClock(start: Date): SettableClock {
  let current = start;
  return {
    now: () => current,
    random: () => systemClock.random(),
    setTimer: (ms, callback) => systemClock.setTimer(ms, callback),
    set: (now) => {
      current = now;
    },
  };
}

/** The clock starts on Monday 2030-03-04; every case moves it into a month of its own. */
const clock = settableClock(new Date('2030-03-04T08:00:00Z'));

const at = (iso: string): Date => new Date(iso);
const later = (moment: Date, ms: number): Date =>
  new Date(moment.getTime() + ms);

let harness: TestApp;
let admin: Session;
let role: RunRole;
let restoreModels: (() => Promise<void>) | undefined;
let restoreBuiltins: (() => Promise<void>) | undefined;
const madeUsers: string[] = [];

/**
 * The app of the current boot: UC-5 restarts the app, and the closures the setup helpers keep (`role.add`, the restores of
 * `useRunModels` and `pointBuiltinsAt`) reach whichever app is up through this, never the closed one.
 */
const currentApp = new Proxy({} as TestApp['app'], {
  get: (_target, property) => {
    const value: unknown = Reflect.get(harness.app, property);
    return typeof value === 'function' ? value.bind(harness.app) : value;
  },
});

function appOptions(): TestAppOptions {
  return {
    workers: true,
    mcpServers: ['backoffice'],
    clock,
    ...(harness === undefined ? {} : { model: harness.model }),
  };
}

async function employee(inRole = true): Promise<Session> {
  const session = await createEmployee(harness.app, admin);
  madeUsers.push(session.id);
  if (inRole) await role.add(session);
  return session;
}

/** The pass the runtime runs on its timer, called directly. */
function pass(): Promise<boolean> {
  return harness.app.get(SchedulesService).pass();
}

function body(
  fields: Partial<ScheduleBody> & { rule: ScheduleRule },
): ScheduleBody {
  return {
    instruction: `Instruction ${randomUUID().slice(0, 8)}`,
    agentId: null,
    timeZone: 'UTC',
    target: 'new_conversation',
    conversationId: null,
    language: 'en',
    ...fields,
  };
}

/** The schedule routes as one employee sees them. */
function schedulesOf(api: ChatApi) {
  return {
    create: (schedule: ScheduleBody) =>
      expectBody(
        api.raw('post', '/schedules', schedule),
        201,
        ScheduleViewSchema,
      ),
    list: () =>
      expectBody(api.raw('get', '/schedules'), 200, ScheduleListResponseSchema),
    get: (id: string) =>
      expectBody(api.raw('get', `/schedules/${id}`), 200, ScheduleViewSchema),
    put: (id: string, schedule: ScheduleBody) =>
      expectBody(
        api.raw('put', `/schedules/${id}`, schedule),
        200,
        ScheduleViewSchema,
      ),
    pause: (id: string) =>
      expectBody(
        api.raw('post', `/schedules/${id}/pause`),
        200,
        ScheduleViewSchema,
      ),
    resume: (id: string) =>
      expectBody(
        api.raw('post', `/schedules/${id}/resume`),
        200,
        ScheduleViewSchema,
      ),
    runNow: (id: string) =>
      expectBody(
        api.raw('post', `/schedules/${id}/run`),
        200,
        ScheduleRunViewSchema,
      ),
    runs: (id: string): Promise<ScheduleRunsPage> =>
      expectBody(
        api.raw('get', `/schedules/${id}/runs`),
        200,
        ScheduleRunsPageSchema,
      ),
  };
}

/** A history row as the database holds it, earliest term first. */
interface RunRow {
  readonly id: string;
  readonly outcome: string;
  readonly skipReason: string | null;
  readonly conversationId: string | null;
  readonly manual: boolean;
  readonly dueAt: Date;
}

async function runRows(scheduleId: string): Promise<RunRow[]> {
  const { rows } = await harness.pool.query<RunRow>(
    `SELECT id, outcome, skip_reason AS "skipReason", conversation_id AS "conversationId", manual, due_at AS "dueAt"
       FROM app.schedule_runs WHERE schedule_id = $1 ORDER BY due_at, id`,
    [scheduleId],
  );
  return rows;
}

/**
 * Waits until no history row of the schedules is `starting`: after a restart the app's own background pass runs
 * beside the test's `pass()`, and the one that claimed a term may still be starting its conversation.
 */
async function untilSettled(scheduleIds: readonly string[]): Promise<void> {
  await waitFor(
    async () => (await Promise.all(scheduleIds.map(runRows))).flat(),
    (rows) => rows.every((row) => row.outcome !== 'starting'),
    'no starting history row',
  );
}

async function conversationCount(id: string): Promise<number> {
  const { rows } = await harness.pool.query<{ count: string }>(
    'SELECT count(*) AS count FROM app.conversations WHERE id = $1',
    [id],
  );
  return Number(rows[0]?.count ?? 0);
}

/** Writes the `starting` row a process that died between the claim and the start leaves behind. */
async function leftStarting(scheduleId: string, dueAt: Date): Promise<string> {
  const id = randomUUID();
  await harness.app
    .get(SchedulesRepository)
    .insertRuns([
      { id, scheduleId, dueAt, manual: false, outcome: 'starting' },
    ]);
  return id;
}

async function block(session: Session): Promise<void> {
  await apiRequest(
    harness.app,
    admin,
    'post',
    `/admin/users/${session.id}/block`,
  ).expect(200);
}

function untilIdle(api: ChatApi, threadId: string): Promise<ConversationView> {
  return waitFor(
    () => api.history(threadId),
    (view) => view.chat.status === 'idle',
    'the free conversation',
  );
}

function untilOpenDecision(
  api: ChatApi,
  threadId: string,
): Promise<ConversationView> {
  return waitFor(
    () => api.history(threadId),
    (view) => view.decisions.some((decision) => decision.status === 'open'),
    'the open decision',
  );
}

/** A conversation of the employee whose first message got `answer`, with its generated title. */
async function conversation(api: ChatApi, text: string, answer: string) {
  harness.model.script({ task: text }, [{ text: answer }]);
  const { id } = await api.createThread();
  await api.send(id, text);
  await untilIdle(api, id);
  await waitFor(
    () => api.getThread(id),
    (thread) => thread.title === GENERATED_TITLE,
    'the generated title',
  );
  return id;
}

function startResearch(question: string): ScriptedToolCall {
  return {
    tool: 'start_deep_agent',
    args: {
      deepAgent: BUILTIN.deepResearch.name,
      question,
      boundaries: '',
      result: '',
    },
  };
}

describe('schedules: due terms, claim, send or start', () => {
  beforeAll(async () => {
    harness = await createTestApp(appOptions());
    harness.model.completeText({ text: GENERATED_TITLE });
    admin = await seedSuperAdmin(
      harness.app,
      `e2e-schedules-admin-${randomUUID().slice(0, 8)}`,
    );
    madeUsers.push(admin.id);
    restoreModels = await useRunModels(currentApp, admin, {
      chat: { id: MODEL, ...HAIKU_TEST_PRICES },
    });
    restoreBuiltins = await pointBuiltinsAt(currentApp, admin, MODEL);
    role = await allowRole(currentApp, admin, {
      name: 'schedules',
      models: [MODEL],
      servers: [BACKOFFICE_SERVER],
    });
  }, TEST_TIMEOUT_MS);

  // The next case's clock passes every term of this one's schedules: they go, the run conversations stay.
  afterEach(async () => {
    await harness.pool.query(
      'DELETE FROM app.schedules WHERE owner_id = ANY($1::uuid[])',
      [madeUsers],
    );
  });

  afterAll(async () => {
    if (harness === undefined) return;
    try {
      try {
        await restoreBuiltins?.();
        await restoreModels?.();
      } finally {
        await harness.pool.query(
          'DELETE FROM app.schedules WHERE owner_id = ANY($1::uuid[])',
          [madeUsers],
        );
        await removeRunRows(harness.pool, {
          models: [MODEL],
          roles: role === undefined ? [] : [role.id],
          users: madeUsers,
        });
      }
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  // AC: AC-01.1, AC-03.1, AC-04.1, AC-08.1.
  // Catches: a term that starts two runs (claim not once-only under two concurrent passes), or a run without the schedule mark / title / history row —
  //   the main path of the feature broken at any link of claim -> start -> history.
  it(
    'UC-1: a due term starts one new conversation with the schedule mark, even when two passes claim it at once',
    async () => {
      clock.set(at('2030-03-04T08:00:00Z'));
      const anna = chatApi(harness.app, await employee());
      const schedules = schedulesOf(anna);
      const instruction = 'UC-1: summarise the night errors';
      harness.model.script({ task: instruction }, [{ text: 'Night summary.' }]);
      const created = await schedules.create(
        body({
          name: 'Morning summary',
          instruction,
          rule: { kind: 'weekdays', days: [1, 2, 3, 4, 5], time: '09:00' },
        }),
      );

      const [listed] = (await schedules.list()).schedules;
      expect(listed).toMatchObject({
        id: created.id,
        timeZone: 'UTC',
        state: 'active',
        nextRunAt: '2030-03-04T09:00:00.000Z',
        lastRun: null,
      });

      // Two passes claim the same due term at once: the conditional claim lets exactly one through
      clock.set(at('2030-03-04T09:00:30Z'));
      await Promise.all([pass(), pass()]);
      expect(await runRows(created.id)).toHaveLength(1);

      const { threads } = await anna.listThreads();
      expect(threads).toHaveLength(1);
      const thread = threads[0]!;
      expect(thread.title).toBe('Morning summary · Mar 4');
      const view = await untilIdle(anna, thread.id);
      expect(view.entries[0]).toMatchObject({
        kind: 'task',
        content: {
          text: instruction,
          schedule: {
            scheduleId: created.id,
            name: 'Morning summary',
            manual: false,
          },
        },
      });
      expect(view.entries.at(-1)).toMatchObject({
        kind: 'model_answer',
        content: { text: 'Night summary.' },
      });

      const page = await waitFor(
        () => schedules.runs(created.id),
        (runs) => runs.runs[0]?.status === 'completed',
        'the completed run',
      );
      expect(page.runs).toEqual([
        {
          id: thread.id,
          dueAt: '2030-03-04T09:00:00.000Z',
          manual: false,
          outcome: 'started',
          status: 'completed',
          skipReason: null,
          conversationId: thread.id,
        },
      ]);
      expect((await schedules.get(created.id)).nextRunAt).toBe(
        '2030-03-05T09:00:00.000Z',
      );
    },
    TEST_TIMEOUT_MS,
  );

  // AC: AC-04.2, AC-05.1, AC-05.2, AC-07.3, AC-07.4.
  // Catches: a second run starting over a run that waits for an unanswered confirmation, or a run dropped into a busy conversation
  //   (silent overlap), or a schedule message that looks like the employee's own.
  it(
    'UC-2: this-conversation runs queue as marked messages; an unanswered confirmation or a busy conversation skips the next term',
    async () => {
      const start = at('2030-04-01T08:00:00Z');
      clock.set(start);
      const anna = chatApi(harness.app, await employee());
      const schedules = schedulesOf(anna);
      const threadId = await conversation(
        anna,
        'UC-2: watch the payment queue with me',
        'Sure.',
      );
      const instruction = 'UC-2: check the payment queue';
      harness.model.script({ task: instruction }, [
        {
          calls: [
            {
              tool: CREATE_NOTE,
              args: { orderId: 'ORD-9001', text: 'Queue is stuck' },
            },
          ],
        },
        { text: 'Note declined.' },
        { calls: [startResearch('UC-2: why is the queue stuck?')] },
      ]);
      const schedule = await schedules.create(
        body({
          name: 'Queue check',
          instruction,
          rule: { kind: 'every_hours', hours: 1 },
          target: 'this_conversation',
          conversationId: threadId,
        }),
      );

      // Term 1: the run's message asks for a changing call, which waits for a decision
      clock.set(later(start, HOUR_MS + 1_000));
      await pass();
      const waiting = await untilOpenDecision(anna, threadId);
      expect(
        fixtureCallsOf(harness.fixtureLog.callLog, {
          tool: 'create_incident_note',
        }),
      ).toEqual([]);
      await waitFor(
        () => schedules.runs(schedule.id),
        (page) => page.runs[0]?.status === 'awaiting_confirmation',
        'the run awaiting confirmation',
      );

      // Term 2: the unanswered decision skips it
      clock.set(later(start, 2 * HOUR_MS + 1_000));
      await pass();
      expect((await schedules.runs(schedule.id)).runs[0]).toMatchObject({
        outcome: 'skipped',
        status: null,
        skipReason: 'previous_run_unfinished',
        conversationId: threadId,
      });

      // Anna declines; then she writes herself, and term 3 comes while the chat answers her
      const decision = waiting.decisions.find((one) => one.status === 'open')!;
      await anna.decide(decision.decisionId, { approve: false });
      await untilIdle(anna, threadId);
      const own = 'UC-2: and what about refunds?';
      const held = createLatch();
      const ownScript = harness.model.script({ task: own }, [
        { latch: held, text: 'Refunds are fine.' },
      ]);
      await anna.send(threadId, own);
      await ownScript.called(1);
      clock.set(later(start, 3 * HOUR_MS + 1_000));
      await pass();
      expect((await schedules.runs(schedule.id)).runs[0]).toMatchObject({
        outcome: 'skipped',
        skipReason: 'conversation_busy',
      });
      held.open();
      await untilIdle(anna, threadId);

      // Term 4: the run's message starts a deep agent, whose brief waits for a decision
      clock.set(later(start, 4 * HOUR_MS + 1_000));
      await pass();
      const briefed = await untilOpenDecision(anna, threadId);
      const page = await waitFor(
        () => schedules.runs(schedule.id),
        (runs) => runs.runs[0]?.status === 'awaiting_confirmation',
        'the deep agent run awaiting confirmation',
      );
      expect(
        page.runs.map((run) => [run.outcome, run.status, run.skipReason]),
      ).toEqual([
        ['started', 'awaiting_confirmation', null],
        ['skipped', null, 'conversation_busy'],
        ['skipped', null, 'previous_run_unfinished'],
        ['started', 'completed', null],
      ]);

      const mark = {
        scheduleId: schedule.id,
        name: 'Queue check',
        manual: false,
      };
      const messages = briefed.entries.filter(
        (entry) => entry.kind === 'user_message',
      );
      expect(
        messages.map((entry) =>
          entry.kind === 'user_message'
            ? [entry.content.text, entry.content.schedule]
            : [],
        ),
      ).toEqual([
        [instruction, mark],
        [own, null],
        [instruction, mark],
      ]);
    },
    TEST_TIMEOUT_MS,
  );

  // AC: AC-07.1, AC-07.2, DC-4, DC-5.
  // Catches: a run that starts although the rights or the quota were taken away since the schedule was made (a run that fails on its first
  //   model call), or a row stuck in `starting` after a refused start that retries forever.
  it(
    'UC-3: rights and quota are checked at the term; a refused start leaves a skip row and no conversation',
    async () => {
      const start = at('2030-05-06T08:00:00Z');
      clock.set(start);
      const hourly: ScheduleRule = { kind: 'every_hours', hours: 1 };

      // The agent of the chip: a system record the administrator shares with the role, then takes away
      const annaSession = await employee();
      const anna = chatApi(harness.app, annaSession);
      const record = await createSystemRecord(
        harness.app,
        admin,
        agentBody(recordName('UC-3 agent'), { model: MODEL }),
      );
      await setSystemAudience(harness.app, admin, record.id, {
        everyone: false,
        roleIds: [role.id],
      });
      const withAgent = await schedulesOf(anna).create(
        body({ rule: hourly, agentId: record.id }),
      );
      await setSystemAudience(harness.app, admin, record.id, {
        everyone: false,
      });

      // The quota: Carl's only right on the model is a personal one with a quota his first chat uses up
      const carlSession = await employee(false);
      await grantTo(
        harness.app,
        admin,
        { userId: carlSession.id },
        {
          effect: 'allow',
          target: { kind: 'model', model: MODEL },
          quotaUsd: 0.01,
        },
      );
      const carl = chatApi(harness.app, carlSession);
      // The conversation gets its title first (a background model call), so nothing of it runs after the count below
      // and no title call meets the exhausted quota.
      const carlThread = await conversation(
        carl,
        'UC-3: a cheap question',
        'A cheap answer.',
      );
      const spend = 'UC-3: an expensive question';
      harness.model.script({ task: spend }, [
        { text: 'An expensive answer.', usage: { inputTokens: 200_000 } },
      ]);
      await carl.send(carlThread, spend);
      await waitFor(
        () => carl.history(carlThread),
        (view) => {
          const last = view.entries.at(-1);
          return (
            view.chat.status === 'idle' &&
            last?.kind === 'model_answer' &&
            last.content.text === 'An expensive answer.'
          );
        },
        'the expensive answer',
      );
      const withoutQuota = await schedulesOf(carl).create(
        body({ rule: hourly }),
      );

      // The account: Dora is blocked before the term
      const dora = await employee();
      const ofBlocked = await schedulesOf(chatApi(harness.app, dora)).create(
        body({ rule: hourly }),
      );
      await block(dora);

      // Between the claim and the start: a `starting` row left behind, then Egor is blocked
      const egor = await employee();
      const refused = await schedulesOf(chatApi(harness.app, egor)).create(
        body({ rule: { kind: 'daily', time: '23:00' } }),
      );
      const startingId = await leftStarting(
        refused.id,
        at('2030-05-05T23:00:00Z'),
      );
      await block(egor);

      const callsBefore = harness.model.calls.length;
      clock.set(later(start, HOUR_MS + 1_000));
      await pass();

      for (const [schedule, reason] of [
        [withAgent, 'agent_unavailable'],
        [withoutQuota, 'quota_exhausted'],
        [ofBlocked, 'owner_disabled'],
      ] as const)
        expect(
          (await runRows(schedule.id)).map((row) => [
            row.outcome,
            row.skipReason,
            row.conversationId,
          ]),
        ).toEqual([['skipped', reason, null]]);
      expect(await runRows(refused.id)).toMatchObject([
        { id: startingId, outcome: 'skipped', skipReason: 'owner_disabled' },
      ]);
      expect(await conversationCount(startingId)).toBe(0);
      expect((await anna.listThreads()).threads).toEqual([]);
      expect(
        (await carl.listThreads()).threads.map((thread) => thread.id),
      ).toEqual([carlThread]);
      expect(harness.model.calls.length).toBe(callsBefore);
    },
    TEST_TIMEOUT_MS,
  );

  // AC: AC-01.2, AC-01.3, DC-1.
  // Catches: another employee reading or acting on a schedule (and through it, running an agent under the owner's rights) or binding a
  //   schedule to a conversation or agent they cannot see; a schedule bound to the owner's own non-chat root (a trainer or test run),
  //   whose term would fail for ever and starve the shared pass.
  it(
    'UC-4: another employee cannot see or act on a schedule, and cannot bind one to a foreign conversation or unavailable agent',
    async () => {
      const anna = chatApi(harness.app, await employee());
      const borisSession = await employee();
      const boris = chatApi(harness.app, borisSession);
      const annaThread = await conversation(
        anna,
        'UC-4: my conversation',
        'Mine.',
      );
      const schedule = await schedulesOf(anna).create(
        body({ rule: { kind: 'daily', time: '09:00' } }),
      );
      const before = await schedulesOf(anna).get(schedule.id);
      const runsBefore = await schedulesOf(anna).runs(schedule.id);

      expect((await schedulesOf(boris).list()).schedules).toEqual([]);
      const change = body({ rule: { kind: 'daily', time: '10:00' } });
      for (const [method, path, payload] of [
        ['get', `/schedules/${schedule.id}`, undefined],
        ['put', `/schedules/${schedule.id}`, change],
        ['post', `/schedules/${schedule.id}/pause`, undefined],
        ['post', `/schedules/${schedule.id}/resume`, undefined],
        ['post', `/schedules/${schedule.id}/run`, undefined],
        ['delete', `/schedules/${schedule.id}`, undefined],
        ['get', `/schedules/${schedule.id}/runs`, undefined],
      ] as const)
        expect(
          (await expectError(boris.raw(method, path, payload), 404)).errorCode,
        ).toBe('SCHEDULE_NOT_FOUND');
      expect(await schedulesOf(anna).get(schedule.id)).toEqual(before);
      expect(await schedulesOf(anna).runs(schedule.id)).toEqual(runsBefore);

      expect(
        (
          await expectError(
            boris.raw(
              'post',
              '/schedules',
              body({
                rule: { kind: 'daily', time: '09:00' },
                target: 'this_conversation',
                conversationId: annaThread,
              }),
            ),
            404,
          )
        ).errorCode,
      ).toBe('THREAD_NOT_FOUND');

      // Anna's own root that is not a chat (a test run's trainer root) refuses a run's message: a schedule on it is refused at
      // create, so it never holds the head of the due list
      await apiRequest(harness.app, admin, 'patch', `/admin/roles/${role.id}`, {
        trainOwn: true,
      }).expect(200);
      const testRunDescription = 'UC-4: a test run root';
      harness.model.script({ task: testRunDescription }, [{ text: 'Ready.' }]);
      const { testRunId } = await expectBody(
        anna.raw('post', '/test-runs', { description: testRunDescription }),
        201,
        TestRunStartedSchema,
      );
      expect(
        (
          await expectError(
            anna.raw(
              'post',
              '/schedules',
              body({
                rule: { kind: 'daily', time: '09:00' },
                target: 'this_conversation',
                conversationId: testRunId,
              }),
            ),
            404,
          )
        ).errorCode,
      ).toBe('THREAD_NOT_FOUND');
      const borisRecord = await createRecord(
        harness.app,
        borisSession,
        agentBody(recordName('UC-4 Boris agent'), { model: MODEL }),
      );
      expect(
        (
          await expectError(
            anna.raw(
              'post',
              '/schedules',
              body({
                rule: { kind: 'daily', time: '09:00' },
                agentId: borisRecord.id,
              }),
            ),
            404,
          )
        ).errorCode,
      ).toBe('RECORD_NOT_FOUND');
      expect((await schedulesOf(boris).list()).schedules).toEqual([]);
      expect(
        (await schedulesOf(anna).list()).schedules.map((one) => one.id),
      ).toEqual([schedule.id]);
    },
    TEST_TIMEOUT_MS,
  );

  // AC: AC-03.2, AC-06.1, AC-06.2, DC-3, NFR-04.
  // Catches: a lost or doubled run after a restart at any point between claim, start and mark, and a double start under concurrency
  //   (what the unique index on the term and the `TASK_EXISTS` path guard).
  it(
    'UC-5: restart and concurrency give each term one run: catch-up, a `starting` row finished, pass vs "Run now"',
    async () => {
      const start = at('2030-06-03T08:00:00Z');
      clock.set(start);
      const annaSession = await employee();
      const anna = chatApi(harness.app, annaSession);
      const schedules = schedulesOf(anna);
      const hourly = await schedules.create(
        body({ rule: { kind: 'every_hours', hours: 1 } }),
      );
      const once = await schedules.create(
        body({ rule: { kind: 'once', date: '2030-06-03', time: '09:30' } }),
      );
      for (const schedule of [hourly, once])
        harness.model.script({ task: schedule.instruction }, [
          { text: 'Done.' },
        ]);

      // (b) a `starting` row without its conversation, and one whose conversation the dead process already made — of an owner
      //     blocked since, so a repeated start would be refused
      const daily = await schedules.create(
        body({ rule: { kind: 'daily', time: '23:00' } }),
      );
      const withoutConversation = await leftStarting(
        daily.id,
        at('2030-06-02T23:00:00Z'),
      );
      const fyodorSession = await employee();
      const fyodor = chatApi(harness.app, fyodorSession);
      const fyodorDaily = await schedulesOf(fyodor).create(
        body({ rule: { kind: 'daily', time: '23:00' } }),
      );
      const withConversation = randomUUID();
      const firstMessage = 'UC-5: the run the dead process started';
      harness.model.script({ task: firstMessage }, [{ text: 'Started.' }]);
      await fyodor.send(withConversation, firstMessage);
      await untilIdle(fyodor, withConversation);
      await harness.app.get(SchedulesRepository).insertRuns([
        {
          id: withConversation,
          scheduleId: fyodorDaily.id,
          dueAt: at('2030-06-02T23:00:00Z'),
          manual: false,
          outcome: 'starting',
        },
      ]);
      await block(fyodorSession);
      harness.model.script({ task: daily.instruction }, [{ text: 'Done.' }]);

      // (a) the server stands through three hourly terms and the `once` term; the restart boots a new app over the same
      //     database, clock and model double
      await harness.close();
      clock.set(later(start, 3 * HOUR_MS + 30 * 60_000));
      harness = await createTestApp(appOptions());
      // The clients of the closed app reach nothing: Anna's session (a database row) goes on in the new one.
      const annaNow = chatApi(harness.app, annaSession);
      const schedulesNow = schedulesOf(annaNow);
      await pass();
      await untilSettled([hourly.id, once.id, daily.id, fyodorDaily.id]);

      expect(
        (await runRows(hourly.id)).map((row) => [
          row.dueAt.toISOString(),
          row.outcome,
          row.skipReason,
        ]),
      ).toEqual([
        ['2030-06-03T09:00:00.000Z', 'skipped', 'server_down'],
        ['2030-06-03T10:00:00.000Z', 'skipped', 'server_down'],
        ['2030-06-03T11:00:00.000Z', 'started', null],
      ]);
      expect((await schedulesNow.get(hourly.id)).nextRunAt).toBe(
        '2030-06-03T12:00:00.000Z',
      );
      expect(await runRows(once.id)).toMatchObject([
        { outcome: 'started', skipReason: null },
      ]);
      expect(await schedulesNow.get(once.id)).toMatchObject({
        state: 'completed',
        nextRunAt: null,
      });

      // (b) one conversation and one started row for each left-behind term
      for (const id of [withoutConversation, withConversation]) {
        expect(await conversationCount(id)).toBe(1);
        const { rows } = await harness.pool.query<{ outcome: string }>(
          'SELECT outcome FROM app.schedule_runs WHERE id = $1',
          [id],
        );
        expect(rows).toEqual([{ outcome: 'started' }]);
      }
      expect(await runRows(daily.id)).toHaveLength(1);
      expect(await runRows(fyodorDaily.id)).toHaveLength(1);

      // (c) the pass and «Run now» at once: one run starts, the other sees it unfinished. The hourly schedule is paused, so
      //     its next term makes no conversation of its own; the race's run is held by its model answer, so it stays working.
      await schedulesNow.pause(hourly.id);
      const raced = await schedulesNow.create(
        body({ rule: { kind: 'every_hours', hours: 1 } }),
      );
      const held = createLatch();
      harness.model.script({ task: raced.instruction }, [
        { latch: held, text: 'Raced.' },
      ]);
      try {
        clock.set(later(clock.now(), HOUR_MS + 1_000));
        const threadsBefore = (await annaNow.listThreads()).threads.length;
        await Promise.all([pass(), schedulesNow.runNow(raced.id)]);
        await pass();
        await untilSettled([raced.id]);
        const rows = await runRows(raced.id);
        expect(
          rows
            .map((row) => `${row.outcome} ${row.skipReason ?? ''}`.trim())
            .sort((a, b) => a.localeCompare(b)),
        ).toEqual(['skipped previous_run_unfinished', 'started']);
        expect((await annaNow.listThreads()).threads).toHaveLength(
          threadsBefore + 1,
        );
      } finally {
        held.open();
      }
    },
    TEST_TIMEOUT_MS,
  );

  // AC: AC-02.1, AC-02.2, AC-02.3, AC-09.1, AC-09.2, AC-10.1, AC-11.1, DC-2, DC-6.
  // Catches: a paused schedule that catches up on resume, an edit that keeps the old term, a schedule that keeps answering into a deleted
  //   conversation, a finished run that turns «stopped» or still links its conversation once it is deleted, or a delete that takes the run
  //   conversations with it.
  it(
    'UC-6: schedule life: pause and resume, edit, run now, deleted conversation, past time, delete',
    async () => {
      clock.set(at('2030-07-01T08:00:00Z'));
      const anna = chatApi(harness.app, await employee());
      const schedules = schedulesOf(anna);
      const threadId = await conversation(
        anna,
        'UC-6: the daily report conversation',
        'Ready.',
      );
      const nineDaily: ScheduleRule = { kind: 'daily', time: '09:00' };
      const here = await schedules.create(
        body({
          name: 'Here',
          rule: nineDaily,
          target: 'this_conversation',
          conversationId: threadId,
        }),
      );
      const elsewhereBody = body({
        name: 'Elsewhere',
        rule: nineDaily,
        conversationId: threadId,
      });
      const elsewhere = await schedules.create(elsewhereBody);
      harness.model.script({ task: here.instruction }, [{ text: 'Here.' }], {
        thereafter: { text: 'Here again.' },
      });
      harness.model.script(
        { task: elsewhere.instruction },
        [{ text: 'Elsewhere.' }],
        { thereafter: { text: 'Elsewhere again.' } },
      );

      // Paused through three terms: no rows, and the resume starts from the nearest future term
      for (const schedule of [here, elsewhere])
        expect(await schedules.pause(schedule.id)).toMatchObject({
          state: 'paused',
          nextRunAt: null,
        });
      clock.set(at('2030-07-03T11:00:00Z'));
      await pass();
      for (const schedule of [here, elsewhere]) {
        expect((await schedules.runs(schedule.id)).runs).toEqual([]);
        expect(await schedules.resume(schedule.id)).toMatchObject({
          state: 'active',
          nextRunAt: '2030-07-04T09:00:00.000Z',
        });
      }

      // The edit at 8:30 moves the term from 9:00 to 10:00
      clock.set(at('2030-07-04T08:30:00Z'));
      expect(
        await schedules.put(elsewhere.id, {
          ...elsewhereBody,
          rule: { kind: 'daily', time: '10:00' },
        }),
      ).toMatchObject({ nextRunAt: '2030-07-04T10:00:00.000Z' });
      clock.set(at('2030-07-04T09:30:00Z'));
      await pass();
      expect((await schedules.runs(elsewhere.id)).runs).toEqual([]);
      const hereDone = () =>
        waitFor(
          () => schedules.runs(here.id),
          (page) => page.runs[0]?.status === 'completed',
          'the this-conversation run completed',
        );
      await hereDone();
      clock.set(at('2030-07-04T10:00:30Z'));
      await pass();
      expect((await schedules.runs(elsewhere.id)).runs).toMatchObject([
        { dueAt: '2030-07-04T10:00:00.000Z', outcome: 'started' },
      ]);

      // «Run now»: a manual row, the term stays
      const manual = await schedules.runNow(here.id);
      expect(manual).toMatchObject({
        manual: true,
        outcome: 'started',
        conversationId: threadId,
      });
      expect((await schedules.get(here.id)).nextRunAt).toBe(
        '2030-07-05T09:00:00.000Z',
      );
      await hereDone();

      // The conversation is deleted: «this conversation» pauses and refuses to run, «new conversation» goes on
      await anna.deleteThread(threadId);
      expect(await schedules.get(here.id)).toMatchObject({
        state: 'paused',
        pausedBecause: 'conversation_deleted',
        conversation: { id: threadId, deleted: true },
      });
      // Its runs that were over keep «completed» and no longer offer the deleted conversation
      expect((await schedules.runs(here.id)).runs).toMatchObject([
        { manual: true, status: 'completed', conversationId: null },
        { manual: false, status: 'completed', conversationId: null },
      ]);
      for (const action of ['resume', 'run'])
        expect(
          (
            await expectError(
              anna.raw('post', `/schedules/${here.id}/${action}`),
              409,
            )
          ).errorCode,
        ).toBe('SCHEDULE_NOT_RUNNABLE');
      await waitFor(
        () => schedules.runs(elsewhere.id),
        (page) => page.runs[0]?.status === 'completed',
        'the first new-conversation run completed',
      );
      clock.set(at('2030-07-05T10:00:30Z'));
      await pass();
      const elsewhereRuns = (await schedules.runs(elsewhere.id)).runs;
      expect(elsewhereRuns.map((run) => run.outcome)).toEqual([
        'started',
        'started',
      ]);

      // A `once` time in the past is refused
      expect(
        (
          await expectError(
            anna.raw(
              'post',
              '/schedules',
              body({
                rule: { kind: 'once', date: '2030-07-01', time: '09:00' },
              }),
            ),
            400,
          )
        ).errorCode,
      ).toBe('VALIDATION_FAILED');

      // Deleting a schedule takes its history, not its run conversations
      expect(
        (await anna.raw('delete', `/schedules/${elsewhere.id}`)).status,
      ).toBe(204);
      expect(
        (await expectError(anna.raw('get', `/schedules/${elsewhere.id}`), 404))
          .errorCode,
      ).toBe('SCHEDULE_NOT_FOUND');
      expect(await runRows(elsewhere.id)).toEqual([]);
      for (const run of elsewhereRuns)
        expect((await anna.getThread(run.conversationId!)).id).toBe(
          run.conversationId,
        );
      expect((await schedules.list()).schedules.map((one) => one.id)).toEqual([
        here.id,
      ]);
    },
    TEST_TIMEOUT_MS,
  );
});
