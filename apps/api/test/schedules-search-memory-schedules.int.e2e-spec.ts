// schedules-search-memory / schedules - API integration (real AppModule + real Postgres, two employees, scripted model)
// Design Doc: docs/features/schedules-search-memory/design-schedules.md, Test Strategy UC-1 .. UC-6.
// PRD: docs/features/schedules-search-memory/prd.md. UXRD: docs/features/schedules-search-memory/uxrd.md.
//
// Harness: `createTestApp({ workers: true, mcpServers: ['backoffice'], clock })`: the scripted model double of `@agent-os/agents/testing`
//   behind the model, the MCP fixture for the changing call of UC-2. Time is the replaced runtime `CLOCK`, a clock the test sets; it only
//   moves forward, each case in its own month. The test calls the pass directly (`ScheduleTriggersService.pass`); with workers on the
//   background pass also runs on its own timer, so the cases wait for rows and check the result, not which pass claimed a term. A restart
//   is `close()` and a new `createTestApp()` over the same clock and model. Blocking an employee ends their sessions, so their rows are read
//   from the database. The scripted model finds a script by the latest user message, so every message text is unique in this file.
//   Run only against a test database (DATABASE_URL): this config migrates it on load.
//
// Not repeated here (one proof per rule, lower level):
//   - the due-time rule (four kinds, week, DST zone, skipped terms): ONE table-driven unit test of the pure function (schedule-rule.spec.ts).
//   - the confirmation card itself and the quota failure of a chat: the enterprise-access and deep-agents suites.
//   - NFR-03 (pass period under a minute) is a constant, not tested; NFR-05 (360 px) is checked in a browser during the screens.

import { randomUUID } from 'node:crypto';
import { createLatch } from '@agent-os/agents/testing';
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
import { waitFor } from '@agent-os/db/testing';
import { fixtureCallsOf } from '@agent-os/mcp-fixture';
import { type Clock, systemClock } from '@agent-os/runtime';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ScheduleTriggersService } from '../src/schedules/schedule-triggers.service';
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
  return harness.app.get(ScheduleTriggersService).pass();
}

function body(
  fields: Partial<ScheduleBody> & { rule: ScheduleRule },
): ScheduleBody {
  return {
    instruction: `Instruction ${randomUUID()}`,
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
  readonly conversationId: string | null;
  readonly manual: boolean;
  readonly dueAt: Date;
}

async function runRows(scheduleId: string): Promise<RunRow[]> {
  const { rows } = await harness.pool.query<RunRow>(
    `SELECT id, conversation_id AS "conversationId", manual, due_at AS "dueAt"
       FROM app.schedule_runs WHERE schedule_id = $1 ORDER BY due_at, id`,
    [scheduleId],
  );
  return rows;
}

/** Waits until the schedule has `count` history rows: the app's background pass may be the one that claims a term. */
function untilRuns(scheduleId: string, count: number): Promise<RunRow[]> {
  return waitFor(
    () => runRows(scheduleId),
    (rows) => rows.length >= count,
    `${count} history rows`,
  );
}

/** The schedule's next term as the database holds it: an owner blocked since has no session to read it with. */
async function nextRunAt(scheduleId: string): Promise<string | null> {
  const { rows } = await harness.pool.query<{ nextRunAt: Date | null }>(
    'SELECT next_run_at AS "nextRunAt" FROM app.schedules WHERE id = $1',
    [scheduleId],
  );
  return rows[0]?.nextRunAt?.toISOString() ?? null;
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

/** The `user_message` entries of a conversation as text and schedule mark, in order. */
function userMessages(view: ConversationView): [string, unknown][] {
  return view.entries.flatMap((entry): [string, unknown][] =>
    entry.kind === 'user_message'
      ? [[entry.content.text, entry.content.schedule]]
      : [],
  );
}

describe('schedules: due terms trigger one send of the instruction', () => {
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

  // The next case's clock passes every term of this one's schedules: they go, the trigger conversations stay.
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

  // AC: AC-01.1, AC-03.1, AC-03.3, AC-04.1, AC-08.1.
  // Catches: a term that triggers twice under two concurrent passes, or a trigger without its new conversation, mark, title or history
  //   row — the main path broken at any link of claim -> send -> row; and a new conversation whose agent never runs (an object handed to
  //   the runtime before the claim commits, KD-2).
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

      clock.set(at('2030-03-04T09:00:30Z'));
      await Promise.all([pass(), pass()]);
      await untilRuns(created.id, 1);
      await pass();

      const { threads } = await anna.listThreads();
      expect(threads).toHaveLength(1);
      const thread = threads[0]!;
      expect(thread.title).toBe('Morning summary · Mar 4');
      const view = await waitFor(
        () => anna.history(thread.id),
        (seen) =>
          seen.chat.status === 'idle' &&
          seen.entries.at(-1)?.kind === 'model_answer',
        'the answer of the new conversation',
      );
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
        content: { text: 'Night summary.' },
      });

      const { runs } = await schedules.runs(created.id);
      expect(runs).toEqual([
        {
          id: expect.any(String),
          dueAt: '2030-03-04T09:00:00.000Z',
          manual: false,
          conversationId: thread.id,
        },
      ]);
      expect((await schedules.get(created.id)).nextRunAt).toBe(
        '2030-03-05T09:00:00.000Z',
      );
    },
    TEST_TIMEOUT_MS,
  );

  // AC: AC-04.2, AC-04.3, AC-07.3.
  // Catches: a this-conversation term that is dropped while the agent works or waits for a confirmation, or a queued schedule message
  //   taken as the answer to the confirmation (a changing MCP call sent without the employee's decision), or a schedule message that
  //   looks like the employee's own.
  it(
    'UC-2: this-conversation terms queue marked messages while the agent waits for a confirmation or answers the employee',
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
      harness.model.script(
        { task: instruction },
        [
          {
            calls: [
              {
                tool: CREATE_NOTE,
                args: { orderId: 'ORD-9001', text: 'Queue is stuck' },
              },
            ],
          },
        ],
        { thereafter: { text: 'Queue checked.' } },
      );
      const schedule = await schedules.create(
        body({
          name: 'Queue check',
          instruction,
          rule: { kind: 'every_hours', hours: 1 },
          target: 'this_conversation',
          conversationId: threadId,
        }),
      );

      // Term 1: the message asks for a changing call, which waits for a decision
      clock.set(later(start, HOUR_MS + 1_000));
      await pass();
      const waiting = await untilOpenDecision(anna, threadId);

      // Term 2 while the decision is open: the message is queued, the decision stays open and nothing is sent
      clock.set(later(start, 2 * HOUR_MS + 1_000));
      await pass();
      await untilRuns(schedule.id, 2);
      const queued = await anna.history(threadId);
      expect(
        queued.decisions.filter((decision) => decision.status === 'open'),
      ).toHaveLength(1);
      expect(queued.pending).toMatchObject([
        { source: 'user', text: instruction },
      ]);
      expect(
        fixtureCallsOf(harness.fixtureLog.callLog, {
          tool: 'create_incident_note',
        }),
      ).toEqual([]);

      // Anna declines; the queued message is read after her decision
      const decision = waiting.decisions.find((one) => one.status === 'open')!;
      await anna.decide(decision.decisionId, { approve: false });
      await waitFor(
        () => anna.history(threadId),
        (view) =>
          view.chat.status === 'idle' &&
          userMessages(view).length === 2 &&
          view.pending.length === 0,
        'the queued message read after the decision',
      );

      // Term 3 while the agent answers Anna's own message
      const own = 'UC-2: and what about refunds?';
      const held = createLatch();
      const ownScript = harness.model.script({ task: own }, [
        { latch: held, text: 'Refunds are fine.' },
      ]);
      await anna.send(threadId, own);
      await ownScript.called(1);
      clock.set(later(start, 3 * HOUR_MS + 1_000));
      await pass();
      await untilRuns(schedule.id, 3);
      held.open();
      const done = await waitFor(
        () => anna.history(threadId),
        (view) =>
          view.chat.status === 'idle' &&
          userMessages(view).length === 4 &&
          view.pending.length === 0,
        'the third schedule message answered',
      );

      expect(
        (await runRows(schedule.id)).map((row) => row.conversationId),
      ).toEqual([threadId, threadId, threadId]);
      const mark = {
        scheduleId: schedule.id,
        name: 'Queue check',
        manual: false,
      };
      expect(userMessages(done)).toEqual([
        [instruction, mark],
        [instruction, mark],
        [own, null],
        [instruction, mark],
      ]);
      expect(done.entries.at(-1)).toMatchObject({
        kind: 'model_answer',
        content: { text: 'Queue checked.' },
      });
      expect(
        fixtureCallsOf(harness.fixtureLog.callLog, {
          tool: 'create_incident_note',
        }),
      ).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  // AC: AC-07.1, AC-07.2, DC-3.
  // Catches: a trigger that runs although the chip agent's right or the account was taken away since the schedule was made, or a refusal
  //   that leaves the term due (the schedule heads the due list and repeats the refusal on every pass); and an exhausted quota that
  //   silently drops the trigger instead of failing the agent in its conversation.
  it(
    'UC-3: a refused chip or a disabled owner consume the term without a conversation; an exhausted quota fails the agent in one',
    async () => {
      const start = at('2030-05-06T08:00:00Z');
      clock.set(start);
      const hourly: ScheduleRule = { kind: 'every_hours', hours: 1 };

      // The chip agent: a system record the administrator shares with the role, then takes away
      const anna = chatApi(harness.app, await employee());
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
        (view) =>
          view.chat.status === 'idle' &&
          view.entries.at(-1)?.kind === 'model_answer',
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

      clock.set(later(start, HOUR_MS + 1_000));
      await pass();
      for (const schedule of [withAgent, withoutQuota, ofBlocked])
        await untilRuns(schedule.id, 1);
      await pass();

      const nextTerm = later(start, 2 * HOUR_MS).toISOString();
      for (const schedule of [withAgent, ofBlocked]) {
        expect(
          (await runRows(schedule.id)).map((row) => row.conversationId),
        ).toEqual([null]);
        expect(await nextRunAt(schedule.id)).toBe(nextTerm);
      }
      expect((await anna.listThreads()).threads).toEqual([]);

      const [quotaRun] = await runRows(withoutQuota.id);
      expect(await runRows(withoutQuota.id)).toHaveLength(1);
      expect(await nextRunAt(withoutQuota.id)).toBe(nextTerm);
      const failed = await waitFor(
        () => carl.history(quotaRun!.conversationId!),
        (view) => view.chat.status === 'failed',
        'the quota failure in the trigger conversation',
      );
      expect(failed.chat.failureReason).toBe('quota_exhausted');
    },
    TEST_TIMEOUT_MS,
  );

  // AC: AC-01.2, AC-01.3, DC-1.
  // Catches: another employee reading or acting on a schedule (and through it, running an agent under the owner's rights) or binding a
  //   schedule to a conversation or agent they cannot see; a schedule bound to the owner's own non-chat root (a test run).
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
      expect(await runRows(schedule.id)).toEqual([]);

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

      // Anna's own root that is not a chat (a test run's trainer root) would refuse a trigger's message
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

  // AC: AC-03.2, AC-06.1, AC-06.2, NFR-04.
  // Catches: a server that was down for several terms triggering once per missed term (or not at all), a `once` schedule triggering
  //   again after its term, and a pass after the catch-up that triggers a second time.
  it(
    'UC-5: after downtime one catch-up trigger for the last missed term, and a `once` schedule triggers once and completes',
    async () => {
      const start = at('2030-06-03T08:00:00Z');
      clock.set(start);
      const annaSession = await employee();
      const schedules = schedulesOf(chatApi(harness.app, annaSession));
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

      // The server stands through three hourly terms and the `once` term; the restart boots a new app over the same database,
      // clock and model double. Its first pass runs at start, beside the test's.
      await harness.close();
      clock.set(later(start, 3 * HOUR_MS + 30 * 60_000));
      harness = await createTestApp(appOptions());
      const schedulesNow = schedulesOf(chatApi(harness.app, annaSession));
      await pass();
      await untilRuns(hourly.id, 1);
      await untilRuns(once.id, 1);
      await pass();

      expect(
        (await runRows(hourly.id)).map((row) => row.dueAt.toISOString()),
      ).toEqual(['2030-06-03T11:00:00.000Z']);
      expect((await schedulesNow.get(hourly.id)).nextRunAt).toBe(
        '2030-06-03T12:00:00.000Z',
      );
      expect(
        (await runRows(once.id)).map((row) => row.dueAt.toISOString()),
      ).toEqual(['2030-06-03T09:30:00.000Z']);
      expect(await schedulesNow.get(once.id)).toMatchObject({
        state: 'completed',
        nextRunAt: null,
      });
      for (const schedule of [hourly, once])
        expect((await runRows(schedule.id))[0]?.conversationId).not.toBeNull();
    },
    TEST_TIMEOUT_MS,
  );

  // AC: AC-02.1, AC-02.2, AC-02.3, AC-08.2, AC-09.1, AC-09.2, AC-10.1, AC-11.1, DC-2, DC-4.
  // Catches: a paused schedule that catches up on resume, an edit that keeps the old term, «Run now» that moves the term, a schedule
  //   that keeps writing into a deleted conversation (or a run now that writes a row there), a history row that still links a deleted
  //   conversation, or a delete that takes the trigger conversations with it.
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
      harness.model.script({ task: here.instruction }, [], {
        thereafter: { text: 'Here.' },
      });
      harness.model.script({ task: elsewhere.instruction }, [], {
        thereafter: { text: 'Elsewhere.' },
      });

      // Paused through three terms: no rows, and the resume starts from the nearest future term
      for (const schedule of [here, elsewhere])
        expect(await schedules.pause(schedule.id)).toMatchObject({
          state: 'paused',
          nextRunAt: null,
        });
      clock.set(at('2030-07-03T11:00:00Z'));
      await pass();
      for (const schedule of [here, elsewhere]) {
        expect(await runRows(schedule.id)).toEqual([]);
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
      await untilRuns(here.id, 1);
      expect(await runRows(elsewhere.id)).toEqual([]);
      clock.set(at('2030-07-04T10:00:30Z'));
      await pass();
      const [firstElsewhere] = await untilRuns(elsewhere.id, 1);
      expect(firstElsewhere).toMatchObject({
        dueAt: at('2030-07-04T10:00:00Z'),
        manual: false,
      });
      expect(firstElsewhere!.conversationId).not.toBe(threadId);

      // «Run now»: a manual row into the conversation, the state and the term stay
      const manual = await schedules.runNow(here.id);
      expect(manual).toMatchObject({ manual: true, conversationId: threadId });
      expect(await schedules.get(here.id)).toMatchObject({
        state: 'active',
        nextRunAt: '2030-07-05T09:00:00.000Z',
      });
      await waitFor(
        () => anna.history(threadId),
        (view) =>
          view.chat.status === 'idle' &&
          userMessages(view).length === 2 &&
          view.pending.length === 0,
        'both triggers answered in the conversation',
      );

      // «Run now» on a paused «new conversation» schedule (AC-11.1): a manual row with its new conversation, still paused, no term
      await schedules.pause(elsewhere.id);
      const pausedManual = await schedules.runNow(elsewhere.id);
      expect(pausedManual).toMatchObject({ manual: true });
      expect(pausedManual.conversationId).toEqual(expect.any(String));
      expect(pausedManual.conversationId).not.toBe(threadId);
      expect(await schedules.get(elsewhere.id)).toMatchObject({
        state: 'paused',
        nextRunAt: null,
      });
      expect(await runRows(elsewhere.id)).toHaveLength(2);
      await untilIdle(anna, pausedManual.conversationId!);
      expect(await schedules.resume(elsewhere.id)).toMatchObject({
        state: 'active',
        nextRunAt: '2030-07-05T10:00:00.000Z',
      });

      // The conversation is deleted: its rows no longer offer it, «Run now» is refused and writes nothing, and the next term
      // pauses «this conversation» without a row while «new conversation» goes on
      await anna.deleteThread(threadId);
      expect((await schedules.runs(here.id)).runs).toMatchObject([
        { manual: true, conversationId: null },
        { manual: false, conversationId: null },
      ]);
      expect(
        (await expectError(anna.raw('post', `/schedules/${here.id}/run`), 409))
          .errorCode,
      ).toBe('SCHEDULE_NOT_RUNNABLE');
      expect(await runRows(here.id)).toHaveLength(2);
      clock.set(at('2030-07-05T10:00:30Z'));
      await pass();
      await untilRuns(elsewhere.id, 3);
      await waitFor(
        () => schedules.get(here.id),
        (view) => view.state === 'paused',
        'the schedule paused at its term',
      );
      expect(await schedules.get(here.id)).toMatchObject({
        state: 'paused',
        pausedBecause: 'conversation_deleted',
        nextRunAt: null,
        conversation: { id: threadId, deleted: true },
      });
      expect(await runRows(here.id)).toHaveLength(2);
      for (const action of ['resume', 'run'])
        expect(
          (
            await expectError(
              anna.raw('post', `/schedules/${here.id}/${action}`),
              409,
            )
          ).errorCode,
        ).toBe('SCHEDULE_NOT_RUNNABLE');

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

      // Deleting a schedule takes its history, not its trigger conversations
      const elsewhereRuns = await runRows(elsewhere.id);
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
