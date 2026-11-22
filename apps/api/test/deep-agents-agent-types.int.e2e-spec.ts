// deep-agents / agent-types - API integration (real AppModule + real Postgres + real SessionGuard, scripted model, workers on)
// Design Doc: docs/features/deep-agents/design-agent-types.md, Test Strategy UC-2, UC-2a, UC-3, UC-4 (the refusal and confirmation halves), KD-3, KD-4, DC-5, DC-6, DC-7, Invariants 3 and 4
// PRD: docs/features/deep-agents/prd.md FR-06, FR-26 (AC-06.2, AC-06.3, AC-06.4, AC-06.6, AC-26.1 by the tool answer only)
// Test type: Integration (the journey is in deep-agents-agent-types.e2e-spec.ts). Run once, at the end of the part (project rule "Tests only at the end").
//
// Harness (follows custom-agents-runtime.int.e2e-spec.ts and custom-agents-library.int.e2e-spec.ts): one `createTestApp({ workers: true, mcpServers })`, the real AppModule with the
//   real library, `IdentityDirectory`, `Agents.mcp` and `AuditLog`; the only double is the scripted model of the chat root, keyed by the conversation's first message. Servers
//   `jira` and `logs` of the design are the run's `LOGS_SERVER` (granted by tool) and `BACKOFFICE_SERVER` (not granted). Employees from `createEmployee`, the administrator from
//   `seedSuperAdmin`. Every row makes its own employees, roles and records (names carry `recordName`'s run suffix), so the order of the rows decides nothing. Refusal texts are
//   asserted by their path and rule here; the platform's literal texts are fixed after the first run of the part (plan Notes, «Общий прогон»).
//
// Budget: Integration 2 here (INT-1, INT-2); with INT-3 (agents package) the part uses 3 of 3, each naming a defect no other test catches.
//
// Proven elsewhere (not repeated): the content schema of a deep agent (unit, contracts, UC-1); the `decideSave` table with paths (unit, save-rules.spec.ts, UC-2); the
//   list text — whose a record is, servers only with allowed tools, the cut (unit, record-listing.spec.ts, UC-2a text); `rootOnly` of a built-in tool (unit, packages/agents
//   src/agent/tool-declaration.spec.ts, AC-06.5); the rights of an MCP call at call time (agents INT-3 A, AC-26.2); the library routes' own visibility, versions and audit
//   (custom-agents-library INT-1, INT-2, INT-5). INT-1 and INT-2 here prove the same rules for the CHAT door, a second door into `LibraryService`.
//
// acProof of this file:
// - AC-06.3: INT-1 rows A and B; AC-06.4: INT-1 row D (wiring), unit (rule); AC-26.1: INT-1 row C (tool answer), manual (the model's choice, PRD)
// - AC-06.2: INT-2 row A; AC-06.6: INT-2 row B; DC-5 (`version_conflict`): INT-2 row C; DC-6 (`builtin`): INT-1 row A; Invariant 4: INT-1 row A and INT-2 row B

import { randomUUID } from 'node:crypto';
import type { ScriptedReply } from '@agent-os/agents/testing';
import {
  RecordDetailSchema,
  type ConversationView,
  type RecordDetail,
  type UpdateRecordBody,
} from '@agent-os/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { waitFor } from '@agent-os/db/testing';
import {
  allowRole,
  grantTo,
  HAIKU_TEST_PRICES,
  removeRunRows,
  runModel,
  type RunRole,
  useRunModels,
} from './support/access';
import { chatApi, expectBody, expectError } from './support/api';
import { createTestApp, type TestApp } from './support/createTestApp';
import {
  auditOfRecord,
  BUILTIN,
  createRecord,
  createSystemRecord,
  deepAgentBody,
  getRecord,
  listLibrary,
  pointBuiltinsAt,
  putRecord,
  recordName,
  setSystemAudience,
  shareWith,
} from './support/library';
import { BACKOFFICE_SERVER, LOGS_SERVER } from './support/mcp-servers';
import {
  createArgs,
  editArgs,
  pendingCardOf,
  recordCardsOf,
  recordToolCall,
  toolResultsOf,
} from './support/record-tools';
import {
  apiRequest,
  createEmployee,
  seedSuperAdmin,
  type Session,
} from './support/session';

/** Bound of one row: a row runs a few chat turns of the scripted model. */
const TEST_TIMEOUT_MS = 180_000;

/** The platform's default chat model while the file runs and the model of the built-in records: the chat runs on it. */
const MODEL = runModel('haiku-records');
/** The title every first message gets. */
const TITLE = 'Записи из чата';
/** The chat's answer after its record calls. */
const DONE = 'Готово.';

/** The one text of a missing record and of one the employee does not see (record-tools.ts). */
const UNAVAILABLE =
  'recordId: there is no record with this id among the records you see';

let harness: TestApp;
let admin: Session;
let restoreModels: (() => Promise<void>) | undefined;
let restoreBuiltins: (() => Promise<void>) | undefined;
/** The built-in research as it was, so its prompt and flag go back after INT-1 A and INT-2 B. */
let researchBefore: RecordDetail | undefined;
/** The role that gives the administrator the chat's model. */
let adminRole: RunRole;
const made = {
  users: [] as string[],
  roles: [] as string[],
  systemRecords: [] as string[],
};

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

/** A role of the run allowed the chat's model, remembered for the cleanup. */
async function newRole(name: string): Promise<RunRole> {
  const role = await allowRole(harness.app, admin, {
    name,
    models: [MODEL],
    servers: [],
  });
  made.roles.push(role.id);
  return role;
}

/** An employee of the run put into `roles`, remembered for the cleanup. */
async function newEmployee(roles: readonly RunRole[]): Promise<Session> {
  const session = await createEmployee(harness.app, admin);
  made.users.push(session.id);
  for (const role of roles) await role.add(session);
  return session;
}

/** `GET /api/admin/library/:id`. */
function panelRecord(id: string): Promise<RecordDetail> {
  return expectBody(
    apiRequest(harness.app, admin, 'get', `/admin/library/${id}`),
    200,
    RecordDetailSchema,
  );
}

/** `PUT /api/admin/library/:id`. */
function putPanelRecord(
  id: string,
  body: UpdateRecordBody,
): Promise<RecordDetail> {
  return expectBody(
    apiRequest(harness.app, admin, 'put', `/admin/library/${id}`, body),
    200,
    RecordDetailSchema,
  );
}

/** The update body of a deep agent at its version, with the prompt and the flag given. */
function deepAgentUpdate(
  record: RecordDetail,
  change: { readonly prompt?: string; readonly selfLearning?: boolean },
): UpdateRecordBody {
  if (record.kind !== 'deep_agent')
    throw new Error(`${record.name} is not a deep agent`);
  return {
    kind: 'deep_agent',
    name: record.name,
    description: record.description,
    version: record.version,
    content: {
      ...record.content,
      prompt: change.prompt ?? record.content.prompt,
      selfLearning: change.selfLearning ?? record.content.selfLearning,
    },
  };
}

/** The built-in research with its self-learning flag on, turned on by the administrator through the panel. */
async function researchLearning(): Promise<RecordDetail> {
  const research = await panelRecord(BUILTIN.deepResearch.id);
  if (research.kind === 'deep_agent' && research.content.selfLearning)
    return research;
  return putPanelRecord(
    research.id,
    deepAgentUpdate(research, { selfLearning: true }),
  );
}

/**
 * A new conversation of `session` whose chat answers with `replies`, then {@link DONE}. The script is keyed by the first
 * message, so a later message of the same conversation takes the next reply.
 */
async function chat(
  session: Session,
  replies: readonly ScriptedReply[],
): Promise<string> {
  const task = `Записи из чата ${randomUUID()}`;
  harness.model.script({ task }, replies, { thereafter: { text: DONE } });
  const api = chatApi(harness.app, session);
  const { id } = await api.createThread();
  await api.send(id, task);
  return id;
}

/** Waits until the chat is free, nothing waits in its queue and its last answer is `text`. */
function untilAnswered(
  session: Session,
  threadId: string,
  text = DONE,
): Promise<ConversationView> {
  return waitFor(
    () => chatApi(harness.app, session).history(threadId),
    (view) => {
      const answers = view.entries.filter(
        (entry) => entry.kind === 'model_answer',
      );
      const last = answers.at(-1);
      return (
        view.chat.status === 'idle' &&
        view.pending.length === 0 &&
        last?.kind === 'model_answer' &&
        last.content.text === text
      );
    },
    `the chat's answer "${text}"`,
  );
}

/** Waits for the open `library.record` request of the conversation. */
async function untilCard(session: Session, threadId: string) {
  const view = await waitFor(
    () => chatApi(harness.app, session).history(threadId),
    (current) => pendingCardOf(current) !== undefined,
    'a library.record card',
  );
  const pending = pendingCardOf(view);
  if (pending === undefined) throw new Error('no library.record card');
  return pending;
}

/** The reasons of the root's results of `tool`, in order. */
function reasonsOf(view: ConversationView, tool: string): (string | null)[] {
  return toolResultsOf(view, tool).map((result) => result.refusalReason);
}

/** What a chat refusal must leave as it was: the version and the content. */
function stateOf(record: RecordDetail): unknown {
  return {
    version: record.version,
    name: record.name,
    content: record.content,
  };
}

describe('deep-agents / agent-types - the chat is a second door into the library and opens it only as far as the employee could', () => {
  beforeAll(async () => {
    harness = await createTestApp({
      workers: true,
      mcpServers: ['logs', 'backoffice'],
    });
    harness.model.completeText({ text: TITLE });
    admin = await seedSuperAdmin(
      harness.app,
      `e2e-records-admin-${randomUUID()}`,
    );
    made.users.push(admin.id);
    restoreModels = await useRunModels(harness.app, admin, {
      chat: { id: MODEL, ...HAIKU_TEST_PRICES },
    });
    restoreBuiltins = await pointBuiltinsAt(harness.app, admin, MODEL);
    researchBefore = await panelRecord(BUILTIN.deepResearch.id);
    adminRole = await newRole('records-admin');
    await adminRole.add(admin);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (harness === undefined) return;
    try {
      try {
        if (researchBefore?.kind === 'deep_agent') {
          const current = await panelRecord(BUILTIN.deepResearch.id);
          await putPanelRecord(
            current.id,
            deepAgentUpdate(current, {
              prompt: researchBefore.content.prompt,
              selfLearning: researchBefore.content.selfLearning,
            }),
          );
        }
      } finally {
        await restoreBuiltins?.();
        await restoreModels?.();
        await harness.pool.query(
          'DELETE FROM app.library_records WHERE id = ANY($1::uuid[])',
          [made.systemRecords],
        );
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

  // ---------------------------------------------------------------------------------------------------------------
  // INT-1: record tools act only within the asking employee's rights - foreign, shared, system and built-in records are refused before any card, the data is not leaked
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-06.3, AC-06.4, AC-26.1 (the tool answer), DC-6, DC-7, Invariant 4. Design: UC-2, UC-2a, UC-3; KD-3; Flow 1 (the refusal branch).
  // Catches: (1) the chat edits or deletes a colleague's record, a record opened to a role, or a system record for a non-administrator; (2) the refusal arriving AFTER a card;
  //   (3) the administrator deleting a built-in record; (4) `read_record` / `list_records` leaking a private record or a server the employee has no right to; (5) a chat call
  //   that touches the stored self-learning flag.
  // Plan correction (phase 6, item 7): R1 of row A is B's record OPENED to A's role (`read_only`); B's private record is row B's (`record_unavailable`, the text of a missing one).
  it(
    'INT-1 A "rights": the chat of a non-administrator is refused read_only, shared and admin_only before any card, the administrator is refused builtin, and no record, version, flag or audit changes',
    async () => {
      // Given: A (no admin) and B share role «A»; A is also in «SRE». B's R1 is opened to «A»; A's R2 to «SRE»; S is a system record opened to «A»;
      // the built-in research has its self-learning flag on (set by the administrator through the panel).
      const roleA = await newRole('records-int1a');
      const sre = await newRole('records-int1a-sre');
      const a = await newEmployee([roleA, sre]);
      const b = await newEmployee([roleA]);
      const r1 = await createRecord(
        harness.app,
        b,
        deepAgentBody(recordName('INT-1 A R1'), MODEL),
      );
      await shareWith(harness.app, b, r1.id, [roleA.id]);
      const r2 = await createRecord(
        harness.app,
        a,
        deepAgentBody(recordName('INT-1 A R2'), MODEL),
      );
      await shareWith(harness.app, a, r2.id, [sre.id]);
      const system = await createSystemRecord(
        harness.app,
        admin,
        deepAgentBody(recordName('INT-1 A S'), MODEL),
      );
      made.systemRecords.push(system.id);
      await setSystemAudience(harness.app, admin, system.id, {
        everyone: false,
        roleIds: [roleA.id],
      });
      await researchLearning();
      const ids = [r1.id, r2.id, system.id, BUILTIN.deepResearch.id];
      const before = await Promise.all(ids.map((id) => panelOrOwner(id, a)));
      const auditBefore = await Promise.all(
        ids.map((id) => auditOfRecord(harness.pool, id)),
      );

      // When: A's chat edits and deletes each of them in one answer
      const aThread = await chat(a, [
        {
          calls: before.flatMap((record) => [
            recordToolCall(
              'edit_record',
              editArgs(record, { prompt: 'Чужая инструкция' }),
            ),
            recordToolCall('delete_record', { recordId: record.id }),
          ]),
        },
      ]);
      const aView = await untilAnswered(a, aThread);

      // Then: refusals with a text naming the record, in call order, and no card was asked
      expect(reasonsOf(aView, 'edit_record')).toEqual([
        'read_only',
        'shared',
        'admin_only',
        'admin_only',
      ]);
      expect(reasonsOf(aView, 'delete_record')).toEqual([
        'read_only',
        'shared',
        'admin_only',
        'admin_only',
      ]);
      for (const result of [
        ...toolResultsOf(aView, 'edit_record'),
        ...toolResultsOf(aView, 'delete_record'),
      ]) {
        expect(result.outcome).toBe('refused');
        expect(result.text).toMatch(/^recordId: /);
      }
      expect(recordCardsOf(aView)).toEqual([]);

      // When: the administrator's chat deletes the built-in research; Then: `builtin` before any card
      const cThread = await chat(admin, [
        {
          calls: [
            recordToolCall('delete_record', {
              recordId: BUILTIN.deepResearch.id,
            }),
          ],
        },
      ]);
      const cView = await untilAnswered(admin, cThread);
      expect(reasonsOf(cView, 'delete_record')).toEqual(['builtin']);
      expect(recordCardsOf(cView)).toEqual([]);

      // Then: every record as before - version, content, the research's flag on - and no audit event after the start
      const after = await Promise.all(ids.map((id) => panelOrOwner(id, a)));
      expect(after.map(stateOf)).toEqual(before.map(stateOf));
      const research = after[3];
      expect(
        research?.kind === 'deep_agent' && research.content.selfLearning,
      ).toBe(true);
      const auditAfter = await Promise.all(
        ids.map((id) => auditOfRecord(harness.pool, id)),
      );
      expect(auditAfter.map((events) => events.length)).toEqual(
        auditBefore.map((events) => events.length),
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'INT-1 B "no leak": a private record of another employee answers as a missing one to read and edit, and list_records holds only what the employee sees',
    async () => {
      // Given: A and B in role «B»; B's private R1 and B's R3 opened to «B»; A's own record; a system record S nobody holds
      const roleB = await newRole('records-int1b');
      const a = await newEmployee([roleB]);
      const b = await newEmployee([roleB]);
      const privateRecord = await createRecord(
        harness.app,
        b,
        deepAgentBody(recordName('INT-1 B private'), MODEL),
      );
      const opened = await createRecord(
        harness.app,
        b,
        deepAgentBody(recordName('INT-1 B opened'), MODEL),
      );
      await shareWith(harness.app, b, opened.id, [roleB.id]);
      const own = await createRecord(
        harness.app,
        a,
        deepAgentBody(recordName('INT-1 B own'), MODEL),
      );
      const hidden = await createSystemRecord(
        harness.app,
        admin,
        deepAgentBody(recordName('INT-1 B S'), MODEL),
      );
      made.systemRecords.push(hidden.id);

      // When: A's chat reads the private record and a random id, edits the private record and lists the records
      const aThread = await chat(a, [
        {
          calls: [
            recordToolCall('read_record', { recordId: privateRecord.id }),
            recordToolCall('read_record', { recordId: randomUUID() }),
            recordToolCall('edit_record', editArgs(privateRecord)),
            recordToolCall('list_records'),
          ],
        },
      ]);
      const aView = await untilAnswered(a, aThread);

      // Then: the private record answers exactly as a missing one, to the read and to the edit
      const reads = toolResultsOf(aView, 'read_record');
      expect(
        reads.map((result) => [result.refusalReason, result.text]),
      ).toEqual([
        ['record_unavailable', UNAVAILABLE],
        ['record_unavailable', UNAVAILABLE],
      ]);
      expect(
        toolResultsOf(aView, 'edit_record').map((result) => [
          result.refusalReason,
          result.text,
        ]),
      ).toEqual([['record_unavailable', UNAVAILABLE]]);
      expect(recordCardsOf(aView)).toEqual([]);

      // Then: the list holds A's own, the one opened to A's role and the built-in research; not the private one, not S
      const [list] = toolResultsOf(aView, 'list_records');
      expect(list?.outcome).toBe('success');
      const text = list?.text ?? '';
      expect(text).toContain(
        `- ${own.id} | deep_agent | ${own.name} | yours | not shared |`,
      );
      expect(text).toContain(
        `- ${opened.id} | deep_agent | ${opened.name} | opened to your role | shared |`,
      );
      expect(text).toContain(`- ${BUILTIN.deepResearch.id} | deep_agent |`);
      expect(text).not.toContain(privateRecord.id);
      expect(text).not.toContain(hidden.id);

      // When: the administrator's chat lists the records; Then: S is there, marked as a system record
      const cThread = await chat(admin, [
        { calls: [recordToolCall('list_records')] },
      ]);
      const [adminList] = toolResultsOf(
        await untilAnswered(admin, cThread),
        'list_records',
      );
      expect(adminList?.text).toContain(
        `- ${hidden.id} | deep_agent | ${hidden.name} | system | not shared |`,
      );
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'INT-1 C "servers": list_records names the server the employee may use with only the tools he has a right to, and reads the rights at each call',
    async () => {
      // Given: A's role may call only `search_logs` of the logs server and has no grant on the back office
      const roleC = await newRole('records-int1c');
      await grantTo(
        harness.app,
        admin,
        { roleId: roleC.id },
        {
          effect: 'allow',
          target: { kind: 'tool', server: LOGS_SERVER, tool: 'search_logs' },
        },
      );
      const a = await newEmployee([roleC]);
      const second = 'Второй список';
      const thread = await chat(a, [
        { calls: [recordToolCall('list_records')] },
        { text: DONE },
        { calls: [recordToolCall('list_records')] },
        { text: second },
      ]);

      // When: A's chat lists the records; Then: the logs server with `search_logs` only, no back office
      const first = await untilAnswered(a, thread);
      const [firstList] = toolResultsOf(first, 'list_records');
      const firstText = firstList?.text ?? '';
      expect(firstText).toContain(`- ${LOGS_SERVER}: search_logs`);
      expect(firstText).not.toContain('get_trace');
      expect(firstText).not.toContain('aggregate_logs');
      expect(firstText).not.toContain(BACKOFFICE_SERVER);

      // When: A gets `get_trace` too and writes again; Then: the next list names both tools
      await grantTo(
        harness.app,
        admin,
        { userId: a.id },
        {
          effect: 'allow',
          target: { kind: 'tool', server: LOGS_SERVER, tool: 'get_trace' },
        },
      );
      await chatApi(harness.app, a).send(thread, 'Покажи список ещё раз');
      const again = await untilAnswered(a, thread, second);
      const secondList = toolResultsOf(again, 'list_records')[1];
      const serverLine =
        (secondList?.text ?? '')
          .split('\n')
          .find((line) => line.startsWith(`- ${LOGS_SERVER}: `)) ?? '';
      expect(serverLine.split(': ')[1]?.split(', ').sort()).toEqual([
        'get_trace',
        'search_logs',
      ]);
      expect(secondList?.text).not.toContain(BACKOFFICE_SERVER);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'INT-1 D "rule wiring": create_record with a server the employee may not use is refused server_not_allowed with the path and the server, before any card',
    async () => {
      // Given: A without any right on the back office
      const roleD = await newRole('records-int1d');
      const a = await newEmployee([roleD]);
      const body = deepAgentBody(recordName('INT-1 D'), MODEL, [
        {},
        { servers: [BACKOFFICE_SERVER] },
      ]);

      // When: A's chat creates a deep agent whose second subagent holds the back office
      const thread = await chat(a, [
        { calls: [recordToolCall('create_record', createArgs(body))] },
      ]);
      const view = await untilAnswered(a, thread);

      // Then: `server_not_allowed` naming `subagents.1.servers` and the server, no card, no record
      const [result] = toolResultsOf(view, 'create_record');
      expect(result?.refusalReason).toBe('server_not_allowed');
      expect(result?.text).toContain('subagents.1.servers');
      expect(result?.text).toContain(BACKOFFICE_SERVER);
      expect(recordCardsOf(view)).toEqual([]);
      expect(
        (await listLibrary(harness.app, a)).map((record) => record.name),
      ).not.toContain(body.name);
    },
    TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2: nothing is saved without the approved card, and what is saved is what the employee saw - reject, stale version, administrator edit of the built-in research
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-06.2, AC-06.6, DC-5, Invariant 3. Design: UC-3 (administrator half), UC-4 (reject and stale halves); KD-3 (`review`, `confirmed`); Flow 1.
  // Catches: (1) a record created or changed before the decision, or after a rejection; (2) a lost update - an old card's approval overwriting an edit made in the library
  //   after the card was shown; (3) a chat edit by the administrator that does not bump the version, writes no audit event, or is not what the employees read next; (4) the
  //   stored `selfLearning: true` of the research lost by the chat edit.
  it(
    'INT-2 A "reject": a rejected card saves nothing, the next approved card saves exactly one record with the id that card carried and the flag off',
    async () => {
      const role = await newRole('records-int2a');
      const a = await newEmployee([role]);
      const api = chatApi(harness.app, a);
      const rejectedBody = deepAgentBody(
        recordName('INT-2 A rejected'),
        MODEL,
        [{}, {}],
      );
      const approvedBody = deepAgentBody(
        recordName('INT-2 A approved'),
        MODEL,
        [{}, {}],
      );
      const thread = await chat(a, [
        { calls: [recordToolCall('create_record', createArgs(rejectedBody))] },
        { calls: [recordToolCall('create_record', createArgs(approvedBody))] },
      ]);

      // When: the first card waits; Then: nothing is saved, and the card is a create with a chosen id
      const first = await untilCard(a, thread);
      expect(first.card).toMatchObject({
        action: 'create',
        kind: 'deep_agent',
        system: false,
        previous: null,
      });
      expect(
        (await listLibrary(harness.app, a)).map((record) => record.name),
      ).not.toContain(rejectedBody.name);

      // When: A rejects it; Then: no record, no audit event, the call reads `rejected`
      expect(
        await api.decide(first.decision.decisionId, { approve: false }),
      ).toEqual({ outcome: 'resolved' });
      const second = await waitFor(
        () => api.history(thread),
        (view) => pendingCardOf(view) !== undefined,
        'the second card',
      );
      expect(
        toolResultsOf(second, 'create_record').map((result) => result.outcome),
      ).toEqual(['rejected']);
      await expectError(api.raw('get', `/library/${first.card.recordId}`), 404);
      expect(await auditOfRecord(harness.pool, first.card.recordId)).toEqual(
        [],
      );

      // When: the chat calls again and A approves the second card
      const pending = pendingCardOf(second);
      if (pending === undefined) throw new Error('no second card');
      expect(
        await api.decide(pending.decision.decisionId, { approve: true }),
      ).toEqual({ outcome: 'resolved' });
      await untilAnswered(a, thread);

      // Then: exactly one record, the second card's id, version 1, A's, the flag off; the first card's id does not exist
      const names = (await listLibrary(harness.app, a)).map(
        (record) => record.name,
      );
      expect(
        names.filter(
          (name) => name === approvedBody.name || name === rejectedBody.name,
        ),
      ).toEqual([approvedBody.name]);
      const saved = await getRecord(harness.app, a, pending.card.recordId);
      expect(saved).toMatchObject({
        kind: 'deep_agent',
        version: 1,
        mine: true,
        author: { id: a.id },
      });
      expect(saved.kind === 'deep_agent' && saved.content.selfLearning).toBe(
        false,
      );
      await expectError(api.raw('get', `/library/${first.card.recordId}`), 404);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'INT-2 B "administrator edit": the administrator\'s approved edit of the built-in research bumps its version once, keeps its self-learning flag, writes one prompt-free audit event and is what an employee reads next',
    async () => {
      const role = await newRole('records-int2b');
      const b = await newEmployee([role]);
      const research = await researchLearning();
      const prompt = `Новый промпт ресерча ${randomUUID()}`;
      const auditBefore = await auditOfRecord(harness.pool, research.id);

      // When: the administrator's chat edits the research with a new prompt (the whole content, no flag)
      const thread = await chat(admin, [
        {
          calls: [
            recordToolCall('edit_record', editArgs(research, { prompt })),
          ],
        },
      ]);
      const pending = await untilCard(admin, thread);
      expect(pending.card).toMatchObject({
        action: 'edit',
        recordId: research.id,
        system: true,
        previous: { version: research.version },
        next: { content: { prompt } },
      });
      expect(
        await chatApi(harness.app, admin).decide(pending.decision.decisionId, {
          approve: true,
        }),
      ).toEqual({
        outcome: 'resolved',
      });
      await untilAnswered(admin, thread);

      // Then: version N+1, the new prompt, the flag still on
      const saved = await panelRecord(research.id);
      expect(saved.version).toBe(research.version + 1);
      expect(saved.kind === 'deep_agent' && saved.content.prompt).toBe(prompt);
      expect(saved.kind === 'deep_agent' && saved.content.selfLearning).toBe(
        true,
      );

      // Then: one audit event of the update by the administrator, without the prompt
      const added = (await auditOfRecord(harness.pool, research.id)).slice(
        auditBefore.length,
      );
      expect(
        added.map(({ kind, actor, outcome }) => ({ kind, actor, outcome })),
      ).toEqual([{ kind: 'library_update', actor: admin.id, outcome: 'ok' }]);
      expect(JSON.stringify(added)).not.toContain(prompt);

      // Then: an employee who sees the built-in research reads the new version
      const read = await getRecord(harness.app, b, research.id);
      expect(read.version).toBe(research.version + 1);
      expect(read.kind === 'deep_agent' && read.content.prompt).toBe(prompt);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'INT-2 C "stale version": a card made stale by an edit through the library is refused version_conflict, and the library\'s edit stays',
    async () => {
      // Given: A's own deep agent R in version 3
      const role = await newRole('records-int2c');
      const a = await newEmployee([role]);
      const created = await createRecord(
        harness.app,
        a,
        deepAgentBody(recordName('INT-2 C'), MODEL),
      );
      const v2 = await putRecord(
        harness.app,
        a,
        created.id,
        deepAgentUpdate(created, { prompt: 'Версия 2' }),
      );
      const v3 = await putRecord(
        harness.app,
        a,
        created.id,
        deepAgentUpdate(v2, { prompt: 'Версия 3' }),
      );
      expect(v3.version).toBe(3);

      // When: the chat's edit waits on a card of version 3, A saves another change through the library, then approves the card
      const thread = await chat(a, [
        {
          calls: [
            recordToolCall(
              'edit_record',
              editArgs(v3, { prompt: 'Правка из чата' }),
            ),
          ],
        },
      ]);
      const pending = await untilCard(a, thread);
      expect(pending.card.previous?.version).toBe(3);
      const v4 = await putRecord(
        harness.app,
        a,
        created.id,
        deepAgentUpdate(v3, { prompt: 'Правка из библиотеки' }),
      );
      expect(
        await chatApi(harness.app, a).decide(pending.decision.decisionId, {
          approve: true,
        }),
      ).toEqual({
        outcome: 'resolved',
      });
      const view = await untilAnswered(a, thread);

      // Then: `version_conflict` with a text, the stored record is the library's version 4, and the card wrote no audit event
      const [result] = toolResultsOf(view, 'edit_record');
      expect(result?.refusalReason).toBe('version_conflict');
      expect(result?.text).toMatch(/^recordId: /);
      const stored = await getRecord(harness.app, a, created.id);
      expect(stateOf(stored)).toEqual(stateOf(v4));
      expect(
        (await auditOfRecord(harness.pool, created.id)).map(
          (event) => event.kind,
        ),
      ).toEqual([
        'library_create',
        'library_update',
        'library_update',
        'library_update',
      ]);
    },
    TEST_TIMEOUT_MS,
  );
});

/** A record as its reader sees it: the panel for a system record, the employee's library otherwise. */
async function panelOrOwner(
  id: string,
  reader: Session,
): Promise<RecordDetail> {
  const record = await getRecord(harness.app, reader, id);
  return record.author === null ? panelRecord(id) : record;
}
