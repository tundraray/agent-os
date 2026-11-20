// custom-agents / runtime - API integration skeletons (the real AppModule + real Postgres + real library, workers on, scripted model)
// Design Doc: docs/features/custom-agents/design-runtime.md (v1.1), Test Strategy UC-1..UC-4, UC-8..UC-11, UC-E1, UC-E2, UC-E5, Flows 1 and 3;
//   PRD: docs/features/custom-agents/prd.md FR-12..FR-19 (AC-12.1 .. AC-19.1). Depends on design-library.md; its skeletons
//   (apps/api/test/custom-agents-library.int.e2e-spec.ts) own visibility, versions, sharing, copy and audit of records and are NOT repeated.
// Generated: 2026-11-17
// Part: runtime. Files of the part (one budget, counted here):
//   - packages/agents/test/custom-agents-runtime.int.e2e-spec.ts     INT-1  the start procedure and the snapshot (library double)
//   - packages/workflows/test/custom-agents-runtime.int.e2e-spec.ts  INT-2  a workflow run on one copy of its team (library double)
//   - apps/api/test/custom-agents-runtime.int.e2e-spec.ts (this file) INT-3  the chat path over the REAL library; INT-4 the draft tool and its routes
// Test Type: Integration. Run with `pnpm --filter api test:e2e` (`vitest.config.e2e.ts`, `*.e2e-spec.ts`), never in the default `vitest run`.
//
// Budget Used: 4/3 integration skeletons for the part (INT-1 .. INT-4), 0/1-2 E2E.
//   The default 3 are INT-1, INT-2, INT-3. INT-4 is the one extra; its unique defect: the new `chat_drafts` table and the two things only a
//   real database and the real routes show - a draft read or saved through another employee's session or another conversation, and a draft
//   saved twice or saved after it was replaced (the rows and the `library_create` event). INT-1..INT-3 cannot see it: the library part never
//   calls `saveOwn` through a chat route, and the agents/workflows files stop below the HTTP edge. Without INT-4 the third item of CLAUDE.md's
//   list (isolation between users) has no test for drafts.
//   0 E2E: the journey a user notices first (write in chat -> a colleague's agent starts -> the run is labelled) crosses the web part's screens and
//   there is no browser E2E tool in the repo; its API half is INT-3 over real HTTP. A child-process kill row would repeat runtime E2E-1.
//
// Harness (follows apps/api/test/support/* and agent-platform-chat.int.e2e-spec.ts):
//   `createTestApp({ workers: true, mcpServers? })` with the run's provider and default chat model of `useRunModels` - the real AppModule with the REAL `LibraryService` behind the
//   `RecordLibrary` port, the real `AccessService`, `IdentityDirectory` and `AuditLog`; the scripted `ModelClient` (`AGENT_TURN_CLIENT`) is the
//   only double. No library double here: this level exists to prove that the real library is what the chat and the starts ask, for the
//   right person. Employees: `createEmployee` + sessions, the administrator `seedSuperAdmin`; roles, membership, models and servers through the
//   existing admin routes (`allowRole`, `POST /api/admin/roles`, `PUT /api/admin/users/:id/roles/:roleId`); records through
//   `POST /api/library`, `PUT .../audience`, the panel routes. Every row uses its own employees, roles and records (run-suffixed names), no
//   check of a global list; `afterAll` deletes the run's rows. Responses are parsed with the schemas of `@agent-os/contracts`
//   (`ConversationView`, `DraftView`, `AgentView`, `ApiErrorSchema`). The scripted model is keyed by the task (the latest user message the
//   call sees, a chip line included) and a recorder in front of it keeps each call's instructions and tool descriptions; "the chat's list" is
//   read from the recorded root call (the `start_agent` / `start_workflow` descriptions). One recorder serves every boot of the file.
//   Support the implementation tasks add (not skeletons): `test/support/library.ts` already named by the library file (`createRecord`, `putRecord`,
//   `shareWith`); `test/support/drafts.ts` (`postDraftAction`); `createTestApp` gets no new option - a second boot over the same database is a
//   second `createTestApp()` after the first one's `close()`.
//   The table list of `packages/db/test/migrations.e2e-spec.ts` gets `chat_drafts`, and its CHECK-domain test (already there) keeps the new
//   refusal reasons equal to the contract enum - nothing new to write.
//
// Proven elsewhere, not repeated here (one test at the lowest level that catches the defect; `provenAt: unit` = a table next to the code,
//   named for the plan, never a second proof in this file):
//   - `packages/agents/src/start/resolve-start.spec.ts`: ONE table, start kind (builtin key, record by number, executor, fork, restart of
//       executor/fork/record) x outcome - AC-14.1, AC-14.3 (rows `record_unavailable`: missing, not visible, wrong kind), AC-14.4
//       (`model_not_connected`, `model_not_allowed` with the model's number), DC-3 (which source each kind uses), DC-4, DC-5; the library and
//       the access gate are the doubles.
//   - `packages/agents/src/tools/tool-gate.spec.ts` (new rows of the existing table): UC-E4 - `run_limit`, `not_allowed` for a name outside the
//       team, `not_allowed` for a fork at a coordinator, `not_allowed` for the wrong kind or a record outside the launch set, root launch set =
//       records the chat may offer (AC-15.2 rule half).
//   - `packages/agents/src/chat-listing.spec.ts`: UC-7 - own first and marked, a colleague's with the author, no colleague's record with the
//       switch off, over the budget every name stays and descriptions vanish first from the records launched least (AC-15.3, AC-15.5, AC-15.7
//       rule half). The choice between same-named records by the model is a manual run (Success Criteria of the PRD).
//   - `packages/agents/src/tools/tool-registry.spec.ts`: UC-E6 - `draft_record` and `start_workflow` only for a session without a parent;
//       a child, an executor and a coordinator get neither (AC-18.4).
//   - `packages/agents/src/start/snapshot-definition.spec.ts`: the one pure function snapshot -> definition for a model call (prompt, tools,
//       servers, turn limit; coordinator: shared text + rules + team lines, no `finalExecutor` -> the coordinator's text ends the turn) and
//       workflow content -> coordinator snapshot.
//   - `apps/api/src/chat/conversation-view.spec.ts` (existing, new rows): `origin` (author, executor), `firstRun`, the chip in `user_message`,
//       `DraftView` states and `refusal`, `refusalDetail` with the model's number - AC-17.1 (mapping half).
//   - `apps/api/src/library/audience-rules.spec.ts`: the first half of AC-12.5 (audience of `chat` -> `audience_fixed`); AC-12.2 (an
//       administrator's delete of a built-in record -> 422 `builtin`) is row 5 of INT-1 in `custom-agents-library.int.e2e-spec.ts`.
//   - existing and rewritten by the implementation tasks, not new: agents INT-3 row A (a tool of a server the runner has no right on never reaches
//       it, with either account - AC-14.2), workflows INT-1..INT-3 (brief, run to the report, final-step rule), runtime E2E-1 (restart).
//
// `provenAt: not automated`:
//   - AC-19.1 (the one-time erase migration, UC-12): a destructive one-shot that a PoC runs once; the repo's migration test has no data-bearing
//       row and building a partial-migration harness costs more than the single run it would guard. It is checked once by hand on a copy of the
//       dev database before release (conversations, tasks, sessions gone; employees, roles, grants, the monthly token ledger, library records
//       unchanged). If the owner wants it automated, it is one more row of `packages/db/test/migrations.e2e-spec.ts` - an escalation, not spent here.
//   - AC-15.5, AC-15.7 (which of two same-named records the model picks) and AC-18.3 second half (the chat answers a request to share with text
//       and the "Поделиться" button): a judgement of the chat record's prompt, the manual run of the PRD's Success Criteria.
//   - UC-N1 (a hundred visible records, NFR-04): an on-demand script like `test/verify/*.verify.ts`, not the suite.
//
// acProof (the one proof of every criterion; `rule` = the unit table above; INT-1/INT-2 are in the sibling files):
//   AC-12.1 INT-3 · AC-12.2 unit (library delete rule, row to add) · AC-12.3 INT-3 (the seeded `deep-research` starts) + rewritten workflows INT-2 ·
//   AC-12.4 INT-3 · AC-12.5 unit (`audience_fixed`) + INT-3 (the list of an employee outside «SRE») ·
//   AC-13.1 INT-1 · AC-13.2 INT-1 · AC-13.3 INT-1 · AC-13.4 INT-2 ·
//   AC-14.1 INT-1 + INT-3 (real roles) · AC-14.2 existing agents INT-3 row A · AC-14.3 INT-1 + INT-3 · AC-14.4 INT-1 + INT-3 (the route answers 409) ·
//   AC-15.1 INT-3 · AC-15.2 INT-3 · AC-15.3 unit · AC-15.4 INT-4 · AC-15.5 unit + not automated · AC-15.6 INT-3 · AC-15.7 unit + not automated ·
//   AC-16.1 INT-2 · AC-16.2 INT-2 · AC-16.3 INT-2 · AC-16.4 INT-2 · AC-16.5 unit (library `WorkflowContentSchema`, design-library) · AC-16.6 unit + INT-2 ·
//   AC-17.1 INT-3 (+ unit mapping) · AC-18.1 INT-4 · AC-18.2 INT-4 · AC-18.3 INT-4 (the refusal) + not automated (the text) · AC-18.4 unit ·
//   AC-18.5 INT-4 · AC-19.1 not automated.

import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  createScriptedModel,
  DEFAULT_USAGE,
  type ScriptedModel,
  type ScriptedReply,
  type ScriptedToolCall,
} from '@agent-os/agents/testing';
import {
  AdminUserDetailSchema,
  RecordDetailSchema,
  StartRefusedErrorSchema,
  WORKFLOWS_BRIEF_CONFIRMATION,
  type AgentNode,
  type ApiError,
  type ConversationView,
  type DraftView,
  type HistoryEntry,
  type RecordDetail,
  type SystemRecordAudienceBody,
  type UpdateRecordBody,
} from '@agent-os/contracts';
import type { App } from 'supertest/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { builtinRecords } from '../src/library/builtin-records.js';
import {
  addModel,
  allowRole,
  grantTo,
  HAIKU_TEST_PRICES,
  removeRunRows,
  runModel,
  type RunRole,
  useRunModels,
} from './support/access.js';
import {
  type ChatApi,
  chatApi,
  expectBody,
  expectError,
  waitFor,
} from './support/api.js';
import { createTestApp, type TestApp } from './support/createTestApp.js';
import { type DraftActionAnswer, postDraftAction } from './support/drafts.js';
import {
  agentBody,
  auditOfRecord,
  BUILTIN,
  createRecord,
  getRecord,
  listLibrary,
  pointBuiltinsAt,
  recordName,
  setSystemAudience,
  shareWith,
} from './support/library.js';
import {
  apiRequest,
  createEmployee,
  seedSuperAdmin,
  type Session,
} from './support/session.js';

/** Bound of one test: INT-3 A boots the app twice more, the other rows settle far sooner. */
const TEST_TIMEOUT_MS = 300_000;

/** The platform's default chat model while the file runs (`useRunModels`) and the model of the built-in records (`pointBuiltinsAt`): the chat runs on it. */
const DEFAULT_MODEL = runModel('haiku');
/** The model of Аня's agent R (INT-3 B): allowed through «SRE» only, so a personal deny takes it from Аня alone. */
const R_MODEL = runModel('sonnet');
/** The title every first message gets (the text script of `beforeAll`). */
const TITLE = 'Заголовок рантайма';
/** The answer of a call no script names: a child's report reaching a root, a call past a script's replies. */
const UNSCRIPTED_ANSWER = 'Принято.';

const START_AGENT = 'start_agent';
const START_WORKFLOW = 'start_workflow';
const DRAFT_RECORD = 'draft_record';

/** Executors of the seeded `deep-research` record, in its order: the team of every run of it. */
const SEED_TEAM = seededTeam();

function seededTeam(): string[] {
  const record = builtinRecords().find(
    (candidate) => candidate.builtinKey === BUILTIN.deepResearch.builtinKey,
  );
  if (record?.body.kind !== 'workflow') {
    throw new Error('The seed holds no deep-research workflow');
  }
  return record.body.content.executors.map((executor) => executor.name);
}

// ---------------------------------------------------------------------------------------------------------------
// The model double: the scripted model of `@agent-os/agents/testing` behind a recorder of what each call offered
// ---------------------------------------------------------------------------------------------------------------

type TurnClient = ScriptedModel['turnClient'];
type TurnCall = Parameters<TurnClient['streamTurn']>[0];
type TurnGeneration = Awaited<ReturnType<TurnClient['streamTurn']>>;

/** One agent call as the tests read it: the run's name, its instructions, its latest user message and its tools. */
interface ModelCall {
  /** The definition name: the record name in the run's snapshot. */
  readonly agentName: string;
  readonly instructions: string;
  /** The task or the employee's message the call answers (a chip line included). */
  readonly lastUser: string | undefined;
  /** Each offered tool's description by name: at a root, the chat listing (KD-4). */
  readonly tools: ReadonlyMap<string, string>;
}

function modelCallOf(call: TurnCall): ModelCall {
  const lastUser = [...call.messages]
    .reverse()
    .find((message) => message.role === 'user');
  return {
    agentName: call.agentName,
    instructions: call.instructions,
    lastUser: lastUser?.role === 'user' ? lastUser.content : undefined,
    tools: new Map(call.tools.map((tool) => [tool.name, tool.description])),
  };
}

/** The scripted double's refusal of a call no script answers (`createScriptedModel`). */
function isUnscripted(error: unknown): boolean {
  return (
    error instanceof Error &&
    /^No script answers|has no answer for call/.test(error.message)
  );
}

/**
 * The scripted model of every boot of the file, so scripts outlive a reboot: the double of the package, whose
 * recorded calls carry no tool descriptions and no instructions, behind a recorder of both. A call no script
 * answers gets {@link UNSCRIPTED_ANSWER}: a row scripts the calls it asserts on, not every report.
 */
function recordingModel(): { model: ScriptedModel; calls: ModelCall[] } {
  const scripted = createScriptedModel();
  const calls: ModelCall[] = [];
  const turnClient: TurnClient = {
    async streamTurn(call, options): Promise<TurnGeneration> {
      if (call.purpose === 'complete_text') {
        return scripted.turnClient.streamTurn(call, options);
      }
      calls.push(modelCallOf(call));
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

/** The calls that answer `text`: the task or message the model saw last. */
function callsFor(text: string): ModelCall[] {
  return recorder.calls.filter((call) => call.lastUser === text);
}

function firstCallFor(text: string): ModelCall {
  const [call] = callsFor(text);
  if (call === undefined) throw new Error(`No model call answered "${text}"`);
  return call;
}

/** Waits for the first model call that answers `text` (a child's task). */
async function untilCalled(text: string): Promise<ModelCall> {
  await waitFor(
    () => callsFor(text).length,
    (count) => count > 0,
    `a model call for "${text}"`,
  );
  return firstCallFor(text);
}

/**
 * The listing lines of a root tool's description without the record descriptions: `<id>: <name> (<whose>)`
 * (chat-listing.ts), so a description dropped over the budget changes nothing here.
 */
function listingHeads(call: ModelCall, tool: string): string[] {
  const description = call.tools.get(tool);
  if (description === undefined) {
    throw new Error(`The call of ${call.agentName} offers no ${tool}`);
  }
  return description
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).split(' — ')[0] ?? '');
}

/** The employee's message as the root's model reads it with a record chip (model-step.ts `withChip`). */
function chipText(
  text: string,
  record: { kind: string; id: string; name: string },
): string {
  return `${text}\n\n[The employee chose a record: ${record.kind} ${record.id} "${record.name}"]`;
}

function scriptTask(text: string, replies: readonly ScriptedReply[]): void {
  recorder.model.script({ task: text }, replies);
}

function startAgent(
  description: string,
  prompt: string,
  agent: string,
): ScriptedToolCall {
  return { tool: START_AGENT, args: { agent, description, prompt } };
}

/** `start_workflow` of the seeded research workflow. */
function startResearch(question: string): ScriptedToolCall {
  return {
    tool: START_WORKFLOW,
    args: {
      workflow: BUILTIN.deepResearch.id,
      question,
      boundaries: '',
      result: '',
    },
  };
}

/** The coordinator's task: the brief as `start_workflow` writes it. */
function briefTask(question: string): string {
  return JSON.stringify({ question, boundaries: '', result: '' });
}

/** `draft_record` of a new agent `name`, or of the record `recordId` when given. */
function draftCall(name: string, recordId?: string): ScriptedToolCall {
  return {
    tool: DRAFT_RECORD,
    args: {
      ...agentBody(name, { model: DEFAULT_MODEL }),
      ...(recordId === undefined ? {} : { recordId }),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The app of the current boot and the file's rows
// ---------------------------------------------------------------------------------------------------------------

let harness: TestApp;
let admin: Session;
/** Gives the built-in records back their models; run in `afterAll` before the run's rows go. */
let restoreBuiltins: (() => Promise<void>) | undefined;
/** Gives the platform back its default models (`useRunModels`); run in `afterAll` before the run's rows go. */
let restoreModels: (() => Promise<void>) | undefined;
/** Gives the built-in records back what INT-3 A changed (name, prompt, audience); run in `afterAll`, last first. */
const restoreEdits: (() => Promise<void>)[] = [];
/** What this file created; `afterAll` deletes exactly these rows (an employee's records, drafts and grants go with him). */
const made = { users: [] as string[], roles: [] as string[] };

/**
 * The app of the current boot: INT-3 A closes the app and boots it again over the same database, and what
 * keeps an app — the restore of `pointBuiltinsAt`, a `ChatApi` — must reach the live one.
 */
const liveApp = new Proxy({} as INestApplication<App>, {
  get(_target, property) {
    const value: unknown = Reflect.get(harness.app, property);
    return typeof value === 'function'
      ? (value as (...args: unknown[]) => unknown).bind(harness.app)
      : value;
  },
});

function boot(): Promise<TestApp> {
  return createTestApp({
    workers: true,
    model: recorder.model,
  });
}

/** Closes the app and boots it again over the same database (sessions, records and conversations stay). */
async function reboot(): Promise<void> {
  await harness.close();
  harness = await boot();
}

function api(session: Session): ChatApi {
  return chatApi(liveApp, session);
}

/** A role of the run (`allowRole`, no servers), remembered for the cleanup; `name` is unique in the file. */
async function newRole(
  name: string,
  models: readonly string[],
): Promise<RunRole> {
  const role = await allowRole(liveApp, admin, { name, models, servers: [] });
  made.roles.push(role.id);
  return role;
}

/** An employee of the run with the display `name`, put into `roles`, remembered for the cleanup. */
async function newEmployee(
  name: string,
  roles: readonly RunRole[],
): Promise<Session> {
  const session = await createEmployee(liveApp, admin, { name });
  made.users.push(session.id);
  for (const role of roles) await role.add(session);
  return session;
}

/** A personal right of the employee on `model`, or a personal deny. */
async function personalModel(
  employee: Session,
  effect: 'allow' | 'deny',
  model: string,
): Promise<void> {
  await grantTo(
    liveApp,
    admin,
    { userId: employee.id },
    { effect, target: { kind: 'model', model } },
  );
}

/** The administrator takes `role` from the employee (`DELETE /api/admin/users/:id/roles/:roleId`). */
async function takeRole(employee: Session, role: RunRole): Promise<void> {
  await expectBody(
    apiRequest(
      liveApp,
      admin,
      'delete',
      `/admin/users/${employee.id}/roles/${role.id}`,
    ),
    200,
    AdminUserDetailSchema,
  );
}

/** The owner's `PUT /api/library/:id/audience`: the roles and «предлагать в главном чате». */
async function setOwnAudience(
  owner: Session,
  recordId: string,
  roleIds: readonly string[],
  offerInChat: boolean,
): Promise<void> {
  await expectBody(
    apiRequest(liveApp, owner, 'put', `/library/${recordId}/audience`, {
      roleIds,
      offerInChat,
    }),
    200,
    RecordDetailSchema,
  );
}

/** `GET /api/admin/library/:id`. */
function panelRecord(id: string): Promise<RecordDetail> {
  return expectBody(
    apiRequest(liveApp, admin, 'get', `/admin/library/${id}`),
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
    apiRequest(liveApp, admin, 'put', `/admin/library/${id}`, body),
    200,
    RecordDetailSchema,
  );
}

/** `PUT /api/admin/library/:id/audience`. */
async function putPanelAudience(
  id: string,
  body: SystemRecordAudienceBody,
): Promise<void> {
  await expectBody(
    apiRequest(liveApp, admin, 'put', `/admin/library/${id}/audience`, body),
    200,
    RecordDetailSchema,
  );
}

/** The update body of an agent record at its version with a new name or prompt. */
function agentUpdate(
  record: RecordDetail,
  change: { readonly name?: string; readonly prompt?: string },
): UpdateRecordBody {
  if (record.kind !== 'agent')
    throw new Error(`${record.name} is not an agent`);
  return {
    kind: 'agent',
    name: change.name ?? record.name,
    description: record.description,
    version: record.version,
    content: {
      ...record.content,
      prompt: change.prompt ?? record.content.prompt,
    },
  };
}

function promptOf(record: RecordDetail): string {
  if (record.kind !== 'agent')
    throw new Error(`${record.name} is not an agent`);
  return record.content.prompt;
}

/** The panel audience body that gives a system record back the holders and the switch it has now. */
function audienceBodyOf(record: RecordDetail): SystemRecordAudienceBody {
  return {
    everyone: record.audience.everyone ?? false,
    roleIds: record.audience.roles.map((role) => role.id),
    userIds: (record.audience.users ?? []).map((user) => user.id),
    offerInChat: record.offerInChat,
  };
}

/** Runs every step, last added first, and throws the first failure after all have run. */
async function runAll(steps: readonly (() => Promise<void>)[]): Promise<void> {
  let failure: unknown;
  for (const step of [...steps].reverse()) {
    try {
      await step();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure !== undefined) throw failure;
}

// ---------------------------------------------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------------------------------------------

/** A new conversation of the employee with its first message sent. */
async function firstMessage(session: Session, text: string): Promise<string> {
  const { id } = await api(session).createThread();
  await api(session).send(id, text);
  return id;
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

/** Waits until the root has answered `text` and is free again. */
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

/** Waits until the background title is written, so no title call is in flight when the app closes. */
async function untilTitled(session: Session, threadId: string): Promise<void> {
  await waitFor(
    () => api(session).getThread(threadId),
    (thread) => thread.title === TITLE,
    `the title of ${threadId}`,
  );
}

function treeOf(nodes: readonly AgentNode[]): AgentNode[] {
  return nodes.flatMap((node) => [node, ...treeOf(node.children)]);
}

function agentNamed(view: ConversationView, description: string): AgentNode {
  const found = treeOf(view.agents).find(
    (node) => node.description === description,
  );
  if (found === undefined) {
    throw new Error(
      `No agent "${description}" in ${view.thread.id}: [${treeOf(view.agents)
        .map((node) => node.description)
        .join(', ')}]`,
    );
  }
  return found;
}

/** Waits until the conversation holds the agent `description` and it satisfies `done`. */
function untilAgent(
  session: Session,
  threadId: string,
  description: string,
  done: (node: AgentNode) => boolean,
): Promise<AgentNode> {
  return waitFor(
    () => api(session).history(threadId),
    (view) =>
      treeOf(view.agents).some(
        (node) => node.description === description && done(node),
      ),
    `the agent "${description}"`,
  ).then((view) => agentNamed(view, description));
}

type ToolResult = Extract<HistoryEntry, { kind: 'tool_result' }>['content'];

function resultsOf(view: ConversationView, tool: string): ToolResult[] {
  return view.entries.flatMap((entry) =>
    entry.kind === 'tool_result' && entry.content.tool === tool
      ? [entry.content]
      : [],
  );
}

/** `<outcome> <refusal reason>` of every result of `tool`, in order. */
function outcomesOf(view: ConversationView, tool: string): string[] {
  return resultsOf(view, tool).map(
    (result) => `${result.outcome} ${result.refusalReason}`,
  );
}

function lastResultOf(view: ConversationView, tool: string): ToolResult {
  const result = resultsOf(view, tool).at(-1);
  if (result === undefined)
    throw new Error(`No result of ${tool} in ${view.thread.id}`);
  return result;
}

/** What a send may leave behind: the history, the queue of the conversation and the runtime inbox of its tree. */
async function threadRows(
  session: Session,
  threadId: string,
): Promise<{ entries: number; pending: number; inbox: number }> {
  const view = await api(session).history(threadId);
  const { rows } = await harness.pool.query<{ count: number }>(
    `SELECT count(*)::int AS count FROM app.runtime_inbox i
       JOIN app.runtime_tasks t ON t.task_id = i.recipient_id WHERE t.root_id = $1`,
    [view.chat.rootAgentId],
  );
  return {
    entries: view.entries.length,
    pending: view.pending.length,
    inbox: rows[0]?.count ?? 0,
  };
}

/**
 * Root sessions of the owner: sessions without a parent (a conversation's chat). A root is a run of the built-in
 * record `chat`, so `ofChat` counts the roots whose row names that record.
 */
async function rootSessions(
  ownerId: string,
): Promise<{ total: number; ofChat: number }> {
  const { rows } = await harness.pool.query<{
    total: number;
    ofChat: number;
  }>(
    `SELECT count(*)::int AS total, count(r.id)::int AS "ofChat"
       FROM app.agent_sessions s
       LEFT JOIN app.library_records r ON r.id = s.record_id AND r.builtin_key = 'chat' AND s.builtin_key = 'chat'
      WHERE s.owner_id = $1 AND s.parent_id IS NULL`,
    [ownerId],
  );
  const [counts] = rows;
  if (counts === undefined) throw new Error('the root count returned no row');
  return counts;
}

// ---------------------------------------------------------------------------------------------------------------
// The library and the drafts
// ---------------------------------------------------------------------------------------------------------------

/** The built-in records by key: id and version (`library_records.builtin_key`). */
async function builtinRows(): Promise<
  Record<string, { id: string; version: number }>
> {
  const { rows } = await harness.pool.query<{
    key: string;
    id: string;
    version: number;
  }>(
    `SELECT builtin_key AS key, id, version FROM app.library_records
      WHERE builtin_key = ANY($1::text[])`,
    [Object.values(BUILTIN).map((record) => record.builtinKey)],
  );
  return Object.fromEntries(
    rows.map((row) => [row.key, { id: row.id, version: row.version }]),
  );
}

/** The actors of the `library_create` events of each built-in record, in `BUILTIN` order. */
async function builtinCreates(): Promise<string[][]> {
  const creates: string[][] = [];
  for (const { id } of Object.values(BUILTIN)) {
    const events = await auditOfRecord(harness.pool, id);
    creates.push(
      events
        .filter((event) => event.kind === 'library_create')
        .map((event) => event.actor),
    );
  }
  return creates;
}

/** The names of the employee's own records in `GET /api/library`. */
async function ownNames(session: Session): Promise<string[]> {
  return (await listLibrary(liveApp, session))
    .filter((record) => record.mine)
    .map((record) => record.name);
}

function draftAction(
  session: Session,
  threadId: string,
  draftId: string,
  action: Parameters<typeof postDraftAction>[4],
): Promise<DraftActionAnswer> {
  return postDraftAction(liveApp, session, threadId, draftId, action);
}

/** Fails unless the action answered 200; returns the draft. */
function acted(answer: DraftActionAnswer): DraftView {
  if (!answer.ok) {
    throw new Error(
      `The draft action answered ${answer.status}: ${JSON.stringify(answer.error)}`,
    );
  }
  return answer.draft;
}

/** Fails unless the action answered `status` with `errorCode`; returns the error body. */
function refused(
  answer: DraftActionAnswer,
  status: number,
  errorCode: string,
): ApiError {
  if (answer.ok) {
    throw new Error(
      `The draft action answered 200: ${JSON.stringify(answer.draft)}`,
    );
  }
  expect([answer.status, answer.error.errorCode]).toEqual([status, errorCode]);
  return answer.error;
}

function draftNamed(view: ConversationView, name: string): DraftView {
  const draft = view.drafts.find((candidate) => candidate.name === name);
  if (draft === undefined) {
    throw new Error(`No draft "${name}" in ${view.thread.id}`);
  }
  return draft;
}

describe('custom-agents / runtime - API integration (real AppModule + real Postgres + real library, scripted model)', () => {
  beforeAll(async () => {
    // One live app at a time (two apps with workers over one database would step each other's tasks); INT-3 A
    // closes it and boots it again. The rows make their own employees, roles and records.
    harness = await boot();
    recorder.model.completeText({ text: TITLE });
    admin = await seedSuperAdmin(
      harness.app,
      `e2e-runtime-admin-${randomUUID()}`,
    );
    made.users.push(admin.id);
    restoreModels = await useRunModels(liveApp, admin, {
      chat: { id: DEFAULT_MODEL, ...HAIKU_TEST_PRICES },
    });
    await addModel(liveApp, admin, { id: R_MODEL, ...HAIKU_TEST_PRICES });
    restoreBuiltins = await pointBuiltinsAt(liveApp, admin, DEFAULT_MODEL);
  }, TEST_TIMEOUT_MS);

  afterAll(async () => {
    if (harness === undefined) return;
    try {
      try {
        try {
          await runAll(restoreEdits);
        } finally {
          await restoreBuiltins?.();
          await restoreModels?.();
        }
      } finally {
        // Drafts go with their conversation, records and personal grants with their employee, shares with the role.
        await removeRunRows(harness.pool, {
          models: [DEFAULT_MODEL, R_MODEL],
          roles: made.roles,
          users: made.users,
        });
      }
    } finally {
      await harness.close();
    }
  }, TEST_TIMEOUT_MS);

  // ---------------------------------------------------------------------------------------------------------------
  // INT-3: the real library is what the chat lists and what a start asks - built-ins, a colleague's agent, the chip
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-12.1 "Given администратор поменял промпт `general-purpose`, when сотрудник запускает этого агента в новой беседе, then агент
  //   работает с новым промптом без выпуска платформы"; AC-12.3 "Given новая установка без записей администратора, when сотрудник пишет в
  //   чат и запускает глубокий ресерч, then чат и ресерч работают как до фичи"; AC-12.4 "Given у сотрудника нет ни одной роли, но есть
  //   личные права, when он пишет в чат, then чат ему отвечает"; AC-12.5 "when он открывает `deep-research` только роли «SRE», then
  //   сотрудники вне этой роли глубокий ресерч не видят"; AC-14.1 / AC-14.3 (real roles); AC-14.4 "Given в агенте Ани выбрана модель, на
  //   которую у Ани больше нет права, when Аня запускает агента из чата, then агент не стартует, а Аня видит, какая модель ей недоступна";
  //   AC-15.1 "Given Аня поделилась агентом с ролью «SRE» и включила «предлагать в главном чате», when Борис пишет следующее сообщение в
  //   любую беседу, then его чат знает этого агента и может его запустить"; AC-15.2 "Given Аня выключила переключатель, when Борис
  //   называет агента по имени, then его чат агента не предлагает и не запускает, а в чате Ани агент запускается"; AC-15.6 "Given Борис
  //   положил агента Ани в поле сообщения кнопкой «Использовать в чате», when он отправляет сообщение, then запускается агент Ани, хотя
  //   у Бориса есть свой с тем же именем"; AC-17.1 "then в беседе и списке агентов у имени указан автор «Аня»". Design: UC-1, UC-2 (the
  //   second half), UC-3 (the listing half), UC-4, UC-8, UC-9, UC-10, UC-E1, UC-E2 (route half), DC-1, DC-2, DC-6, KD-4, KD-7.
  // Behavior: the app boots -> `BuiltinRecordsSeeder` seeds after the migration check -> a message reaches the root, which reads the real
  //   `listVisible` of its owner on EVERY model step -> a start asks the real `resolve` for the runner -> the child's view carries the record's origin.
  // Rows (ordered; each row states its own Given):
  //   A. Built-ins (AC-12.1, AC-12.3, AC-12.4, AC-12.5, DC-1, DC-2). Given an empty library; When the app boots, closes and boots again over
  //      the same database; Then exactly three system records exist (keys `chat`, `general-purpose`, `deep-research`), each with the SAME
  //      number after the second boot and one `library_create` event each (written by `system`, none on the second boot); the administrator
  //      renames `chat` and edits the prompt of `general-purpose`, the app boots a third time: both edits are still there (a seed never
  //      overwrites). Given Вера with no role and only a personal model right; When she writes in a new conversation; Then the chat answers
  //      (the root starts from the `chat` record by key, renamed or not, whatever its audience). A new conversation's `general-purpose` child
  //      carries the edited prompt in its model input; a conversation created before the edit keeps the old chat prompt on its next message.
  //      The administrator opens `deep-research` to «SRE» only: Борис (a member) sees it in the `start_workflow` description of his root, Вера
  //      does not; Борис confirms a brief for it and the coordinator's snapshot carries the three executors of the seed (the run view's `team`
  //      equals the executor names of the seed file) - the seeded content is a valid, startable record.
  //   B. A colleague's agent in the chat (AC-14.1, AC-14.3, AC-14.4, AC-15.1, AC-15.2, AC-15.6, AC-17.1; UC-8, UC-9, UC-10, UC-E1, UC-E2).
  //      Given Аня's agent R shared with «SRE» with the switch on, Борис also owns an agent with the same name; When Борис writes any message;
  //      Then his root's first model call lists R (number, name, author Аня), his own first and marked "ваша"; Аня turns the switch off and
  //      Борис writes again: R is gone from the list, and his root's `start_agent` of R's number is refused `not_allowed`, while Аня's own
  //      root starts it. Turn the switch on; Борис sends a message with a chip `recordId` of R: 200, the root's input carries R's number
  //      and the chip appears in the history (`record`: id, kind, name); the root starts R by that number and not Борис's namesake; the child's
  //      `AgentView.origin` names R, version 1, author `{ Аня }`, `firstRun: true`, and the second start of R by Борис has `firstRun: false`.
  //      The chip with a number the chat of Борис cannot launch (a personal record of Глеб, a record of «Оплаты», R with the switch off, a
  //      number that does not exist) -> 404 `RECORD_NOT_FOUND`, the same body for each, and no `runtime_*` queue row or history entry was added
  //      for that send. The administrator removes Борис from «SRE»: his running agent that starts R is refused `record_unavailable`, no child.
  //      Given R's model is disallowed for Аня by the administrator (`AccessAdminController`); When Аня starts R from her chat; Then the root's
  //      tool result carries `model_not_allowed` and the model's number and there is no child; `POST /api/agents/:id/restart` of her earlier
  //      finished run of R -> 409 `START_REFUSED` with `reason: 'model_not_allowed'` and `model` the same number; the agent list is unchanged.
  // Catches: a seeder that runs before the migration check, runs per request, overwrites an administrator's edit, or gives a new number on
  //   every boot (the chat is found by number or by name instead of by key, so a rename breaks every conversation); a chat that refuses an
  //   employee with no role because it asks the audience of the chat record; a list read once per conversation (a colleague's new agent or
  //   a switched-off one appears or lingers until a new conversation); the list built from the AUTHOR's view or including `offerInChat` off;
  //   a chip checked against the whole library instead of what the chat may launch (a colleague's private record is launched through a
  //   crafted `recordId`), or a rejected chip that still enqueued the message; a start that asks the library for the author, so the
  //   removal from the role changes nothing; the author's label missing or a namesake started; a restart whose refusal is a 500 or whose
  //   `model` is lost; a seeded record that violates its own content schema and fails only at the first real start.
  // @category: core-functionality
  // @dependency: BuiltinRecordsSeeder, LibraryService (listVisible, resolve, resolveBuiltin), ConversationsService (chip), ThreadsController, start_agent / start_workflow, AccessService, IdentityDirectory, runtime workers, Postgres
  // @complexity: high
  // Implementation (task 6.5, Notes 4; where the comment above differs, the task's text decides): `api` e2e runs on the developer's
  //   database, where the built-in records are already seeded (Task Q.2), so "an empty library" and "exactly three records" are read
  //   by the three keys and the `library_create` events of their numbers. Row A changes the built-in records and gives them back in
  //   `afterAll` (name, prompt, audience; the models through `pointBuiltinsAt`); "outside «SRE»" is an employee with another role,
  //   since an employee with no role sees no record open to everyone at all. Row B gives Аня's agent R a model of its own, allowed
  //   through «SRE» only: removing Борис from «SRE» and a personal deny for Аня change R and nothing of their chats.
  it(
    'INT-3 A: the app seeds the three built-in records once and never over an edit; the chat starts from the `chat` record by key for an employee with no role, and the seeded research workflow starts for its audience only',
    async () => {
      const chat = BUILTIN.chat;
      const generalPurpose = BUILTIN.generalPurpose;
      const deepResearch = BUILTIN.deepResearch;
      // Given: Борис in «SRE», Глеб in another role, Вера in no role with a personal right on the chat's model
      const sre = await newRole('sre-int3a', [DEFAULT_MODEL]);
      const other = await newRole('other-int3a', [DEFAULT_MODEL]);
      const boris = await newEmployee('Борис', [sre]);
      const gleb = await newEmployee('Глеб', [other]);
      const vera = await newEmployee('Вера', []);
      await personalModel(vera, 'allow', DEFAULT_MODEL);

      // The first boot (beforeAll) seeded the three records with their constant numbers, or found them seeded
      const seeded = await builtinRows();
      expect(
        Object.fromEntries(
          Object.entries(seeded).map(([key, row]) => [key, row.id]),
        ),
      ).toEqual({
        [chat.builtinKey]: chat.id,
        [generalPurpose.builtinKey]: generalPurpose.id,
        [deepResearch.builtinKey]: deepResearch.id,
      });
      const creates = await builtinCreates();
      // The developer's database keeps the audit of earlier seeds of the same numbers (a wiped library is seeded again),
      // so the count is not fixed here; the boots below add none.
      expect(creates.map((actors) => [...new Set(actors)])).toEqual([['system'], ['system'], ['system']]);

      // When: the app boots a second time over the same database
      await reboot();
      // Then: the same numbers and versions, and no new `library_create`
      expect(await builtinRows()).toEqual(seeded);
      expect(await builtinCreates()).toEqual(creates);

      // A conversation started before the administrator's edits
      const beforeEdits = 'INT-3 A: беседа до правок';
      scriptTask(beforeEdits, [{ text: 'INT-3 A: ответ до правок' }]);
      const oldThread = await firstMessage(boris, beforeEdits);
      await untilAnswered(boris, oldThread, 'INT-3 A: ответ до правок');
      await untilTitled(boris, oldThread);
      const chatBefore = await panelRecord(chat.id);
      const generalBefore = await panelRecord(generalPurpose.id);
      expect(firstCallFor(beforeEdits).agentName).toBe(chatBefore.name);

      // The administrator renames `chat` and edits the prompt of `general-purpose`; `afterAll` gives both back
      restoreEdits.push(async () => {
        const current = await panelRecord(chat.id);
        await putPanelRecord(
          chat.id,
          agentUpdate(current, { name: chatBefore.name }),
        );
      });
      restoreEdits.push(async () => {
        const current = await panelRecord(generalPurpose.id);
        await putPanelRecord(
          generalPurpose.id,
          agentUpdate(current, { prompt: promptOf(generalBefore) }),
        );
      });
      const renamed = recordName('Главный чат INT-3');
      const editMark = `INT-3 A: the edited prompt ${randomUUID()}`;
      const editedPrompt = `${promptOf(generalBefore)}\n${editMark}`;
      const chatEdited = await putPanelRecord(
        chat.id,
        agentUpdate(chatBefore, { name: renamed }),
      );
      const generalEdited = await putPanelRecord(
        generalPurpose.id,
        agentUpdate(generalBefore, { prompt: editedPrompt }),
      );

      // When: the app boots a third time
      await reboot();
      // Then: a seed never overwrites an edit
      const chatAfter = await panelRecord(chat.id);
      const generalAfter = await panelRecord(generalPurpose.id);
      expect([chatAfter.name, chatAfter.version]).toEqual([
        renamed,
        chatEdited.version,
      ]);
      expect([promptOf(generalAfter), generalAfter.version]).toEqual([
        editedPrompt,
        generalEdited.version,
      ]);
      expect(await builtinCreates()).toEqual(creates);

      // Вера, with no role, writes: the chat answers - the root starts from `chat` by its key, renamed, whatever its audience
      const veraText = 'INT-3 A: Вера пишет в чат';
      scriptTask(veraText, [{ text: 'INT-3 A: ответ Вере' }]);
      const veraThread = await firstMessage(vera, veraText);
      await untilAnswered(vera, veraThread, 'INT-3 A: ответ Вере');
      expect(firstCallFor(veraText).agentName).toBe(renamed);

      // The conversation started before the edits keeps its chat as it was at its start
      const oldNext = 'INT-3 A: беседа до правок, второе сообщение';
      scriptTask(oldNext, [{ text: 'INT-3 A: второй ответ до правок' }]);
      await api(boris).send(oldThread, oldNext);
      await untilAnswered(boris, oldThread, 'INT-3 A: второй ответ до правок');
      expect(firstCallFor(oldNext).agentName).toBe(chatBefore.name);

      // The administrator opens `deep-research` to «SRE» only; `afterAll` gives it back its audience
      const researchBefore = await panelRecord(deepResearch.id);
      restoreEdits.push(() =>
        putPanelAudience(deepResearch.id, audienceBodyOf(researchBefore)),
      );
      await setSystemAudience(liveApp, admin, deepResearch.id, {
        everyone: false,
        roleIds: [sre.id],
      });

      // Борис (in «SRE») starts general-purpose in a new conversation: his chat lists the research workflow, and the
      // child runs on the edited prompt
      const borisText = 'INT-3 A: новая беседа Бориса';
      const generalTask = 'INT-3 A: задание general-purpose';
      scriptTask(borisText, [
        {
          calls: [
            startAgent(
              'INT-3 A: general-purpose',
              generalTask,
              generalPurpose.id,
            ),
          ],
        },
        { text: 'INT-3 A: агент запущен' },
      ]);
      scriptTask(generalTask, [{ text: 'INT-3 A: отчёт general-purpose' }]);
      const borisThread = await firstMessage(boris, borisText);
      await untilAnswered(boris, borisThread, 'INT-3 A: агент запущен');
      const borisCall = firstCallFor(borisText);
      expect(borisCall.agentName).toBe(renamed);
      expect(
        listingHeads(borisCall, START_WORKFLOW).filter((head) =>
          head.startsWith(`${deepResearch.id}: `),
        ),
      ).toHaveLength(1);
      expect((await untilCalled(generalTask)).instructions).toContain(editMark);

      // Глеб (outside «SRE») does not see it
      const glebText = 'INT-3 A: Глеб пишет в чат';
      scriptTask(glebText, [{ text: 'INT-3 A: ответ Глебу' }]);
      const glebThread = await firstMessage(gleb, glebText);
      await untilAnswered(gleb, glebThread, 'INT-3 A: ответ Глебу');
      expect(
        listingHeads(firstCallFor(glebText), START_WORKFLOW).filter((head) =>
          head.startsWith(`${deepResearch.id}: `),
        ),
      ).toEqual([]);

      // Борис confirms a brief: the seeded workflow is a valid, startable record, its run carries the seed's team
      const question = 'INT-3 A: как ведёт себя очередь оплат?';
      const briefText = 'INT-3 A: Борис просит глубокий ресерч';
      scriptTask(briefText, [
        { calls: [startResearch(question)] },
        { text: 'INT-3 A: бриф решён' },
      ]);
      scriptTask(briefTask(question), [
        { text: 'INT-3 A: координатор ответил' },
      ]);
      await api(boris).send(borisThread, briefText);
      const awaiting = await waitFor(
        () => api(boris).history(borisThread),
        (view) =>
          view.decisions.some(
            (decision) =>
              decision.kind === WORKFLOWS_BRIEF_CONFIRMATION &&
              decision.status === 'open',
          ),
        'the brief of the research workflow',
      );
      const brief = awaiting.decisions.find(
        (decision) => decision.kind === WORKFLOWS_BRIEF_CONFIRMATION,
      );
      if (brief === undefined) throw new Error('No brief to decide');
      await api(boris).decide(brief.decisionId, { approve: true });
      const coordinator = await untilAgent(
        boris,
        borisThread,
        question,
        (node) => node.origin?.recordId === deepResearch.id,
      );
      const run = await api(boris).run(coordinator.agentId);
      expect([run.origin.recordId, run.brief.question]).toEqual([
        deepResearch.id,
        question,
      ]);
      expect(run.team.map((member) => member.name)).toEqual(SEED_TEAM);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "INT-3 B: the chat lists and starts a colleague's record for the runner's real roles, switch and model on every step, refuses a chip it may not launch, and a refused start or restart answers with the model",
    async () => {
      // Given: «SRE» allows R's model and is R's audience; every employee's chat model comes from «Чат», so a change of
      // «SRE» touches R only. Глеб is in «Оплаты». Борис owns an agent with R's name.
      const chatRole = await newRole('chat-int3b', [DEFAULT_MODEL]);
      const sre = await newRole('sre-int3b', [R_MODEL]);
      const payments = await newRole('payments-int3b', []);
      const anya = await newEmployee('Аня', [chatRole, sre]);
      const boris = await newEmployee('Борис', [chatRole, sre]);
      const gleb = await newEmployee('Глеб', [chatRole, payments]);
      const name = recordName('Разбор инцидентов');
      const r = await createRecord(
        liveApp,
        anya,
        agentBody(name, { model: R_MODEL }),
      );
      await shareWith(liveApp, anya, r.id, [sre.id]);
      const borisOwn = await createRecord(
        liveApp,
        boris,
        agentBody(name, { model: DEFAULT_MODEL }),
      );
      const glebPersonal = await createRecord(
        liveApp,
        gleb,
        agentBody(recordName('Личный агент Глеба'), { model: DEFAULT_MODEL }),
      );
      const glebPayments = await createRecord(
        liveApp,
        gleb,
        agentBody(recordName('Агент «Оплат»'), { model: DEFAULT_MODEL }),
      );
      await shareWith(liveApp, gleb, glebPayments.id, [payments.id]);
      const namesakes = (call: ModelCall): string[] =>
        listingHeads(call, START_AGENT).filter((head) =>
          head.includes(`: ${name} (`),
        );

      // When: Борис writes any message; Then: his chat lists R with its author, his own namesake first and marked
      const listed = 'INT-3 B: Борис пишет';
      scriptTask(listed, [{ text: 'INT-3 B: ответ Борису' }]);
      const borisThread = await firstMessage(boris, listed);
      await untilAnswered(boris, borisThread, 'INT-3 B: ответ Борису');
      expect(namesakes(firstCallFor(listed))).toEqual([
        `${borisOwn.id}: ${name} (yours)`,
        `${r.id}: ${name} (by Аня)`,
      ]);

      // Аня turns the switch off; Борис writes again: R is gone from his list and his start of R is refused
      await setOwnAudience(anya, r.id, [sre.id], false);
      const switchedOff = 'INT-3 B: Борис запускает R по номеру';
      scriptTask(switchedOff, [
        {
          calls: [
            startAgent('INT-3 B: R у Бориса', 'INT-3 B: задание R', r.id),
          ],
        },
        { text: 'INT-3 B: R не запущен' },
      ]);
      await api(boris).send(borisThread, switchedOff);
      const refusedOff = await untilAnswered(
        boris,
        borisThread,
        'INT-3 B: R не запущен',
      );
      expect(namesakes(firstCallFor(switchedOff))).toEqual([
        `${borisOwn.id}: ${name} (yours)`,
      ]);
      expect(outcomesOf(refusedOff, START_AGENT)).toEqual([
        'refused not_allowed',
      ]);
      expect(treeOf(refusedOff.agents)).toEqual([]);

      // ... while Аня's own chat starts it (the run she restarts at the end of the row)
      const anyaText = 'INT-3 B: Аня запускает своего агента';
      const anyaTask = 'INT-3 B: задание R от Ани';
      scriptTask(anyaText, [
        {
          calls: [startAgent('INT-3 B: R у Ани', anyaTask, r.id)],
        },
        { text: 'INT-3 B: Аня запустила R' },
      ]);
      scriptTask(anyaTask, [{ text: 'INT-3 B: отчёт R для Ани' }]);
      const anyaThread = await firstMessage(anya, anyaText);
      const anyaRun = await untilAgent(
        anya,
        anyaThread,
        'INT-3 B: R у Ани',
        (node) => node.status === 'completed',
      );
      await untilAnswered(anya, anyaThread, 'INT-3 B: Аня запустила R');

      // Аня turns the switch on; Борис sends a message with the chip of R: the root reads R's number and starts R,
      // not his namesake, and the child is labelled with R and its author
      await setOwnAudience(anya, r.id, [sre.id], true);
      const chipped = 'INT-3 B: Борис выбрал агента Ани';
      const chipTask = 'INT-3 B: задание R по чипу';
      scriptTask(chipText(chipped, { kind: 'agent', id: r.id, name }), [
        { calls: [startAgent('INT-3 B: R по чипу', chipTask, r.id)] },
        { text: 'INT-3 B: R запущен по чипу' },
      ]);
      scriptTask(chipTask, [{ text: 'INT-3 B: отчёт R по чипу' }]);
      const sent = await api(boris).raw(
        'post',
        `/threads/${borisThread}/messages`,
        { text: chipped, recordId: r.id },
      );
      expect(sent.status).toBe(202);
      const chippedView = await untilAnswered(
        boris,
        borisThread,
        'INT-3 B: R запущен по чипу',
      );
      expect(
        chippedView.entries.flatMap((entry) =>
          entry.kind === 'user_message' && entry.content.text === chipped
            ? [entry.content.record]
            : [],
        ),
      ).toEqual([{ id: r.id, kind: 'agent', name }]);
      const chipRun = agentNamed(chippedView, 'INT-3 B: R по чипу');
      expect([chipRun.origin, chipRun.firstRun]).toEqual([
        {
          recordId: r.id,
          kind: 'agent',
          version: 1,
          name,
          author: { id: anya.id, name: 'Аня' },
          builtinKey: null,
          executor: null,
        },
        true,
      ]);

      // A chip the chat of Борис may not launch: one 404 for each, and the send leaves nothing behind. The run's
      // report wakes the chat once more (an unscripted answer ends the thread); the rows are read after it.
      await untilIdle(
        boris,
        borisThread,
        (view) => {
          const last = view.entries.at(-1);
          return (
            last?.kind === 'model_answer' &&
            last.content.text === UNSCRIPTED_ANSWER
          );
        },
        'the chat answering the report of the chip run',
      );
      const rowsBefore = await threadRows(boris, borisThread);
      const chipAnswer = async (recordId: string): Promise<ApiError> =>
        expectError(
          api(boris).raw('post', `/threads/${borisThread}/messages`, {
            text: 'INT-3 B: чип, которого нет в наборе чата',
            recordId,
          }),
          404,
        );
      const answers = [
        await chipAnswer(glebPersonal.id),
        await chipAnswer(glebPayments.id),
        await chipAnswer(randomUUID()),
        await chipAnswer('not-a-uuid'),
      ];
      await setOwnAudience(anya, r.id, [sre.id], false);
      answers.push(await chipAnswer(r.id));
      await setOwnAudience(anya, r.id, [sre.id], true);
      expect(answers.map((answer) => answer.errorCode)).toEqual(
        Array(answers.length).fill('RECORD_NOT_FOUND'),
      );
      for (const answer of answers) expect(answer).toEqual(answers[0]);
      expect(await threadRows(boris, borisThread)).toEqual(rowsBefore);

      // Борис starts R a second time: no longer his first run of it
      const again = 'INT-3 B: Борис снова запускает R';
      const againTask = 'INT-3 B: второе задание R';
      scriptTask(again, [
        { calls: [startAgent('INT-3 B: R второй раз', againTask, r.id)] },
        { text: 'INT-3 B: R запущен второй раз' },
      ]);
      scriptTask(againTask, [{ text: 'INT-3 B: второй отчёт R' }]);
      await api(boris).send(borisThread, again);
      const againView = await untilAnswered(
        boris,
        borisThread,
        'INT-3 B: R запущен второй раз',
      );
      const againRun = agentNamed(againView, 'INT-3 B: R второй раз');
      expect([againRun.origin?.recordId, againRun.firstRun]).toEqual([
        r.id,
        false,
      ]);

      // The administrator removes Борис from «SRE»: his chat asks the library for Борис, so R is unavailable to it
      await takeRole(boris, sre);
      const removed = 'INT-3 B: Борис вне «SRE» запускает R';
      scriptTask(removed, [
        {
          calls: [
            startAgent(
              'INT-3 B: R вне роли',
              'INT-3 B: задание вне роли',
              r.id,
            ),
          ],
        },
        { text: 'INT-3 B: R недоступен' },
      ]);
      const agentsBefore = treeOf(againView.agents).length;
      await api(boris).send(borisThread, removed);
      const removedView = await untilAnswered(
        boris,
        borisThread,
        'INT-3 B: R недоступен',
      );
      expect(
        `${lastResultOf(removedView, START_AGENT).outcome} ${lastResultOf(removedView, START_AGENT).refusalReason}`,
      ).toBe('refused record_unavailable');
      expect(treeOf(removedView.agents)).toHaveLength(agentsBefore);
      // A conversation's root keeps its link to the record it runs: the built-in `chat`
      expect(await rootSessions(boris.id)).toEqual({ total: 1, ofChat: 1 });

      // An employee with no right on the chat's model: the first message is refused with the model, and no root exists
      const dima = await newEmployee('Дима', []);
      const { id: dimaThread } = await api(dima).createThread();
      const firstRefused = await expectBody(
        api(dima).raw('post', `/threads/${dimaThread}/messages`, {
          text: 'INT-3 B: Дима пишет без прав',
        }),
        409,
        StartRefusedErrorSchema,
      );
      expect([firstRefused.reason, firstRefused.model]).toEqual([
        'model_not_allowed',
        DEFAULT_MODEL,
      ]);
      expect(await rootSessions(dima.id)).toEqual({ total: 0, ofChat: 0 });

      // The administrator denies Аня R's model: her chat's start of R is refused with the model, and so is the
      // restart of her finished run of R; her agent list does not change
      await personalModel(anya, 'deny', R_MODEL);
      const denied = 'INT-3 B: Аня запускает R без права на модель';
      scriptTask(denied, [
        {
          calls: [
            startAgent(
              'INT-3 B: R без модели',
              'INT-3 B: задание без модели',
              r.id,
            ),
          ],
        },
        { text: 'INT-3 B: модель R запрещена' },
      ]);
      const agentListBefore = (await api(anya).agentList()).agents.map(
        (agent) => agent.agentId,
      );
      await api(anya).send(anyaThread, denied);
      const deniedView = await untilAnswered(
        anya,
        anyaThread,
        'INT-3 B: модель R запрещена',
      );
      const deniedStart = lastResultOf(deniedView, START_AGENT);
      expect([
        deniedStart.outcome,
        deniedStart.refusalReason,
        deniedStart.refusalDetail,
      ]).toEqual(['refused', 'model_not_allowed', { model: R_MODEL }]);
      expect(treeOf(deniedView.agents).map((node) => node.agentId)).toEqual([
        anyaRun.agentId,
      ]);
      const restartRefused = await expectBody(
        api(anya).raw('post', `/agents/${anyaRun.agentId}/restart`),
        409,
        StartRefusedErrorSchema,
      );
      expect([restartRefused.reason, restartRefused.model]).toEqual([
        'model_not_allowed',
        R_MODEL,
      ]);
      expect(
        (await api(anya).agentList()).agents.map((agent) => agent.agentId),
      ).toEqual(agentListBefore);
    },
    TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-4 (extra, see Budget Used): the draft tool and its routes - one saved record, no foreign reads, the refusals before a card
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-18.1 "Given Аня просит в чате сделать агента для разбора оплат, when чат готовит черновик, then Аня видит карточку с именем,
  //   описанием, промптом, инструментами и моделью, а запись появляется только после её подтверждения"; AC-18.2 "Given Аня отклонила
  //   карточку, then новой записи нет"; AC-18.3 "Given администратор просит чат поправить `general-purpose`, then чат отказывает, и
  //   системная запись не меняется"; AC-18.5 "Given агент Ани открыт роли «SRE», when Аня просит чат поправить его промпт, then чат
  //   отказывает и предлагает редактор, а запись не меняется"; AC-15.4 "Given Аня сохранила нового агента (UC-1), then переключатель
  //   «предлагать в главном чате» у него включён". Design: UC-11, UC-E5, DC-8, DC-9, KD-6, Flow 3, invariant 5.
  // Behavior: the root calls `draft_record` -> a row in `chat_drafts`, the tool answers at once (the conversation stays free) -> the employee's
  //   action on the card -> `DraftsService` finds the draft through her own conversation and calls the real `LibraryService.saveOwn`.
  // Rows (literal expected values):
  //   A. Save once (AC-18.1, AC-15.4, DC-8, DC-9). Given Аня's conversation with no drafts; When the scripted root calls `draft_record` twice
  //      (two definitions); Then `ConversationView.drafts` holds two `DraftView`s: the first `superseded`, the second `pending`, and the
  //      library holds no record of that name yet; `POST /api/threads/:threadId/drafts/:id` `save` on the first -> 409 `DRAFT_RESOLVED`;
  //      `save` on the second -> 200 `saved` with `savedRecordId`: a PERSONAL record of Аня, version 1, "offer in chat" ON, one
  //      `library_create` event; the next model call of her root lists that record; a second `save` of the same draft -> 409 `DRAFT_RESOLVED`
  //      and still one record and one event. `saveOwn` refusing (the name is taken by Аня's other record): 200, the `DraftView` is still
  //      `pending` with `refusal` set, no record added; `save` with another `name` then succeeds.
  //   B. Reject (AC-18.2). Given a pending draft; When Аня rejects it; Then `state` is `rejected`, no record exists, a second action -> 409.
  //   C. Refusals before any card (AC-18.3, AC-18.5, KD-6). Given the administrator asking the chat to change `general-purpose` and Аня asking
  //      to change her record R2 shared with «SRE»; When the scripted root calls `draft_record` with `recordId` of each; Then the tool
  //      results are `read_only` and `shared` respectively, `ConversationView.drafts` is empty (no draft row, no card), and neither record
  //      changed (version, prompt, audience). An argument the content schema rejects -> `invalid_arguments`, no draft.
  //   D. Isolation (invariant 5, CLAUDE.md: isolation between users). Given Аня's pending draft D1 and Борис's pending draft D2 in his own conversation; When Борис
  //      sends an action on D1 through Аня's thread id, through his own thread id, and on a number that does not exist; Then each is 404
  //      `DRAFT_NOT_FOUND` with one and the same body, D1 stays `pending`, no record was created; the same action on D2 through ANOTHER of
  //      Борис's conversations is 404 too (the draft belongs to its conversation); Борис's `ConversationView` never holds D1.
  // Catches: a draft saved by a route that finds it by number only (one employee saves, rejects or reads another's draft, or a draft of
  //   another conversation); a save that runs twice (a double click or a retry makes two records or two events), or that saves a replaced
  //   draft; a draft that creates the record before the employee confirms, or whose saved record is shared, not personal, or has the switch
  //   off (the new agent invisible to the chat); a `saveOwn` refusal that surfaces as a 500 or marks the draft resolved; a refusal for a system
  //   or a role-shared record that still leaves a card (the employee confirms a change the save will refuse); an administrator's request that
  //   edits a system record through the chat.
  // @category: core-functionality
  // @dependency: draft_record tool, DraftsService, ThreadsController (drafts route), chat_drafts, LibraryService (saveOwn, resolve), Agents.mcp.usable, AuditLog, Postgres
  // @complexity: high
  // Implementation (task 6.5): each row makes its own employees in the file's drafts role; the administrator of row C gets a
  //   personal right on the chat's model (the built-in role he sits in holds the developer's rights, not the run's model).
  describe('INT-4: a chat draft becomes exactly one personal record only when its owner saves it from her own conversation, and a system or role-shared record is refused before any card is made', () => {
    let drafts: RunRole;

    beforeAll(async () => {
      drafts = await newRole('drafts-int4', [DEFAULT_MODEL]);
    }, TEST_TIMEOUT_MS);

    it(
      'INT-4 A: a newer draft supersedes the waiting one, a draft is saved once as a personal record with the switch on, and a refused save keeps it waiting',
      async () => {
        // Given: Аня's conversation with no drafts; When: her root calls draft_record twice
        const anya = await newEmployee('Аня', [drafts]);
        const first = recordName('Разбор оплат');
        const second = recordName('Разбор оплат, вариант 2');
        const asked = 'INT-4 A: сделай агента для разбора оплат';
        scriptTask(asked, [
          { calls: [draftCall(first)] },
          { calls: [draftCall(second)] },
          { text: 'INT-4 A: черновики готовы' },
        ]);
        const thread = await firstMessage(anya, asked);
        const drafted = await untilAnswered(
          anya,
          thread,
          'INT-4 A: черновики готовы',
        );
        // Then: the first is superseded, the second waits, and the library holds neither
        expect(
          drafted.drafts.map((draft) => [draft.name, draft.state]),
        ).toEqual([
          [first, 'superseded'],
          [second, 'pending'],
        ]);
        expect(outcomesOf(drafted, DRAFT_RECORD)).toEqual([
          'success null',
          'success null',
        ]);
        const namesBefore = await ownNames(anya);
        expect(
          namesBefore.filter((own) => own === first || own === second),
        ).toEqual([]);
        const superseded = draftNamed(drafted, first);
        const pending = draftNamed(drafted, second);

        // A superseded draft cannot be saved
        refused(
          await draftAction(anya, thread, superseded.draftId, {
            action: 'save',
          }),
          409,
          'DRAFT_RESOLVED',
        );
        // The waiting one is saved: a personal record of Аня, version 1, offered in the chat, one create event
        const saved = acted(
          await draftAction(anya, thread, pending.draftId, { action: 'save' }),
        );
        expect(saved.state).toBe('saved');
        if (saved.savedRecordId === null)
          throw new Error('The saved draft names no record');
        const record = await getRecord(liveApp, anya, saved.savedRecordId);
        expect({
          name: record.name,
          version: record.version,
          mine: record.mine,
          author: record.author?.id,
          roles: record.audience.roles,
          offerInChat: record.offerInChat,
        }).toEqual({
          name: second,
          version: 1,
          mine: true,
          author: anya.id,
          roles: [],
          offerInChat: true,
        });
        const createEvents = async () =>
          (await auditOfRecord(harness.pool, record.id)).map(
            (event) => `${event.kind} ${event.actor}`,
          );
        expect(await createEvents()).toEqual([`library_create ${anya.id}`]);

        // The next model call of her root lists the new record as hers
        const next = 'INT-4 A: что у меня есть?';
        scriptTask(next, [{ text: 'INT-4 A: список прочитан' }]);
        await api(anya).send(thread, next);
        await untilAnswered(anya, thread, 'INT-4 A: список прочитан');
        expect(listingHeads(firstCallFor(next), START_AGENT)).toContain(
          `${record.id}: ${second} (yours)`,
        );

        // A second save of the same draft: 409, and still one record and one event
        refused(
          await draftAction(anya, thread, pending.draftId, { action: 'save' }),
          409,
          'DRAFT_RESOLVED',
        );
        expect((await ownNames(anya)).filter((own) => own === second)).toEqual([
          second,
        ]);
        expect(await createEvents()).toEqual([`library_create ${anya.id}`]);

        // `saveOwn` refuses a name Аня already has: 200, the draft still waits with the reason, no record added
        const taken = await createRecord(
          liveApp,
          anya,
          agentBody(recordName('Занятое имя'), { model: DEFAULT_MODEL }),
        );
        const takenAsk = 'INT-4 A: сделай агента с занятым именем';
        scriptTask(takenAsk, [
          { calls: [draftCall(taken.name)] },
          { text: 'INT-4 A: черновик с занятым именем' },
        ]);
        await api(anya).send(thread, takenAsk);
        const takenView = await untilAnswered(
          anya,
          thread,
          'INT-4 A: черновик с занятым именем',
        );
        const takenDraft = draftNamed(takenView, taken.name);
        const refusedSave = acted(
          await draftAction(anya, thread, takenDraft.draftId, {
            action: 'save',
          }),
        );
        expect([
          refusedSave.state,
          refusedSave.refusal,
          refusedSave.savedRecordId,
        ]).toEqual(['pending', 'name_taken', null]);
        expect(
          (await ownNames(anya)).filter((own) => own === taken.name),
        ).toEqual([taken.name]);
        // Saved under another name, it succeeds
        const otherName = recordName('Разбор оплат, другое имя');
        const savedAs = acted(
          await draftAction(anya, thread, takenDraft.draftId, {
            action: 'save',
            name: otherName,
          }),
        );
        expect([savedAs.state, savedAs.name, savedAs.refusal]).toEqual([
          'saved',
          otherName,
          null,
        ]);
        expect(await ownNames(anya)).toContain(otherName);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'INT-4 B: a rejected draft creates no record and takes no second action',
      async () => {
        const anya = await newEmployee('Аня', [drafts]);
        const name = recordName('Отклонённый агент');
        const asked = 'INT-4 B: сделай агента, которого я отклоню';
        scriptTask(asked, [
          { calls: [draftCall(name)] },
          { text: 'INT-4 B: черновик готов' },
        ]);
        const thread = await firstMessage(anya, asked);
        const view = await untilAnswered(
          anya,
          thread,
          'INT-4 B: черновик готов',
        );
        const draft = draftNamed(view, name);
        expect(draft.state).toBe('pending');

        const rejected = acted(
          await draftAction(anya, thread, draft.draftId, { action: 'reject' }),
        );
        expect([rejected.state, rejected.savedRecordId]).toEqual([
          'rejected',
          null,
        ]);
        expect(await ownNames(anya)).not.toContain(name);
        refused(
          await draftAction(anya, thread, draft.draftId, { action: 'save' }),
          409,
          'DRAFT_RESOLVED',
        );
        expect(await ownNames(anya)).not.toContain(name);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      'INT-4 C: a request to change a system record or a role-shared one is refused before any card, and neither record changes',
      async () => {
        const generalPurpose = BUILTIN.generalPurpose;
        // Given: the administrator asks the chat to change `general-purpose`
        await personalModel(admin, 'allow', DEFAULT_MODEL);
        const generalBefore = await panelRecord(generalPurpose.id);
        const adminAsk = 'INT-4 C: поправь general-purpose';
        scriptTask(adminAsk, [
          {
            calls: [draftCall(generalBefore.name, generalPurpose.id)],
          },
          { text: 'INT-4 C: системную запись не меняю' },
        ]);
        const adminThread = await firstMessage(admin, adminAsk);
        const adminView = await untilAnswered(
          admin,
          adminThread,
          'INT-4 C: системную запись не меняю',
        );
        expect(outcomesOf(adminView, DRAFT_RECORD)).toEqual([
          'refused read_only',
        ]);
        expect(adminView.drafts).toEqual([]);
        const generalAfter = await panelRecord(generalPurpose.id);
        expect([generalAfter.version, promptOf(generalAfter)]).toEqual([
          generalBefore.version,
          promptOf(generalBefore),
        ]);

        // Given: Аня's record shared with the role; she asks to change it, and the model also sends a broken definition
        const anya = await newEmployee('Аня', [drafts]);
        const shared = await createRecord(
          liveApp,
          anya,
          agentBody(recordName('Общий агент Ани'), { model: DEFAULT_MODEL }),
        );
        await shareWith(liveApp, anya, shared.id, [drafts.id]);
        const sharedBefore = await getRecord(liveApp, anya, shared.id);
        const anyaAsk = 'INT-4 C: поправь промпт моего общего агента';
        const broken: ScriptedToolCall = {
          tool: DRAFT_RECORD,
          args: {
            kind: 'agent',
            name: recordName('Сломанный черновик'),
            description: 'INT-4 C: содержимое не проходит схему',
            content: { prompt: '' },
          },
        };
        scriptTask(anyaAsk, [
          { calls: [draftCall(shared.name, shared.id), broken] },
          { text: 'INT-4 C: общую запись не меняю' },
        ]);
        const anyaThread = await firstMessage(anya, anyaAsk);
        const anyaView = await untilAnswered(
          anya,
          anyaThread,
          'INT-4 C: общую запись не меняю',
        );
        // Then: `shared` and `invalid_arguments`, no draft, and the record as it was
        expect(outcomesOf(anyaView, DRAFT_RECORD)).toEqual([
          'refused shared',
          'refused invalid_arguments',
        ]);
        expect(anyaView.drafts).toEqual([]);
        const sharedAfter = await getRecord(liveApp, anya, shared.id);
        expect([
          sharedAfter.version,
          promptOf(sharedAfter),
          sharedAfter.audience.roles.map((role) => role.id),
        ]).toEqual([sharedBefore.version, promptOf(sharedBefore), [drafts.id]]);
      },
      TEST_TIMEOUT_MS,
    );

    it(
      "INT-4 D: another employee's draft and a draft of another conversation answer one 404, and the draft stays as it was",
      async () => {
        // Given: Аня's waiting draft D1 and Борис's waiting draft D2 in his own conversation
        const anya = await newEmployee('Аня', [drafts]);
        const boris = await newEmployee('Борис', [drafts]);
        const anyaName = recordName('Черновик Ани');
        const borisName = recordName('Черновик Бориса');
        const anyaAsk = 'INT-4 D: Аня просит черновик';
        const borisAsk = 'INT-4 D: Борис просит черновик';
        scriptTask(anyaAsk, [
          { calls: [draftCall(anyaName)] },
          { text: 'INT-4 D: черновик Ани готов' },
        ]);
        scriptTask(borisAsk, [
          { calls: [draftCall(borisName)] },
          { text: 'INT-4 D: черновик Бориса готов' },
        ]);
        const anyaThread = await firstMessage(anya, anyaAsk);
        const borisThread = await firstMessage(boris, borisAsk);
        const anyaDraft = draftNamed(
          await untilAnswered(anya, anyaThread, 'INT-4 D: черновик Ани готов'),
          anyaName,
        );
        const borisDraft = draftNamed(
          await untilAnswered(
            boris,
            borisThread,
            'INT-4 D: черновик Бориса готов',
          ),
          borisName,
        );
        const { id: borisOther } = await api(boris).createThread();

        // When: Борис acts on D1 through Аня's thread and his own, on a number that does not exist, and on D2 through
        // another of his conversations
        const answers = [
          refused(
            await draftAction(boris, anyaThread, anyaDraft.draftId, {
              action: 'save',
            }),
            404,
            'DRAFT_NOT_FOUND',
          ),
          refused(
            await draftAction(boris, anyaThread, anyaDraft.draftId, {
              action: 'reject',
            }),
            404,
            'DRAFT_NOT_FOUND',
          ),
          refused(
            await draftAction(boris, borisThread, anyaDraft.draftId, {
              action: 'save',
            }),
            404,
            'DRAFT_NOT_FOUND',
          ),
          refused(
            await draftAction(boris, borisThread, randomUUID(), {
              action: 'save',
            }),
            404,
            'DRAFT_NOT_FOUND',
          ),
          refused(
            await draftAction(boris, borisOther, borisDraft.draftId, {
              action: 'save',
            }),
            404,
            'DRAFT_NOT_FOUND',
          ),
        ];
        // Then: one and the same body, D1 and D2 still wait, no record was created
        for (const answer of answers) expect(answer).toEqual(answers[0]);
        const anyaView = await api(anya).history(anyaThread);
        expect(draftNamed(anyaView, anyaName).state).toBe('pending');
        const borisView = await api(boris).history(borisThread);
        expect(
          borisView.drafts.map((draft) => [draft.draftId, draft.state]),
        ).toEqual([[borisDraft.draftId, 'pending']]);
        expect(await ownNames(anya)).not.toContain(anyaName);
        expect(await ownNames(boris)).not.toContain(anyaName);
        expect(await ownNames(boris)).not.toContain(borisName);
      },
      TEST_TIMEOUT_MS,
    );
  });
});
