// self-learning / memory - API integration (real AppModule + real Postgres, workers on, scripted model)
// Design Doc: docs/features/self-learning/design-memory.md, Test Strategy UC-1 (remember, read, forget), UC-2 (an employee's memory
//   reaches nobody else), UC-3 (rights on the two screens).
//
// Harness: one `createTestApp({ workers: true })`; each run is a deep agent started from the employee's chat (`startDeepAgentInChat`),
//   its answers scripted by its brief. Two employees share one self-learning deep agent of Аня's through a role they both hold.
//
// Not repeated here: the memory of a training tree (training TR-1: the trainer's reads leave out the employee's memory, a replay's
//   `remember` writes nothing); a default agent with the flag (unit `save-rules.spec.ts`). The size and order rule of the memory index
//   has no test.

import { randomUUID } from 'node:crypto';
import type { ScriptedToolCall } from '@agent-os/agents/testing';
import {
  AgentMemoryViewSchema,
  MyMemoryViewSchema,
  type CreateRecordBody,
  type MyMemoryView,
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
import { chatApi, expectBody, expectError } from './support/api';
import { createTestApp, type TestApp } from './support/createTestApp';
import {
  createRecord,
  deepAgentBody,
  pointBuiltinsAt,
  recordName,
  shareWith,
} from './support/library';
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
const MODEL = runModel('haiku-memory');

const HOW = 'Как искать заказы';
const HOW_TEXT = 'Сначала search_orders, потом get_order';
const ANYA_PREFERENCE = 'Аня просит отчёт таблицей';
const ANYA_PREFERENCE_TEXT = 'Таблица: заказ, сумма, статус';
const TEMPORARY = 'Временная заметка';

function memoryCall(
  tool: 'remember' | 'read_memory' | 'forget',
  scope: 'agent' | 'user',
  description: string,
  text?: string,
): ScriptedToolCall {
  return {
    tool,
    args: { scope, description, ...(text === undefined ? {} : { text }) },
  };
}

let harness: TestApp;
let admin: Session;
let role: RunRole;
let restoreModels: (() => Promise<void>) | undefined;
let restoreBuiltins: (() => Promise<void>) | undefined;
const made = { users: [] as string[], roles: [] as string[] };

async function employee(): Promise<Session> {
  const session = await createEmployee(harness.app, admin);
  made.users.push(session.id);
  await role.add(session);
  return session;
}

/** A self-learning deep agent of `author`, shared with the file's role. */
async function sharedAgent(author: Session) {
  const body = deepAgentBody(recordName('Память'), MODEL);
  const record = await createRecord(harness.app, author, {
    ...body,
    content: { ...body.content, selfLearning: true },
  } satisfies CreateRecordBody);
  await shareWith(harness.app, author, record.id, [role.id]);
  return record;
}

function myMemory(session: Session): Promise<MyMemoryView> {
  return expectBody(
    apiRequest(harness.app, session, 'get', '/memory'),
    200,
    MyMemoryViewSchema,
  );
}

describe('self-learning / memory - a run keeps the agent memory for everyone and the employee memory for its owner only', () => {
  beforeAll(async () => {
    harness = await createTestApp({ workers: true });
    harness.model.completeText({ text: 'Память' });
    admin = await seedSuperAdmin(
      harness.app,
      `e2e-memory-admin-${randomUUID().slice(0, 8)}`,
    );
    made.users.push(admin.id);
    restoreModels = await useRunModels(harness.app, admin, {
      chat: { id: MODEL, ...HAIKU_TEST_PRICES },
    });
    restoreBuiltins = await pointBuiltinsAt(harness.app, admin, MODEL);
    role = await allowRole(harness.app, admin, {
      name: 'memory',
      models: [MODEL],
      servers: [],
    });
    made.roles.push(role.id);
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

  // UC-1, UC-2. Catches: a record of scope user written where another employee's run reads it (index or read_memory) or lists it
  //   («Моя память»); an agent record that does not reach the next employee's run; a forgotten record that stays; a delete of
  //   another employee's record by id that changes it.
  it(
    "MEM-1: Аня's run remembers in both scopes and forgets; Борис's run of the same agent sees the agent record and never Аня's; each employee lists only their own records",
    async () => {
      const anya = await employee();
      const boris = await employee();
      const record = await sharedAgent(anya);

      const anyaQuestion = `Заказы Ани ${record.id}`;
      harness.model.script({ task: briefTask(anyaQuestion) }, [
        {
          calls: [
            memoryCall('remember', 'agent', HOW, HOW_TEXT),
            memoryCall(
              'remember',
              'user',
              ANYA_PREFERENCE,
              ANYA_PREFERENCE_TEXT,
            ),
            memoryCall('remember', 'user', TEMPORARY, 'скоро уйдёт'),
          ],
        },
        { calls: [memoryCall('forget', 'user', TEMPORARY)] },
        { text: 'Запомнил.' },
      ]);
      const anyaApi = chatApi(harness.app, anya);
      const anyaRun = await startDeepAgentInChat(harness.model, anyaApi, {
        record,
        question: anyaQuestion,
        chatTask: `Запусти для Ани ${record.id}`,
      });
      await untilAgentStatus(
        anyaApi,
        anyaRun.threadId,
        anyaRun.deepAgentId,
        'completed',
      );

      const borisQuestion = `Заказы Бориса ${record.id}`;
      const borisDeepAgent = harness.model.script(
        { task: briefTask(borisQuestion) },
        [
          {
            calls: [
              memoryCall('read_memory', 'agent', HOW),
              memoryCall('read_memory', 'user', ANYA_PREFERENCE),
            ],
          },
          { text: 'Прочитал.' },
        ],
      );
      const borisApi = chatApi(harness.app, boris);
      const borisRun = await startDeepAgentInChat(harness.model, borisApi, {
        record,
        question: borisQuestion,
        chatTask: `Запусти для Бориса ${record.id}`,
      });
      await untilAgentStatus(
        borisApi,
        borisRun.threadId,
        borisRun.deepAgentId,
        'completed',
      );

      // Борис's index names the agent record and nothing of Аня's
      const instructions = borisDeepAgent.calls[0]?.instructions ?? '';
      expect(instructions).toContain(HOW);
      expect(instructions).not.toContain(ANYA_PREFERENCE);
      expect(instructions).not.toContain(TEMPORARY);
      const borisPage = await borisApi.agentPage(borisRun.deepAgentId);
      const reads = borisPage.entries.flatMap((entry) =>
        entry.kind === 'tool_result' && entry.content.tool === 'read_memory'
          ? [[entry.content.outcome, entry.content.text]]
          : [],
      );
      expect(reads).toEqual([
        ['success', expect.stringContaining(HOW_TEXT)],
        ['empty', 'There is no such record'],
      ]);

      // «Моя память»: Аня's one record, Борис's none; the agent's memory holds the agent record only
      const anyaMemory = await myMemory(anya);
      expect(
        anyaMemory.records.map(({ description, text }) => [description, text]),
      ).toEqual([[ANYA_PREFERENCE, ANYA_PREFERENCE_TEXT]]);
      expect((await myMemory(boris)).records).toEqual([]);
      const agentMemory = await expectBody(
        apiRequest(harness.app, anya, 'get', `/library/${record.id}/memory`),
        200,
        AgentMemoryViewSchema,
      );
      expect(agentMemory.records.map(({ description }) => description)).toEqual(
        [HOW],
      );

      // Борис deletes Аня's record by its id: 204, and it stays
      const [anyaRecord] = anyaMemory.records;
      await apiRequest(
        harness.app,
        boris,
        'delete',
        `/memory/${anyaRecord?.id}`,
      ).expect(204);
      expect(await myMemory(anya)).toEqual(anyaMemory);
    },
    TEST_TIMEOUT_MS,
  );

  // UC-3. Catches: the agent's memory open to an employee who only runs the agent, or closed to the admin who sees it in the panel;
  //   an agent the employee does not see answered as forbidden instead of missing.
  it(
    "MEM-2: an agent's memory is open to its author and to an admin, 403 to an employee who only uses it, 404 to one who does not see it",
    async () => {
      const anya = await employee();
      const boris = await employee();
      const outsider = await createEmployee(harness.app, admin);
      made.users.push(outsider.id);
      const record = await sharedAgent(anya);
      const path = `/library/${record.id}/memory`;

      for (const session of [anya, admin])
        await expectBody(
          apiRequest(harness.app, session, 'get', path),
          200,
          AgentMemoryViewSchema,
        );
      expect(
        (await expectError(apiRequest(harness.app, boris, 'get', path), 403))
          .errorCode,
      ).toBe('MEMORY_FORBIDDEN');
      expect(
        (await expectError(apiRequest(harness.app, outsider, 'get', path), 404))
          .errorCode,
      ).toBe('RECORD_NOT_FOUND');
    },
    TEST_TIMEOUT_MS,
  );
});
