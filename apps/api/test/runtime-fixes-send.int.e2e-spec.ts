// runtime-fixes / send - API integration (real AppModule + real Postgres, scripted model)
// Design Doc: docs/features/runtime-fixes/design-send.md (FR-03; KD-1, KD-2, KD-5; Flows 1 and 2; Data Model `send_keys`).
// PRD: docs/features/runtime-fixes/prd.md (AC-03.1, AC-03.2, AC-03.4, NFR-01). UXRD: none.
// Generated: 2026-11-28 | Part: send | Test type: Integration, run by `pnpm --filter api test:e2e` (never in the default `vitest run`).
// Run only against a test database (DATABASE_URL): this config migrates it on load.
//
// Budget: Integration 3 of 3, E2E 0 of 1-2. The browser half of the journey (the composer sending again after an error) is
// the web unit test `apps/web/src/lib/feed/feed-store.test.ts`; the API half is INT-1 over real HTTP.
// Harness, naming and isolation as in `agent-platform-chat.int.e2e-spec.ts`: `createTestApp`, a unique employee and a unique
// conversation per test, no sleeps (synchronise on rows and the scripted model's calls).
//
// Not repeated here (one proof per rule, lower level):
//   - the `sendKey` schema (required, UUID): library behaviour of zod; the only wiring that can regress is "the field became
//     optional" and INT-1 row E pins it.
//   - the order, single delivery and wake-up of the inbox, the first message becoming the root: runtime and chat suites.
//   - "Запустить сейчас", the schedule's own sends, `message-agent`, the fork's `edit`: out of the part (KD-4, KD-5, Out of scope).
//   - the existing "two first messages at once" row of `agent-platform-chat.int.e2e-spec.ts` (two DIFFERENT keys, one root and
//     one queued message) stays as it is; INT-3 here is the SAME-key case, a different defect.

import { randomUUID } from 'node:crypto';
import {
  SendMessageResponseSchema,
  type AgentPageView,
  type ConversationView,
  type SendMessageResponse,
} from '@agent-os/contracts';
import { waitFor } from '@agent-os/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  allowRole,
  HAIKU_TEST_PRICES,
  removeRunRows,
  runModel,
  useRunModels,
} from './support/access';
import { type ChatApi, chatApi, expectBody, expectError } from './support/api';
import { createTestApp, type TestApp } from './support/createTestApp';
import {
  agentBody,
  BUILTIN,
  createRecord,
  pointBuiltinsAt,
  recordName,
} from './support/library';
import {
  createEmployee,
  seedSuperAdmin,
  type Session,
} from './support/session';

/** Bound of one test; the rows settle far sooner. */
const TEST_TIMEOUT_MS = 120_000;
/** The model of the file's built-in records: the chat and its agents run on it. */
const DEFAULT_MODEL = runModel('claude-haiku-5-5');
/** The title every first message gets. */
const GENERATED_TITLE = 'Conversation title';

/** The texts of the file, each answered by a script of its own (a script answers the call whose latest user message it is). */
const TEXT = {
  firstA: 'RF-INT-1: first message of A',
  firstB: 'RF-INT-1: first message of B',
  chatOfAgent: 'RF-INT-1 B: start the helper',
  childTask: 'RF-INT-1 B: the helper assignment',
  t1: 'RF-INT-1 A: message T1',
  b1: 'RF-INT-1 B: message to the agent',
  t2: 'RF-INT-1 C: the same text twice',
  t3: 'RF-INT-1 D: B with the key of A',
  first2: 'RF-INT-2: first message',
  t4: 'RF-INT-2: the corrected send',
  t5: 'RF-INT-3: one first message, one key',
} as const;

/** `POST` of a message with an explicit body, 202: the repeat must reuse the very same key. */
function postMessage(
  api: ChatApi,
  path: string,
  body: { text: string; sendKey: string; recordId?: string },
): Promise<SendMessageResponse> {
  return expectBody(
    api.raw('post', path, body),
    202,
    SendMessageResponseSchema,
  );
}

/** The texts of an entry kind in a view, in order. */
function textsOf(
  view: ConversationView | AgentPageView,
  kind: 'task' | 'user_message',
): string[] {
  return view.entries.flatMap((entry) =>
    (entry.kind === 'task' || entry.kind === 'user_message') &&
    entry.kind === kind
      ? [entry.content.text]
      : [],
  );
}

/** Waits until the chat of the conversation is free (`idle`), nothing is pending and the view satisfies `done`. */
function untilSettled(
  api: ChatApi,
  threadId: string,
  done: (view: ConversationView) => boolean,
  what: string,
): Promise<ConversationView> {
  return waitFor(
    () => api.history(threadId),
    (view) =>
      view.chat.status === 'idle' && view.pending.length === 0 && done(view),
    what,
  );
}

describe('runtime-fixes / send - integration (real AppModule + real Postgres, scripted model)', () => {
  let harness: TestApp;
  let roleId: string | undefined;
  /** Every user the file made: deleted in `afterAll`, their conversations and `send_keys` rows by cascade. */
  const users: string[] = [];
  let restoreBuiltins: (() => Promise<void>) | undefined;
  let restoreModels: (() => Promise<void>) | undefined;
  let employee: () => Promise<Session>;

  beforeAll(async () => {
    harness = await createTestApp({ workers: true });
    harness.model.completeText({ text: GENERATED_TITLE });
    const admin = await seedSuperAdmin(
      harness.app,
      `e2e-admin-${randomUUID()}`,
    );
    users.push(admin.id);
    restoreModels = await useRunModels(harness.app, admin, {
      chat: { id: DEFAULT_MODEL, ...HAIKU_TEST_PRICES },
    });
    restoreBuiltins = await pointBuiltinsAt(harness.app, admin, DEFAULT_MODEL);
    const role = await allowRole(harness.app, admin, {
      name: 'send',
      models: [DEFAULT_MODEL],
      servers: [],
    });
    roleId = role.id;
    employee = async () => {
      const session = await createEmployee(harness.app, admin);
      users.push(session.id);
      await role.add(session);
      return session;
    };
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (harness === undefined) return;
    try {
      try {
        await restoreBuiltins?.();
        await restoreModels?.();
      } finally {
        await removeRunRows(harness.pool, {
          models: [DEFAULT_MODEL],
          roles: roleId === undefined ? [] : [roleId],
          users,
        });
      }
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  /** The employee's conversation with its first message answered: later messages go to the root's queue. */
  async function answeredConversation(
    api: ChatApi,
    first: string,
  ): Promise<string> {
    harness.model.script({ task: first }, [], {
      thereafter: { text: `Answer to: ${first}` },
    });
    const { id } = await api.createThread();
    await api.send(id, first);
    await untilSettled(
      api,
      id,
      (view) => view.entries.some((entry) => entry.kind === 'model_answer'),
      `the first answer of "${first}"`,
    );
    return id;
  }

  // INT-1 -------------------------------------------------------------------------------------------------------------
  // AC: AC-03.1 "Given сообщение в беседу или на странице агента принято, а ответ сервера потерялся, when интерфейс повторяет
  //   отправку с тем же ключом, then повтор ничего не создаёт и получает ответ, что отправка принята, агент отвечает один раз,
  //   а после того как лента перечитала беседу, сотрудник видит в ней одно, исходное сообщение."
  // AC: AC-03.4 "Given две разные отправки сотрудника, when каждая отправлена со своим ключом, then каждая создаёт своё сообщение,
  //   даже если текст одинаковый."
  // AC: NFR-01 "Ключ отправки действует в пределах одного сотрудника: такой же ключ от другого сотрудника создаёт его собственное
  //   сообщение и никогда не возвращает чужую беседу или чужой результат."
  // Catches: (1) a retry after a lost answer that stores a second identical message and makes the agent answer twice, on the
  //   conversation route and on the agent page route; (2) a key matched without the employee, so B's send with A's key returns
  //   nothing or reaches A's conversation; (3) a key matched against the text, so a second, different send is swallowed.
  it(
    'INT-1 AC-03.1, AC-03.4, NFR-01: a repeat with the same key creates nothing; another key or another employee sends anew',
    async () => {
      const a = await employee();
      const b = await employee();
      const apiA = chatApi(harness.app, a);
      const apiB = chatApi(harness.app, b);
      const threadA = await answeredConversation(apiA, TEXT.firstA);
      const threadB = await answeredConversation(apiB, TEXT.firstB);
      const answerT1 = harness.model.script({ task: TEXT.t1 }, [], {
        thereafter: { text: 'Answer to T1.' },
      });
      harness.model.script({ task: TEXT.t2 }, [], {
        thereafter: { text: 'Answer to T2.' },
      });
      harness.model.script({ task: TEXT.t3 }, [], {
        thereafter: { text: 'Answer to T3.' },
      });
      const k1 = randomUUID();

      // Row A: the conversation message, then its repeat with the same key
      const sentT1 = await postMessage(apiA, `/threads/${threadA}/messages`, {
        text: TEXT.t1,
        sendKey: k1,
      });
      const repeatT1 = await postMessage(apiA, `/threads/${threadA}/messages`, {
        text: TEXT.t1,
        sendKey: k1,
      });
      expect(typeof sentT1.messageId).toBe('string');
      expect(repeatT1).toEqual({ messageId: null });
      const afterT1 = await untilSettled(
        apiA,
        threadA,
        (view) => textsOf(view, 'user_message').includes(TEXT.t1),
        'T1 answered',
      );
      expect(textsOf(afterT1, 'user_message')).toEqual([TEXT.t1]);
      expect(answerT1.calls).toHaveLength(1);

      // Row C: the same text with two different keys is two sends
      const sentT2 = await Promise.all(
        [randomUUID(), randomUUID()].map((sendKey) =>
          postMessage(apiA, `/threads/${threadA}/messages`, {
            text: TEXT.t2,
            sendKey,
          }),
        ),
      );
      expect(sentT2.map((sent) => typeof sent.messageId)).toEqual([
        'string',
        'string',
      ]);
      const afterT2 = await untilSettled(
        apiA,
        threadA,
        (view) =>
          textsOf(view, 'user_message').filter((text) => text === TEXT.t2)
            .length === 2,
        'both T2 delivered',
      );
      expect(textsOf(afterT2, 'user_message')).toEqual([
        TEXT.t1,
        TEXT.t2,
        TEXT.t2,
      ]);

      // Row D: B sends with A's key into B's own conversation, and A's conversation is untouched
      const sentT3 = await postMessage(apiB, `/threads/${threadB}/messages`, {
        text: TEXT.t3,
        sendKey: k1,
      });
      expect(typeof sentT3.messageId).toBe('string');
      const afterT3 = await untilSettled(
        apiB,
        threadB,
        (view) => textsOf(view, 'user_message').includes(TEXT.t3),
        "B's T3 delivered",
      );
      expect(textsOf(afterT3, 'user_message')).toEqual([TEXT.t3]);
      expect(
        textsOf(await apiA.history(threadA), 'user_message'),
      ).not.toContain(TEXT.t3);
    },
    TEST_TIMEOUT_MS,
  );

  // INT-1 row B: the agent page route keeps the same rule (AC-03.1).
  it(
    'INT-1 AC-03.1: a repeat of an agent page message with the same key creates nothing',
    async () => {
      const api = chatApi(harness.app, await employee());
      harness.model.script(
        { task: TEXT.chatOfAgent },
        [
          {
            calls: [
              {
                tool: 'start_agent',
                args: {
                  agent: BUILTIN.generalPurpose.name,
                  description: 'RF helper',
                  prompt: TEXT.childTask,
                },
              },
            ],
          },
        ],
        { thereafter: { text: 'Chat noted.' } },
      );
      harness.model.script({ task: TEXT.childTask }, [], {
        thereafter: { text: 'Helper done.' },
      });
      const answerB1 = harness.model.script({ task: TEXT.b1 }, [], {
        thereafter: { text: 'Answer to B1.' },
      });
      const { id: threadId } = await api.createThread();
      await api.send(threadId, TEXT.chatOfAgent);
      const settled = await untilSettled(
        api,
        threadId,
        (view) =>
          view.agents.length === 1 && view.agents[0]?.status === 'completed',
        'the helper finished',
      );
      const agentId = settled.agents[0]?.agentId ?? '';
      const sendKey = randomUUID();

      const sent = await postMessage(api, `/agents/${agentId}/messages`, {
        text: TEXT.b1,
        sendKey,
      });
      const repeat = await postMessage(api, `/agents/${agentId}/messages`, {
        text: TEXT.b1,
        sendKey,
      });

      expect(typeof sent.messageId).toBe('string');
      expect(repeat).toEqual({ messageId: null });
      const page = await waitFor(
        () => api.agentPage(agentId),
        (view) =>
          view.agent.status === 'completed' &&
          view.pending.length === 0 &&
          textsOf(view, 'user_message').includes(TEXT.b1),
        'B1 answered by the helper',
      );
      expect(textsOf(page, 'user_message')).toEqual([TEXT.b1]);
      expect(answerB1.calls).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );

  // INT-1 row E (KD-5): a body without a key, or with a key that is not a UUID, is refused before anything is written.
  // Catches: `sendKey` left optional, so a client that skips it silently loses the protection.
  it.each([
    { route: 'thread', body: { text: 'RF-INT-1 E: no key' } },
    {
      route: 'thread',
      body: { text: 'RF-INT-1 E: bad key', sendKey: 'not-a-uuid' },
    },
    { route: 'agent', body: { text: 'RF-INT-1 E: no key' } },
    {
      route: 'agent',
      body: { text: 'RF-INT-1 E: bad key', sendKey: 'not-a-uuid' },
    },
  ])(
    'INT-1 KD-5: $route message $body.text is 400 VALIDATION_FAILED',
    async ({ route, body }) => {
      const api = chatApi(harness.app, await employee());
      const { id } = await api.createThread();
      const path =
        route === 'thread'
          ? `/threads/${id}/messages`
          : `/agents/${id}/messages`;

      const refused = await expectError(api.raw('post', path, body), 400);

      expect(refused.errorCode).toBe('VALIDATION_FAILED');
      // Nothing was written: the conversation still has no first message.
      expect(
        (await expectError(api.raw('get', `/threads/${id}/history`), 404))
          .errorCode,
      ).toBe('THREAD_NOT_FOUND');
    },
    TEST_TIMEOUT_MS,
  );

  // INT-2 -------------------------------------------------------------------------------------------------------------
  // AC: FR-03 refinement "Когда сервер отказал первой отправке, ключ не занят, и отправка с тем же ключом проверяется и
  //   выполняется заново (KD-1)."
  // Catches: the key taken in its own transaction before the send: after a refusal the key stays taken, the corrected send
  //   answers `messageId: null` and the employee's message silently never arrives.
  it(
    'INT-2 FR-03 (KD-1): a refused send releases its key, so the corrected send with the same key is performed',
    async () => {
      const anya = await employee();
      const boris = await employee();
      const api = chatApi(harness.app, anya);
      const threadId = await answeredConversation(api, TEXT.first2);
      const borisRecord = await createRecord(
        harness.app,
        boris,
        agentBody(recordName('RF-INT-2 Boris'), { model: DEFAULT_MODEL }),
      );
      harness.model.script({ task: TEXT.t4 }, [], {
        thereafter: { text: 'Answer to T4.' },
      });
      const sendKey = randomUUID();
      const keyRows = async (): Promise<number> => {
        const { rows } = await harness.pool.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM app.send_keys WHERE user_id = $1 AND send_key = $2',
          [anya.id, sendKey],
        );
        return rows[0]?.count ?? 0;
      };

      // When: the send with a chip of Boris's record is refused
      const refused = await expectError(
        api.raw('post', `/threads/${threadId}/messages`, {
          text: TEXT.t4,
          sendKey,
          recordId: borisRecord.id,
        }),
        404,
      );
      expect(refused.errorCode).toBe('RECORD_NOT_FOUND');
      expect(await keyRows()).toBe(0);

      // Then: the corrected send with the same key is a new send
      const sent = await postMessage(api, `/threads/${threadId}/messages`, {
        text: TEXT.t4,
        sendKey,
      });
      expect(typeof sent.messageId).toBe('string');
      expect(await keyRows()).toBe(1);
      const view = await untilSettled(
        api,
        threadId,
        (settled) => textsOf(settled, 'user_message').includes(TEXT.t4),
        'T4 delivered',
      );
      expect(textsOf(view, 'user_message')).toEqual([TEXT.t4]);
    },
    TEST_TIMEOUT_MS,
  );

  // INT-3 -------------------------------------------------------------------------------------------------------------
  // AC: AC-03.2 "Given сотрудник отправляет первое сообщение новой беседы, when одновременно приходят два запроса с одним ключом,
  //   then создана одна беседа с одним сообщением, и оба запроса возвращают эту беседу."
  // Catches: a first message of a new conversation not covered by the key, or a key check not serialised on the primary key,
  //   so a double click or a retry races into two roots or one root plus a duplicate queued message.
  it(
    'INT-3 AC-03.2: two simultaneous first messages with one key create one root and one message',
    async () => {
      const api = chatApi(harness.app, await employee());
      const answerT5 = harness.model.script({ task: TEXT.t5 }, [], {
        thereafter: { text: 'Answer to T5.' },
      });
      const { id: threadId } = await api.createThread();
      const sendKey = randomUUID();

      const answers = await Promise.all(
        [1, 2].map(() =>
          postMessage(api, `/threads/${threadId}/messages`, {
            text: TEXT.t5,
            sendKey,
          }),
        ),
      );

      expect(answers).toEqual([{ messageId: null }, { messageId: null }]);
      const view = await untilSettled(
        api,
        threadId,
        (settled) =>
          settled.entries.some((entry) => entry.kind === 'model_answer'),
        'T5 answered',
      );
      expect(textsOf(view, 'task')).toEqual([TEXT.t5]);
      expect(textsOf(view, 'user_message')).toEqual([]);
      expect(await api.threadAgents(threadId)).toEqual([]);
      expect(answerT5.calls).toHaveLength(1);
    },
    TEST_TIMEOUT_MS,
  );
});
