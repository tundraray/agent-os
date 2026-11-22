// deep-agents / agent-types - E2E journey (real AppModule + real Postgres + real SessionGuard, runtime workers ON, scripted model)
// Design Doc: docs/features/deep-agents/design-agent-types.md, Flow 1, Flow 2, KD-3, KD-6, Test Strategy UC-4 and UC-6 (the chain only);
//   docs/features/deep-agents/design-task-list.md, KD-4, KD-5, Test Strategy UC-4 (the main path of the session task list)
// PRD: docs/features/deep-agents/prd.md FR-01, FR-03, FR-04, FR-05, FR-06, FR-27, FR-28 (AC-01.2, AC-03.1, AC-04.1, AC-05.2, AC-06.1, AC-27.1, AC-28.1, AC-28.3);
//   FR-12, FR-14, FR-15 (AC-12.1, AC-14.4, AC-15.1 - the data of the route)
// Test type: End-to-end (HTTP routes of the API; the browser is not in it). First run is the feature's full run.
//
// Harness: as the integration file next to it; the scripted model answers the chat root, the deep agent and the subagents, each script keyed by its first task (the
// conversation's first message, the brief JSON, the subagent's assignment). Decisions go through the decision route of the conversation; the stream is not read, the
// conversation view and `GET /api/agents/:agentId/tasks` are polled with `waitFor`. The conversation view with `focus` is the route that returns it in code,
// `GET /api/threads/:threadId/history` (plan Snapshot, question 2).
//
// Budget: E2E 1 of 1-2 — the main path of the part named in the PRD.
//
// Not repeated here (proven at a lower level): the card refusals, the stale version and the administrator edit (INT-1, INT-2 next to this file); the task list surviving
// a replayed step, a restart and compaction, and the block in every model call (UC-3 of packages/agents); the rules of the list (task-rules.spec.ts); the end-of-turn
// branch by session kind (turn-rules.spec.ts); the brief's own lifecycle (agent-platform-chat INT-2 D); the research team's
// run (agents agent-platform-workflows INT-2 A / INT-3 B); the schema rule of 11 subagents (unit, contracts) — step 1 only shows the record tool's arguments ARE that schema.
//
// acProof of this file: AC-06.1, AC-01.2, AC-28.1 (the `focus` half), AC-27.1 (wiring), AC-12.1 and AC-15.1 for the chat's list: E2E-1 steps 1-3; AC-03.1 (a record
// made by the chat starts after a brief), AC-04.1 (read route), AC-05.2, AC-28.3 (the `started` focus), AC-12.1 and AC-14.4 for the deep agent's list: E2E-1 steps 4-6

import { randomUUID } from 'node:crypto';
import { createLatch, type ScriptedToolCall } from '@agent-os/agents/testing';
import {
  AGENTS_BRIEF_CONFIRMATION,
  RunTaskListViewSchema,
  type AgentNode,
  type ConversationView,
  type CreateRecordBody,
} from '@agent-os/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  allowRole,
  HAIKU_TEST_PRICES,
  removeRunRows,
  runModel,
  type RunRole,
  useRunModels,
} from './support/access';
import { chatApi, expectBody, expectError, waitFor } from './support/api';
import { createTestApp, type TestApp } from './support/createTestApp';
import { deepAgentBody, getRecord, listLibrary, pointBuiltinsAt, recordName } from './support/library';
import { createArgs, pendingCardOf, recordToolCall, toolResultsOf } from './support/record-tools';
import { createEmployee, seedSuperAdmin, type Session } from './support/session';

const TEST_TIMEOUT_MS = 300_000;

const MODEL = runModel('haiku-journey');
const TITLE = 'Глубокий агент из чата';

const ASK = 'Сделай глубокого агента для разбора логов: сбор и ответ';
const CREATED = 'Глубокий агент создан.';
const RUN_REQUEST = 'запусти его по логам за ночь';
const STARTED = 'Запустил разбор.';
const QUESTION = 'Что было в логах за ночь?';
/** The chat's own tasks: three created, the first started with its `activeForm`. */
const CHAT_TASKS = ['Описать глубокого агента', 'Создать запись', 'Запустить разбор'] as const;
const CHAT_ACTIVE = 'Описываю глубокого агента';
/** The deep agent's tasks, one per subagent. */
const DEEP_TASKS = ['Собрать логи за ночь', 'Написать ответ'] as const;
const GATHER = 'сбор';
const ANSWER = 'ответ';
const GATHER_TASK = 'Собери логи за ночь и перечисли ошибки';
const ANSWER_TASK = 'Напиши ответ по собранным логам';
const GATHER_REPORT = 'Ночью было три ошибки оплаты.';
const ANSWER_REPORT = 'Ночью было три ошибки оплаты, все в 03:10 UTC; причина — таймаут шлюза.';

let harness: TestApp;
let admin: Session;
let role: RunRole;
let restoreModels: (() => Promise<void>) | undefined;
let restoreBuiltins: (() => Promise<void>) | undefined;
const made = { users: [] as string[], roles: [] as string[] };

/** The brief as `start_deep_agent` writes it into the deep agent's first task. */
function briefTask(question: string): string {
  return JSON.stringify({ question, boundaries: '', result: '' });
}

function taskCreate(subject: string, activeForm?: string): ScriptedToolCall {
  return {
    tool: 'task_create',
    args: { subject, description: `Описание: ${subject}`, ...(activeForm === undefined ? {} : { activeForm }) },
  };
}

function taskUpdate(taskId: number, status: string): ScriptedToolCall {
  return { tool: 'task_update', args: { taskId, status } };
}

function startSubagent(agent: string, description: string, prompt: string): ScriptedToolCall {
  return { tool: 'start_agent', args: { agent, description, prompt } };
}

/** The deep agent «Разбор логов»: subagents «сбор» and «ответ», the second final. */
function journeyBody(name: string, subagentCount = 2): CreateRecordBody {
  const body = deepAgentBody(
    name,
    MODEL,
    Array.from({ length: subagentCount }, (_, index) => ({
      name: index === 0 ? GATHER : index === 1 ? ANSWER : `сбор ${index}`,
      description: index === 1 ? 'Пишет ответ по собранному' : 'Собирает логи',
    })),
  );
  return { ...body, content: { ...body.content, finalSubagent: ANSWER } };
}

function treeOf(nodes: readonly AgentNode[]): AgentNode[] {
  return nodes.flatMap((node) => [node, ...treeOf(node.children)]);
}

async function newEmployee(): Promise<Session> {
  const session = await createEmployee(harness.app, admin);
  made.users.push(session.id);
  await role.add(session);
  return session;
}

describe('deep-agents / agent-types - a deep agent made in chat is the same record the runtime starts, and its task list and report come back through the API', () => {
  beforeAll(async () => {
    harness = await createTestApp({ workers: true });
    harness.model.completeText({ text: TITLE });
    admin = await seedSuperAdmin(harness.app, `e2e-journey-admin-${randomUUID()}`);
    made.users.push(admin.id);
    restoreModels = await useRunModels(harness.app, admin, { chat: { id: MODEL, ...HAIKU_TEST_PRICES } });
    restoreBuiltins = await pointBuiltinsAt(harness.app, admin, MODEL);
    role = await allowRole(harness.app, admin, { name: 'records-journey', models: [MODEL], servers: [] });
    made.roles.push(role.id);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (harness === undefined) return;
    try {
      try {
        await restoreBuiltins?.();
        await restoreModels?.();
      } finally {
        await removeRunRows(harness.pool, { models: [MODEL], roles: made.roles, users: made.users });
      }
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  // E2E-1: the chat keeps its own tasks -> describe a deep agent in chat -> confirm the card -> it is in the library and in focus -> start it by brief -> its task list
  //   is readable -> an answer with an open task gets a notice -> the report is the answer
  // Catches: a deep agent that the chat creates but the runtime cannot start (the saved content differs from what `resolveStart` snapshots), a `focus` that does not move from
  //   `created` to `started`, a route that does not give the chat's own tasks at the root or the deep agent's to its owner, a deep agent that ends its turn with an open
  //   task, an answer that is not the final subagent's report.
  it(
    "E2E-1: a deep agent described in chat is created through the card, is the record the runtime starts by brief, and shows the chat's and its own task lists and its final subagent's report through the API",
    async () => {
      const employee = await newEmployee();
      const other = await newEmployee();
      const api = chatApi(harness.app, employee);
      const name = recordName('Разбор логов');
      const gatherHeld = createLatch();
      let createdId: string | undefined;

      harness.model.script(
        { task: ASK },
        [
          {
            calls: [
              taskCreate(CHAT_TASKS[0], CHAT_ACTIVE),
              taskCreate(CHAT_TASKS[1]),
              taskCreate(CHAT_TASKS[2]),
            ],
          },
          { calls: [taskUpdate(1, 'in_progress')] },
          { calls: [recordToolCall('create_record', createArgs(journeyBody(name, 11)))] },
          { calls: [recordToolCall('create_record', createArgs(journeyBody(name)))] },
          { text: CREATED },
          () => ({
            calls: [
              {
                tool: 'start_deep_agent',
                args: { deepAgent: createdId, question: QUESTION, boundaries: '', result: '' },
              },
            ],
          }),
          { text: STARTED },
        ],
        { thereafter: { text: 'Принято.' } },
      );
      harness.model.script(
        { task: briefTask(QUESTION) },
        [
          { calls: [taskCreate(DEEP_TASKS[0]), taskCreate(DEEP_TASKS[1])] },
          { calls: [taskUpdate(1, 'in_progress'), startSubagent(GATHER, 'Сбор логов за ночь', GATHER_TASK)] },
          { text: 'Жду сбор.' },
          {
            calls: [
              taskUpdate(1, 'completed'),
              taskUpdate(2, 'in_progress'),
              startSubagent(ANSWER, 'Ответ по логам', ANSWER_TASK),
            ],
          },
          { text: 'Жду ответ.' },
          // Task 2 is still in progress: this answer is refused with a notice naming it.
          { text: 'Ответ готов.' },
          { calls: [taskUpdate(2, 'completed')] },
        ],
        { thereafter: { text: 'Готово.' } },
      );
      harness.model.script({ task: GATHER_TASK }, [{ latch: gatherHeld, text: GATHER_REPORT }]);
      harness.model.script({ task: ANSWER_TASK }, [{ text: ANSWER_REPORT }]);

      try {
        const { id: threadId } = await api.createThread();
        await api.send(threadId, ASK);

        // 1. (AC-27.1 wiring) eleven subagents: `invalid_arguments` naming `subagents` and the limit 10, no card, no record
        // 2. (AC-06.1) the right one: one waiting `library.record` request with the whole definition; the library has no such record
        const waiting = await waitFor(
          () => api.history(threadId),
          (view) => pendingCardOf(view) !== undefined,
          'the card of the deep agent',
        );
        const [refused] = toolResultsOf(waiting, 'create_record');
        expect(refused?.refusalReason).toBe('invalid_arguments');
        expect(refused?.text).toContain('subagents');
        expect(refused?.text).toContain('10');
        const pending = pendingCardOf(waiting);
        if (pending === undefined) throw new Error('no card');
        expect(waiting.decisions).toHaveLength(1);
        expect(pending.card).toMatchObject({
          action: 'create',
          kind: 'deep_agent',
          previous: null,
          next: {
            name,
            content: {
              finalSubagent: ANSWER,
              selfLearning: false,
              subagents: [{ name: GATHER }, { name: ANSWER }],
            },
          },
        });
        expect((await listLibrary(harness.app, employee)).map((record) => record.name)).not.toContain(name);
        // (AC-12.1, AC-15.1) the route of the conversation's root gives the chat's own tasks, the started one with its `activeForm`
        const chatTasks = await expectBody(
          api.raw('get', `/agents/${waiting.chat.rootAgentId}/tasks`),
          200,
          RunTaskListViewSchema,
        );
        expect(chatTasks.tasks.map(({ id, subject, status, activeForm }) => ({ id, subject, status, activeForm }))).toEqual([
          { id: 1, subject: CHAT_TASKS[0], status: 'in_progress', activeForm: CHAT_ACTIVE },
          { id: 2, subject: CHAT_TASKS[1], status: 'pending', activeForm: null },
          { id: 3, subject: CHAT_TASKS[2], status: 'pending', activeForm: null },
        ]);

        // 3. (AC-01.2, AC-28.1) approved: the record is in the library with the card's id, and in focus as `created`
        const approvedAt = new Date().toISOString();
        expect(await api.decide(pending.decision.decisionId, { approve: true })).toEqual({ outcome: 'resolved' });
        const created = await waitFor(
          () => api.history(threadId),
          (view) => view.focus !== null && view.chat.status === 'idle',
          'the created record in focus',
        );
        createdId = pending.card.recordId;
        const record = await getRecord(harness.app, employee, createdId);
        expect(record).toMatchObject({ id: createdId, kind: 'deep_agent', version: 1, name });
        expect(record.kind === 'deep_agent' && record.content.selfLearning).toBe(false);
        expect(created.focus).toMatchObject({ recordId: createdId, action: 'created' });
        expect((created.focus?.at ?? '') >= approvedAt).toBe(true);

        // 4. (AC-03.1) the brief waits and no deep agent exists; confirmed, exactly one deep agent of the record's version with the brief as its first task
        await api.send(threadId, RUN_REQUEST);
        const briefWaiting = await waitFor(
          () => api.history(threadId),
          (view) =>
            view.decisions.some(
              (decision) => decision.kind === AGENTS_BRIEF_CONFIRMATION && decision.status === 'open',
            ),
          'the brief',
        );
        expect(briefWaiting.agents).toEqual([]);
        const brief = briefWaiting.decisions.find((decision) => decision.kind === AGENTS_BRIEF_CONFIRMATION);
        if (brief === undefined) throw new Error('no brief');
        expect(await api.decide(brief.decisionId, { approve: true })).toEqual({ outcome: 'resolved' });
        const running = await waitFor(
          () => api.history(threadId),
          (view: ConversationView) => treeOf(view.agents).some((agent) => agent.origin?.recordId === createdId),
          'the deep agent',
        );
        const deepAgents = treeOf(running.agents).filter(
          (agent) => agent.origin?.recordId === createdId && agent.origin?.subagent === null,
        );
        expect(deepAgents.map((agent) => agent.origin?.version)).toEqual([1]);
        const deepAgent = deepAgents[0];
        if (deepAgent === undefined) throw new Error('no deep agent');
        const [firstEntry] = (await api.agentPage(deepAgent.agentId)).entries;
        expect(firstEntry?.kind === 'task' && firstEntry.content.text).toBe(briefTask(QUESTION));

        // 5. (AC-04.1, AC-12.1, AC-28.3) the deep agent's tasks while «сбор» works, the focus `started`, 404 to another employee; then both tasks completed
        const tasksOf = () =>
          expectBody(api.raw('get', `/agents/${deepAgent.agentId}/tasks`), 200, RunTaskListViewSchema);
        const working = await waitFor(
          tasksOf,
          (list) => list.tasks.map((task) => task.status).join() === 'in_progress,pending',
          'the task list while the gather subagent works',
        );
        expect(working.tasks.map(({ id, subject }) => ({ id, subject }))).toEqual([
          { id: 1, subject: DEEP_TASKS[0] },
          { id: 2, subject: DEEP_TASKS[1] },
        ]);
        expect((await api.history(threadId)).focus).toMatchObject({ recordId: createdId, action: 'started' });
        const foreign = await expectError(
          chatApi(harness.app, other).raw('get', `/agents/${deepAgent.agentId}/tasks`),
          404,
        );
        expect(foreign.errorCode).toBe('AGENT_NOT_FOUND');
        gatherHeld.open();
        await waitFor(
          tasksOf,
          (list) => list.tasks.map((task) => task.status).join() === 'completed,completed',
          'both tasks completed',
        );

        // 6. (AC-05.2) the conversation's answer is the final subagent's report, literally, and the deep agent finished
        const answered = await waitFor(
          () => api.history(threadId),
          (view) =>
            view.entries.some((entry) => entry.kind === 'child_report' && entry.content.agentId === deepAgent.agentId),
          'the report of the deep agent',
        );
        const report = answered.entries.find(
          (entry) => entry.kind === 'child_report' && entry.content.agentId === deepAgent.agentId,
        );
        expect(report?.kind === 'child_report' && report.content).toMatchObject({
          status: 'completed',
          text: ANSWER_REPORT,
        });
        expect(treeOf(answered.agents).find((agent) => agent.agentId === deepAgent.agentId)?.status).toBe('completed');
        // (AC-14.4) the answer given while task 2 was in progress met a notice naming it
        const notices = (await api.agentPage(deepAgent.agentId)).entries.flatMap((entry) =>
          entry.kind === 'notice' && entry.content.openTasks !== undefined ? [entry.content.openTasks] : [],
        );
        expect(notices).toContainEqual([2]);
      } finally {
        gatherHeld.open();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
