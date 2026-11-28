// self-learning / scripts - API integration (real AppModule + real Postgres + MCP fixture process, workers on, scripted model)
// Design Doc: docs/features/self-learning/design-scripts.md, Test Strategy «Главный путь и изоляция» (AC-12.1, AC-12.2, AC-13.1, DC-1,
//   DC-3), «Запись не уходит без решения» (AC-13.2, AC-14.3, DC-6), «Версия без активации и чат» (DC-5, the chat half).
//
// Harness: one `createTestApp({ workers: true, mcpServers: ['backoffice', 'logs'] })`; the fixture's call log is the proof of what reached
//   a server. Runs are deep agents started from the employee's chat (`startDeepAgentInChat`).
//
// Not repeated here: the activation guard of a version (DC-2) is training TR-5 (`TRAINING_BASE_CHANGED`, nothing moved); a restart in
//   the middle of a `write` run is code-execution's (`run_code` and a saved script share the run).

import { randomUUID } from 'node:crypto';
import {
  AGENTS_TOOL_CONFIRMATION,
  RunCodeConfirmationContentSchema,
  type CreateRecordBody,
  type HistoryEntry,
  type Script,
} from '@agent-os/contracts';
import { waitFor } from '@agent-os/db/testing';
import { readFixtureLog } from '@agent-os/mcp-fixture';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  allowRole,
  grantTo,
  HAIKU_TEST_PRICES,
  removeRunRows,
  runModel,
  type RunRole,
  useRunModels,
} from './support/access';
import { chatApi } from './support/api';
import { createTestApp, type TestApp } from './support/createTestApp';
import {
  createRecord,
  deepAgentBody,
  getRecord,
  pointBuiltinsAt,
  recordName,
} from './support/library';
import { BACKOFFICE_SERVER, LOGS_SERVER } from './support/mcp-servers';
import {
  briefTask,
  editArgs,
  pendingCardOf,
  recordToolCall,
  startDeepAgentInChat,
  toolResultsOf,
  untilAgentStatus,
} from './support/record-tools';
import {
  createEmployee,
  seedSuperAdmin,
  type Session,
} from './support/session';

const TEST_TIMEOUT_MS = 300_000;
const MODEL = runModel('haiku-scripts');

const READER = 'reader';
const GET_ORDER = `mcp__${BACKOFFICE_SERVER}__get_order`;
const GET_TRACE = `mcp__${LOGS_SERVER}__get_trace`;
const CREATE_NOTE = `mcp__${BACKOFFICE_SERVER}__create_incident_note`;

/** The reader's `read` script: one allowed read, one read the employee has no right to. */
const LOOKUP: Script = {
  name: 'lookup',
  description: 'Reads the order and its trace',
  input: 'orderId',
  code: [
    `await callTool(${JSON.stringify(GET_ORDER)}, { orderId: input.orderId });`,
    `try { await callTool(${JSON.stringify(GET_TRACE)}, { traceId: "b1".repeat(16) }); return "order read; trace sent"; }`,
    'catch (error) { return "order read; trace " + error.outcome + " " + error.reason; }',
  ].join('\n'),
  class: 'read',
  owner: READER,
};

/** The deep agent's own `write` script. */
const NOTE: Script = {
  name: 'note',
  description: 'Writes the incident note of the order',
  input: '',
  code: `await callTool(${JSON.stringify(CREATE_NOTE)}, { orderId: "ord-0000a001", text: "from a script" }); return "noted";`,
  class: 'write',
  owner: null,
};

let harness: TestApp;
let admin: Session;
let role: RunRole;
let restoreModels: (() => Promise<void>) | undefined;
let restoreBuiltins: (() => Promise<void>) | undefined;
const made = { users: [] as string[], roles: [] as string[] };

/** An employee of the role, with a personal deny of `get_trace`. */
async function employee(): Promise<Session> {
  const session = await createEmployee(harness.app, admin);
  made.users.push(session.id);
  await role.add(session);
  await grantTo(
    harness.app,
    admin,
    { userId: session.id },
    {
      effect: 'deny',
      target: { kind: 'tool', server: LOGS_SERVER, tool: 'get_trace' },
    },
  );
  return session;
}

/** A deep agent of `author` whose subagent `reader` uses both servers, with the scripts `lookup` (reader's) and `note` (its own). */
function scriptedAgentBody(): Extract<
  CreateRecordBody,
  { kind: 'deep_agent' }
> {
  const body = deepAgentBody(recordName('Скрипты'), MODEL, [
    { name: READER, servers: [BACKOFFICE_SERVER, LOGS_SERVER] },
  ]);
  return {
    ...body,
    content: {
      ...body.content,
      servers: [BACKOFFICE_SERVER],
      scripts: [LOOKUP, NOTE],
    },
  };
}

function results(
  entries: readonly HistoryEntry[],
  tool: string,
): Extract<HistoryEntry, { kind: 'tool_result' }>['content'][] {
  return entries.flatMap((entry) =>
    entry.kind === 'tool_result' && entry.content.tool === tool
      ? [entry.content]
      : [],
  );
}

/** The tools that reached the fixture servers since `from` entries of its log. */
function sentSince(from: number): string[] {
  return readFixtureLog(harness.fixtureLog.callLog)
    .slice(from)
    .map((entry) => entry.tool);
}

describe('self-learning / scripts - a saved script is a tool of its owner only, under the rights of run_code, and the chat never changes it', () => {
  beforeAll(async () => {
    harness = await createTestApp({
      workers: true,
      mcpServers: ['backoffice', 'logs'],
    });
    harness.model.completeText({ text: 'Скрипты' });
    admin = await seedSuperAdmin(
      harness.app,
      `e2e-scripts-admin-${randomUUID().slice(0, 8)}`,
    );
    made.users.push(admin.id);
    restoreModels = await useRunModels(harness.app, admin, {
      chat: { id: MODEL, ...HAIKU_TEST_PRICES },
    });
    restoreBuiltins = await pointBuiltinsAt(harness.app, admin, MODEL);
    role = await allowRole(harness.app, admin, {
      name: 'scripts',
      models: [MODEL],
      servers: [BACKOFFICE_SERVER, LOGS_SERVER],
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

  // Main path and isolation. Catches: a script offered to a member that does not own it; a script's MCP call that skips the employee's
  //   rights (the denied read reaching the logs server).
  it(
    "SCR-1: the reader's read script runs as script__lookup for the reader only, the deep agent's own script only for it, and its MCP calls go through the employee's rights",
    async () => {
      const anya = await employee();
      const record = await createRecord(harness.app, anya, scriptedAgentBody());
      const question = `Заказ ${randomUUID().slice(0, 8)}`;
      const assignment = 'Прочитай заказ ord-0000a001 скриптом';
      const deepAgent = harness.model.script(
        { task: briefTask(question) },
        [
          {
            calls: [
              {
                tool: 'task',
                args: { subagentType: READER, description: assignment },
              },
            ],
          },
        ],
        { thereafter: { text: 'Заказ прочитан.' } },
      );
      const reader = harness.model.script(
        { task: `Question: ${question}\n\n${assignment}` },
        [
          {
            calls: [
              {
                tool: 'script__lookup',
                args: { input: { orderId: 'ord-0000a001' } },
              },
            ],
          },
          { text: 'Прочитал.' },
        ],
      );
      const sentBefore = readFixtureLog(harness.fixtureLog.callLog).length;
      const api = chatApi(harness.app, anya);
      const { threadId, deepAgentId } = await startDeepAgentInChat(
        harness.model,
        api,
        { record, question, chatTask: `Запусти ${question}` },
      );
      await untilAgentStatus(api, threadId, deepAgentId, 'completed');

      const scriptsOf = (names: readonly string[] | undefined) =>
        (names ?? []).filter((name) => name.startsWith('script__')).sort();
      expect(scriptsOf(deepAgent.calls[0]?.toolNames)).toEqual([
        'script__note',
      ]);
      expect(scriptsOf(reader.calls[0]?.toolNames)).toEqual(['script__lookup']);

      const readerNode = (await api.history(threadId)).agents
        .flatMap((node) => node.children)
        .find((node) => node.origin?.subagent === READER);
      const readerEntries = (await api.agentPage(readerNode?.agentId ?? ''))
        .entries;
      expect(
        results(readerEntries, 'script__lookup').map((result) => [
          result.outcome,
          result.text,
        ]),
      ).toEqual([['success', 'order read; trace refused no_access']]);
      expect(sentSince(sentBefore)).toEqual(['get_order']);
    },
    TEST_TIMEOUT_MS,
  );

  // A write never leaves without the employee. Catches: a `write` script run without a question; a question without the calls the code
  //   makes or without the code; a refused run that still sends.
  it(
    'SCR-2: a write script waits for the decision, the question carries its call list and its code, and refused nothing is sent',
    async () => {
      const anya = await employee();
      const record = await createRecord(harness.app, anya, scriptedAgentBody());
      const question = `Заметка ${randomUUID().slice(0, 8)}`;
      harness.model.script(
        { task: briefTask(question) },
        [{ calls: [{ tool: 'script__note', args: {} }] }],
        { thereafter: { text: 'Заметку не написал.' } },
      );
      const sentBefore = readFixtureLog(harness.fixtureLog.callLog).length;
      const api = chatApi(harness.app, anya);
      const { threadId, deepAgentId } = await startDeepAgentInChat(
        harness.model,
        api,
        { record, question, chatTask: `Запусти ${question}` },
      );

      const asking = await waitFor(
        () => api.history(threadId),
        (view) =>
          view.decisions.some(
            (decision) =>
              decision.kind === AGENTS_TOOL_CONFIRMATION &&
              decision.status === 'open',
          ),
        'the question of the write script',
      );
      const request = asking.decisions.find(
        (decision) => decision.kind === AGENTS_TOOL_CONFIRMATION,
      );
      expect(request).toMatchObject({
        agentId: deepAgentId,
        tool: 'script__note',
        scriptCode: NOTE.code,
      });
      expect(
        RunCodeConfirmationContentSchema.parse(request?.content).canCall,
      ).toEqual([{ name: CREATE_NOTE, changes: true }]);
      expect(sentSince(sentBefore)).toEqual([]);

      await api.decide(request?.decisionId ?? '', { approve: false });
      await untilAgentStatus(api, threadId, deepAgentId, 'completed');
      expect(
        results((await api.agentPage(deepAgentId)).entries, 'script__note').map(
          (result) => result.outcome,
        ),
      ).toEqual(['rejected']);
      expect(sentSince(sentBefore)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  // The chat half of DC-5. Catches: a chat edit that drops or rewrites the scripts; a chat edit that leaves a script without its owner.
  it(
    'SCR-3: a chat edit of the prompt keeps the scripts; an edit that renames the subagent owning a script is refused script_owner',
    async () => {
      const anya = await employee();
      const record = await createRecord(harness.app, anya, scriptedAgentBody());
      if (record.kind !== 'deep_agent') throw new Error('not a deep agent');
      const renamed = editArgs(record);
      const content = renamed.content as typeof record.content;
      const task = `Поправь ${record.name}`;
      harness.model.script(
        { task },
        [
          {
            calls: [
              recordToolCall(
                'edit_record',
                editArgs(record, { prompt: 'Новый промпт из чата' }),
              ),
            ],
          },
          {
            calls: [
              recordToolCall('edit_record', {
                ...renamed,
                content: {
                  ...content,
                  subagents: content.subagents.map((subagent) => ({
                    ...subagent,
                    name: 'writer',
                  })),
                },
              }),
            ],
          },
        ],
        { thereafter: { text: 'Готово.' } },
      );
      const api = chatApi(harness.app, anya);
      const { id: threadId } = await api.createThread();
      await api.send(threadId, task);
      const card = await waitFor(
        () => api.history(threadId),
        (view) => pendingCardOf(view) !== undefined,
        'the card of the edit',
      );
      await api.decide(pendingCardOf(card)?.decision.decisionId ?? '', {
        approve: true,
      });
      const done = await waitFor(
        () => api.history(threadId),
        (view) => toolResultsOf(view, 'edit_record').length === 2,
        'both edits',
      );

      const saved = await getRecord(harness.app, anya, record.id);
      expect(saved.version).toBe(2);
      expect(saved.kind === 'deep_agent' && saved.content.prompt).toBe(
        'Новый промпт из чата',
      );
      expect(saved.kind === 'deep_agent' && saved.content.scripts).toEqual([
        LOOKUP,
        NOTE,
      ]);
      const [, refused] = toolResultsOf(done, 'edit_record');
      expect(refused).toMatchObject({
        outcome: 'refused',
        refusalReason: 'invalid_arguments',
      });
      expect(refused?.text).toContain(READER);
      expect((await getRecord(harness.app, anya, record.id)).version).toBe(2);
    },
    TEST_TIMEOUT_MS,
  );
});
