// self-learning / notepad - API integration (real AppModule + real Postgres, workers on, scripted model)
// Design Doc: docs/features/self-learning/design-notepad.md, Test Strategy UC-1 (documents stay with their employee and agent), UC-2 (the
//   report and its display).
//
// Harness: one `createTestApp({ workers: true })`; each run is a deep agent started from the employee's chat (`startDeepAgentInChat`).
//   The scripted model writes the report document itself after the report notice (`createScriptedModel`), so a script lists only the answer.
//
// Not repeated here: the notice and the answer after the document in the history (packages/agents deep-agents-agent-types INT, row C).
//   The size and replace rules of a document have no test.

import { randomUUID } from 'node:crypto';
import {
  DocumentSchema,
  ThreadDocumentsViewSchema,
  type ConversationView,
  type HistoryEntry,
} from '@agent-os/contracts';
import { waitFor } from '@agent-os/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  allowRole,
  HAIKU_TEST_PRICES,
  removeRunRows,
  runModel,
  type RunRole,
  useRunModels,
} from './support/access';
import { type ChatApi, chatApi, expectBody, expectError } from './support/api';
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
  createEmployee,
  seedSuperAdmin,
  type Session,
} from './support/session';

const TEST_TIMEOUT_MS = 300_000;
const MODEL = runModel('haiku-notepad');

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

function childReports(
  view: ConversationView,
): Extract<HistoryEntry, { kind: 'child_report' }>['content'][] {
  return view.entries.flatMap((entry) =>
    entry.kind === 'child_report' ? [entry.content] : [],
  );
}

/** One completed run of the deep agent `record` by `api`'s employee, answering `answer` (and first calling `calls`). */
async function run(
  api: ChatApi,
  record: { readonly id: string; readonly name: string },
  answer: string,
  calls: readonly { tool: string; args: Record<string, unknown> }[] = [],
): Promise<{ threadId: string; deepAgentId: string }> {
  const question = `${answer} ${randomUUID().slice(0, 8)}`;
  harness.model.script({ task: briefTask(question) }, [
    ...(calls.length === 0 ? [] : [{ calls }]),
    { text: answer },
  ]);
  const started = await startDeepAgentInChat(harness.model, api, {
    record,
    question,
    chatTask: `Запусти: ${question}`,
  });
  await untilAgentStatus(
    api,
    started.threadId,
    started.deepAgentId,
    'completed',
  );
  return started;
}

describe("self-learning / notepad - a deep agent's report is a document of its run, read only by its employee", () => {
  beforeAll(async () => {
    harness = await createTestApp({ workers: true });
    harness.model.completeText({ text: 'Блокнот' });
    admin = await seedSuperAdmin(
      harness.app,
      `e2e-notepad-admin-${randomUUID().slice(0, 8)}`,
    );
    made.users.push(admin.id);
    restoreModels = await useRunModels(harness.app, admin, {
      chat: { id: MODEL, ...HAIKU_TEST_PRICES },
    });
    restoreBuiltins = await pointBuiltinsAt(harness.app, admin, MODEL);
    role = await allowRole(harness.app, admin, {
      name: 'notepad',
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

  // UC-1, UC-2. Catches: a report that reaches the chat without its document; a document read through another employee's
  //   conversation; `notepad_past` that lists another employee's documents of the same agent, or the run's own.
  it(
    "NOTE-1: the report comes back with its document; the conversation's documents are its owner's only; notepad_past lists the same employee's past documents of the agent",
    async () => {
      const anya = await employee();
      const boris = await employee();
      const body = deepAgentBody(recordName('Блокнот'), MODEL);
      const record = await createRecord(harness.app, anya, body);
      await shareWith(harness.app, anya, record.id, [role.id]);
      const anyaApi = chatApi(harness.app, anya);
      const borisApi = chatApi(harness.app, boris);

      // Аня's run: the report in the chat names its document, the conversation lists it, the route gives its text
      const anyaReport = 'Отчёт Ани по заказам.';
      const first = await run(anyaApi, record, anyaReport);
      const view = await waitFor(
        () => anyaApi.history(first.threadId),
        (candidate) =>
          candidate.chat.status === 'idle' &&
          childReports(candidate).length === 1,
        "the deep agent's report in the chat",
      );
      const [report] = childReports(view);
      expect(report).toMatchObject({ status: 'completed', text: anyaReport });
      if (report?.document == null)
        throw new Error('the report has no document');
      const documentsPath = `/threads/${first.threadId}/documents`;
      const listed = await expectBody(
        anyaApi.raw('get', documentsPath),
        200,
        ThreadDocumentsViewSchema,
      );
      expect(
        listed.documents.map(({ id, agentId, report: isReport }) => ({
          id,
          agentId,
          isReport,
        })),
      ).toEqual([
        { id: report.document.id, agentId: first.deepAgentId, isReport: true },
      ]);
      const documentPath = `${documentsPath}/${report.document.id}`;
      const document = await expectBody(
        anyaApi.raw('get', documentPath),
        200,
        DocumentSchema,
      );
      expect(document.text).toBe(anyaReport);

      // Борис reaches neither route of Аня's conversation
      for (const path of [documentsPath, documentPath]) {
        const error = await expectError(borisApi.raw('get', path), 404);
        expect(error.errorCode).toBe('THREAD_NOT_FOUND');
      }

      // Борис's run of the same agent, then Аня's second run asks for her past documents
      const borisRun = await run(borisApi, record, 'Отчёт Бориса.');
      const borisDocuments = await expectBody(
        borisApi.raw('get', `/threads/${borisRun.threadId}/documents`),
        200,
        ThreadDocumentsViewSchema,
      );
      // Борис's run has its own report document, which Аня's past never lists.
      expect(borisDocuments.documents).toHaveLength(1);
      const second = await run(anyaApi, record, 'Второй отчёт Ани.', [
        { tool: 'notepad_past', args: {} },
      ]);
      const past = (await anyaApi.agentPage(second.deepAgentId)).entries.find(
        (entry) =>
          entry.kind === 'tool_result' && entry.content.tool === 'notepad_past',
      );
      const pastText = past?.kind === 'tool_result' ? past.content.text : null;
      expect(pastText?.split('\n').map((line) => line.split('.')[0])).toEqual([
        String(report.document.id),
      ]);
    },
    TEST_TIMEOUT_MS,
  );
});
