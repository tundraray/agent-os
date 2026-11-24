// data-model / agents - integration tests (real AppModule + real Postgres + real library, workers on, scripted model)
// Design Doc: docs/features/data-model/design-agents.md, Test Strategy UC-1, UC-2, UC-3 (call by name) and UC-7 (deletion).
// No PRD and no UXRD for this feature (owner's decision): the Design Doc's acceptance criteria (DC-16 .. DC-30) are the source.
// Test Type: Integration. Budget of the part: 4 of 3 integration skeletons (this file 2, packages/agents 1, packages/db 1), 0 E2E.
//   The fourth is the migration rows of the default agents (packages/db file); it names a defect no other test catches (its header).
//   0 E2E: the journey a user notices first (write in chat -> a colleague's agent starts by name -> the run is labelled) crosses the web
//   part's screens and the repo has no browser E2E tool; its API half is the first case below over real HTTP.
// First run: the feature's full run, after the last part.
//
// File name and place follow the package convention: `test/*.e2e-spec.ts` with the `.int.` infix, picked up by `vitest.config.e2e.ts`;
// harness `createTestApp({ workers: true })` and the helpers of `test/support/*`, as in `custom-agents-runtime.int.e2e-spec.ts`.
// Do NOT run it against the development database: export the test `DATABASE_URL` first (apps/api/CLAUDE.md).
// Each case uses its own employees, roles and run-suffixed agent names; no check of a global list.
//
// Already proven elsewhere and NOT repeated here (these suites are adapted to the new tables, names and versions, not duplicated):
// - DC-16, DC-17 (a save inserts version n+1 with the employee as author and moves the pointer; a stale save is 409 and leaves nothing):
//   INT-5 of `custom-agents-library.int.e2e-spec.ts`.
// - DC-18 (a running conversation stays on its version, a new start takes the new one): INT-1 A of
//   `packages/agents/test/custom-agents-runtime.int.e2e-spec.ts`.
// - DC-22 (an employee without roles sees the three default agents; the administrator edits one but cannot delete or share it): INT-1 of
//   `custom-agents-library.int.e2e-spec.ts` and the unit rows of `apps/api/src/library/audience-rules.spec.ts` / `save-rules.spec.ts`.
// - DC-20 (an inherited model the owner may no longer use refuses the child): the unit row of `resolve-start.spec.ts` (INT-2 / INT-3 of
//   `enterprise-access-access.int.e2e-spec.ts` refuse only an agent's own model).
// - Unit level: the model chain and the version/name per start path, an unknown deep agent name starting a temporary default deep
//   agent among them (`resolve-start.spec.ts`); the rule of `task` and of the wrong kind (`tool-gate.spec.ts`, `delegation-rules.spec.ts`);
//   `start_deep_agent` with the name of an ordinary agent answering `not_allowed` (`start-deep-agent.spec.ts`; the real kind filter
//   is exercised here once, through `start_agent`); "the tool description lists only the winner of each name" (`chat-listing.spec.ts`).
//
// Mock boundary: the model is the scripted double (`AGENT_TURN_CLIENT`); `LibraryService`, `AccessService`, the repositories, the runtime and Postgres
//   are real - this level exists because visibility of the owner of the tree is the isolation rule and only the real library has it.

import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  createLatch,
  createScriptedModel,
  DEFAULT_USAGE,
  type ScriptedModel,
  type ScriptedReply,
  type ScriptedToolCall,
} from '@agent-os/agents/testing';
import {
  type AgentNode,
  type ConversationView,
  type HistoryEntry,
  RecordSummarySchema,
  StartRefusedErrorSchema,
} from '@agent-os/contracts';
import { waitFor } from '@agent-os/db/testing';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  allowRole,
  grantTo,
  HAIKU_TEST_PRICES,
  removeRunRows,
  runModel,
  type RunRole,
  useRunModels,
} from './support/access';
import { type ChatApi, chatApi, expectBody } from './support/api';
import { createTestApp, type TestApp } from './support/createTestApp';
import {
  agentBody,
  BUILTIN,
  createRecord,
  createSystemRecord,
  listLibrary,
  pointBuiltinsAt,
  putRecord,
  recordName,
  setSystemAudience,
  shareWith,
} from './support/library';
import {
  apiRequest,
  createEmployee,
  seedSuperAdmin,
  type Session,
} from './support/session';

/** Bound of one test. */
const TEST_TIMEOUT_MS = 300_000;

/** The platform's default chat model while the file runs and the model of the agents of the migration: everything runs on it. */
const DEFAULT_MODEL = runModel('haiku');
/** The title every first message gets. */
const TITLE = 'Заголовок модели данных';
/** The answer of a call no script names: a child's report reaching a root, a call past a script's replies. */
const UNSCRIPTED_ANSWER = 'Принято.';

const START_AGENT = 'start_agent';
const START_DEEP_AGENT = 'start_deep_agent';

// ---------------------------------------------------------------------------------------------------------------
// The model double: the scripted model behind a recorder of each call's instructions and tool descriptions
// ---------------------------------------------------------------------------------------------------------------

type TurnClient = ScriptedModel['turnClient'];

interface ModelCall {
  readonly instructions: string;
  /** The task or the employee's message the call answers. */
  readonly lastUser: string | undefined;
  readonly tools: ReadonlyMap<string, string>;
}

function isUnscripted(error: unknown): boolean {
  return (
    error instanceof Error &&
    /^No script answers|has no answer for call/.test(error.message)
  );
}

/** A call no script answers gets {@link UNSCRIPTED_ANSWER}: a row scripts the calls it asserts on, not every report. */
function recordingModel(): { model: ScriptedModel; calls: ModelCall[] } {
  const scripted = createScriptedModel();
  const calls: ModelCall[] = [];
  const turnClient: TurnClient = {
    async streamTurn(call, options) {
      if (call.purpose === 'complete_text')
        return scripted.turnClient.streamTurn(call, options);
      const lastUser = [...call.messages]
        .reverse()
        .find((message) => message.role === 'user');
      calls.push({
        instructions: call.instructions,
        lastUser: lastUser?.role === 'user' ? lastUser.content : undefined,
        tools: new Map(call.tools.map((tool) => [tool.name, tool.description])),
      });
      try {
        return await scripted.turnClient.streamTurn(call, options);
      } catch (error) {
        if (!isUnscripted(error)) throw error;
        return {
          finishReason: 'stop',
          text: UNSCRIPTED_ANSWER,
          toolCalls: [],
          usage: DEFAULT_USAGE,
        };
      }
    },
  };
  return { model: { ...scripted, turnClient }, calls };
}

const recorder = recordingModel();

function callsFor(text: string): ModelCall[] {
  return recorder.calls.filter((call) => call.lastUser === text);
}

function scriptTask(text: string, replies: readonly ScriptedReply[]): void {
  recorder.model.script({ task: text }, replies);
}

function startAgent(agent: string, description: string): ScriptedToolCall {
  return {
    tool: START_AGENT,
    args: { agent, description, prompt: taskOf(description) },
  };
}

/** The task a test gives a started agent: its description's task. */
function taskOf(description: string): string {
  return `${description}: задание`;
}

// ---------------------------------------------------------------------------------------------------------------
// The app and the file's rows
// ---------------------------------------------------------------------------------------------------------------

let harness: TestApp;
let admin: Session;
let restoreBuiltins: (() => Promise<void>) | undefined;
let restoreModels: (() => Promise<void>) | undefined;
/** What this file created; `afterAll` deletes exactly these rows (an employee's agents and grants go with him). */
const made = { users: [] as string[], roles: [] as string[] };

const liveApp = new Proxy({} as INestApplication<App>, {
  get(_target, property) {
    const value: unknown = Reflect.get(harness.app, property);
    return typeof value === 'function'
      ? (value as (...args: unknown[]) => unknown).bind(harness.app)
      : value;
  },
});

function api(session: Session): ChatApi {
  return chatApi(liveApp, session);
}

async function newRole(name: string): Promise<RunRole> {
  const role = await allowRole(liveApp, admin, {
    name: `${name}-${randomUUID().slice(0, 8)}`,
    models: [DEFAULT_MODEL],
    servers: [],
  });
  made.roles.push(role.id);
  return role;
}

/** An employee of the run; with no role he gets a personal right on the chat's model. */
async function newEmployee(
  name: string,
  roles: readonly RunRole[],
): Promise<Session> {
  const session = await createEmployee(liveApp, admin, { name });
  made.users.push(session.id);
  for (const role of roles) await role.add(session);
  if (roles.length === 0) {
    await grantTo(
      liveApp,
      admin,
      { userId: session.id },
      { effect: 'allow', target: { kind: 'model', model: DEFAULT_MODEL } },
    );
  }
  return session;
}

function treeOf(nodes: readonly AgentNode[]): AgentNode[] {
  return nodes.flatMap((node) => [node, ...treeOf(node.children)]);
}

function nodeOf(view: ConversationView, description: string): AgentNode {
  const found = treeOf(view.agents).find(
    (node) => node.description === description,
  );
  if (found === undefined)
    throw new Error(`No agent "${description}" in ${view.thread.id}`);
  return found;
}

type ToolResult = Extract<HistoryEntry, { kind: 'tool_result' }>['content'];

function resultsOf(view: ConversationView, tool: string): ToolResult[] {
  return view.entries.flatMap((entry) =>
    entry.kind === 'tool_result' && entry.content.tool === tool
      ? [entry.content]
      : [],
  );
}

/** Waits until the chat of the conversation is free, nothing waits in its queue and the view satisfies `done`. */
function untilIdle(
  session: Session,
  threadId: string,
  done: (view: ConversationView) => boolean,
  what: string,
): Promise<ConversationView> {
  return waitFor(
    () => api(session).history(threadId),
    (view) =>
      view.chat.status === 'idle' && view.pending.length === 0 && done(view),
    what,
  );
}

function untilAnswered(
  session: Session,
  threadId: string,
  text: string,
): Promise<ConversationView> {
  return untilIdle(
    session,
    threadId,
    (view) =>
      view.entries.some(
        (entry) => entry.kind === 'model_answer' && entry.content.text === text,
      ),
    `the answer "${text}"`,
  );
}

/**
 * A new conversation of the employee whose chat makes `calls` in its first answer and then says `<label>: готово`;
 * every agent it starts reports at once. Returns the view after that answer.
 */
async function chatCalls(
  session: Session,
  label: string,
  calls: readonly ScriptedToolCall[],
): Promise<{ view: ConversationView; message: string }> {
  const message = `${label}: сообщение`;
  scriptTask(message, [{ calls }, { text: `${label}: готово` }]);
  for (const call of calls) {
    const description = call.args.description;
    if (call.tool === START_AGENT && typeof description === 'string')
      scriptTask(taskOf(description), [{ text: `${description}: отчёт` }]);
  }
  const { id } = await api(session).createThread();
  await api(session).send(id, message);
  return {
    view: await untilAnswered(session, id, `${label}: готово`),
    message,
  };
}

/** The child the chat started by `name` in a conversation of its own (`label` names it). */
async function startedByName(
  session: Session,
  label: string,
  name: string,
): Promise<AgentNode> {
  const { view } = await chatCalls(session, label, [startAgent(name, label)]);
  return nodeOf(view, label);
}

/** Rows of `agents` (and of their versions) with this name, whatever their owner: a temporary start adds none. */
async function catalogueRowsNamed(
  name: string,
): Promise<{ agents: number; versions: number }> {
  const { rows } = await harness.pool.query<{
    agents: number;
    versions: number;
  }>(
    `SELECT count(DISTINCT a.id)::int AS agents, count(v.id)::int AS versions
       FROM app.agents a LEFT JOIN app.agent_versions v ON v.agent_id = a.id
      WHERE lower(a.name) = lower($1)`,
    [name],
  );
  const [counts] = rows;
  if (counts === undefined) throw new Error('the count returned no row');
  return counts;
}

/** The owner's conversations, roots and agents: a refused start or restart adds none. */
async function conversationsOf(ownerId: string): Promise<number> {
  const { rows } = await harness.pool.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM app.conversations WHERE owner_id = $1',
    [ownerId],
  );
  return rows[0]?.count ?? 0;
}

/** The answer of a tool call with ids and the called name masked, without the call's own id, arguments and times: what tells one start from another. */
function masked(result: ToolResult | undefined, name: string): unknown {
  const answer = result && {
    tool: result.tool,
    server: result.server,
    outcome: result.outcome,
    refusalReason: result.refusalReason,
    refusalDetail: result.refusalDetail,
    text: result.text,
  };
  return JSON.parse(
    JSON.stringify(answer ?? null)
      .replaceAll(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
        '<id>',
      )
      .replaceAll(name, '<name>'),
  );
}

function deleteOwn(owner: Session, id: string): Promise<unknown> {
  return expectBody(
    apiRequest(liveApp, owner, 'delete', `/library/${id}`),
    204,
    z.unknown(),
  );
}

describe('data-model / agents (real AppModule + real Postgres + real library, scripted model)', () => {
  beforeAll(async () => {
    harness = await createTestApp({ workers: true, model: recorder.model });
    recorder.model.completeText({ text: TITLE });
    admin = await seedSuperAdmin(
      harness.app,
      `e2e-data-model-admin-${randomUUID()}`,
    );
    made.users.push(admin.id);
    restoreModels = await useRunModels(liveApp, admin, {
      chat: { id: DEFAULT_MODEL, ...HAIKU_TEST_PRICES },
    });
    restoreBuiltins = await pointBuiltinsAt(liveApp, admin, DEFAULT_MODEL);
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
          roles: made.roles,
          users: made.users,
        });
      }
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  // AC (DC-23): "Чат или обычный агент, вызвавший имя видимого агента, запускает его активную версию, даже если агент не предложен в чате и не
  //   входит в список `agents` вызывающего."
  // AC (DC-24): "Имя, которого владелец не видит или которого нет, запускает временного агента: беседа ссылается на активную версию
  //   `general-purpose` (у `start_deep_agent` - глубокого агента по умолчанию), носит имя из вызова, а в каталоге ничего не появляется."
  // AC (DC-25): "Из нескольких видимых агентов с одним именем запускается свой, затем самый ранний агент коллеги, затем системный."
  // AC (DC-27): "`start_agent` с именем видимого глубокого агента и `start_deep_agent` с именем видимого обычного агента отвечают `not_allowed`."
  // Behavior: the scripted chat step of Anya calls `start_agent` with a name -> the tool resolves the name through the catalogue's visibility
  //   procedure for Anya (not for the author) -> the child conversation stands on the version and the name shown below; a temporary start adds
  //   nothing to `agents` or `agent_versions`; the tool answer carries no trace of an invisible colleague's agent.
  // Catches: a name lookup that ignores visibility (Boris's private agent starts for Anya and his prompt runs under her rights, or the answer
  //   differs between "exists but hidden" and "does not exist"); a temporary agent that copies the hidden agent's definition; a wrong winner among
  //   same-named agents; a start still limited by "offered in the chat" or the caller's `agents` list (R21 not applied); a chat that launches a
  //   deep agent by `start_agent`.
  // @category: core-functionality
  // @dependency: start_agent, resolveStart, LibraryService (name lookup), the agents repository, AccessService, runtime workers, ScriptedModel, Postgres
  // @complexity: high
  it(
    'DC-23 / DC-24 / DC-25 / DC-27: a call by name starts the active version of a visible agent whatever the chat offers, anything invisible or unknown becomes a temporary general agent under that name without leaking or creating anything, the winner among same names is own then the earliest colleague then system, and a wrong-kind name is not_allowed',
    async () => {
      // Row "invisible": Boris's private agent, Anya with no roles
      const audience = await newRole('dm-agents-audience');
      const boris = await newEmployee('Борис', [audience]);
      const anya = await newEmployee('Аня', []);
      const hidden = recordName('log-analyst');
      const borisAgent = await createRecord(
        liveApp,
        boris,
        agentBody(hidden, { model: DEFAULT_MODEL }),
      );
      const borisPrompt = `Промпт агента ${hidden}`;
      const nowhere = recordName('nowhere');
      const rowsBefore = await catalogueRowsNamed(hidden);
      const invisible = await chatCalls(anya, 'DM invisible', [
        startAgent(hidden, 'DM invisible'),
        startAgent(nowhere, 'DM nowhere'),
      ]);
      const temporary = nodeOf(invisible.view, 'DM invisible');
      expect([
        temporary.name,
        temporary.origin?.recordId,
        temporary.origin?.subagent,
      ]).toEqual([hidden, BUILTIN.generalPurpose.id, null]);
      await waitFor(
        async () => callsFor(taskOf('DM invisible')),
        (calls) => calls.length > 0,
        'the model call of the temporary agent',
      );
      expect(
        callsFor(taskOf('DM invisible')).some((call) =>
          call.instructions.includes(borisPrompt),
        ),
      ).toBe(false);
      expect(await catalogueRowsNamed(hidden)).toEqual(rowsBefore);
      const [listing] = callsFor(invisible.message);
      expect(listing?.tools.get(START_AGENT)).not.toContain(hidden);
      const [hiddenAnswer, nowhereAnswer] = resultsOf(
        invisible.view,
        START_AGENT,
      );
      expect(masked(hiddenAnswer, hidden)).toEqual(
        masked(nowhereAnswer, nowhere),
      );

      // Row "becomes visible": Boris saves version 2 and shares the agent with Anya's role, not offered in the chat
      await putRecord(liveApp, boris, borisAgent.id, {
        kind: 'agent',
        name: hidden,
        description: borisAgent.description,
        version: borisAgent.version,
        content: {
          ...agentBody(hidden, { model: DEFAULT_MODEL }).content,
          prompt: `${borisPrompt}, версия 2`,
        },
      });
      await shareWith(liveApp, boris, borisAgent.id, [audience.id]);
      await expectBody(
        apiRequest(
          liveApp,
          boris,
          'put',
          `/library/${borisAgent.id}/audience`,
          {
            roleIds: [audience.id],
            offerInChat: false,
          },
        ),
        200,
        z.unknown(),
      );
      await audience.add(anya);
      const visible = await startedByName(anya, 'DM visible', hidden);
      expect([
        visible.name,
        visible.origin?.recordId,
        visible.origin?.version,
      ]).toEqual([hidden, borisAgent.id, 2]);

      // Row "wrong kind": the default deep agent by start_agent
      const vera = await newEmployee('Вера', []);
      const conversationsBefore = await conversationsOf(vera.id);
      const deepByStartAgent = await chatCalls(vera, 'DM wrong kind', [
        startAgent(BUILTIN.deepAgent.name, 'DM deep by start_agent'),
      ]);
      const [wrongTool] = resultsOf(deepByStartAgent.view, START_AGENT);
      expect([wrongTool?.outcome, wrongTool?.refusalReason]).toEqual([
        'refused',
        'not_allowed',
      ]);
      expect(wrongTool?.text ?? '').toContain(START_DEEP_AGENT);
      expect(treeOf(deepByStartAgent.view.agents)).toEqual([]);
      // Only the root was written
      expect(await conversationsOf(vera.id)).toBe(conversationsBefore + 1);

      // Row "same name three times": Boris's (shared with Anya's role, created first), Anya's own and a system one
      // (created last: an employee may not take the name of a system agent, a system agent may take an employee's)
      const report = recordName('report');
      const borisReport = await createRecord(
        liveApp,
        boris,
        agentBody(report, { model: DEFAULT_MODEL }),
      );
      await shareWith(liveApp, boris, borisReport.id, [audience.id]);
      const anyaReport = await createRecord(
        liveApp,
        anya,
        agentBody(report, { model: DEFAULT_MODEL }),
      );
      const systemReport = await createSystemRecord(
        liveApp,
        admin,
        agentBody(report, { model: DEFAULT_MODEL }),
      );
      await setSystemAudience(liveApp, admin, systemReport.id, {
        everyone: true,
      });
      expect(
        (await startedByName(anya, 'DM same name: own', report)).origin
          ?.recordId,
      ).toBe(anyaReport.id);
      await deleteOwn(anya, anyaReport.id);
      expect(
        (await startedByName(anya, 'DM same name: colleague', report)).origin
          ?.recordId,
      ).toBe(borisReport.id);
      await deleteOwn(boris, borisReport.id);
      expect(
        (await startedByName(anya, 'DM same name: system', report)).origin
          ?.recordId,
      ).toBe(systemReport.id);
    },
    TEST_TIMEOUT_MS,
  );

  // AC (DC-30): "Удалённый агент отсутствует в библиотеке, панели и поиске по имени, его имя можно занять; идущая беседа доходит до конца;
  //   перезапуск отвечает `record_unavailable`."
  // AC (DC-29, the API half): "Вход задачи агента не содержит определения; ... вид агента (`AgentView`) отдаёт ту же форму `RunOrigin`: `version` - номер версии
  //   беседы, `name` и `author` - текущие имя и владелец агента."
  // Behavior: Anya's conversation runs on Boris's agent (its model call is held open) -> Boris saves version 2, deletes the agent and creates a
  //   new one with the same name -> the delete writes only the mark on the agent row -> the held conversation resumes and ends with its report
  //   -> Anya's view of the run shows Boris's agent with the conversation's version number -> a restart of that run is refused with `record_unavailable`.
  // Catches: a deletion that removes the agent or its versions; a unique-name index that still counts the deleted row; a deleted agent still found
  //   by the library list, the panel or the name lookup; a restart that quietly starts the new same-named agent; a task input that again carries a
  //   copy of the definition.
  // @category: edge-case
  // @dependency: LibraryService (delete), the agents repository, ConversationsService / AgentView, restart, runtime workers, ScriptedModel (held call), Postgres
  // @complexity: high
  it(
    'DC-30 / DC-29: deleting an agent only marks it, the running conversation finishes on its version, the name is free for a new agent, and a restart is refused with record_unavailable',
    async () => {
      // Given: Boris's agent shared with Anya's role; Anya's chat starts it and its model call is held
      const audience = await newRole('dm-agents-deletion');
      const boris = await newEmployee('Борис', [audience]);
      const anya = await newEmployee('Аня', [audience]);
      const name = recordName('incident digest');
      const agent = await createRecord(
        liveApp,
        boris,
        agentBody(name, { model: DEFAULT_MODEL }),
      );
      await shareWith(liveApp, boris, agent.id, [audience.id]);
      const held = createLatch();
      const label = 'DM deletion';
      const message = `${label}: сообщение`;
      scriptTask(message, [
        { calls: [startAgent(name, label)] },
        { text: `${label}: готово` },
      ]);
      scriptTask(taskOf(label), [{ text: `${label}: отчёт`, latch: held }]);
      const { id: threadId } = await api(anya).createThread();
      await api(anya).send(threadId, message);
      await held.reached();
      const running = nodeOf(
        await untilAnswered(anya, threadId, `${label}: готово`),
        label,
      );

      // When: Boris saves version 2, deletes the agent and creates a new one with the same name
      await putRecord(liveApp, boris, agent.id, {
        kind: 'agent',
        name,
        description: agent.description,
        version: agent.version,
        content: {
          ...agentBody(name, { model: DEFAULT_MODEL }).content,
          prompt: `Промпт агента ${name}, версия 2`,
        },
      });
      await deleteOwn(boris, agent.id);
      const successor = await createRecord(
        liveApp,
        boris,
        agentBody(name, { model: DEFAULT_MODEL }),
      );

      // Then: the deleted agent is gone from the library, the panel and the name lookup; the new one is listed
      expect(
        (await listLibrary(liveApp, anya)).map((row) => row.id),
      ).not.toContain(agent.id);
      expect((await listLibrary(liveApp, boris)).map((row) => row.id)).toEqual(
        expect.arrayContaining([successor.id]),
      );
      expect(
        (
          await expectBody(
            apiRequest(liveApp, admin, 'get', '/admin/library/shared'),
            200,
            z.array(RecordSummarySchema),
          )
        ).map((row) => row.id),
      ).not.toContain(agent.id);
      const byName = await startedByName(anya, 'DM deletion: lookup', name);
      expect([byName.name, byName.origin?.recordId]).toEqual([
        name,
        BUILTIN.generalPurpose.id,
      ]);

      // Then: the delete only marked the row; the held conversation goes on and finishes on its version
      const { rows: marks } = await harness.pool.query<{ deleted: boolean }>(
        'SELECT deleted_at IS NOT NULL AS deleted FROM app.agents WHERE id = $1',
        [agent.id],
      );
      expect(marks).toEqual([{ deleted: true }]);
      held.open();
      const finished = await waitFor(
        () => api(anya).history(threadId),
        (view) => nodeOf(view, label).status === 'completed',
        'the run of the deleted agent to finish',
      ).then((view) => nodeOf(view, label));
      const { rows: stored } = await harness.pool.query<{ number: number }>(
        `SELECT v.number FROM app.conversations c
           JOIN app.agent_versions v ON v.id = c.agent_version_id
          WHERE c.id = $1`,
        [running.agentId],
      );
      expect(stored.map((row) => row.number)).toEqual([1]);
      // DC-46 (data-model design-runtime.md KD-8): the input keeps only `answerFields`; what the conversation
      // holds — version, name, model, assignment — is not copied into it, at the root and at its child.
      const { rows: inputs } = await harness.pool.query<{
        input: Record<string, unknown>;
      }>(
        `SELECT t.input FROM app.runtime_tasks t
           JOIN app.runtime_tasks child ON t.task_id IN (child.task_id, child.root_id)
          WHERE child.task_id = $1
          ORDER BY t.depth`,
        [running.agentId],
      );
      expect(inputs.map((row) => Object.keys(row.input))).toEqual([[], []]);
      expect(finished.origin).toEqual({
        recordId: agent.id,
        kind: 'agent',
        version: 1,
        name,
        author: { id: boris.id, name: 'Борис' },
        builtinKey: null,
        subagent: null,
      });

      // Then: a restart of the finished run is refused and writes nothing
      const conversationsBefore = await conversationsOf(anya.id);
      const refused = await expectBody(
        apiRequest(liveApp, anya, 'post', `/agents/${running.agentId}/restart`),
        409,
        StartRefusedErrorSchema,
      );
      expect(refused.reason).toBe('record_unavailable');
      expect(await conversationsOf(anya.id)).toBe(conversationsBefore);
    },
    TEST_TIMEOUT_MS,
  );
});
