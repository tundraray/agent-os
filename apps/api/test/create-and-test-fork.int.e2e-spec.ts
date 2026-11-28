// create-and-test / fork - API integration (real AppModule + real Postgres + MCP fixture process, workers on, scripted model)
// Design Doc: docs/features/create-and-test/design-fork.md, Test Strategy UC-1 (a complete and independent copy), UC-2 (the last answer
//   and the inherited mark; an inherited open call), UC-3 (only the owner forks), UC-4 (the four refusals); and
//   docs/features/improvements/design-server.md, Test Strategy UC-10 (a fork through a message and an edit).
//
// Harness: one `createTestApp({ workers: true, mcpServers: ['logs', 'backoffice'] })`. The chat is scripted by the employee's messages;
//   `search_logs` answers oversized (fixture fault `oversize`), so its result is stored and read back with `read_tool_result`. The
//   double records every model call: the proof that a fork calls no model and of what the fork's first turn reads.
//
// Not repeated here: the refusal rule's order (`forkRefusal` is reached once per reason here, which is the whole rule), the copy's SQL
//   (one row per table through these forks), the deletion of a conversation and the stop of a root (agent-platform chat INT-3, INT-2).

import { randomUUID } from 'node:crypto';
import { ControlOperations } from '@agent-os/agents';
import {
  createLatch,
  inputLines,
  type ScriptedToolCall,
} from '@agent-os/agents/testing';
import {
  AgentTasksViewSchema,
  TestRunStartedSchema,
  ThreadForksResponseSchema,
  ThreadSummarySchema,
  type ConversationView,
  type HistoryEntry,
  type ThreadSummary,
} from '@agent-os/contracts';
import { waitFor } from '@agent-os/db/testing';
import { argsHash, fixtureCallsOf } from '@agent-os/mcp-fixture';
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
import { BUILTIN, pointBuiltinsAt } from './support/library';
import { BACKOFFICE_SERVER, LOGS_SERVER } from './support/mcp-servers';
import {
  apiRequest,
  createEmployee,
  seedSuperAdmin,
  type Session,
} from './support/session';

const TEST_TIMEOUT_MS = 120_000;
const MODEL = runModel('haiku-fork');
const GENERATED_TITLE = 'Conversation title';

const SEARCH_LOGS = `mcp__${LOGS_SERVER}__search_logs`;
const CREATE_NOTE = `mcp__${BACKOFFICE_SERVER}__create_incident_note`;
const LOG_ARGS = {
  from: '2000-01-01T00:00:00Z',
  to: '2100-01-01T00:00:00Z',
  pageSize: 20,
};
/** Above the default store threshold of 50 000 characters. */
const OVERSIZED_BYTES = 60_000;

function call(
  tool: string,
  args: Record<string, unknown> = {},
): ScriptedToolCall {
  return { tool, args };
}

/** A history entry as one line: `<kind>: <text>`, an answer with its calls, a result with its outcome. */
function entryLine(entry: HistoryEntry): string {
  switch (entry.kind) {
    case 'task':
    case 'user_message':
      return `${entry.kind}: ${entry.content.text}`;
    case 'model_answer':
      return `model_answer: ${entry.content.text} [${entry.content.toolCalls.map((one) => one.tool).join(', ')}]`;
    case 'tool_result':
      return `tool_result: ${entry.content.tool} ${entry.content.outcome}`;
    case 'event':
      return `event: ${entry.content.event}`;
    default:
      return entry.kind;
  }
}

function linesOf(view: ConversationView): string[] {
  return view.entries.map(entryLine);
}

let harness: TestApp;
let admin: Session;
let role: RunRole;
let restoreModels: (() => Promise<void>) | undefined;
let restoreBuiltins: (() => Promise<void>) | undefined;
const madeUsers: string[] = [];

async function employee(): Promise<Session> {
  const session = await createEmployee(harness.app, admin);
  madeUsers.push(session.id);
  await role.add(session);
  return session;
}

function fork(api: ChatApi, threadId: string) {
  return api.raw('post', `/threads/${threadId}/fork`);
}

function forked(api: ChatApi, threadId: string): Promise<ThreadSummary> {
  return expectBody(fork(api, threadId), 201, ThreadSummarySchema);
}

async function forksOf(api: ChatApi, threadId: string): Promise<string[]> {
  const { threads } = await expectBody(
    api.raw('get', `/threads/${threadId}/forks`),
    200,
    ThreadForksResponseSchema,
  );
  return threads.map((thread) => thread.id);
}

async function refusal(api: ChatApi, threadId: string): Promise<string> {
  const error = await expectError(fork(api, threadId), 409);
  expect(error.errorCode).toBe('FORK_REFUSED');
  return error.reason ?? '';
}

/** Waits until the chat is free and its last entry is the answer `text`. */
function untilAnswered(
  api: ChatApi,
  threadId: string,
  text: string,
): Promise<ConversationView> {
  return waitFor(
    () => api.history(threadId),
    (view) => {
      const last = view.entries.at(-1);
      return (
        view.chat.status === 'idle' &&
        last?.kind === 'model_answer' &&
        last.content.text === text
      );
    },
    `the answer "${text}"`,
  );
}

/** Sends `text` and waits for the scripted `answer`. */
async function ask(
  api: ChatApi,
  threadId: string,
  text: string,
  answer: string,
): Promise<ConversationView> {
  await api.send(threadId, text);
  return untilAnswered(api, threadId, answer);
}

/** A new conversation whose first message gets `answer`; waits for its generated title, so no title call runs later. */
async function conversation(
  api: ChatApi,
  text: string,
  answer: string,
): Promise<string> {
  harness.model.script({ task: text }, [{ text: answer }]);
  const { id } = await api.createThread();
  await ask(api, id, text, answer);
  await waitFor(
    () => api.getThread(id),
    (thread) => thread.title === GENERATED_TITLE,
    'the generated title',
  );
  return id;
}

/** A conversation whose chat asked to create a note and waits for the decision. */
async function awaitingNote(api: ChatApi, text: string): Promise<string> {
  harness.model.script({ task: text }, [
    { calls: [call(CREATE_NOTE, { orderId: 'ORD-9001', text })] },
  ]);
  const { id } = await api.createThread();
  await api.send(id, text);
  await waitFor(
    () => api.history(id),
    (view) => view.decisions.some((decision) => decision.status === 'open'),
    'the open decision',
  );
  return id;
}

describe('create-and-test / fork - a conversation forks into an independent copy that continues from its last answer, for its owner only and only when it is free', () => {
  beforeAll(async () => {
    harness = await createTestApp({
      workers: true,
      mcpServers: ['logs', 'backoffice'],
      faults: () => [
        {
          tool: 'search_logs',
          argsHash: argsHash(LOG_ARGS),
          occurrences: 'all',
          mode: 'oversize',
          bytes: OVERSIZED_BYTES,
        },
      ],
    });
    harness.model.completeText({ text: GENERATED_TITLE });
    admin = await seedSuperAdmin(
      harness.app,
      `e2e-fork-admin-${randomUUID().slice(0, 8)}`,
    );
    madeUsers.push(admin.id);
    restoreModels = await useRunModels(harness.app, admin, {
      chat: { id: MODEL, ...HAIKU_TEST_PRICES },
    });
    restoreBuiltins = await pointBuiltinsAt(harness.app, admin, MODEL);
    role = await allowRole(harness.app, admin, {
      name: 'fork',
      models: [MODEL],
      servers: [LOGS_SERVER, BACKOFFICE_SERVER],
    });
    // UC-4 forks a test run, which needs the right to train one's own agents.
    await apiRequest(harness.app, admin, 'patch', `/admin/roles/${role.id}`, {
      trainOwn: true,
    }).expect(200);
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
          roles: role === undefined ? [] : [role.id],
          users: madeUsers,
        });
      }
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  // UC-1 (AC-11.1, AC-11.5, AC-11.8, DC-1, invariants 1, 2, 4).
  // Catches: a model call at the fork; an entry, a stored result or the task list left out of the copy; a message of one conversation
  //   in the other; the fork missing from the source's forks; a fork lost or cut when its source is deleted.
  it(
    'FK-1: the fork copies the history, the stored result and the task list without a model call; both go on apart; the fork outlives its source',
    async () => {
      const api = chatApi(harness.app, await employee());
      const [searched, planned, summed] = [
        'UC-1: search the payment logs',
        'UC-1: plan the review',
        'UC-1: sum it up',
      ];
      harness.model.script({ task: searched }, [
        { calls: [call(SEARCH_LOGS, LOG_ARGS)] },
        { text: 'Found the failures.' },
      ]);
      harness.model.script({ task: planned }, [
        {
          calls: [
            call('task_create', {
              subject: 'Check the failures',
              description: 'Read every failure of the logs',
            }),
          ],
        },
        { text: 'Planned.' },
      ]);
      harness.model.script({ task: summed }, [
        { text: 'Payments fail on timeouts.' },
      ]);
      const { id: sourceId } = await api.createThread();
      await ask(api, sourceId, searched, 'Found the failures.');
      await ask(api, sourceId, planned, 'Planned.');
      const source = await ask(
        api,
        sourceId,
        summed,
        'Payments fail on timeouts.',
      );
      await waitFor(
        () => api.getThread(sourceId),
        (thread) => thread.title === GENERATED_TITLE,
        'the generated title',
      );
      await api.renameThread(sourceId, 'Разбор Jira');
      const stored = source.entries.find(
        (entry) =>
          entry.kind === 'tool_result' && entry.content.tool === 'search_logs',
      );
      if (stored?.kind !== 'tool_result')
        throw new Error('no search_logs result');
      expect(stored.content.text).toMatch(/^\[stored result\]/);
      const sourceTasks = await expectBody(
        api.raw('get', `/agents/${sourceId}/tasks`),
        200,
        AgentTasksViewSchema,
      );
      expect(sourceTasks.tasks.map((task) => task.subject)).toEqual([
        'Check the failures',
      ]);
      const modelCalls = harness.model.calls.length;
      const throughSeq = source.entries.at(-1)?.seq;

      // When: the employee forks it
      const branch = await forked(api, sourceId);

      // Then: no model call; the summary names the source and the boundary
      expect(harness.model.calls).toHaveLength(modelCalls);
      expect(branch).toMatchObject({
        title: 'Ветка · Разбор Jira',
        forkable: true,
        forkCount: 0,
        forkedFrom: { threadId: sourceId, title: 'Разбор Jira', throughSeq },
      });
      expect(await forksOf(api, sourceId)).toEqual([branch.id]);
      expect((await api.getThread(sourceId)).forkCount).toBe(1);

      // Then: entries 2 … the boundary are the source's, entry 1 has its text, the `forked` event follows
      const copy = await api.history(branch.id);
      expect(copy.chat.status).toBe('idle');
      expect(copy.entries.slice(1, source.entries.length)).toEqual(
        source.entries.slice(1),
      );
      expect(linesOf(copy)).toEqual([...linesOf(source), 'event: forked']);
      expect(
        await expectBody(
          api.raw('get', `/agents/${branch.id}/tasks`),
          200,
          AgentTasksViewSchema,
        ),
      ).toEqual(sourceTasks);

      // When: the employee writes into each; Then: the fork reads the stored result in full, neither sees the other's message
      const [inFork, inSource] = [
        'UC-1: read the stored logs',
        'UC-1: anything else?',
      ];
      harness.model.script({ task: inFork }, [
        {
          calls: [call('read_tool_result', { callId: stored.content.callId })],
        },
        { text: 'Read them all.' },
      ]);
      harness.model.script({ task: inSource }, [{ text: 'Nothing else.' }]);
      const branchAfter = await ask(api, branch.id, inFork, 'Read them all.');
      const sourceAfter = await ask(api, sourceId, inSource, 'Nothing else.');
      const read = branchAfter.entries.find(
        (entry) =>
          entry.kind === 'tool_result' &&
          entry.content.tool === 'read_tool_result',
      );
      expect(read?.kind === 'tool_result' && read.content.outcome).toBe(
        'success',
      );
      expect(linesOf(branchAfter)).not.toContain(`user_message: ${inSource}`);
      expect(linesOf(sourceAfter)).not.toContain(`user_message: ${inFork}`);

      // When: the source is deleted; Then: the fork reads whole, its source untitled
      await api.deleteThread(sourceId);
      expect((await api.getThread(branch.id)).forkedFrom).toEqual({
        threadId: sourceId,
        title: null,
        throughSeq,
      });
      expect((await api.history(branch.id)).entries).toEqual(
        branchAfter.entries,
      );
    },
    TEST_TIMEOUT_MS,
  );

  // UC-2 (AC-11.4, AC-11.6, AC-11.7, DC-3, invariant 3).
  // Catches: the fork's first turn reading the history out of order or answering the inherited question again; an inherited open
  //   call left open in the fork or sent to its server; a write into the source.
  it(
    "FK-2: the fork's first turn reads the inherited history, the last answer, the forked event and the new message in order; an inherited open call is closed interrupted and never sent",
    async () => {
      const owner = await employee();
      const api = chatApi(harness.app, owner);

      // A conversation that ends with the agent's answer
      const question = 'UC-2: what failed yesterday?';
      const sourceId = await conversation(
        api,
        question,
        'Two payments failed.',
      );
      const branch = await forked(api, sourceId);
      const shorter = 'UC-2: make it shorter';
      const turn = harness.model.script({ task: shorter }, [
        { text: 'Two failed.' },
      ]);
      await ask(api, branch.id, shorter, 'Two failed.');
      expect(turn.calls).toHaveLength(1);
      expect(inputLines(turn.calls[0]!.messages)).toEqual([
        `user: ${question}`,
        'assistant: Two payments failed. []',
        expect.stringMatching(/^user: \[event\] forked: /),
        `user: ${shorter}`,
      ]);

      // A root stopped while its call waited for the employee's decision. The API stops no chat root, so the stop goes
      // through the agents' operation, as any other stopper of a root would.
      const noted = 'UC-2: note the double charge';
      const stoppedId = await awaitingNote(api, noted);
      await harness.app
        .get(ControlOperations)
        .stop({ agentId: stoppedId, ownerId: owner.id });
      const stopped = await waitFor(
        () => api.history(stoppedId),
        (view) =>
          view.entries.some(
            (entry) =>
              entry.kind === 'event' && entry.content.event === 'stopped',
          ),
        'the stopped root',
      );
      const stoppedBranch = await forked(api, stoppedId);
      const inherited = await api.history(stoppedBranch.id);
      expect(linesOf(inherited).slice(-2)).toEqual([
        'tool_result: create_incident_note interrupted',
        'event: forked',
      ]);
      expect((await api.history(stoppedId)).entries).toEqual(stopped.entries);

      const after = 'UC-2: what happened to the note?';
      const next = harness.model.script({ task: after }, [
        { text: 'The note was not filed.' },
      ]);
      await ask(api, stoppedBranch.id, after, 'The note was not filed.');
      expect(inputLines(next.calls[0]!.messages)).toContain(
        `tool: ${CREATE_NOTE}`,
      );
      expect(
        fixtureCallsOf(harness.fixtureLog.callLog, {
          tool: 'create_incident_note',
        }),
      ).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  // UC-3 (AC-11.2, invariant 5).
  // Catches: a foreign conversation forked or its forks listed, by an employee or an administrator.
  it(
    'FK-3: another employee and an administrator get 404 THREAD_NOT_FOUND and no conversation is made',
    async () => {
      const owner = chatApi(harness.app, await employee());
      const sourceId = await conversation(
        owner,
        'UC-3: my question',
        'My answer.',
      );
      for (const other of [await employee(), admin]) {
        const api = chatApi(harness.app, other);
        for (const response of [
          fork(api, sourceId),
          api.raw('get', `/threads/${sourceId}/forks`),
        ])
          expect((await expectError(response, 404)).errorCode).toBe(
            'THREAD_NOT_FOUND',
          );
        expect((await api.listThreads()).threads).toEqual([]);
      }
      expect((await owner.listThreads()).threads.map((one) => one.id)).toEqual([
        sourceId,
      ]);
      expect(await forksOf(owner, sourceId)).toEqual([]);
    },
    TEST_TIMEOUT_MS,
  );

  // UC-4 (AC-11.3, DC-2).
  // Catches: a fork of a conversation whose chat answers, that waits for a decision, whose agent works, or that is not a chat; a
  //   conversation made by a refused fork.
  it(
    'FK-4: an answering chat, an open decision, a working agent and a test run -> 409 FORK_REFUSED with the reason, nothing made',
    async () => {
      const session = await employee();
      const api = chatApi(harness.app, session);

      // The chat answers
      const answering = 'UC-4: answer slowly';
      const held = createLatch();
      const slow = harness.model.script({ task: answering }, [
        { latch: held, text: 'Slow answer.' },
      ]);
      const { id: answeringId } = await api.createThread();
      await api.send(answeringId, answering);
      await slow.called(1);

      // A decision waits
      const awaitingId = await awaitingNote(api, 'UC-4: note it');

      // An agent of the conversation works
      const delegating = 'UC-4: delegate the reading';
      const childTask = 'UC-4: read the logs';
      const childHeld = createLatch();
      harness.model.script(
        { task: delegating },
        [
          {
            calls: [
              call('start_agent', {
                agent: BUILTIN.generalPurpose.name,
                description: 'reader',
                prompt: childTask,
              }),
            ],
          },
          { text: 'A reader is on it.' },
        ],
        { thereafter: { text: 'The reader reported.' } },
      );
      const child = harness.model.script({ task: childTask }, [
        { latch: childHeld, text: 'Read.' },
      ]);
      const { id: delegatingId } = await api.createThread();
      await api.send(delegatingId, delegating);
      await untilAnswered(api, delegatingId, 'A reader is on it.');
      await child.called(1);

      // A test run
      const description = `UC-4: an agent that sorts orders ${randomUUID().slice(0, 8)}`;
      const trainerHeld = createLatch();
      const trainer = harness.model.script({ task: description }, [
        { latch: trainerHeld, text: 'Думаю.' },
      ]);
      const { testRunId } = await expectBody(
        apiRequest(harness.app, session, 'post', '/test-runs', { description }),
        201,
        TestRunStartedSchema,
      );
      await trainer.called(1);

      const threadsBefore = (await api.listThreads()).threads.map(
        (one) => one.id,
      );
      const sources = [answeringId, awaitingId, delegatingId, testRunId];
      const reasons: string[] = [];
      for (const sourceId of sources)
        reasons.push(await refusal(api, sourceId));

      expect(reasons).toEqual([
        'answering',
        'awaiting_confirmation',
        'tasks_running',
        'not_a_chat',
      ]);
      expect(
        (await api.listThreads()).threads.map((one) => one.id).sort(),
      ).toEqual([...threadsBefore].sort());
      for (const sourceId of sources)
        expect(await forksOf(api, sourceId)).toEqual([]);

      held.open();
      childHeld.open();
      await api.stopAgent(testRunId);
    },
    TEST_TIMEOUT_MS,
  );

  // improvements design-server.md UC-10 (AC-05.1, AC-05.2, NFR-02; KD-6, Flow 3).
  // Catches: a boundary moved off the named message; an edit's fork made without its message, or not answered; a fork made while
  //   the tree is busy; the task list copied past the boundary; a boundary on a non-message (or both fields) accepted; another
  //   employee's conversation forked through a message.
  it(
    'FK-5: a fork through a message inherits through it; an edit forks before the message and answers the edited text (also of the first and of a message delivered mid-turn); busy -> 409, not a message -> 400, foreign -> 404',
    async () => {
      const owner = await employee();
      const api = chatApi(harness.app, owner);
      const [first, second, third] = [
        'UC-10: what failed yesterday?',
        'UC-10: plan the review',
        'UC-10: sum it up',
      ];
      harness.model.script({ task: second }, [
        {
          calls: [
            call('task_create', {
              subject: 'Review the failures',
              description: 'Read every failure',
            }),
          ],
        },
        { text: 'Planned.' },
      ]);
      harness.model.script({ task: third }, [{ text: 'Timeouts.' }]);
      const sourceId = await conversation(api, first, 'Two payments failed.');
      await ask(api, sourceId, second, 'Planned.');
      const source = await ask(api, sourceId, third, 'Timeouts.');
      const secondSeq = source.entries.find(
        (entry) =>
          entry.kind === 'user_message' && entry.content.text === second,
      )?.seq;
      if (secondSeq === undefined) throw new Error('no second message');
      const { tasks: sourceTasks } = await expectBody(
        api.raw('get', `/agents/${sourceId}/tasks`),
        200,
        AgentTasksViewSchema,
      );
      expect(sourceTasks.map((task) => task.subject)).toEqual([
        'Review the failures',
      ]);
      const modelCalls = harness.model.calls.length;

      // When: an aside through the third message; Then: three messages and the forked event, no model call, no task list
      const aside = await expectBody(
        api.raw('post', `/threads/${sourceId}/fork`, { throughSeq: secondSeq }),
        201,
        ThreadSummarySchema,
      );
      expect(aside.forkedFrom).toEqual({
        threadId: sourceId,
        title: GENERATED_TITLE,
        throughSeq: secondSeq,
      });
      const asideView = await api.history(aside.id);
      expect(asideView.chat.status).toBe('idle');
      expect(linesOf(asideView)).toEqual([
        `task: ${first}`,
        'model_answer: Two payments failed. []',
        `user_message: ${second}`,
        'event: forked',
      ]);
      expect(harness.model.calls).toHaveLength(modelCalls);
      const { tasks: asideTasks } = await expectBody(
        api.raw('get', `/agents/${aside.id}/tasks`),
        200,
        AgentTasksViewSchema,
      );
      expect(asideTasks).toEqual([]);

      // When: the first message is edited; Then: the fork starts with the edited text and answers it, through 0
      const editedFirst = 'UC-10: what failed last week?';
      harness.model.script({ task: editedFirst }, [
        { text: 'Five payments failed.' },
      ]);
      const editFirst = await expectBody(
        api.raw('post', `/threads/${sourceId}/fork`, {
          edit: { seq: 1, text: editedFirst },
        }),
        201,
        ThreadSummarySchema,
      );
      expect(editFirst.forkedFrom).toMatchObject({
        threadId: sourceId,
        throughSeq: 0,
      });
      expect(
        linesOf(
          await untilAnswered(api, editFirst.id, 'Five payments failed.'),
        ),
      ).toEqual([
        `task: ${editedFirst}`,
        'model_answer: Five payments failed. []',
      ]);

      // A conversation whose second message is delivered mid-turn, after the result of the call in flight
      const looked = 'UC-10: look at the logs';
      const added = 'UC-10: and the refunds';
      const held = createLatch();
      const looking = harness.model.script({ task: looked }, [
        { latch: held, calls: [call(SEARCH_LOGS, LOG_ARGS)] },
      ]);
      harness.model.script({ task: added }, [{ text: 'Logs and refunds.' }]);
      const { id: midTurnId } = await api.createThread();
      await api.send(midTurnId, looked);
      await looking.called(1);

      // When: it is forked while the chat answers; Then: 409 answering
      const busy = await expectError(
        api.raw('post', `/threads/${midTurnId}/fork`, { throughSeq: 1 }),
        409,
      );
      expect(busy).toMatchObject({
        errorCode: 'FORK_REFUSED',
        reason: 'answering',
      });

      await api.send(midTurnId, added);
      held.open();
      const midTurn = await untilAnswered(api, midTurnId, 'Logs and refunds.');
      const addedIndex = midTurn.entries.findIndex(
        (entry) =>
          entry.kind === 'user_message' && entry.content.text === added,
      );
      expect(midTurn.entries[addedIndex - 1]?.kind).toBe('tool_result');
      const callingAnswer = midTurn.entries.find(
        (entry) =>
          entry.kind === 'model_answer' && entry.content.toolCalls.length > 0,
      );
      if (callingAnswer === undefined) throw new Error('no answer with calls');

      // When: the employee edits the mid-turn message; Then: everything before it, the forked event, the edited text, its answer
      const editedAdded = 'UC-10: and the chargebacks';
      harness.model.script({ task: editedAdded }, [
        { text: 'Logs and chargebacks.' },
      ]);
      const editMid = await expectBody(
        api.raw('post', `/threads/${midTurnId}/fork`, {
          edit: { seq: midTurn.entries[addedIndex]!.seq, text: editedAdded },
        }),
        201,
        ThreadSummarySchema,
      );
      expect(editMid.forkedFrom?.throughSeq).toBe(
        midTurn.entries[addedIndex]!.seq - 1,
      );
      expect(
        linesOf(await untilAnswered(api, editMid.id, 'Logs and chargebacks.')),
      ).toEqual([
        ...linesOf(midTurn).slice(0, addedIndex),
        'event: forked',
        `user_message: ${editedAdded}`,
        'model_answer: Logs and chargebacks. []',
      ]);
      expect((await api.history(midTurnId)).entries).toEqual(midTurn.entries);

      // When: a boundary on no message it may end at, or both fields; Then: 400, nothing made
      const threadsBefore = (await api.listThreads()).threads.map(
        (one) => one.id,
      );
      for (const body of [
        { throughSeq: callingAnswer.seq },
        { throughSeq: midTurn.entries[addedIndex - 1]!.seq },
        { throughSeq: 10_000 },
        { edit: { seq: callingAnswer.seq, text: editedAdded } },
        { throughSeq: 1, edit: { seq: 1, text: editedAdded } },
      ])
        expect(
          (
            await expectError(
              api.raw('post', `/threads/${midTurnId}/fork`, body),
              400,
            )
          ).errorCode,
        ).toBe('VALIDATION_FAILED');
      expect((await api.listThreads()).threads.map((one) => one.id)).toEqual(
        threadsBefore,
      );
      expect(await forksOf(api, midTurnId)).toEqual([editMid.id]);

      // Then: the source did not change
      expect((await api.history(sourceId)).entries).toEqual(source.entries);

      // When: another employee forks the owner's conversation through a message; Then: 404, nothing made
      const other = chatApi(harness.app, await employee());
      expect(
        (
          await expectError(
            other.raw('post', `/threads/${sourceId}/fork`, {
              throughSeq: secondSeq,
            }),
            404,
          )
        ).errorCode,
      ).toBe('THREAD_NOT_FOUND');
      expect((await other.listThreads()).threads).toEqual([]);
      expect([...(await forksOf(api, sourceId))].sort()).toEqual(
        [aside.id, editFirst.id].sort(),
      );
    },
    TEST_TIMEOUT_MS,
  );
});
