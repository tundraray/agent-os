// self-learning / core - agents-package integration tests (in-process `RuntimeModule` + `createAgents` over real Postgres, scripted model)
// Design Doc: docs/features/self-learning/design-core.md (v1.3), Test Strategy UC-1, UC-2, UC-4, UC-6, UC-7, UC-9, UC-E1..UC-E9, UC-N1;
//   PRD: docs/features/self-learning/prd.md (v1.3: AC-01.1 .. AC-20.1, NFR-01, NFR-02).
// Generated: 2026-11-19 as skeletons; updated 2026-11-20 for Design Doc v1.2 (vector store, `knowledge.embed`, two-pass selection, question
//   vector per session, similar entities, `placement` / `state` / `selection` / `counts`); implemented 2026-11-20 (Tasks 8.2 .. 8.4).
// Part: core. Budget Used: 11 integration tests here (INT-1 .. INT-8, INT-10 .. INT-12) + 1 in apps/api/test/self-learning-core.int.e2e-spec.ts (INT-9)
//   = 12 for the part (the owner's cap for this part is 12 after v1.2; the skill's default is 3, up to 5 when each extra names its defect - every
//   test has a `Catches:` line). v1.2 added three cases (INT-10 .. INT-12) and merged the rest of its Test Strategy into INT-1, INT-5, INT-6, INT-8, INT-9.
//   0 E2E: the part has no screen; the journey through the screens is the `web` part's.
// Test Type: Integration. Run with `pnpm --filter @agent-os/agents test:e2e` (`vitest.config.e2e.ts`, `*.e2e-spec.ts`).
//
// Harness (as built; follows custom-agents-runtime.int.e2e-spec.ts, agent-platform-agents.int.e2e-spec.ts and test/support/agentsHarness.ts):
//   real Postgres with the `vector` extension (`pgvector/pgvector:pg16`, KD-8), real `RuntimeModule` and `createAgents`, workers on, the scripted
//   model under `ModelClient` recording every call's system text (`instructions`) and input (the assertion surface for "the model call carries the
//   block" and "the extraction call carries these tool calls"), the real MCP fixture process, the access-gate double of the harness
//   (`ownerModelRefusals`; the embedding model `harness.embeddingVerdict`: none, model A of 3 dimensions or model B of 4), and the embeddings
//   double under the embeddings service (`harness.embeddings`: every provider request with its `inputType`, model and texts - each retry of the
//   service is a request of its own -, `vectorOf` for vectors by topic, `failure` for a 5xx). A second instance over a zombie (`ZOMBIE_RUNTIME`) is
//   the restarted server (INT-4 row B).
//   Support (test/support/knowledge.ts): `withLibraryRow` - the real `app.library_records` row the graph hangs on by its cascading key (KD-1),
//   removed afterwards with the run and question rows; `learningDeepAgent` - the double's record of the same id; `seedGraph` - graph rows and their
//   vectors straight into the tables (the graphs over the size cap of INT-8, INT-10 .. INT-12); `withKnowledgeLimit` - the cap at
//   `KNOWLEDGE_LIMIT_TOKENS_MIN`, the settings row put back afterwards; `waitForRound` / `waitForEmbedPass` - waits on the rows, never sleeps;
//   `knowledgeTasksOf`, `knowledgeView` (`Agents.knowledge.view`), the package's reads (`readGraph`, `readQuestion`, `findRunById`). The real
//   `KnowledgeVectorStore` is read through `list(collection)`, never doubled. The token ledger is read by owner and task (`ledgerRowsOf`,
//   `PLATFORM_OWNER_ID` for the platform's rows).
//   Isolation: a unique runner `newUser()` and a unique deep agent record per test. The settings row is one per database: a case that sets the cap
//   does it through `withKnowledgeLimit` and puts it back; a run of the apps/api suite at the same time would see the changed cap.
//
// Proven elsewhere, not repeated here (CLAUDE.md: one test at the lowest level that catches the defect):
//   - `selectKnowledge` (packages/agents/src/knowledge/select-knowledge.spec.ts, one table, UC-5): AC-04.3 (outdated out of the text),
//       AC-06.1 / AC-06.2 / AC-06.3 (least confirmed first out, older among equals, a smaller limit cuts in the same order), AC-15.3 (`lessons_off`),
//       AC-17.1 / DC-12 (a tool missing from the registry or the team's servers marks the lesson outdated, a returned tool brings it back),
//       DC-9 (same input, same text byte for byte), AC-18.1 (the two-pass ordering: up to half of the limit by closeness, the rest in the common
//       order, an item with no vector still reaches the text by the common order, no pairs -> the whole limit in the common order, a smaller limit
//       cuts in the same order) and the computed view fields - `placement` (`always` / `by_topic` / `does_not_fit` / `null` per `selection` state),
//       `state`, `counts`, `selection` (`off` with `model_not_selected` or `provider_failed`, `preparing` with `pending`, `on`). INT-8 proves only
//       that the step feeds this function the stored question, the store's pairs and the fresh graph, once.
//   - Similar entities at extraction (a unit table beside `check-operations.spec.ts`; UC-10, AC-20.1, DC-17): the candidate rule
//       (`SIMILAR_ENTITY_MIN_SCORE`, `SIMILAR_ENTITY_LIMIT`, `kind` `entity`), no candidates -> no third model call, a `choose_entities` id that
//       is not among the candidates of that entity is rejected and the entity stays new, "keep" leaves both entities, "choose" merges into one
//       with two confirmations. Not repeated at integration level: the part's budget goes to what only the real round shows; the threshold is
//       tuned on the first real extractions (Risks).
//   - `checkOperations` (packages/agents/src/knowledge/check-operations.spec.ts, one table): AC-04.1 (relation attached to the existing
//       entity, ` Billing-API ` becomes a confirmation, not a second entity), AC-16.1 (second confirmation and the round's date), AC-16.2 (no
//       confirmation without a cited call), DC-6 (unknown id, repeated id, malformed operation rejected, others applied), DC-11 (a lesson
//       needs a call of the same tool, "searched, found nothing" needs an `empty` call), `too_many`, `[redacted]` in place of a secret
//       (AC-05.1). INT-7 proves only that this function is wired into the real round once.
//   - Process kill and step recovery as a technique: agents INT-3 row E of agent-platform-agents.int.e2e-spec.ts; INT-4 row B reuses it.
//   - 401 / the `ADMIN_REQUIRED` of the settings routes: the route walk of enterprise-access-identity INT-1 takes new routes from the router
//       by itself; settings bounds (400 `VALIDATION_FAILED`) are a contract-schema row.
//
// `provenAt: not automated`:
//   - AC-07.2 (the answer does not name the graph as a source) is the model's behaviour; INT-1 and INT-8 check the rule stands in the block,
//       the owner checks the answer against the PRD success criteria.
//   - AC-02.2 / AC-02.1 / copy half of AC-02.3: the graph is keyed by the record number only, so a flag switch, a new version and a copy cannot
//       touch it by construction; INT-8 row 3 reads the same graph after a flag round trip, INT-5 proves the delete half.
//   - A task of extraction failing in the runtime (`task.failed` -> `interrupted`, a new task when the mark stands): one consumer decision,
//       a branch of `knowledge-trigger`, left to its unit table. The same for `knowledge.embed` (one task per deep agent, a second request
//       while it runs only sets the "another pass" mark; Invariant 13): a branch of its consumer, left to its unit table.
//   - The vector store port as such (`upsert` replaces the vector of a key, `query` is cosine within one model and honours `kind`, `list`):
//       one contract table against real pgvector; INT-8 row 4, INT-10, INT-11 and INT-5 row B use the store only through the real wiring.
//   - Restart in the middle of an embedding pass (the step recounts only what is still missing, Flow 4): the same recovery technique as
//       INT-4 row B on a step that is idempotent by construction; no case of its own.
//
// acProof (the one proof of every criterion; `unit` = the tables above):
//   AC-01.1 INT-1 · AC-01.2 INT-8 · AC-02.1 not automated · AC-02.2 INT-8 · AC-02.3 INT-5 + not automated · AC-03.1 INT-1 · AC-03.2 INT-2 ·
//   AC-03.3 INT-3 · AC-03.4 INT-6 · AC-04.1 unit · AC-04.2 INT-7 · AC-04.3 unit · AC-04.4 INT-4 · AC-05.1 unit (+ one row in INT-7) ·
//   AC-06.1 unit · AC-06.2 unit · AC-06.3 unit · AC-07.1 INT-8 · AC-07.2 not automated · AC-07.3 INT-1 + INT-8 ·
//   AC-08.1 INT-1 (extraction) + INT-12 (embeddings of sessions and of the pass, on the starter) + INT-11 (recomputation, on the platform) ·
//   AC-08.2 INT-6 · AC-08.3 INT-1 · AC-09.1 INT-9 · AC-09.2 INT-8 (delete -> next step) + INT-9 (delete route) · AC-09.3 INT-9 · AC-15.1 INT-1 ·
//   AC-15.2 INT-1 · AC-15.3 unit · AC-16.1 unit · AC-16.2 INT-7 · AC-17.1 unit · AC-18.1 INT-8 (wiring) + unit (ordering) ·
//   AC-18.2 INT-12 · AC-18.3 INT-10 · AC-18.4 INT-11 · AC-19.1 INT-8 row 4 (entity) + INT-5 row B (deep agent) · AC-20.1 unit ·
//   NFR-01 INT-1 · NFR-02 INT-4.
//
// Charging rule (design-core v1.3): the `knowledge.embed` task is owned by the platform; each `embed` call decides who pays — items that
//   never had a vector go to the starter whose extraction queued the pass (the platform if only deletions queued it), items with a vector of
//   an old model go to the platform; a session's question vector goes to the session's owner under the session's task. INT-11 asserts the
//   split of one pass, INT-12 the question vectors and a pass of new items on the starter.

import { randomUUID } from 'node:crypto';
import type { EmbeddingVerdict } from '@agent-os/agents';
import {
  createLatch,
  createLibraryDouble,
  createScriptedModel,
  type Latch,
  type LibraryDouble,
  modelError,
  type RecordedModelCall,
  type ReplyFromInput,
  type Script,
  type ScriptedAnswer,
  type ScriptedModel,
  type ScriptedModelError,
  type ScriptedToolCall,
} from '@agent-os/agents/testing';
import { type LogFields, rememberSecret } from '@agent-os/common';
import {
  type DeepAgentContent,
  KNOWLEDGE_LIMIT_TOKENS_MIN,
  type KnowledgeView,
  type Subagent,
} from '@agent-os/contracts';
import {
  agentMessages,
  createDatabase,
  type Database,
  type DatabaseConnection,
  type KnowledgeGraph,
  libraryRecords,
} from '@agent-os/db';
import { PLATFORM_OWNER_ID } from '@agent-os/runtime';
import { eq, max } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { KnowledgeRun } from '../src/knowledge/knowledge-runs';
import { KNOWLEDGE_RULE, knowledgeKey } from '../src/knowledge/knowledge-text';
import {
  type AgentsHarness,
  type AgentsHarnessOptions,
  closeAll,
  createAgentsHarness,
  ZOMBIE_RUNTIME,
  historyLines,
  historyOf,
  ledgerRowsOf,
  START_TEST_DEEP_AGENT,
  taskCall,
  TEST_AUTHOR_ID,
  TEST_EMBEDDING_MODEL_A,
  TEST_EMBEDDING_MODEL_B,
  TEST_MODEL_CHOSEN,
  TEST_MODEL_DEFAULT,
  testRecord,
  toolCallRowsOf,
  waitForTaskStatus,
} from './support/agentsHarness';
import { databaseUrl, newUser, waitFor } from '@agent-os/db/testing';
import {
  createPgvectorStore,
  findEmbeddingRow,
  findRunById,
  KNOWLEDGE_EXTRACT_AGENT,
  type KnowledgeTask,
  knowledgeTasksOf,
  knowledgeView,
  learningDeepAgent,
  readGraph,
  readQuestion,
  recordKnowledge,
  type SeededItem,
  type SeedItem,
  seedGraph,
  vectorsByTopic,
  waitForEmbedPass,
  waitForRound,
  withKnowledgeLimit,
  withLibraryRow,
} from './support/knowledge';
import { LOGS_SERVER } from './support/mcp-servers';

/** Bound of one in-process test; the rows settle far sooner. */
const TEST_TIMEOUT_MS = 180_000;

/** `search_logs` of the run's logs server as the model names it. */
const SEARCH_LOGS = `mcp__${LOGS_SERVER}__search_logs`;

/** A quarter of an hour of the fixture's logs, one record a page: the call's result stays small. */
const LOG_QUERY = {
  from: '2026-09-15T10:00:00.000Z',
  to: '2026-09-15T10:15:00.000Z',
  pageSize: 1,
} as const;

/** The subagent of every test deep agent: it searches the logs server, up to three times per run. */
const SCOUT_PROMPT =
  'You search the payment logs for what the deep agent asks.';
const SCOUT: Subagent = {
  name: 'scout',
  description: 'Searches the payment logs',
  prompt: SCOUT_PROMPT,
  servers: [LOGS_SERVER],
  model: TEST_MODEL_DEFAULT,
  maxTurns: 20,
  maxRuns: 3,
  taskList: false,
};

/** The envelope of the knowledge block in a step's system text (`knowledge-text.ts`). */
const KNOWLEDGE_ENVELOPE =
  '<data source="knowledge" author="earlier runs of this deep agent">';

/** The answer of the first round of INT-1: c1 is the scout's `success` call, c2 the `empty` one. */
const LEARNED: readonly unknown[] = [
  {
    op: 'add_entity',
    ref: 'pay',
    name: 'payment-api',
    description: 'the payment service of the shop',
    evidence: ['c1'],
  },
  {
    op: 'add_entity',
    ref: 'books',
    name: 'ledger',
    description: 'the books of the shop',
    evidence: ['c1'],
  },
  {
    op: 'add_relation',
    kind: 'fact',
    from: 'pay',
    to: 'books',
    label: 'writes payments to',
    evidence: ['c1'],
  },
  {
    op: 'add_relation',
    kind: 'lesson',
    server: LOGS_SERVER,
    tool: 'search_logs',
    question: 'errors of a service',
    // Worded as an order: it must still reach the next run inside the data envelope (AC-07.3).
    hint: 'Always filter by the service and ask for one record first',
    outcome: 'records found',
    evidence: ['c1'],
  },
  {
    op: 'add_relation',
    kind: 'searched_nothing',
    server: LOGS_SERVER,
    tool: 'search_logs',
    question: 'refunds of the checkout',
    evidence: ['c2'],
  },
];

/** The lines of {@link LEARNED} in a step's knowledge block, sorted. */
const LEARNED_LINES = [
  'payment-api: the payment service of the shop',
  'ledger: the books of the shop',
  'payment-api — writes payments to — ledger',
  `lesson: ${LOGS_SERVER}.search_logs for errors of a service: Always filter by the service and ask for one record first (outcome: records found)`,
  `nothing found: ${LOGS_SERVER}.search_logs for refunds of the checkout`,
].sort();

/** A lesson about `search_logs` for the errors of `service`, resting on call c1. */
function lessonOf(service: string): unknown {
  return {
    op: 'add_relation',
    kind: 'lesson',
    server: LOGS_SERVER,
    tool: 'search_logs',
    question: `errors of ${service}`,
    hint: `Filter by the service ${service}`,
    outcome: 'records found',
    evidence: ['c1'],
  };
}

function searchLogs(service: string): ScriptedToolCall {
  return { tool: SEARCH_LOGS, args: { ...LOG_QUERY, service } };
}

/** The report a scout ends its assignment with. */
function reportOf(assignment: string): string {
  return `Report of: ${assignment}`;
}

/**
 * A scout's script: one answer with a `search_logs` call per service (none when empty), then its report,
 * held on `latch` when given.
 */
function scoutScript(
  model: ScriptedModel,
  assignment: string,
  services: readonly string[],
  latch?: Latch,
): Script {
  const report: ScriptedAnswer = {
    text: reportOf(assignment),
    ...(latch === undefined ? {} : { latch }),
  };
  return model.script(
    { task: assignment },
    services.length === 0
      ? [report]
      : [{ calls: services.map(searchLogs) }, report],
  );
}

/** A turn of a deep agent: its task or a later employee message, and what it does with it. */
interface DeepAgentTurn {
  readonly text: string;
  /** The assignment of the scout the turn starts; `null` — the turn starts none and answers at once. */
  readonly scout: string | null;
  /** The answer that ends the turn; a plain text by default. */
  readonly answer?: ScriptedAnswer | ScriptedModelError;
}

function descriptionOf(args: unknown): unknown {
  return typeof args === 'object' && args !== null && 'description' in args
    ? args.description
    : undefined;
}

/**
 * A deep agent decided by its input, so a stop, a continuation or a message arriving with the scout's result
 * does not shift its answers: the latest turn it was given gives its scout one `task`, and the deep agent is
 * woken once the scout has finished (deep-agents/design-task.md KD-4), then answers.
 */
function deepAgentReplies(turns: readonly DeepAgentTurn[]): ReplyFromInput {
  return (messages) => {
    const said = messages.flatMap((message) =>
      message.role === 'user' ? [message.content] : [],
    );
    const turn = [...turns]
      .reverse()
      .find((candidate) => said.includes(candidate.text));
    if (turn === undefined)
      throw new Error('The deep agent got none of its turns');
    const answer = turn.answer ?? { text: `Answer to: ${turn.text}` };
    const { scout } = turn;
    if (scout === null) return answer;
    const delegated = messages.some(
      (message) =>
        message.role === 'assistant' &&
        message.toolCalls.some(
          (call) =>
            call.toolName === 'task' && descriptionOf(call.args) === scout,
        ),
    );
    return delegated
      ? answer
      : { calls: [taskCall({ subagentType: SCOUT.name, description: scout })] };
  };
}

/** The first child an agent started (`childTaskId` of a `start_test_deep_agent` or a single `task` result), once it exists. */
async function startedChild(
  harness: AgentsHarness,
  agentId: string,
): Promise<string> {
  const rows = await waitFor(
    () => toolCallRowsOf(harness.db, agentId),
    (calls) => calls.some((call) => call.childTaskId !== null),
    `a child of agent ${agentId}`,
  );
  const child = rows.find((call) => call.childTaskId !== null)?.childTaskId;
  if (child === undefined || child === null)
    throw new Error(`Agent ${agentId} started no child`);
  return child;
}

interface LearningRun {
  readonly deepAgentId: string;
  /** The deep agent's calls. */
  readonly deepAgent: Script;
}

/**
 * Starts a run of the deep agent `recordId` for `ownerId`: a conversation whose root starts the deep agent with the
 * first turn's text, the deep agent answering by {@link deepAgentReplies}. Returns once the deep agent exists.
 */
async function startLearningRun(
  harness: AgentsHarness,
  model: ScriptedModel,
  run: {
    readonly ownerId: string;
    readonly recordId: string;
    readonly turns: readonly DeepAgentTurn[];
  },
): Promise<LearningRun> {
  const [first] = run.turns;
  if (first === undefined) throw new Error('A run needs its first turn');
  const rootTask = `Start the deep agent: ${first.text}`;
  const startDeepAgent: ScriptedToolCall = {
    tool: START_TEST_DEEP_AGENT,
    args: {
      deepAgent: run.recordId,
      prompt: first.text,
      description: first.text,
    },
  };
  model.script({ task: rootTask }, [{ calls: [startDeepAgent] }], {
    thereafter: { text: 'noted' },
  });
  const deepAgent = model.script({ task: first.text }, [], {
    thereafter: deepAgentReplies(run.turns),
  });
  const { agentId: rootId } = await harness.sessions.start({
    ownerId: run.ownerId,
    prompt: rootTask,
    description: first.text,
  });
  return { deepAgentId: await startedChild(harness, rootId), deepAgent };
}

/**
 * A harness whose root may start deep agents and whose every employee may use the logs server; `settings` makes it
 * a zombie or a second instance (INT-4 row B), refuses models per owner (INT-6 row A) or lowers the compaction
 * threshold (INT-8, INT-12).
 */
function learningHarness(
  model: ScriptedModel,
  library: LibraryDouble,
  settings: Pick<
    AgentsHarnessOptions,
    'runtimeConfig' | 'fixture' | 'ownerModelRefusals' | 'variables'
  > = {},
): Promise<AgentsHarness> {
  return createAgentsHarness({
    model,
    library,
    access: { '*': [LOGS_SERVER] },
    root: testRecord('chat', { tools: ['start_agent'] }),
    deepAgentStarter: true,
    ...settings,
  });
}

/** The content of {@link learningDeepAgent} with the scout team, to edit the record from. */
function learningContent(recordId: string): DeepAgentContent {
  const record = learningDeepAgent(recordId, [SCOUT]);
  if (record.kind !== 'deep_agent')
    throw new Error('learningDeepAgent made no deep agent');
  return record.content;
}

/**
 * Writes the `tool_result` of a `search_logs` call with the outcome `empty` into the history of a finished
 * session, as the tool step leaves one: the fixture answers every call with a structured result, so no real
 * call is `empty`, and a «searched — found nothing» record needs one (DC-11). The session must be finished:
 * no step reads it again.
 */
async function writeEmptyCall(
  db: Database,
  taskId: string,
  service: string,
): Promise<void> {
  const at = new Date();
  const callId = `empty-${randomUUID()}`;
  const [last] = await db
    .select({ seq: max(agentMessages.seq) })
    .from(agentMessages)
    .where(eq(agentMessages.taskId, taskId));
  await db.insert(agentMessages).values({
    taskId,
    seq: (last?.seq ?? 0) + 1,
    kind: 'tool_result',
    callId,
    finishedAt: at,
    content: {
      callId,
      tool: 'search_logs',
      server: LOGS_SERVER,
      args: { ...LOG_QUERY, service },
      outcome: 'empty',
      refusalReason: null,
      refusalDetail: null,
      text: '',
      startedAt: at.toISOString(),
      finishedAt: at.toISOString(),
    },
  });
}

/** The data of an envelope as written, before `envelope` escaped it. */
function unescapeData(text: string): string {
  return text
    .replaceAll('&quot;', '"')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');
}

function serviceOf(args: string): string {
  const parsed: unknown = JSON.parse(args);
  return typeof parsed === 'object' && parsed !== null && 'service' in parsed
    ? String(parsed.service)
    : '-';
}

/** Orders values by their text, for comparing sets whose order the run does not fix. */
function byText(a: unknown, b: unknown): number {
  return String(a).localeCompare(String(b));
}

/**
 * The tool calls an extraction call received in its input, in input order (`c1`, `c2`, …), as
 * `<server>/<tool> <outcome> <service>` — the service is what tells the tests' calls apart.
 */
function roundCallsOf(call: RecordedModelCall | undefined): string[] {
  const first = call?.messages[0];
  if (first === undefined || first.role !== 'user') return [];
  const heads = unescapeData(first.content).matchAll(
    /^c\d+ server=(\S+) tool=(\S+) outcome=(\S+)\nargs: (.*)$/gm,
  );
  return [...heads].map(
    ([, server, tool, outcome, args]) =>
      `${server ?? ''}/${tool ?? ''} ${outcome ?? ''} ${serviceOf(args ?? '{}')}`,
  );
}

/**
 * The record lines of the knowledge block in a call's system text, sorted; `null` — no block. The block is the
 * rule line and, right under it, the data envelope (`knowledgeText`).
 */
function knowledgeLinesOf(
  call: RecordedModelCall | undefined,
): string[] | null {
  const instructions = call?.instructions ?? '';
  const head = `${KNOWLEDGE_RULE}\n${KNOWLEDGE_ENVELOPE}\n`;
  const start = instructions.indexOf(head);
  if (start === -1) return null;
  const body = instructions.slice(start + head.length);
  return body.slice(0, body.indexOf('\n</data>')).split('\n').sort();
}

/**
 * The run's extraction tasks once each is `completed`: the step's own commit sets the status after the round's
 * guarded transaction that `waitForRound` sees.
 */
function completedExtractsOf(
  db: Database,
  runId: string,
): Promise<KnowledgeTask[]> {
  return waitFor(
    () => knowledgeTasksOf(db, { runId }),
    (tasks) =>
      tasks.length > 0 && tasks.every((task) => task.status === 'completed'),
    `the extraction tasks of run ${runId} to complete`,
  );
}

/** The fields of the first log record `message` about task `taskId`, once it is there. */
async function logFieldsOf(
  harness: AgentsHarness,
  message: string,
  taskId: string,
): Promise<LogFields> {
  const found = await waitFor(
    () =>
      harness.logs.find(
        (record) =>
          record.message === message && record.fields.taskId === taskId,
      ),
    (record) => record !== undefined,
    `the log "${message}" of task ${taskId}`,
  );
  return found?.fields ?? {};
}

/** The fields of the trigger's first decision on an end event of `taskId` (`knowledge trigger decided`). */
function triggerDecisionOf(
  harness: AgentsHarness,
  taskId: string,
): Promise<LogFields> {
  return logFieldsOf(harness, 'knowledge trigger decided', taskId);
}

/** A run row's last round as a literal tuple: status, reason, counts, model and the "extracted up to" mark. */
function outcomeOf(round: KnowledgeRun): unknown[] {
  return [
    round.lastStatus,
    round.lastReason,
    round.lastAdded,
    round.lastConfirmed,
    round.lastOutdated,
    round.lastModel,
    round.extractedUpTo,
  ];
}

/**
 * Continues a run with a turn of its deep agent that makes no call and waits for the round of its new end,
 * written after `after`: a round whose mark did not move reads the run's calls again.
 */
async function roundAfterTurn(
  harness: AgentsHarness,
  turn: {
    readonly ownerId: string;
    readonly runId: string;
    readonly text: string;
  },
  after: KnowledgeRun,
): Promise<KnowledgeRun> {
  await harness.sessions.send({
    agentId: turn.runId,
    ownerId: turn.ownerId,
    text: turn.text,
  });
  return waitForRound(harness.db, turn.runId, after.lastAt);
}

/** The author deletes the deep agent: its `app.library_records` row goes, and every key to it cascades. */
async function deleteLibraryRow(db: Database, recordId: string): Promise<void> {
  await db.delete(libraryRecords).where(eq(libraryRecords.id, recordId));
}

/** What the graph tables and the vector store keep of a deep agent. */
async function knowledgeLeftOf(db: Database, recordId: string) {
  const graph = await readGraph(db, recordId);
  return {
    entities: graph.entities.length,
    relations: graph.relations.length,
    vectors: await createPgvectorStore(db).list(recordId),
    embeddingRow: await findEmbeddingRow(db, recordId),
  };
}

const NOTHING_LEFT = {
  entities: 0,
  relations: 0,
  vectors: [],
  embeddingRow: undefined,
};

/**
 * What would show a broken step or a broken delivery of the round's task: an error record of the task, its guarded
 * commit rolled back, or a failed or parked delivery of the knowledge trigger.
 */
function troublesOf(harness: AgentsHarness, taskId: string): string[] {
  return harness.logs
    .filter(
      (record) =>
        (record.fields.taskId === taskId &&
          (record.level === 'error' ||
            record.message === 'guard rolled back')) ||
        (record.fields.consumer === KNOWLEDGE_TRIGGER &&
          (record.message === 'delivery failed' ||
            record.message === 'delivery needs attention')),
    )
    .map((record) => `${record.level} ${record.message}`);
}

/** The consumer that creates and closes the knowledge tasks (`knowledge-trigger.ts`). */
const KNOWLEDGE_TRIGGER = 'agents.knowledge-trigger';

/** A spent monthly quota as the access gate refuses it (INT-6 row A). */
const QUOTA_SPENT = {
  kind: 'refused',
  reason: 'quota_exhausted',
  spentUsd: 20,
  quotaUsd: 20,
  month: '2026-11',
} as const;

/** An obviously fake secret value the process remembers as the logger's settings would (INT-7). */
const FAKE_SECRET = 'int7-fake-secret-value-0000';

/** An entity id no graph of the tests reaches: the largest identity value. */
const UNKNOWN_ENTITY_ID = 'e2147483647';

/** The catalogue id of an embedding model of the harness. */
function embeddingModelOf(verdict: EmbeddingVerdict): string {
  if (verdict.kind !== 'allowed')
    throw new Error('Not an allowed embedding model');
  return verdict.model;
}

const MODEL_A = embeddingModelOf(TEST_EMBEDDING_MODEL_A);
const MODEL_B = embeddingModelOf(TEST_EMBEDDING_MODEL_B);

/** The extraction answer that records nothing: the round is `done` with zero counts and its end queues a pass. */
const RECORDS_NOTHING: ScriptedAnswer = { calls: [recordKnowledge([])] };

/** `AGENT_COMPACT_AT_TOKENS` of the compacting cases: far above the default usage of a scripted answer. */
const COMPACT_AT_TOKENS = 5_000;
const COMPACTING = { AGENT_COMPACT_AT_TOKENS: String(COMPACT_AT_TOKENS) };

/** The start of the request that ends a compaction call's input (`compaction-step.ts`). */
const COMPACTION_REQUEST_START = 'The conversation above is getting too long.';

/**
 * A scout of three calls, each held on its latch when given: the model step that searches the logs and reports
 * input tokens at the compaction threshold, the compaction step, and the model step after it that reports. Keyed
 * by the subagent's name: after the compaction the scout no longer sees its task.
 */
function compactingScoutScript(
  model: ScriptedModel,
  assignment: string,
  holds: { readonly compaction?: Latch; readonly report?: Latch } = {},
): Script {
  const held = (latch: Latch | undefined) =>
    latch === undefined ? {} : { latch };
  return model.script({ agent: SCOUT.name }, [
    {
      calls: [searchLogs('billing-api')],
      usage: { inputTokens: COMPACT_AT_TOKENS },
    },
    { text: `Summary of: ${assignment}`, ...held(holds.compaction) },
    { text: reportOf(assignment), ...held(holds.report) },
  ]);
}

/** The text of the last message of a call's input when the employee's side said it. */
function lastUserText(call: RecordedModelCall | undefined): string | null {
  const last = call?.messages.at(-1);
  return last?.role === 'user' ? last.content : null;
}

/** An entity whose step line `name: description` is `tokens` tokens long: four ASCII bytes a token, dots pad the description. */
function entityOfTokens(name: string, about: string, tokens: number) {
  return {
    name,
    description: about.padEnd(tokens * 4 - `${name}: `.length, '.'),
  } as const;
}

function lineOf(entity: {
  readonly name: string;
  readonly description: string;
}): string {
  return `${entity.name}: ${entity.description}`;
}

/*
 * The graph over the size cap of INT-8 and INT-10 .. INT-12, the cap at `KNOWLEDGE_LIMIT_TOKENS_MIN` (1 000 tokens, half 500): four
 * archives of 250 tokens confirmed three times fill the common order exactly; the billing entity (300), its fact (12) and the refunds
 * entity (300), confirmed once, reach a step only by closeness to its question. Billing and its fact take 312 of the half, the next
 * record does not fit, and the rest of the limit takes two archives; refunds alone takes 300, the next record does not fit.
 */
function archiveOf(n: number) {
  return entityOfTokens(
    `archive-${n}`,
    `the archive ${n} of old payment records`,
    250,
  );
}
const ARCHIVE_1 = archiveOf(1);
const ARCHIVE_2 = archiveOf(2);
const ARCHIVES = [ARCHIVE_1, ARCHIVE_2, archiveOf(3), archiveOf(4)];
const BILLING = entityOfTokens(
  'billing-api',
  'the billing service of the shop',
  300,
);
const REFUNDS = entityOfTokens(
  'refunds-api',
  'the refunds service of the shop',
  300,
);
const FACT_LABEL = 'posts invoices to';
const FACT_LINE = `${BILLING.name} — ${FACT_LABEL} — ${ARCHIVE_1.name}`;

/** The block of a step without closeness pairs: the common order over the whole limit. */
const COMMON_BLOCK = ARCHIVES.map(lineOf).sort();
/** The block of a step whose question is about billing. */
const BILLING_BLOCK = [
  lineOf(ARCHIVE_1),
  lineOf(ARCHIVE_2),
  lineOf(BILLING),
  FACT_LINE,
].sort();
/** The block of a step whose question is about refunds. */
const REFUNDS_BLOCK = [
  lineOf(ARCHIVE_1),
  lineOf(ARCHIVE_2),
  lineOf(REFUNDS),
].sort();

/** The records of the graph over the cap that may be seeded with a vector of model A. */
type OverLimitRecord = 'archives' | 'billing' | 'fact' | 'refunds';

/**
 * Model A's vectors (3 dimensions, unit length): billing and refunds orthogonal, the archives apart from both, the
 * fact near billing and away from refunds.
 */
const OVER_LIMIT_VECTORS: Readonly<Record<OverLimitRecord, readonly number[]>> =
  {
    archives: [0, 0, 1],
    billing: [1, 0, 0],
    fact: [0.6, -0.8, 0],
    refunds: [0, 1, 0],
  };

const topicsOfModelA = vectorsByTopic(
  [
    ['billing', OVER_LIMIT_VECTORS.billing],
    ['refund', OVER_LIMIT_VECTORS.refunds],
  ],
  OVER_LIMIT_VECTORS.archives,
);
const topicsOfModelB = vectorsByTopic(
  [
    ['billing', [1, 0, 0, 0]],
    ['refund', [0, 1, 0, 0]],
  ],
  [0, 0, 0, 1],
);

/** `ScriptedEmbeddings.vectorOf` of these cases: a text about billing or refunds is close to that topic, on either model. */
function topicVector(text: string, model: string): readonly number[] {
  return model === MODEL_B ? topicsOfModelB(text) : topicsOfModelA(text);
}

interface OverLimitGraph {
  readonly archives: readonly SeededItem[];
  readonly billing: SeededItem;
  readonly fact: SeededItem;
  readonly refunds: SeededItem;
}

/** Seeds the graph over the cap into `recordId`, the records named in `withVectors` with their vectors of model A. */
async function seedOverLimit(
  db: Database,
  recordId: string,
  withVectors: readonly OverLimitRecord[],
): Promise<OverLimitGraph> {
  const vectorOf = (record: OverLimitRecord) =>
    withVectors.includes(record)
      ? { vector: { model: MODEL_A, values: OVER_LIMIT_VECTORS[record] } }
      : {};
  const archives = ARCHIVES.map((archive, index): SeedItem => ({
    kind: 'entity',
    ref: archive.name,
    ...archive,
    confirmations: 3,
    // Newer first in the common order: archive-1 is the newest.
    confirmedAt: new Date(Date.UTC(2026, 9, 4 - index)),
    ...vectorOf('archives'),
  }));
  const seeded = await seedGraph(db, recordId, [
    ...archives,
    {
      kind: 'entity',
      ref: 'billing',
      ...BILLING,
      confirmedAt: new Date('2026-09-02T00:00:00.000Z'),
      ...vectorOf('billing'),
    },
    {
      kind: 'entity',
      ref: 'refunds',
      ...REFUNDS,
      confirmedAt: new Date('2026-09-01T00:00:00.000Z'),
      ...vectorOf('refunds'),
    },
    {
      kind: 'fact',
      from: 'billing',
      to: ARCHIVE_1.name,
      label: FACT_LABEL,
      confirmedAt: new Date('2026-09-03T00:00:00.000Z'),
      ...vectorOf('fact'),
    },
  ]);
  const [billing, refunds, fact] = seeded.slice(archives.length);
  if (billing === undefined || refunds === undefined || fact === undefined)
    throw new Error('The graph was not seeded');
  return { archives: seeded.slice(0, archives.length), billing, fact, refunds };
}

/** The distinct knowledge blocks of the calls (`knowledgeLinesOf`), in the order first seen. */
function distinctBlocks(
  calls: readonly RecordedModelCall[],
): (string[] | null)[] {
  const blocks = new Map<string, string[] | null>();
  for (const call of calls) {
    const lines = knowledgeLinesOf(call);
    blocks.set(JSON.stringify(lines), lines);
  }
  return [...blocks.values()];
}

/** A call's system text with its knowledge block cut out: what `withStepBlocks` gives without a knowledge block. */
function withoutKnowledge(instructions: string): string {
  const start = instructions.indexOf(`\n\n${KNOWLEDGE_RULE}\n`);
  if (start === -1) return instructions;
  const end = instructions.indexOf('\n</data>', start) + '\n</data>'.length;
  return instructions.slice(0, start) + instructions.slice(end);
}

/** The store keys of a graph's records. */
function graphKeysOf(graph: KnowledgeGraph): string[] {
  return [
    ...graph.entities.map((entity) =>
      knowledgeKey({ type: 'entity', id: entity.id }),
    ),
    ...graph.relations.map((relation) =>
      knowledgeKey({ type: 'relation', id: relation.id }),
    ),
  ];
}

/** The store's entries of the deep agent's collection as `<key> <model>`, sorted. */
async function vectorLinesOf(
  db: Database,
  recordId: string,
): Promise<string[]> {
  return (await createPgvectorStore(db).list(recordId))
    .map((entry) => `${entry.key} ${entry.model}`)
    .sort();
}

/** `<key> <model>` of each record of the graph on one model, sorted: what `vectorLinesOf` gives after a full pass. */
function everyKeyOn(graph: KnowledgeGraph, model: string): string[] {
  return graphKeysOf(graph)
    .map((key) => `${key} ${model}`)
    .sort();
}

/** The `placement` of each record of the view as `<key> <placement>`, sorted. */
function placementsOf(view: KnowledgeView): string[] {
  return view.items
    .map((item) => `${knowledgeKey(item)} ${String(item.placement)}`)
    .sort();
}

/** The embeddings double's provider requests of one input type, in order of arrival. */
function embeddingRequestsOf(
  harness: AgentsHarness,
  inputType: 'query' | 'document',
) {
  return harness.embeddings.calls.filter(
    (call) => call.inputType === inputType,
  );
}

/** The ledger rows of the embedding models of an owner's task as `<model> <input tokens>`. */
async function embeddingSpendOf(
  db: Database,
  ownerId: string,
  taskId: string,
): Promise<string[]> {
  return (await ledgerRowsOf(db, ownerId, taskId))
    .filter((row) => row.model === MODEL_A || row.model === MODEL_B)
    .map((row) => `${row.model} ${row.inputTokens}`);
}

describe('self-learning / core - integration (real Postgres, scripted model)', () => {
  let database: DatabaseConnection;

  beforeAll(() => {
    database = createDatabase({ connectionString: databaseUrl(), poolMax: 2 });
  });

  afterAll(async () => {
    await database.close();
  });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-1: the main path - a learning run ends, the graph fills, the next run's prompt carries it
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-01.1 "новый и любой ранее сохранённый workflow читается с выключенным флажком, пока его не включат"; AC-03.1 "Given запуск с
  //   самообучением закончился сбоем, when извлечение выполнено, then граф содержит записи из вызовов инструментов этого запуска";
  //   AC-08.1 (extraction half: "в месячном расходе запускающего видны стоимость извлечения ..."; the embeddings half is INT-12 / INT-11); AC-08.3 "координатор работал на модели A, автор сменил её на B,
  //   извлечение выполнено на модели A"; AC-15.1 "в графе есть урок с инструментом `logs.search`, видом вопроса, подсказкой и исходом";
  //   AC-15.2 "в графе есть запись «искал — не нашёл»"; AC-07.3 "текст, сформулированный как приказ, стоит внутри блока, помеченного как данные";
  //   NFR-01 "начало извлечения каждого запуска позже его конца". Design: UC-1.
  // Behavior: the subagent calls `search_logs` (`success`, service `payment-api`) -> the deep agent ends (row 1) or fails (row 2) ->
  //   `knowledge-trigger` creates one `knowledge.extract` task in the delivery transaction -> the round calls model A with
  //   `record_knowledge` -> the commit writes two entities, a fact, a lesson and a "searched, found nothing" item -> the next run's model
  //   steps (deep agent and subagent) carry them inside the data envelope under the "a hint, verify every claim by a call in this run"
  //   rule. The graph is below the limit, so the two-pass selection takes all of it in the common order and no embedding model is needed
  //   (INT-10 owns the no-embeddings path, INT-8 the over-the-limit path).
  //   As built: the MCP fixture answers every call with a structured result, so no real call is `empty`; the `empty` call a "searched,
  //   found nothing" item needs (DC-11) is written into the finished subagent's audit (`writeEmptyCall`) before the deep agent ends.
  // Verification items:
  //   - rows: (1) the run completes; (2) the run fails; in both the graph holds the items and the run's final state is untouched
  //   - the author switched the deep agent to model B after the start: the extraction call, the run row and the ledger row name A
  //   - while the round's model call is held, the run is already `completed` with its answer in its history and the extraction task was
  //     created at or after the run's `finished_at` (NFR-01); after the round the status and the history are the same
  //   - the token ledger row of the round's task is the starter's (model A, the call's tokens and cost); none of the author, none of the
  //     platform. The monthly spend is the sum of these rows by owner (`runtime.ledger.monthSpend`), so the row is the rise
  //   - the next run's deep agent and subagent system text carry the five items inside the envelope and the standing rule right above it
  //   - the same deep agent with the flag switched off: its next run gets no run row, no extraction task (the trigger ignores its end as
  //     `not_learning`) and no block, although the graph is there
  // Catches: an extraction that bills the author or nobody instead of the starter, runs on the model the author switched to, runs before the
  //   run's end is visible, or leaves a graph the next run never receives (or receives outside the data envelope, as an instruction).
  // @category: core-functionality
  // @dependency: knowledge-trigger, runtime tasks, ModelClient, token ledger, step prompt (modelStep), Postgres
  // @complexity: high
  it(
    'INT-1: a finished or failed learning run is extracted on the model of its start, billed to the starter, and the next run gets the items in the data envelope',
    async () => {
      // Given: a learning deep agent with the scout team (row 1) and a second one whose run will fail (row 2)
      const recordId = randomUUID();
      const failingId = randomUUID();
      const library = createLibraryDouble();
      library.add(learningDeepAgent(recordId, [SCOUT]));
      library.add(learningDeepAgent(failingId, [SCOUT]));
      const starter = newUser();
      const failingStarter = newUser();
      const endHeld = createLatch();
      const roundHeld = createLatch();
      const model = createScriptedModel();
      const extraction = model.script({ agent: KNOWLEDGE_EXTRACT_AGENT }, [
        { calls: [recordKnowledge(LEARNED)], latch: roundHeld },
        { calls: [recordKnowledge([lessonOf('ledger')])] },
      ]);
      scoutScript(model, 'Scout learning run 1', ['payment-api']);
      const nextScout = scoutScript(model, 'Scout learning run 2', []);
      scoutScript(model, 'Scout failing run', ['ledger']);

      await withLibraryRow(database.db, recordId, () =>
        withLibraryRow(database.db, failingId, async () => {
          const harness = await learningHarness(model, library);
          try {
            // When (row 1): the run's scout searches the logs; the deep agent's answer is held
            const run = await startLearningRun(harness, model, {
              ownerId: starter,
              recordId,
              turns: [
                {
                  text: 'Coordinate learning run 1',
                  scout: 'Scout learning run 1',
                  answer: { text: 'Answer of learning run 1', latch: endHeld },
                },
              ],
            });
            const scoutId = await startedChild(harness, run.deepAgentId);
            await endHeld.reached();
            // When: the author switches the deep agent to model B mid-run; the finished scout gets its `empty` call
            const content = learningContent(recordId);
            const switched = { ...content, model: TEST_MODEL_CHOSEN };
            library.edit(recordId, {
              body: { kind: 'deep_agent', content: switched },
            });
            await writeEmptyCall(database.db, scoutId, 'checkout-web');
            endHeld.open();

            // Then (NFR-01): when the round's model call arrives, the run has ended with its answer, and its one
            // extraction task, the starter's, was created at or after the end
            await roundHeld.reached();
            const ended = await harness.runtime.tasks.get(
              run.deepAgentId,
              starter,
            );
            const historyAtRound = historyLines(
              await historyOf(harness, run.deepAgentId, starter),
            );
            const [extract, ...moreExtracts] = await knowledgeTasksOf(
              database.db,
              { runId: run.deepAgentId },
            );
            if (extract === undefined || ended.finishedAt === null)
              throw new Error('no extraction task or no end');
            expect(ended.status).toBe('completed');
            expect(historyAtRound).toContain(
              'model_answer: Answer of learning run 1 []',
            );
            expect(moreExtracts).toEqual([]);
            expect(extract.ownerId).toBe(starter);
            expect(extract.createdAt.getTime()).toBeGreaterThanOrEqual(
              ended.finishedAt.getTime(),
            );

            roundHeld.open();
            const round = await waitForRound(database.db, run.deepAgentId);

            // Then: the round read the run's two calls and ran once, on model A of the start
            expect(roundCallsOf(extraction.calls[0])).toEqual([
              `${LOGS_SERVER}/search_logs success payment-api`,
              `${LOGS_SERVER}/search_logs empty checkout-web`,
            ]);
            expect(extraction.calls.map((call) => call.model)).toEqual([
              TEST_MODEL_DEFAULT,
            ]);
            expect([
              round.lastStatus,
              round.lastReason,
              round.lastAdded,
              round.lastConfirmed,
              round.lastOutdated,
              round.lastModel,
              round.lastExtractTaskId,
            ]).toEqual([
              'done',
              null,
              5,
              0,
              0,
              TEST_MODEL_DEFAULT,
              extract.taskId,
            ]);
            // Then (AC-08.1, AC-08.3): billed to the starter on model A: 1 000 input and 100 output tokens at 1 and 5 USD per million
            const billed = await ledgerRowsOf(
              database.db,
              starter,
              extract.taskId,
            );
            expect(
              billed.map(
                (row) => `${row.model} ${row.inputTokens} ${row.costUsd}`,
              ),
            ).toEqual([`${TEST_MODEL_DEFAULT} 1000 0.0015`]);
            expect(await ledgerRowsOf(database.db, TEST_AUTHOR_ID)).toEqual([]);
            expect(
              await ledgerRowsOf(
                database.db,
                PLATFORM_OWNER_ID,
                extract.taskId,
              ),
            ).toEqual([]);
            // Then: the run's final state and its history are as the end left them; its one task completed
            expect(
              (await harness.runtime.tasks.get(run.deepAgentId, starter))
                .status,
            ).toBe('completed');
            expect(
              historyLines(await historyOf(harness, run.deepAgentId, starter)),
            ).toEqual(historyAtRound);
            expect(
              (await completedExtractsOf(database.db, run.deepAgentId)).map(
                (task) => task.taskId,
              ),
            ).toEqual([extract.taskId]);

            // When: the starter runs the deep agent again
            const next = await startLearningRun(harness, model, {
              ownerId: starter,
              recordId,
              turns: [
                {
                  text: 'Coordinate learning run 2',
                  scout: 'Scout learning run 2',
                },
              ],
            });
            await nextScout.called(1);
            await waitForTaskStatus(
              harness,
              next.deepAgentId,
              starter,
              'completed',
            );

            // Then (AC-01.1, AC-15.1, AC-15.2, AC-07.3): the deep agent, now on model B, and the scout carry the five items
            // inside the data envelope, the rule right above it; the scout's prompt comes first
            expect(next.deepAgent.calls[0]?.model).toBe(TEST_MODEL_CHOSEN);
            expect(knowledgeLinesOf(next.deepAgent.calls[0])).toEqual(
              LEARNED_LINES,
            );
            expect(knowledgeLinesOf(nextScout.calls[0])).toEqual(LEARNED_LINES);
            expect(
              nextScout.calls[0]?.instructions.startsWith(
                `${SCOUT_PROMPT}\n\n${KNOWLEDGE_RULE}\n${KNOWLEDGE_ENVELOPE}\n`,
              ),
            ).toBe(true);

            // When: the author switches the flag off and the starter runs the deep agent once more
            library.edit(recordId, {
              body: {
                kind: 'deep_agent',
                content: { ...switched, selfLearning: false },
              },
            });
            const unlearned = await startLearningRun(harness, model, {
              ownerId: starter,
              recordId,
              turns: [{ text: 'Coordinate learning run 3', scout: null }],
            });
            await waitForTaskStatus(
              harness,
              unlearned.deepAgentId,
              starter,
              'completed',
            );

            // Then: the run has no row, its end creates no task, and its steps get no block although the graph is there
            const decided = await triggerDecisionOf(
              harness,
              unlearned.deepAgentId,
            );
            expect([decided.decision, decided.reason]).toEqual([
              'ignore',
              'not_learning',
            ]);
            expect(
              await findRunById(database.db, unlearned.deepAgentId),
            ).toBeUndefined();
            expect(
              await knowledgeTasksOf(database.db, {
                runId: unlearned.deepAgentId,
              }),
            ).toEqual([]);
            expect(unlearned.deepAgent.calls[0]?.instructions).not.toContain(
              KNOWLEDGE_RULE,
            );

            // When (row 2): a run of the second deep agent fails at its deep agent's last call
            const failing = await startLearningRun(harness, model, {
              ownerId: failingStarter,
              recordId: failingId,
              turns: [
                {
                  text: 'Coordinate failing run',
                  scout: 'Scout failing run',
                  answer: modelError(400),
                },
              ],
            });
            const failedRound = await waitForRound(
              database.db,
              failing.deepAgentId,
            );

            // Then (AC-03.1): the failed run is extracted on model A, its lesson is in its graph, and it stays failed
            expect(roundCallsOf(extraction.calls[1])).toEqual([
              `${LOGS_SERVER}/search_logs success ledger`,
            ]);
            expect(extraction.calls.map((call) => call.model)).toEqual([
              TEST_MODEL_DEFAULT,
              TEST_MODEL_DEFAULT,
            ]);
            expect([
              failedRound.lastStatus,
              failedRound.lastAdded,
              failedRound.lastModel,
            ]).toEqual(['done', 1, TEST_MODEL_DEFAULT]);
            expect(
              (await readGraph(database.db, failingId)).relations.map(
                (row) => `${row.kind} ${row.question}`,
              ),
            ).toEqual(['lesson errors of ledger']);
            expect(
              (
                await harness.runtime.tasks.get(
                  failing.deepAgentId,
                  failingStarter,
                )
              ).status,
            ).toBe('failed');
          } finally {
            endHeld.open();
            roundHeld.open();
            await closeAll([harness]);
          }
        }),
      );
    },
    TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2: a user stop is never extracted, not even after the run is continued
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-03.2 "Given сотрудник остановил запуск, then граф не меняется". Design: UC-E1, DC-3, KD-3 (`task.stopped` only writes the state
  //   and moves the mark), Invariant 2.
  // Behavior: the user stops a run that made calls -> no extraction task, graph unchanged, `lastExtraction` = skipped / `stopped`, the
  //   "extracted up to" mark moves to the stop moment -> the user continues, the run ends with no new calls -> the round gets none of the
  //   stopped segment's calls.
  // Rows:
  //   A. stop while no round is in flight (the scout held after its call): the trigger decides `stopped`, no extraction task, no model call,
  //      `lastExtraction` = skipped / `stopped`, graph unchanged. Then continue, a new scout makes one new call and the run finishes: the one
  //      extraction call's input holds only that new call, none of the stopped stretch (as built, the continuation makes a call so the
  //      input is observable; an end with no new calls is INT-3 row B).
  //   B. stop while a round of an earlier end is in flight (latched model call) and the continued run's new call is done: the stop keeps
  //      the round's task on the row and writes skipped / `stopped`; the round then commits its operations and writes its own `done` over
  //      it (it is later), with its own task as the last one, the mark stays at the stop moment (not moved back to the round's read), and
  //      the run has one extraction task.
  // Catches: the stopped segment's tool calls (possibly wrong or half-done work the user cancelled) written into the graph shared by all
  //   employees as soon as the run is continued, or the late round dragging the mark back so the same calls are extracted twice.
  // @category: edge-case
  // @dependency: knowledge-trigger, knowledge-runs row, runtime tasks, ModelClient (scripted), Postgres
  // @complexity: high
  it(
    'INT-2: a stopped run produces no extraction, and calls of the stopped segment are never extracted after the run is continued',
    async () => {
      // Given: two learning deep agents, one per row, run by the same employee
      const idleId = randomUUID();
      const inFlightId = randomUUID();
      const library = createLibraryDouble();
      library.add(learningDeepAgent(idleId, [SCOUT]));
      library.add(learningDeepAgent(inFlightId, [SCOUT]));
      const starter = newUser();
      const scoutHeld = createLatch();
      const roundHeld = createLatch();
      const continuedScoutHeld = createLatch();
      const model = createScriptedModel();
      const extraction = model.script({ agent: KNOWLEDGE_EXTRACT_AGENT }, [
        { calls: [recordKnowledge([lessonOf('fraud-check')])] },
        {
          calls: [recordKnowledge([lessonOf('payment-api')])],
          latch: roundHeld,
        },
      ]);
      scoutScript(model, 'Scout before the stop', ['ledger'], scoutHeld);
      scoutScript(model, 'Scout after the stop', ['fraud-check']);
      scoutScript(model, 'Scout of the round in flight', ['payment-api']);
      scoutScript(
        model,
        'Scout stopped during the round',
        ['provider-adapter'],
        continuedScoutHeld,
      );

      await withLibraryRow(database.db, idleId, () =>
        withLibraryRow(database.db, inFlightId, async () => {
          const harness = await learningHarness(model, library);
          try {
            // When (row A): the scout has searched `ledger` and is held; the employee stops the run
            const idle = await startLearningRun(harness, model, {
              ownerId: starter,
              recordId: idleId,
              turns: [
                {
                  text: 'Coordinate the run stopped while idle',
                  scout: 'Scout before the stop',
                },
                {
                  text: 'Carry on after the stop',
                  scout: 'Scout after the stop',
                },
              ],
            });
            await scoutHeld.reached();
            await harness.sessions.stop({
              agentId: idle.deepAgentId,
              ownerId: starter,
            });
            const stopped = await waitForRound(database.db, idle.deepAgentId);

            // Then: the stop is written as skipped / `stopped` with the mark at the stop; no task, no model call, no graph
            expect(
              (await triggerDecisionOf(harness, idle.deepAgentId)).decision,
            ).toBe('stopped');
            expect([
              stopped.lastStatus,
              stopped.lastReason,
              stopped.extractTaskId,
            ]).toEqual(['skipped', 'stopped', null]);
            expect(stopped.extractedUpTo).not.toBeNull();
            expect(
              await knowledgeTasksOf(database.db, { runId: idle.deepAgentId }),
            ).toEqual([]);
            expect(extraction.calls).toHaveLength(0);
            const graphAfterStop = await readGraph(database.db, idleId);
            expect([
              graphAfterStop.entities.length,
              graphAfterStop.relations.length,
            ]).toEqual([0, 0]);

            // When: the employee continues the run; a new scout searches `fraud-check` and the run finishes
            await harness.sessions.send({
              agentId: idle.deepAgentId,
              ownerId: starter,
              text: 'Carry on after the stop',
            });
            const resumed = await waitForRound(
              database.db,
              idle.deepAgentId,
              stopped.lastAt,
            );

            // Then (AC-03.2, DC-3): the round's input holds the new call only, never the stopped stretch's `ledger` call
            expect(roundCallsOf(extraction.calls[0])).toEqual([
              `${LOGS_SERVER}/search_logs success fraud-check`,
            ]);
            expect([resumed.lastStatus, resumed.lastAdded]).toEqual([
              'done',
              1,
            ]);
            expect(resumed.extractedUpTo?.getTime()).toBeGreaterThan(
              stopped.extractedUpTo?.getTime() ?? Infinity,
            );
            expect(
              await knowledgeTasksOf(database.db, { runId: idle.deepAgentId }),
            ).toHaveLength(1);

            // When (row B): a run ends after a `payment-api` search and its round's model call is held; the employee
            // continues it, its new scout searches `provider-adapter` and is held; the employee stops the run
            const inFlight = await startLearningRun(harness, model, {
              ownerId: starter,
              recordId: inFlightId,
              turns: [
                {
                  text: 'Coordinate the run stopped during its round',
                  scout: 'Scout of the round in flight',
                },
                {
                  text: 'Carry on while the round runs',
                  scout: 'Scout stopped during the round',
                },
              ],
            });
            await roundHeld.reached();
            const [roundTask] = await knowledgeTasksOf(database.db, {
              runId: inFlight.deepAgentId,
            });
            if (roundTask === undefined)
              throw new Error('the run of row B has no extraction task');
            await harness.sessions.send({
              agentId: inFlight.deepAgentId,
              ownerId: starter,
              text: 'Carry on while the round runs',
            });
            await continuedScoutHeld.reached();
            await harness.sessions.stop({
              agentId: inFlight.deepAgentId,
              ownerId: starter,
            });
            const stoppedMidRound = await waitFor(
              () => findRunById(database.db, inFlight.deepAgentId),
              (row) => row?.lastReason === 'stopped',
              'the stop of the run of row B to be written',
            );
            if (stoppedMidRound === undefined)
              throw new Error('the run row of row B is gone');

            // Then: the stop keeps the round's task on the row and creates none
            expect([
              stoppedMidRound.lastStatus,
              stoppedMidRound.extractTaskId,
            ]).toEqual(['skipped', roundTask.taskId]);

            // When: the round's model answers
            roundHeld.open();
            const late = await waitForRound(
              database.db,
              inFlight.deepAgentId,
              stoppedMidRound.lastAt,
            );

            // Then (Invariant 2): the round writes its own outcome over the stop, the mark stays at the stop, and the
            // stopped stretch's `provider-adapter` call was never in a round
            expect([
              late.lastStatus,
              late.lastReason,
              late.lastAdded,
              late.lastExtractTaskId,
            ]).toEqual(['done', null, 1, roundTask.taskId]);
            expect(late.extractedUpTo?.getTime()).toBe(
              stoppedMidRound.extractedUpTo?.getTime(),
            );
            expect(roundCallsOf(extraction.calls[1])).toEqual([
              `${LOGS_SERVER}/search_logs success payment-api`,
            ]);
            expect(extraction.calls).toHaveLength(2);
            expect(
              (
                await knowledgeTasksOf(database.db, {
                  runId: inFlight.deepAgentId,
                })
              ).map((task) => task.taskId),
            ).toEqual([roundTask.taskId]);
          } finally {
            scoutHeld.open();
            roundHeld.open();
            continuedScoutHeld.open();
            await closeAll([harness]);
          }
        }),
      );
    },
    TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-3: a revived run that ends again - one task at a time, only new calls, nothing extracted twice
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-03.3 "Given запуск завершился, его извлечение выполнено, и сотрудник продолжил запуск сообщением, when запуск снова завершается,
  //   then извлечение получает только вызовы инструментов после прошлого извлечения". Design: UC-4, DC-4, DC-5, KD-3, Invariants 1 and 3.
  // Behavior: the run ended with three calls and its round is done -> the employee continues the deep agent, two new calls, it ends
  //   while the first round is still waiting on the model (latch) -> the consumer only sets "needs another round" -> the first round's commit
  //   sees the mark and continues the same task with a second round.
  // Rows:
  //   A. second end arrives while a round is in flight: the trigger only sets "needs another round" on the row that names the one task;
  //      one `knowledge.extract` task for the run throughout (never two in flight), the first round's input holds the three first calls,
  //      the second round's input only the two new calls (no call in two rounds), the second round's `done` names the same task.
  //   B. a run ends again with no new calls: a new task (the first is completed), `lastExtraction` = done with zeros, no model call and
  //      no ledger row for that task.
  // Catches: two extraction tasks of one run writing in parallel, a revived run re-extracting its first three calls (duplicate knowledge and a
  //   second bill), or an end without new calls spending a model call.
  // @category: core-functionality
  // @dependency: knowledge-trigger, knowledge.extract handler, runtime tasks, ModelClient (scripted, latch), Postgres
  // @complexity: high
  it(
    'INT-3: a run revived and ended again gets one extraction task at a time and each round reads only the calls after the previous round',
    async () => {
      // Given: a learning deep agent; the first round's model call will be held
      const recordId = randomUUID();
      const library = createLibraryDouble();
      library.add(learningDeepAgent(recordId, [SCOUT]));
      const starter = newUser();
      const firstHeld = createLatch();
      const model = createScriptedModel();
      const extraction = model.script({ agent: KNOWLEDGE_EXTRACT_AGENT }, [
        {
          calls: [recordKnowledge([lessonOf('checkout-web')])],
          latch: firstHeld,
        },
        { calls: [recordKnowledge([lessonOf('fraud-check')])] },
      ]);
      scoutScript(model, 'Scout three services', [
        'checkout-web',
        'payment-api',
        'ledger',
      ]);
      scoutScript(model, 'Scout two more services', [
        'fraud-check',
        'provider-adapter',
      ]);

      await withLibraryRow(database.db, recordId, async () => {
        const harness = await learningHarness(model, library);
        try {
          // When (row A): the run ends after three searches and its round's model call is held
          const run = await startLearningRun(harness, model, {
            ownerId: starter,
            recordId,
            turns: [
              {
                text: 'Coordinate the revived run',
                scout: 'Scout three services',
              },
              {
                text: 'Look at two more services',
                scout: 'Scout two more services',
              },
              { text: 'Wrap up without new searches', scout: null },
            ],
          });
          await firstHeld.reached();
          const [task] = await knowledgeTasksOf(database.db, {
            runId: run.deepAgentId,
          });
          if (task === undefined)
            throw new Error('the run has no extraction task');

          // When: the employee continues the run, a new scout searches two more services, and the run ends again
          await harness.sessions.send({
            agentId: run.deepAgentId,
            ownerId: starter,
            text: 'Look at two more services',
          });
          const marked = await waitFor(
            () => findRunById(database.db, run.deepAgentId),
            (row) => row?.needsRound === true,
            'the second end to ask for another round',
          );

          // Then: the second end only marked the row of the task in flight; the run still has that one task
          expect(marked?.extractTaskId).toBe(task.taskId);
          expect(
            (
              await knowledgeTasksOf(database.db, { runId: run.deepAgentId })
            ).map((row) => row.taskId),
          ).toEqual([task.taskId]);

          // When: the first round's model answers
          firstHeld.open();
          const second = await waitForRound(database.db, run.deepAgentId);

          // Then (AC-03.3, DC-4): the same task ran two rounds; the first read the three first calls, the second only the two new ones
          expect(extraction.calls).toHaveLength(2);
          expect(roundCallsOf(extraction.calls[0]).sort()).toEqual([
            `${LOGS_SERVER}/search_logs success checkout-web`,
            `${LOGS_SERVER}/search_logs success ledger`,
            `${LOGS_SERVER}/search_logs success payment-api`,
          ]);
          expect(roundCallsOf(extraction.calls[1]).sort()).toEqual([
            `${LOGS_SERVER}/search_logs success fraud-check`,
            `${LOGS_SERVER}/search_logs success provider-adapter`,
          ]);
          expect([
            second.lastStatus,
            second.lastAdded,
            second.lastExtractTaskId,
          ]).toEqual(['done', 1, task.taskId]);
          expect(
            (await completedExtractsOf(database.db, run.deepAgentId)).map(
              (row) => row.taskId,
            ),
          ).toEqual([task.taskId]);
          expect(
            (await readGraph(database.db, recordId)).relations
              .map((row) => row.question)
              .sort(byText),
          ).toEqual(['errors of checkout-web', 'errors of fraud-check']);

          // When (row B): the employee continues the run and it ends with no new call
          await harness.sessions.send({
            agentId: run.deepAgentId,
            ownerId: starter,
            text: 'Wrap up without new searches',
          });
          const third = await waitForRound(
            database.db,
            run.deepAgentId,
            second.lastAt,
          );

          // Then (DC-5): a new task wrote done with zeros without calling the model or billing anyone
          const tasks = await completedExtractsOf(database.db, run.deepAgentId);
          const [, emptyTask, ...more] = tasks;
          if (emptyTask === undefined)
            throw new Error('the third end created no extraction task');
          expect([tasks[0]?.taskId, more]).toEqual([task.taskId, []]);
          expect([
            third.lastStatus,
            third.lastReason,
            third.lastAdded,
            third.lastConfirmed,
            third.lastOutdated,
            third.lastExtractTaskId,
          ]).toEqual(['done', null, 0, 0, 0, emptyTask.taskId]);
          expect(extraction.calls).toHaveLength(2);
          expect(
            await ledgerRowsOf(database.db, starter, emptyTask.taskId),
          ).toEqual([]);
        } finally {
          firstHeld.open();
          await closeAll([harness]);
        }
      });
    },
    TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-4: the graph write is exactly-once - two concurrent extractions, and a restart mid-round
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-04.4 "Given два запуска одного workflow закончились одновременно, when оба извлечения выполнены, then в графе есть записи
  //   обоих"; NFR-02 "извлечение, прерванное рестартом процесса, выполняется снова, и ни одна операция не применяется дважды".
  //   Design: UC-E6, UC-N1, Invariant 5, KD-4 (`checkOperations` against the graph read again in the commit).
  // Behavior: two runs of one deep agent end together, both answers add different items and the same entity -> both commits run in parallel
  //   -> the graph holds both runs' items and the shared entity once, with two confirmations.
  // Rows:
  //   A. two concurrent rounds (both model calls latched, then released together): each round read its own run's call, records of both,
  //      one entity of the shared name with two confirmations (added by one run, confirmed by the other), the rounds' counts 2 + 0 and
  //      1 + 1, both tasks completed (none failed), no lost operation.
  //   B. as built: the zombie instance's round holds its model call; the second instance starts, requeues the step as a lost one and re-runs it from the
  //      start (its own model call, same input) and commits; the zombie's call then answers and its guarded commit is fenced
  //      (`knowledge round abandoned without writes`). The graph has the run's items once, the ledger has two rows for the round's task.
  //      A step lost AFTER its guarded commit (the re-run finds the row no longer names it: `not_current`) is not reproduced: the harness
  //      does not expose the runtime's crash points.
  // Catches: the lost update or the duplicate entity of two commits that check the graph before either writes (the rule is `checkOperations`
  //   on the graph read inside the commit, not on the graph read before the model call), and a commit that is not atomic across a restart.
  // @category: core-functionality
  // @dependency: knowledge.extract handler, graph repository, checkOperations, runtime recovery (`ZOMBIE_RUNTIME`, a second instance), Postgres
  // @complexity: high
  it(
    'INT-4: two concurrent extractions of one deep agent lose nothing and duplicate nothing, and a restart mid-round applies no operation twice',
    async () => {
      // Given (row A): a learning deep agent two employees run at once; both rounds name the same entity and their model calls are held together
      const recordId = randomUUID();
      const restartId = randomUUID();
      const library = createLibraryDouble();
      library.add(learningDeepAgent(recordId, [SCOUT]));
      library.add(learningDeepAgent(restartId, [SCOUT]));
      const [first, second, restartStarter] = [newUser(), newUser(), newUser()];
      const bothHeld = createLatch();
      const model = createScriptedModel();
      const ledger = {
        op: 'add_entity',
        ref: 'books',
        name: 'ledger',
        description: 'the books of the shop',
        evidence: ['c1'],
      };
      const extraction = model.script({ agent: KNOWLEDGE_EXTRACT_AGENT }, [
        {
          calls: [recordKnowledge([ledger, lessonOf('payment-api')])],
          latch: bothHeld,
        },
        {
          calls: [recordKnowledge([ledger, lessonOf('fraud-check')])],
          latch: bothHeld,
        },
      ]);
      scoutScript(model, 'Scout concurrent run 1', ['payment-api']);
      scoutScript(model, 'Scout concurrent run 2', ['fraud-check']);
      // Given (row B): a second deep agent whose round runs on a zombie instance, its model call held; the re-run answers the same
      const restartHeld = createLatch();
      const restartModel = createScriptedModel();
      const restartOperations: readonly unknown[] = [
        {
          op: 'add_entity',
          ref: 'pay',
          name: 'payment-api',
          description: 'the payment service of the shop',
          evidence: ['c1'],
        },
        lessonOf('checkout-web'),
      ];
      const restartExtraction = restartModel.script(
        { agent: KNOWLEDGE_EXTRACT_AGENT },
        [
          { calls: [recordKnowledge(restartOperations)], latch: restartHeld },
          { calls: [recordKnowledge(restartOperations)] },
        ],
      );
      scoutScript(restartModel, 'Scout the restarted run', ['checkout-web']);

      await withLibraryRow(database.db, recordId, async () => {
        const harness = await learningHarness(model, library);
        try {
          // When (row A): both runs end; both rounds' model calls arrive, then answer together
          const runs = await Promise.all([
            startLearningRun(harness, model, {
              ownerId: first,
              recordId,
              turns: [
                {
                  text: 'Coordinate concurrent run 1',
                  scout: 'Scout concurrent run 1',
                },
              ],
            }),
            startLearningRun(harness, model, {
              ownerId: second,
              recordId,
              turns: [
                {
                  text: 'Coordinate concurrent run 2',
                  scout: 'Scout concurrent run 2',
                },
              ],
            }),
          ]);
          await bothHeld.reached(2);
          bothHeld.open();
          const rounds = await Promise.all(
            runs.map((run) => waitForRound(database.db, run.deepAgentId)),
          );

          // Then (AC-04.4, Invariant 5): each round read its own run's call; one wrote the entity and its lesson, the
          // other confirmed the entity it found under the lock and wrote its lesson
          expect(
            extraction.calls.map((call) => roundCallsOf(call)).sort(byText),
          ).toEqual([
            [`${LOGS_SERVER}/search_logs success fraud-check`],
            [`${LOGS_SERVER}/search_logs success payment-api`],
          ]);
          expect(
            rounds
              .map((round) => [
                round.lastStatus,
                round.lastAdded,
                round.lastConfirmed,
              ])
              .sort(byText),
          ).toEqual([
            ['done', 1, 1],
            ['done', 2, 0],
          ]);
          const graph = await readGraph(database.db, recordId);
          expect(
            graph.entities.map(
              (entity) => `${entity.name} ${entity.confirmations}`,
            ),
          ).toEqual(['ledger 2']);
          expect(
            graph.entities
              .flatMap((entity) => [
                entity.sourceRunId,
                entity.confirmedByRunId,
              ])
              .sort(),
          ).toEqual(runs.map((run) => run.deepAgentId).sort());
          expect(
            graph.relations.map((relation) => relation.question).sort(byText),
          ).toEqual(['errors of fraud-check', 'errors of payment-api']);
          for (const run of runs) {
            expect(
              await completedExtractsOf(database.db, run.deepAgentId),
            ).toHaveLength(1);
          }
        } finally {
          bothHeld.open();
          await closeAll([harness]);
        }
      });

      await withLibraryRow(database.db, restartId, async () => {
        const harnesses: AgentsHarness[] = [];
        try {
          // When (row B): the zombie instance (one slot, a sweeper that never passes again) runs the run and holds its round's model call
          const zombie = await learningHarness(restartModel, library, {
            runtimeConfig: ZOMBIE_RUNTIME,
          });
          harnesses.push(zombie);
          const run = await startLearningRun(zombie, restartModel, {
            ownerId: restartStarter,
            recordId: restartId,
            turns: [
              {
                text: 'Coordinate the restarted run',
                scout: 'Scout the restarted run',
              },
            ],
          });
          await restartHeld.reached();
          const [extract, ...moreExtracts] = await knowledgeTasksOf(
            database.db,
            { runId: run.deepAgentId },
          );
          if (extract === undefined)
            throw new Error('the restarted run has no extraction task');

          // When: a second instance starts, requeues the zombie's step as a lost one and takes the round over
          const restarted = await learningHarness(restartModel, library, {
            fixture: zombie.fixture,
          });
          harnesses.push(restarted);
          const round = await waitForRound(database.db, run.deepAgentId);

          // When: the zombie's held model call answers; its commit finds its attempt gone
          restartHeld.open();
          expect(
            (
              await logFieldsOf(
                zombie,
                'knowledge round abandoned without writes',
                extract.taskId,
              )
            ).outcome,
          ).toBe('fenced');

          // Then (NFR-02): both attempts read the same calls; the re-run's commit is the only one: the items once, its task named
          expect(
            restartExtraction.calls.map((call) => roundCallsOf(call)),
          ).toEqual([
            [`${LOGS_SERVER}/search_logs success checkout-web`],
            [`${LOGS_SERVER}/search_logs success checkout-web`],
          ]);
          expect([
            round.lastStatus,
            round.lastAdded,
            round.lastConfirmed,
            round.lastExtractTaskId,
          ]).toEqual(['done', 2, 0, extract.taskId]);
          const graph = await readGraph(database.db, restartId);
          expect(
            graph.entities.map(
              (entity) => `${entity.name} ${entity.confirmations}`,
            ),
          ).toEqual(['payment-api 1']);
          expect(
            graph.relations.map(
              (relation) => `${relation.question} ${relation.confirmations}`,
            ),
          ).toEqual(['errors of checkout-web 1']);
          // Then: both model calls are billed to the starter on the round's task; the run has that one task, completed
          expect(
            (
              await ledgerRowsOf(database.db, restartStarter, extract.taskId)
            ).map((row) => `${row.model} ${row.inputTokens}`),
          ).toEqual([
            `${TEST_MODEL_DEFAULT} 1000`,
            `${TEST_MODEL_DEFAULT} 1000`,
          ]);
          expect(moreExtracts).toEqual([]);
          expect(
            (await completedExtractsOf(database.db, run.deepAgentId)).map(
              (task) => task.taskId,
            ),
          ).toEqual([extract.taskId]);
        } finally {
          restartHeld.open();
          await closeAll(harnesses);
        }
      });
    },
    TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-5: the deep agent record is deleted while its round waits for the model, or after it - graph and vectors go with it
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-04.2 "Given модель предложила изменение, которое нельзя применить, например к уже удалённой записи, then остальные изменения этого
  //   извлечения записаны"; AC-02.3 "when автор удаляет workflow, then его граф удалён"; AC-19.1 (workflow half: "после удаления workflow его
  //   коллекция пуста", DC-16). Design: UC-E5, UC-E9 (workflow row), DC-8, DC-16, KD-1 (the cascading key), KD-8 (pgvector carries the vectors by cascade).
  // Behavior: the round waits on the model -> the author deletes the deep agent -> the model answers -> the commit's writes hit the missing
  //   record -> they are undone at their save point, the task completes, `record_deleted` goes to the log.
  // Rows:
  //   A. delete before the answer: no graph rows, no vectors and no vector row for the record, no error of the step and no failed or parked
  //      delivery of the knowledge trigger, the extraction task is completed, the log has `record_deleted` (the round's dropped writes) and
  //      the trigger ignores the extraction's end as `record_deleted` (no vector pass). As built: the run row has no key to the record (it is
  //      keyed by the run and goes with the conversation), so it stays with the round's `done` and zero counts.
  //   B. delete after a finished round and a finished embedding pass (items with vectors of model A in the store): every entity and relation
  //      of the record is gone with it (the key cascades), and `list(collection)` of the record's vector collection is empty - no vector
  //      that `query` could find is left - and the vector row is gone.
  // Catches: a key violation that fails the whole step and retries it forever (or parks the delivery), a graph left orphaned after its
  //   deep agent is deleted, and vectors of a deleted deep agent left in the store (a later query would still return their keys).
  // @category: edge-case
  // @dependency: knowledge.extract handler, graph repository, KnowledgeVectorStore (real pgvector), app.library_records (real row), runtime tasks, Postgres
  // @complexity: medium
  it(
    'INT-5: a deep agent deleted during the round leaves no graph rows, no step error and a completed extraction task; deleted after it, no graph rows and no vectors',
    async () => {
      // Given: two learning deep agents, one per row; the first round's model call will be held; embeddings on model A
      const midRoundId = randomUUID();
      const afterRoundId = randomUUID();
      const library = createLibraryDouble();
      library.add(learningDeepAgent(midRoundId, [SCOUT]));
      library.add(learningDeepAgent(afterRoundId, [SCOUT]));
      const starter = newUser();
      const roundHeld = createLatch();
      const model = createScriptedModel();
      const learned: readonly unknown[] = [
        {
          op: 'add_entity',
          ref: 'pay',
          name: 'payment-api',
          description: 'the payment service of the shop',
          evidence: ['c1'],
        },
        lessonOf('payment-api'),
      ];
      model.script({ agent: KNOWLEDGE_EXTRACT_AGENT }, [
        { calls: [recordKnowledge(learned)], latch: roundHeld },
        { calls: [recordKnowledge(learned)] },
      ]);
      scoutScript(model, 'Scout the run deleted mid-round', ['payment-api']);
      scoutScript(model, 'Scout the run deleted after its round', [
        'payment-api',
      ]);
      const embeddingModel = TEST_EMBEDDING_MODEL_A;
      if (embeddingModel.kind !== 'allowed')
        throw new Error('model A is not an allowed embedding model');

      await withLibraryRow(database.db, midRoundId, () =>
        withLibraryRow(database.db, afterRoundId, async () => {
          const harness = await learningHarness(model, library);
          harness.embeddingVerdict = embeddingModel;
          try {
            // When (row A): the run ends, its round's model call is held, the author deletes the deep agent, the model answers
            const midRound = await startLearningRun(harness, model, {
              ownerId: starter,
              recordId: midRoundId,
              turns: [
                {
                  text: 'Coordinate the run deleted mid-round',
                  scout: 'Scout the run deleted mid-round',
                },
              ],
            });
            await roundHeld.reached();
            await deleteLibraryRow(database.db, midRoundId);
            roundHeld.open();
            const dropped = await waitForRound(
              database.db,
              midRound.deepAgentId,
            );
            const [extract, ...moreExtracts] = await completedExtractsOf(
              database.db,
              midRound.deepAgentId,
            );
            if (extract === undefined)
              throw new Error('the run of row A has no extraction task');

            // Then (AC-04.2, DC-8): the round's writes were undone at their save point and the round still ended `done`; the
            // task completed, nothing failed or was parked, and the extraction's end queued no vector pass
            expect(moreExtracts).toEqual([]);
            expect([
              dropped.lastStatus,
              dropped.lastReason,
              dropped.lastAdded,
              dropped.lastConfirmed,
              dropped.lastOutdated,
              dropped.lastExtractTaskId,
            ]).toEqual(['done', null, 0, 0, 0, extract.taskId]);
            expect(
              (
                await logFieldsOf(
                  harness,
                  'knowledge graph writes dropped: deep agent deleted',
                  extract.taskId,
                )
              ).reason,
            ).toBe('record_deleted');
            const decided = await triggerDecisionOf(harness, extract.taskId);
            expect([decided.decision, decided.reason]).toEqual([
              'ignore',
              'record_deleted',
            ]);
            expect(await knowledgeLeftOf(database.db, midRoundId)).toEqual(
              NOTHING_LEFT,
            );
            expect(
              await knowledgeTasksOf(database.db, { recordId: midRoundId }),
            ).toEqual([]);
            expect(troublesOf(harness, extract.taskId)).toEqual([]);

            // When (row B): a run of the second deep agent ends, its round writes, the vector pass embeds its items on model A
            const finished = await startLearningRun(harness, model, {
              ownerId: starter,
              recordId: afterRoundId,
              turns: [
                {
                  text: 'Coordinate the run deleted after its round',
                  scout: 'Scout the run deleted after its round',
                },
              ],
            });
            const round = await waitForRound(database.db, finished.deepAgentId);
            const pass = await waitForEmbedPass(
              database.db,
              afterRoundId,
              round.lastAt ?? new Date(0),
            );
            const graph = await readGraph(database.db, afterRoundId);
            const keys = [
              ...graph.entities.map((entity) => `e${entity.id}`),
              ...graph.relations.map((relation) => `r${relation.id}`),
            ];
            expect([
              round.lastStatus,
              round.lastAdded,
              pass.lastReason,
              keys.length,
            ]).toEqual(['done', 2, null, 2]);
            expect(
              (await createPgvectorStore(database.db).list(afterRoundId))
                .map((entry) => `${entry.key} ${entry.model}`)
                .sort(),
            ).toEqual(
              keys.map((key) => `${key} ${embeddingModel.model}`).sort(),
            );

            // When: the author deletes the deep agent
            await deleteLibraryRow(database.db, afterRoundId);

            // Then (AC-02.3, AC-19.1, DC-16): its graph, its vectors and its vector row went with the record
            expect(await knowledgeLeftOf(database.db, afterRoundId)).toEqual(
              NOTHING_LEFT,
            );
          } finally {
            roundHeld.open();
            await closeAll([harness]);
          }
        }),
      );
    },
    TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-6: the model cannot be used - the round ends with a named state and the graph and the run stay as they were
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-03.4 "Given извлечение закончилось ошибкой модели, then граф не изменился, запуск остался завершённым, а ответ сотрудник получил
  //   как обычно"; AC-08.2 "Given квота запускающего на модель координатора исчерпана, when запуск закончился, then граф не изменился,
  //   а состояние графа называет причину". Design: UC-E2, UC-E3, UC-E4, DC-7, DC-13, KD-4 (at most three model calls per round: two for the
  //   answer, a third only when similar-entity candidates exist), Flow 1 failure handling.
  // Behavior: the run ends -> the access check refuses, the provider errors, or the answer carries no valid `record_knowledge` -> the round
  //   writes its state and the mark does not move.
  // Rows (literal `lastExtraction`; one deep agent that runs on model B, one starter per row, rows one after another):
  //   A. quota of the starter exhausted: zero model calls and no ledger row; `skipped` / `quota_exhausted`. As built: the refusal of model B
  //      for the starter is added while the deep agent's last answer is held (the run itself must still run), and withdrawn before row A's
  //      later round.
  //   B. provider error after the client's retries - `ModelClient` answers `model_error` with the reason `provider_unavailable` (a provider
  //      reason maps to `model_error`, the exact reason stays in the log, DC-13): `failed` / `model_error`. As built: three attempts (503 is
  //      retried twice), no ledger row (a provider rejection before any output is not billed).
  //   C. two text answers with no tool call: exactly two model calls (the second carries the error) and no third call with candidates (no
  //      valid operation, nothing to compare); `failed` / `invalid_answer`; two ledger rows.
  //   All rows: graph unchanged, the mark not moved, the run's final state and its reply untouched; then the run is continued with a turn
  //   that makes no call, and its next round reads the same call and writes `done`.
  // Catches: a refused call that spends tokens anyway, a failed round that advances the mark (the run's calls are then never extracted), a
  //   provider reason surfacing as a state outside the contract's list instead of `model_error`, or a third model call after an invalid answer
  //   (the budget bound).
  // @category: edge-case
  // @dependency: ModelClient, AccessGate (double), knowledge.extract handler, knowledge-runs row, Postgres
  // @complexity: medium
  it(
    'INT-6: a refused, failed or unparsable round writes its named state (provider reasons as `model_error`), calls the model at most twice, and changes neither graph nor run',
    async () => {
      // Given: a learning deep agent that runs on model B; three employees, one per row
      const recordId = randomUUID();
      const library = createLibraryDouble();
      library.add(learningDeepAgent(recordId, [SCOUT]));
      const content = learningContent(recordId);
      library.edit(recordId, {
        body: {
          kind: 'deep_agent',
          content: { ...content, model: TEST_MODEL_CHOSEN },
        },
      });
      const [refused, failing, unparsable] = [newUser(), newUser(), newUser()];
      const refusals: Record<string, Record<string, typeof QUOTA_SPENT>> = {};
      const endHeld = createLatch();
      const model = createScriptedModel();
      // The extraction calls in the order the rows make them
      const extraction = model.script({ agent: KNOWLEDGE_EXTRACT_AGENT }, [
        { calls: [recordKnowledge([lessonOf('payment-api')])] }, // 0: row A, its later round
        modelError(503), // 1-3: row B, the call and the client's two retries
        modelError(503),
        modelError(503),
        { calls: [recordKnowledge([lessonOf('ledger')])] }, // 4: row B, its later round
        { text: 'Nothing worth keeping.' }, // 5-6: row C, two answers without record_knowledge
        { text: 'Still nothing worth keeping.' },
        { calls: [recordKnowledge([lessonOf('fraud-check')])] }, // 7: row C, its later round
      ]);
      scoutScript(model, 'Scout the refused run', ['payment-api']);
      scoutScript(model, 'Scout the failing run', ['ledger']);
      scoutScript(model, 'Scout the unparsable run', ['fraud-check']);

      await withLibraryRow(database.db, recordId, async () => {
        const harness = await learningHarness(model, library, {
          ownerModelRefusals: refusals,
        });
        try {
          // When (row A): the starter's quota of model B runs out while the deep agent's last answer is held
          const refusedRun = await startLearningRun(harness, model, {
            ownerId: refused,
            recordId,
            turns: [
              {
                text: 'Coordinate the refused run',
                scout: 'Scout the refused run',
                answer: { text: 'Answer of the refused run', latch: endHeld },
              },
              { text: 'Coordinate the refused run again', scout: null },
            ],
          });
          await endHeld.reached();
          refusals[refused] = { [TEST_MODEL_CHOSEN]: QUOTA_SPENT };
          endHeld.open();
          const skipped = await waitForRound(
            database.db,
            refusedRun.deepAgentId,
          );
          const [refusedTask] = await completedExtractsOf(
            database.db,
            refusedRun.deepAgentId,
          );
          if (refusedTask === undefined)
            throw new Error('the run of row A has no extraction task');

          // Then (AC-08.2): skipped with the gate's reason, no model call, no ledger row, no graph, the mark not moved, the run as it ended
          expect(outcomeOf(skipped)).toEqual([
            'skipped',
            'quota_exhausted',
            0,
            0,
            0,
            TEST_MODEL_CHOSEN,
            null,
          ]);
          expect(extraction.calls).toHaveLength(0);
          expect(
            await ledgerRowsOf(database.db, refused, refusedTask.taskId),
          ).toEqual([]);
          expect(await readGraph(database.db, recordId)).toEqual({
            entities: [],
            relations: [],
          });
          expect(
            (await harness.runtime.tasks.get(refusedRun.deepAgentId, refused))
              .status,
          ).toBe('completed');
          expect(
            historyLines(
              await historyOf(harness, refusedRun.deepAgentId, refused),
            ),
          ).toContain('model_answer: Answer of the refused run []');

          // When: the quota is back and the run is continued; its next round reads the same call
          refusals[refused] = {};
          const refusedRetry = await roundAfterTurn(
            harness,
            {
              ownerId: refused,
              runId: refusedRun.deepAgentId,
              text: 'Coordinate the refused run again',
            },
            skipped,
          );
          expect(roundCallsOf(extraction.calls[0])).toEqual([
            `${LOGS_SERVER}/search_logs success payment-api`,
          ]);
          expect([
            refusedRetry.lastStatus,
            refusedRetry.lastAdded,
            refusedRetry.extractedUpTo,
          ]).toEqual(['done', 1, expect.any(Date)]);

          // When (row B): the provider answers 503 to the round's call and to both retries of the client
          const graphBeforeFailure = await readGraph(database.db, recordId);
          const failingRun = await startLearningRun(harness, model, {
            ownerId: failing,
            recordId,
            turns: [
              {
                text: 'Coordinate the failing run',
                scout: 'Scout the failing run',
              },
              { text: 'Coordinate the failing run again', scout: null },
            ],
          });
          const failed = await waitForRound(
            database.db,
            failingRun.deepAgentId,
          );
          const [failingTask] = await completedExtractsOf(
            database.db,
            failingRun.deepAgentId,
          );
          if (failingTask === undefined)
            throw new Error('the run of row B has no extraction task');

          // Then (AC-03.4, DC-13): `model_error` in the contract's list, the provider's reason only in the log; nothing billed,
          // the graph and the mark unchanged, the run as it ended
          expect(outcomeOf(failed)).toEqual([
            'failed',
            'model_error',
            0,
            0,
            0,
            TEST_MODEL_CHOSEN,
            null,
          ]);
          const failure = await logFieldsOf(
            harness,
            'knowledge round failed: model error',
            failingTask.taskId,
          );
          expect([failure.reason, failure.statusCode]).toEqual([
            'provider_unavailable',
            503,
          ]);
          expect(extraction.calls).toHaveLength(4);
          expect(
            await ledgerRowsOf(database.db, failing, failingTask.taskId),
          ).toEqual([]);
          expect(await readGraph(database.db, recordId)).toEqual(
            graphBeforeFailure,
          );
          expect(
            (await harness.runtime.tasks.get(failingRun.deepAgentId, failing))
              .status,
          ).toBe('completed');
          expect(
            historyLines(
              await historyOf(harness, failingRun.deepAgentId, failing),
            ),
          ).toContain('model_answer: Answer to: Coordinate the failing run []');

          // When: the run is continued; its next round reads the same call
          const failingRetry = await roundAfterTurn(
            harness,
            {
              ownerId: failing,
              runId: failingRun.deepAgentId,
              text: 'Coordinate the failing run again',
            },
            failed,
          );
          expect(roundCallsOf(extraction.calls[4])).toEqual(
            roundCallsOf(extraction.calls[1]),
          );
          expect(roundCallsOf(extraction.calls[4])).toEqual([
            `${LOGS_SERVER}/search_logs success ledger`,
          ]);
          expect([
            failingRetry.lastStatus,
            failingRetry.lastAdded,
            failingRetry.extractedUpTo,
          ]).toEqual(['done', 1, expect.any(Date)]);

          // When (row C): the model answers twice with text and no record_knowledge
          const graphBeforeInvalid = await readGraph(database.db, recordId);
          const unparsableRun = await startLearningRun(harness, model, {
            ownerId: unparsable,
            recordId,
            turns: [
              {
                text: 'Coordinate the unparsable run',
                scout: 'Scout the unparsable run',
              },
              { text: 'Coordinate the unparsable run again', scout: null },
            ],
          });
          const invalid = await waitForRound(
            database.db,
            unparsableRun.deepAgentId,
          );
          const [unparsableTask] = await completedExtractsOf(
            database.db,
            unparsableRun.deepAgentId,
          );
          if (unparsableTask === undefined)
            throw new Error('the run of row C has no extraction task');

          // Then (DC-7, KD-4): exactly two calls, the second told what was wrong, no third; both billed; graph and mark unchanged
          expect(outcomeOf(invalid)).toEqual([
            'failed',
            'invalid_answer',
            0,
            0,
            0,
            TEST_MODEL_CHOSEN,
            null,
          ]);
          expect(extraction.calls).toHaveLength(7);
          const told = extraction.calls[6]?.messages.at(-1);
          expect(told?.role === 'user' ? told.content : null).toContain(
            'You did not call record_knowledge',
          );
          expect(
            (
              await ledgerRowsOf(database.db, unparsable, unparsableTask.taskId)
            ).map((row) => row.model),
          ).toEqual([TEST_MODEL_CHOSEN, TEST_MODEL_CHOSEN]);
          expect(await readGraph(database.db, recordId)).toEqual(
            graphBeforeInvalid,
          );
          expect(
            (
              await harness.runtime.tasks.get(
                unparsableRun.deepAgentId,
                unparsable,
              )
            ).status,
          ).toBe('completed');
          expect(
            historyLines(
              await historyOf(harness, unparsableRun.deepAgentId, unparsable),
            ),
          ).toContain(
            'model_answer: Answer to: Coordinate the unparsable run []',
          );

          // When: the run is continued; its next round reads the same call
          const unparsableRetry = await roundAfterTurn(
            harness,
            {
              ownerId: unparsable,
              runId: unparsableRun.deepAgentId,
              text: 'Coordinate the unparsable run again',
            },
            invalid,
          );
          expect(roundCallsOf(extraction.calls[7])).toEqual(
            roundCallsOf(extraction.calls[5]),
          );
          expect(roundCallsOf(extraction.calls[7])).toEqual([
            `${LOGS_SERVER}/search_logs success fraud-check`,
          ]);
          expect([
            unparsableRetry.lastStatus,
            unparsableRetry.lastAdded,
            unparsableRetry.extractedUpTo,
          ]).toEqual(['done', 1, expect.any(Date)]);
        } finally {
          endHeld.open();
          await closeAll([harness]);
        }
      });
    },
    TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-7: operations from the model - invalid ones are rejected, valid ones in the same answer apply
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-04.2 "остальные изменения этого извлечения записаны"; AC-16.2 "Given запуск не вызывал `logs.search`, а ответ повторил урок о нём
  //   из графа, when извлечение выполнено, then число подтверждений и дата урока не изменились"; AC-05.1 "на месте значения секрета стоит
  //   пометка о скрытии". Design: UC-6 (wiring only), DC-6, KD-4.
  // Behavior: one answer holds a valid operation, an operation with an unknown id, one that cites a call not in the round's input, and a
  //   confirmation of an existing lesson whose cited call does not fit it (the run never called that tool) -> `checkOperations` inside the
  //   real round -> the valid operation is in the graph, the rejected ones are counted in the log by reason.
  //   As built: the valid operation is a new entity whose description holds the value of a secret the process remembers (`rememberSecret`,
  //   as the logger's settings do), the only call of the run is c1 (`search_logs`), the lesson is seeded about `get_trace`.
  // Verification items:
  //   - the valid entity is written; the unknown-id and unknown-call operations change nothing; the lesson's row (confirmations 2, its
  //     date, its run) is unchanged; the log counts one `unknown_item`, one `unknown_call` and one `evidence_mismatch`
  //   - the secret's value is `[redacted]` in the stored text and appears nowhere in the graph tables nor in any log record
  //   - `lastExtraction` is done with counts of only the applied operations
  // Catches: one bad operation voiding the answer (knowledge lost) or, worse, a replayed graph line confirming itself and raising its
  //   standing without any tool call of this run (the poisoning route of the PRD's main risk), or a secret stored in the shared graph.
  // @category: integration
  // @dependency: knowledge.extract handler, checkOperations, createSecretMasker (reads the process secret memory, `rememberSecret`), Postgres
  // @complexity: medium
  it(
    'INT-7: a round applies the valid operations of an answer, rejects the unknown-id and uncited ones, and stores no secret value',
    async () => {
      // Given: the process remembers a secret; a learning deep agent whose graph holds a lesson about `get_trace`, confirmed twice
      rememberSecret(FAKE_SECRET);
      const recordId = randomUUID();
      const library = createLibraryDouble();
      library.add(learningDeepAgent(recordId, [SCOUT]));
      const starter = newUser();
      const model = createScriptedModel();
      scoutScript(model, 'Scout the payment service', ['payment-api']);

      await withLibraryRow(database.db, recordId, async () => {
        const [replayed] = await seedGraph(database.db, recordId, [
          {
            kind: 'lesson',
            server: LOGS_SERVER,
            tool: 'get_trace',
            question: 'traces of a payment',
            hint: 'Ask by the trace id',
            outcome: 'trace found',
            confirmations: 2,
            confirmedAt: new Date('2026-10-01T00:00:00.000Z'),
          },
        ]);
        if (replayed === undefined)
          throw new Error('the lesson was not seeded');
        const seeded = await readGraph(database.db, recordId);
        // Given: the answer of the round - one valid operation and three that must be rejected
        const extraction = model.script({ agent: KNOWLEDGE_EXTRACT_AGENT }, [
          {
            calls: [
              recordKnowledge([
                {
                  op: 'add_entity',
                  ref: 'pay',
                  name: 'payment-api',
                  description: `the payment service, signed with ${FAKE_SECRET}`,
                  evidence: ['c1'],
                },
                { op: 'confirm', id: UNKNOWN_ENTITY_ID, evidence: ['c1'] },
                {
                  op: 'add_relation',
                  kind: 'lesson',
                  server: LOGS_SERVER,
                  tool: 'search_logs',
                  question: 'errors of ledger',
                  hint: 'Filter by the service ledger',
                  outcome: 'records found',
                  evidence: ['c9'],
                },
                { op: 'confirm', id: replayed.key, evidence: ['c1'] },
              ]),
            ],
          },
        ]);
        const harness = await learningHarness(model, library);
        try {
          // When: a run searches the logs once and ends; its round applies the answer
          const run = await startLearningRun(harness, model, {
            ownerId: starter,
            recordId,
            turns: [
              {
                text: 'Coordinate the run with a secret',
                scout: 'Scout the payment service',
              },
            ],
          });
          const round = await waitForRound(database.db, run.deepAgentId);
          const [extract] = await completedExtractsOf(
            database.db,
            run.deepAgentId,
          );
          if (extract === undefined)
            throw new Error('the run has no extraction task');

          // Then (AC-04.2, DC-6): the valid entity is written with the secret redacted; the rest changed nothing
          expect(extraction.calls).toHaveLength(1);
          expect(roundCallsOf(extraction.calls[0])).toEqual([
            `${LOGS_SERVER}/search_logs success payment-api`,
          ]);
          expect([
            round.lastStatus,
            round.lastReason,
            round.lastAdded,
            round.lastConfirmed,
            round.lastOutdated,
          ]).toEqual(['done', null, 1, 0, 0]);
          const graph = await readGraph(database.db, recordId);
          expect(
            graph.entities.map(
              (entity) => `${entity.name}: ${entity.description}`,
            ),
          ).toEqual([
            'payment-api: the payment service, signed with [redacted]',
          ]);
          // Then (AC-16.2): the replayed lesson kept its two confirmations, its date and its run
          expect(graph.relations).toEqual(seeded.relations);
          const checked = await logFieldsOf(
            harness,
            'knowledge operations checked',
            extract.taskId,
          );
          expect([
            checked.added,
            checked.confirmed,
            checked.outdated,
            checked.rejected,
          ]).toEqual([
            1,
            0,
            0,
            { unknown_item: 1, unknown_call: 1, evidence_mismatch: 1 },
          ]);

          // Then (AC-05.1): the secret's value is nowhere in the graph tables nor in the log
          expect(JSON.stringify(graph)).not.toContain(FAKE_SECRET);
          expect(JSON.stringify(harness.logs)).not.toContain(FAKE_SECRET);
        } finally {
          await closeAll([harness]);
        }
      });
    },
    TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-8: the step prompt - the block chosen by the two-pass selection in the model step and the compaction step, read fresh, off when the flag is off
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-01.2 "флажок, стоявший при старте запуска, держится до его конца"; AC-02.2 "граф тот же, что был до выключения"; AC-07.1 "Given
  //   автор удалил связь, когда запуск ещё шёл, when начинается следующий шаг этого запуска, then шаг её не получает"; AC-09.2 "автор удаляет
  //   сущность, then её связи тоже удалены, и следующий шаг любого запуска их не получает"; AC-07.3 (the block is inside the envelope);
  //   AC-18.1 "Given граф больше предела, и у записи, которая по общему порядку в промпт не проходит, уже есть вектор, when сессия получает
  //   вопрос, близкий по смыслу к этой записи, then запись в промпте"; AC-19.1 (entity half) "Given автор удалил запись, when сессия получает
  //   вопрос, дословно совпадающий с её текстом, then этой записи нет в промпте".
  //   Design: UC-2, UC-7, UC-E9 (entity row), KD-6 (one block text in both steps; two passes; the question vector is stored, steps only read it),
  //   KD-2, KD-8, Invariant 10 (the graph is the source of truth for vectors).
  // Behavior: the step reads the graph, the settings, the registry and the session's stored question row -> the store's pairs for that vector
  //   -> `selectKnowledge` (up to half of the limit by closeness, the rest in the common order) -> the text goes after the definition prompt.
  // Rows:
  //   1. a learning run with an entity and its relation: the model step's system text and the compaction step's system text (history long
  //      enough to compact) carry the same block; after the author deletes the entity the next step of the same run carries neither the
  //      entity nor its relation (the relation went with it).
  //   2. a deep agent without the flag (and a subagent whose snapshot has `learning = null`): the system text is byte-identical to a deep agent
  //      that never had the feature, and no run row exists.
  //   3. the author switches the flag off mid-run: the running run keeps its block and is still extracted; a new run gets no block and no row;
  //      after the flag is on again the graph is the one that was there before.
  //   4. the graph is above the limit (the limit at its minimum, rows seeded with their vectors, the store real): an item the common order
  //      drops but whose vector is closest to the stored question is in the block of both steps, at the same position in both. Then the author
  //      deletes an entity whose vector is still in the store (the embedding pass has not run) and the question equals its text verbatim: the
  //      next step does not carry it nor its relations; after the `knowledge.embed` pass `list(collection)` holds none of their keys.
  //   As built, one deep agent and two runs carry all four rows. Run 1 (rows 1, 3, 4): the graph over the cap (`seedOverLimit`), billing and its
  //   fact with vectors of model A; the question of the scout's session is about billing, so the closeness pass brings them in; the scout's
  //   three calls are the model step, the compaction step (held) and the model step after it (held). While the compaction is held the author
  //   switches the flag off (row 3) and deletes the billing entity (rows 1, 4): its fact goes with it, the deletion's pass removes both
  //   vectors, and the test writes them back as a pass that embedded the two records just before the deletion leaves them (the embed handler's
  //   "a vector written for a record deleted meanwhile is dangling") - so the next step's store query returns their keys. The block of that
  //   step is the common order: the dangling keys are dropped, the archives' and refunds' vectors (the deletion's pass embedded them) are
  //   equally far from billing (closeness 0, the archives first by id), and the common order then takes the same four archives. The pass at
  //   the run's end removes the dangling vectors again. Run 2 (rows 2, 3): the flag off, its subagent's snapshot has `learning = null`;
  //   "byte-identical" is the learning scout's first system text with its block cut out. The vector values are in `OVER_LIMIT_VECTORS`.
  // Catches: the compaction call built without the block (the provider cache of the model step is then missed and the history summary loses
  //   the context), a graph cached at run start so deletions never reach a running run, the block leaking into runs of a deep agent that does not
  //   learn, a closeness pass that ignores the stored vector (the item near the question never reaches the prompt), and a deleted item found
  //   by its leftover vector and put in the prompt, or its vector kept in the store for ever.
  // @category: core-functionality
  // @dependency: modelStep, compactionStep, knowledgeBlock, selectKnowledge, KnowledgeVectorStore (real pgvector), question row, envelope, ensureSession, EmbeddingClient (double), ModelClient (scripted), Postgres
  // @complexity: high
  it(
    'INT-8: both the model step and the compaction step carry the two-pass block read fresh at each step, a deleted item is not found by its vector, and a non-learning deep agent gets none',
    async () => {
      // Given: a learning deep agent whose graph is over the cap; embeddings on model A; the scout's compaction and report will be held
      const recordId = randomUUID();
      const library = createLibraryDouble();
      library.add(learningDeepAgent(recordId, [SCOUT]));
      const flagged = (selfLearning: boolean) =>
        library.edit(recordId, {
          body: {
            kind: 'deep_agent',
            content: { ...learningContent(recordId), selfLearning },
          },
        });
      const starter = newUser();
      const compactionHeld = createLatch();
      const reportHeld = createLatch();
      const model = createScriptedModel();
      model.script({ agent: KNOWLEDGE_EXTRACT_AGENT }, [], {
        thereafter: RECORDS_NOTHING,
      });
      const scout = compactingScoutScript(model, 'Scout the billing question', {
        compaction: compactionHeld,
        report: reportHeld,
      });
      const unlearnedScout = scoutScript(
        model,
        'Scout the run without learning',
        [],
      );

      await withLibraryRow(database.db, recordId, () =>
        withKnowledgeLimit(
          database.db,
          KNOWLEDGE_LIMIT_TOKENS_MIN,
          async () => {
            const seeded = await seedOverLimit(database.db, recordId, [
              'billing',
              'fact',
            ]);
            const harness = await learningHarness(model, library, {
              variables: COMPACTING,
            });
            harness.embeddingVerdict = TEST_EMBEDDING_MODEL_A;
            harness.embeddings.vectorOf = topicVector;
            try {
              // When (rows 1, 4): a run about billing; its scout searches at the compaction threshold, then compacts (held)
              const run = await startLearningRun(harness, model, {
                ownerId: starter,
                recordId,
                turns: [
                  {
                    text: 'Coordinate the billing question',
                    scout: 'Scout the billing question',
                  },
                ],
              });
              await compactionHeld.reached();
              const [modelCall, compactionCall] = scout.calls;

              // Then (AC-18.1, KD-6): the model step's block holds billing and its fact by closeness, which the common order leaves
              // out, inside the envelope; the compaction call's system text is the same, byte for byte
              expect(lastUserText(compactionCall)).toContain(
                COMPACTION_REQUEST_START,
              );
              expect(knowledgeLinesOf(modelCall)).toEqual(BILLING_BLOCK);
              expect(compactionCall?.instructions).toBe(
                modelCall?.instructions,
              );

              // When (row 3): the author switches the flag off mid-run. (Rows 1, 4): the author deletes the billing entity; the
              // deletion's pass runs; the two records' vectors are written back as a pass that embedded them just before leaves them
              flagged(false);
              const beforeDelete = new Date();
              const deletion = await harness.agents.knowledge.deleteEntity({
                recordId,
                entityId: seeded.billing.id,
              });
              const cleanup = await waitForEmbedPass(
                database.db,
                recordId,
                beforeDelete,
              );
              const afterDelete = await readGraph(database.db, recordId);
              expect([deletion, cleanup.lastReason]).toEqual([
                { deleted: true, relations: 1 },
                null,
              ]);
              expect(graphKeysOf(afterDelete)).not.toContain(seeded.fact.key);
              // Then (AC-19.1, Invariant 10): the deletion's pass left no vector of the entity or its fact
              expect(await vectorLinesOf(database.db, recordId)).toEqual(
                everyKeyOn(afterDelete, MODEL_A),
              );
              await createPgvectorStore(database.db).upsert(recordId, [
                {
                  key: seeded.billing.key,
                  kind: 'entity',
                  model: MODEL_A,
                  vector: OVER_LIMIT_VECTORS.billing,
                },
                {
                  key: seeded.fact.key,
                  kind: 'relation',
                  model: MODEL_A,
                  vector: OVER_LIMIT_VECTORS.fact,
                },
              ]);
              const leftover = [
                ...everyKeyOn(afterDelete, MODEL_A),
                `${seeded.billing.key} ${MODEL_A}`,
                `${seeded.fact.key} ${MODEL_A}`,
              ];
              compactionHeld.open();
              await reportHeld.reached();

              // Then (AC-07.1, AC-09.2, AC-19.1): the next step of the same run reads the graph fresh - neither the entity nor its fact,
              // although their vectors, the closest to the question, are in the store; (AC-01.2) the flag of the start still gives a block
              expect(knowledgeLinesOf(scout.calls[2])).toEqual(COMMON_BLOCK);
              expect(await vectorLinesOf(database.db, recordId)).toEqual(
                leftover.sort(),
              );

              // When: the scout reports and the run ends
              reportHeld.open();
              const round = await waitForRound(database.db, run.deepAgentId);
              const pass = await waitForEmbedPass(
                database.db,
                recordId,
                round.lastAt ?? new Date(0),
              );

              // Then (row 3): the run whose flag went off mid-run is still extracted; (row 4) the pass removed the leftover vectors
              expect([
                round.lastStatus,
                round.lastReason,
                pass.lastReason,
              ]).toEqual(['done', null, null]);
              const graph = await readGraph(database.db, recordId);
              expect(await vectorLinesOf(database.db, recordId)).toEqual(
                everyKeyOn(graph, MODEL_A),
              );

              // When (rows 2, 3): the starter runs the deep agent with the flag off
              const unlearned = await startLearningRun(harness, model, {
                ownerId: starter,
                recordId,
                turns: [
                  {
                    text: 'Coordinate the run without learning',
                    scout: 'Scout the run without learning',
                  },
                ],
              });
              await waitForTaskStatus(
                harness,
                unlearned.deepAgentId,
                starter,
                'completed',
              );

              // Then: no run row, no block for the deep agent, and the subagent's system text is the learning one without its block
              expect(
                await findRunById(database.db, unlearned.deepAgentId),
              ).toBeUndefined();
              expect(unlearned.deepAgent.calls[0]?.instructions).not.toContain(
                KNOWLEDGE_RULE,
              );
              expect(unlearnedScout.calls[0]?.instructions).toBe(
                withoutKnowledge(modelCall?.instructions ?? ''),
              );

              // When (row 3): the author switches the flag on again. Then (AC-02.2): the graph is the one that was there
              flagged(true);
              expect(await readGraph(database.db, recordId)).toEqual(graph);
            } finally {
              compactionHeld.open();
              reportHeld.open();
              await closeAll([harness]);
            }
          },
        ),
      );
    },
    TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-10: embeddings unavailable - the run is never failed, selection falls back to the common order and says why  (NEW, v1.2)
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-18.3 "Given провайдер эмбеддингов вернул ошибку, when начинается шаг запуска, then запуск продолжается, шаг получает граф по общему
  //   порядку во весь предел, а состояние графа говорит, что отбор по смыслу выключен, и называет причину". Design: UC-E7, KD-6, Flow 2 failure
  //   handling (the question row is stored with an empty vector), Flow 4 failure handling.
  // Behavior: the graph is above the limit -> a session starts -> the handler computes the question vector -> the double fails (or no model is
  //   selected) -> the question row is written with an empty vector -> every step of the run reads it and builds the block in the common order
  //   over the whole limit -> the run completes -> the author opens the view.
  // Rows (several steps in each; literal `selection`):
  //   A. no embedding model selected (`model_not_configured`): no embedding call; `selection` = `off`, reason `model_not_selected`, model `null`.
  //   B. the provider answers 5xx (`provider_unavailable` after the client's own retries): exactly one embedding call with `inputType` `query`
  //      for the session however many steps it makes; `selection` = `off`, reason `provider_failed`, `model` = the selected model's id.
  //   Both rows: the run's final state is `completed` and its reply is in the conversation; the block of every step is the common order over the
  //   whole limit (equal to what a graph with no vectors gives); in the view the records beyond the limit are `does_not_fit`, none `by_topic`.
  //   As built: one deep agent per row, the graph over the cap without vectors (`seedOverLimit`); the deep agent makes three or more model steps,
  //   the scout two. Row B's one `embed` per session is three provider requests - the call and the service's two retries (1 and 3 s) - so the
  //   double records three `query` requests per learning session (deep agent, scout), and none from a later step. Each run is followed to
  //   the end of the vector pass its extraction queues (row A: `model_not_configured`, no request; row B: `provider_unavailable`).
  // Catches: an embedding outage failing a run or a step, a failing call repeated at every step (spend and latency multiplied by the step
  //   count), a prompt that is empty or half-filled instead of the common order over the whole limit, and a view that promises `by_topic`
  //   records that no run can receive.
  // @category: edge-case
  // @dependency: AgentStepHandler (question row), knowledgeBlock, selectKnowledge, EmbeddingClient (double: not selected / 5xx), Agents.knowledge.view, ModelClient (scripted), Postgres
  // @complexity: medium
  it(
    'INT-10: with no embedding model or a failing provider the run completes, steps get the common order over the whole limit, one failed call per session, and the view says off with the reason',
    async () => {
      // Given: two learning deep agents over the cap, one per row, no vectors anywhere
      const unselectedId = randomUUID();
      const failingId = randomUUID();
      const library = createLibraryDouble();
      library.add(learningDeepAgent(unselectedId, [SCOUT]));
      library.add(learningDeepAgent(failingId, [SCOUT]));
      const starter = newUser();
      const model = createScriptedModel();
      model.script({ agent: KNOWLEDGE_EXTRACT_AGENT }, [], {
        thereafter: RECORDS_NOTHING,
      });
      const unselectedScout = scoutScript(
        model,
        'Scout with no embedding model',
        ['payment-api'],
      );
      const failingScout = scoutScript(model, 'Scout with failing embeddings', [
        'payment-api',
      ]);

      await withLibraryRow(database.db, unselectedId, () =>
        withLibraryRow(database.db, failingId, () =>
          withKnowledgeLimit(
            database.db,
            KNOWLEDGE_LIMIT_TOKENS_MIN,
            async () => {
              const unselectedGraph = await seedOverLimit(
                database.db,
                unselectedId,
                [],
              );
              const failingGraph = await seedOverLimit(
                database.db,
                failingId,
                [],
              );
              // With selection off the whole limit goes to the common order: the archives always, the rest never
              const offPlacements = (graph: OverLimitGraph) =>
                [
                  ...graph.archives.map((item) => `${item.key} always`),
                  ...[graph.billing, graph.fact, graph.refunds].map(
                    (item) => `${item.key} does_not_fit`,
                  ),
                ].sort();
              const harness = await learningHarness(model, library);
              /** Runs the deep agent to the end of the vector pass its extraction queues. */
              const runToItsPass = async (
                recordId: string,
                text: string,
                scout: string,
              ) => {
                const run = await startLearningRun(harness, model, {
                  ownerId: starter,
                  recordId,
                  turns: [{ text, scout }],
                });
                const round = await waitForRound(database.db, run.deepAgentId);
                const pass = await waitForEmbedPass(
                  database.db,
                  recordId,
                  round.lastAt ?? new Date(0),
                );
                const ended = await harness.runtime.tasks.get(
                  run.deepAgentId,
                  starter,
                );
                const history = historyLines(
                  await historyOf(harness, run.deepAgentId, starter),
                );
                return { run, pass, status: ended.status, history };
              };
              try {
                // When (row A): no embedding model is selected; a run makes several steps and ends
                const unselected = await runToItsPass(
                  unselectedId,
                  'Coordinate with no embedding model',
                  'Scout with no embedding model',
                );

                // Then (AC-18.3): the run completed with its reply; every step got the common order over the whole limit; no
                // provider request at all, and the view says why selection is off
                expect([unselected.status, unselected.pass.lastReason]).toEqual(
                  ['completed', 'model_not_configured'],
                );
                expect(unselected.history).toContain(
                  'model_answer: Answer to: Coordinate with no embedding model []',
                );
                expect(unselectedScout.calls).toHaveLength(2);
                expect(
                  distinctBlocks([
                    ...unselected.run.deepAgent.calls,
                    ...unselectedScout.calls,
                  ]),
                ).toEqual([COMMON_BLOCK]);
                expect(harness.embeddings.calls).toEqual([]);
                const unselectedView = await knowledgeView(
                  harness,
                  unselectedId,
                  [LOGS_SERVER],
                );
                expect(unselectedView.selection).toEqual({
                  state: 'off',
                  reason: 'model_not_selected',
                  model: null,
                });
                expect(placementsOf(unselectedView)).toEqual(
                  offPlacements(unselectedGraph),
                );

                // When (row B): model A is selected and its provider answers 503 to every request
                harness.embeddingVerdict = TEST_EMBEDDING_MODEL_A;
                harness.embeddings.failure = { statusCode: 503 };
                const failing = await runToItsPass(
                  failingId,
                  'Coordinate with failing embeddings',
                  'Scout with failing embeddings',
                );

                // Then (AC-18.3): the same run, the same blocks; one failed `embed` per session (three requests: the call and two
                // retries), none from a later step; the view names the provider failure and the model
                expect([failing.status, failing.pass.lastReason]).toEqual([
                  'completed',
                  'provider_unavailable',
                ]);
                expect(failing.history).toContain(
                  'model_answer: Answer to: Coordinate with failing embeddings []',
                );
                expect(failingScout.calls).toHaveLength(2);
                expect(
                  distinctBlocks([
                    ...failing.run.deepAgent.calls,
                    ...failingScout.calls,
                  ]),
                ).toEqual([COMMON_BLOCK]);
                expect(
                  embeddingRequestsOf(harness, 'query').map(
                    (call) => `${call.model} ${call.texts.join(' | ')}`,
                  ),
                ).toEqual([
                  `${MODEL_A} Coordinate with failing embeddings`,
                  `${MODEL_A} Coordinate with failing embeddings`,
                  `${MODEL_A} Coordinate with failing embeddings`,
                  `${MODEL_A} Scout with failing embeddings`,
                  `${MODEL_A} Scout with failing embeddings`,
                  `${MODEL_A} Scout with failing embeddings`,
                ]);
                const failingView = await knowledgeView(harness, failingId, [
                  LOGS_SERVER,
                ]);
                expect(failingView.selection).toEqual({
                  state: 'off',
                  reason: 'provider_failed',
                  model: MODEL_A,
                });
                expect(placementsOf(failingView)).toEqual(
                  offPlacements(failingGraph),
                );
              } finally {
                await closeAll([harness]);
              }
            },
          ),
        ),
      );
    },
    TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-11: the embedding model changes - old vectors are not used, selection says preparing, the pass recomputes  (NEW, v1.2)
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-18.4 "Given администратор сменил модель эмбеддингов, when пересчёт векторов ещё идёт, then запуски проходят, а записи без вектора новой
  //   модели попадают в промпт по общему порядку"; AC-08.1 (the recomputation half: "за пересчёт после смены модели — на платформу"). Design:
  //   UC-E8, KD-8, Invariant 11 (similarity only between vectors of one model), Flow 4, `Agents.embeddings.model()`.
  // Behavior: every item has a vector of model A, the administrator selects model B (the double's selected model changes) -> a session starts
  //   -> the question vector is of model B and meets no vector of B -> the block is the common order, the view says `preparing` -> the run ends,
  //   the extraction adds an item, the `knowledge.embed` pass runs -> vectors of B for every item, the key's old vector of A replaced (one vector
  //   per key) -> the next session selects by closeness again, the view says `on`.
  // Verification items:
  //   - before the pass: the run completes; the block of its steps is the common order; the view's `selection` is `preparing` with `pending`
  //     = the number of `active` items, and no item is chosen by a vector of A
  //   - after the pass: `list(collection)` holds one entry per key, all of model B; `selection` is `on`, `pending` gone
  //   - the ledger rows of the pass: the recomputation of the items that existed before the change is owned by `platform`; the item the round
  //     added is owned by the starter (see the charging rule in the header)
  //   As built: the graph over the cap (`seedOverLimit`), all seven records with vectors of model A (3 dimensions), and model B (4 dimensions)
  //   selected before the run. pgvector cannot compare vectors of different lengths, so a query that compared them would fail and the step would
  //   log "knowledge store query failed" and fall back to the common order: the test asserts that no such warning was logged, so the common order
  //   comes from the model filter. The view is read while the deep agent's last answer is held; the round adds one lesson, so the one pass
  //   makes two `document` requests - the lesson (never had a vector) on the starter, the seven old records on the platform -, both under the
  //   pass's task, whose owner is the platform. The scripted provider counts 10 input tokens a text.
  // Catches: vectors of the old model compared with a question vector of the new one (nonsense closeness, a prompt with random items), a run
  //   blocked or failed while the vectors are being recomputed, a pass that leaves items on the old model for ever, and a recomputation that is
  //   billed to the employee who happened to finish a run.
  // @category: edge-case
  // @dependency: AgentStepHandler (question row), knowledgeBlock, knowledge.embed handler, KnowledgeVectorStore (real pgvector), EmbeddingClient (double: model A -> B), token ledger, Agents.knowledge.view, Postgres
  // @complexity: high
  it(
    'INT-11: after the embedding model changes, steps use the common order and the view says preparing until the pass re-embeds every item on the new model, billed to the platform',
    async () => {
      // Given: a learning deep agent over the cap, every record with a vector of model A; the administrator selected model B
      const recordId = randomUUID();
      const library = createLibraryDouble();
      library.add(learningDeepAgent(recordId, [SCOUT]));
      const starter = newUser();
      const endHeld = createLatch();
      const model = createScriptedModel();
      model.script({ agent: KNOWLEDGE_EXTRACT_AGENT }, [
        { calls: [recordKnowledge([lessonOf('billing-api')])] },
      ]);
      const scout = scoutScript(model, 'Scout the billing logs', [
        'payment-api',
      ]);

      await withLibraryRow(database.db, recordId, () =>
        withKnowledgeLimit(
          database.db,
          KNOWLEDGE_LIMIT_TOKENS_MIN,
          async () => {
            await seedOverLimit(database.db, recordId, [
              'archives',
              'billing',
              'fact',
              'refunds',
            ]);
            const harness = await learningHarness(model, library);
            harness.embeddingVerdict = TEST_EMBEDDING_MODEL_B;
            harness.embeddings.vectorOf = topicVector;
            try {
              // When: a run about billing; its deep agent's last answer is held
              const run = await startLearningRun(harness, model, {
                ownerId: starter,
                recordId,
                turns: [
                  {
                    text: 'Coordinate the billing question',
                    scout: 'Scout the billing logs',
                    answer: {
                      text: 'Answer of the billing run',
                      latch: endHeld,
                    },
                  },
                ],
              });
              await endHeld.reached();

              // Then (AC-18.4, Invariant 11): the question vector is of model B and meets no vector of B - every step got the common
              // order, billing's vector of A never compared (no failed store query); the view says preparing, all seven records pending
              expect(
                (await readQuestion(database.db, run.deepAgentId))?.model,
              ).toBe(MODEL_B);
              expect(
                distinctBlocks([...run.deepAgent.calls, ...scout.calls]),
              ).toEqual([COMMON_BLOCK]);
              expect(
                harness.logs.filter(
                  (record) =>
                    record.message ===
                    'knowledge store query failed; selection without closeness',
                ),
              ).toEqual([]);
              expect(
                (await knowledgeView(harness, recordId, [LOGS_SERVER]))
                  .selection,
              ).toEqual({
                state: 'preparing',
                pending: 7,
              });

              // When: the run ends, the round adds a lesson, the pass runs
              endHeld.open();
              const round = await waitForRound(database.db, run.deepAgentId);
              const pass = await waitForEmbedPass(
                database.db,
                recordId,
                round.lastAt ?? new Date(0),
              );
              expect([
                round.lastStatus,
                round.lastAdded,
                pass.lastReason,
                pass.lastModel,
              ]).toEqual(['done', 1, null, MODEL_B]);
              expect(
                (await harness.runtime.tasks.get(run.deepAgentId, starter))
                  .status,
              ).toBe('completed');

              // Then: one vector per key, every one of model B; selection is on
              expect(await vectorLinesOf(database.db, recordId)).toEqual(
                everyKeyOn(await readGraph(database.db, recordId), MODEL_B),
              );
              expect(
                (await knowledgeView(harness, recordId, [LOGS_SERVER]))
                  .selection,
              ).toEqual({ state: 'on' });

              // Then (AC-08.1, KD-8): the pass is the platform's task; the new lesson is the starter's, the seven recomputed records
              // the platform's, nobody else pays
              const [passTask, ...morePasses] = await knowledgeTasksOf(
                database.db,
                { recordId },
              );
              if (passTask === undefined) throw new Error('no vector pass');
              expect([passTask.ownerId, morePasses]).toEqual([
                PLATFORM_OWNER_ID,
                [],
              ]);
              expect(
                embeddingRequestsOf(harness, 'document').map(
                  (call) => `${call.model} ${call.texts.length}`,
                ),
              ).toEqual([`${MODEL_B} 1`, `${MODEL_B} 7`]);
              expect(
                await embeddingSpendOf(database.db, starter, passTask.taskId),
              ).toEqual([`${MODEL_B} 10`]);
              expect(
                await embeddingSpendOf(
                  database.db,
                  PLATFORM_OWNER_ID,
                  passTask.taskId,
                ),
              ).toEqual([`${MODEL_B} 70`]);
              expect(await ledgerRowsOf(database.db, TEST_AUTHOR_ID)).toEqual(
                [],
              );
            } finally {
              endHeld.open();
              await closeAll([harness]);
            }
          },
        ),
      );
    },
    TEST_TIMEOUT_MS,
  );

  // ---------------------------------------------------------------------------------------------------------------
  // INT-12: the question vector - one per session and one per new employee message, billed to the starter  (NEW, v1.2)
  // ---------------------------------------------------------------------------------------------------------------
  // AC: AC-18.2 "Given координатор ответил на одно сообщение, when сотрудник пишет новое сообщение на другую тему, then следующий шаг координатора
  //   получает записи, близкие к новому сообщению"; AC-08.1 (the embeddings half: "стоимость эмбеддингов запуска и извлечения" in the
  //   starter's monthly spend). Design: UC-9, DC-14, KD-6, Invariant 12 (the vector is computed at the session's start and at each new message
  //   to the deep agent; model and compaction steps only read it).
  // Behavior: the graph is above the limit, items have vectors (two topics) -> the deep agent and one subagent session start and each make
  //   several steps (some compacted) -> the employee writes the deep agent a message on the other topic -> the next deep agent step -> the
  //   run ends, the extraction adds items, the embedding pass runs.
  // Verification items:
  //   - embedding calls with `inputType` `query`: one per session (deep agent, subagent) plus one for the new message, however many steps and
  //     compaction steps ran; none is made by a step or by the compaction step
  //   - the deep agent step after the message carries the items close to the new topic and not those close to the first topic; the subagent's
  //     block is unchanged by the message
  //   - the ledger rows of the session vectors and of the pass belong to the starter (not the author, not the platform), each with its own task
  //     number (the session's task, the pass's task), and the starter's monthly spend rose by their sum
  //   As built: the graph over the cap (`seedOverLimit`) with vectors of model A on billing, its fact and refunds; the archives have none, so
  //   the pass the first round queues embeds them on the starter (the extraction adds nothing in either round). The scout's three calls are a
  //   model step, a compaction step and a model step; the deep agent makes three or more model steps before the message. The new message is
  //   sent after the first round and its pass; the run is followed to the second round and its pass. The scripted provider counts 10 input
  //   tokens a text and model A costs 0.25 USD a million, so the starter - a new user - has 70 tokens, 0.0000175 USD, on model A this month.
  // Catches: a question vector recomputed at every step (spend multiplied by the step count and the prompt cache rewritten every step), a new
  //   message that keeps the old topic's items, and embedding spend billed to nobody or to the wrong person.
  // @category: core-functionality
  // @dependency: AgentStepHandler (question row, last `user_message`), knowledgeBlock, compactionStep, knowledge.embed handler, EmbeddingClient (double), KnowledgeVectorStore (real pgvector), token ledger, ModelClient (scripted), Postgres
  // @complexity: high
  it(
    'INT-12: the question vector is computed once per session and once per new deep agent message, steps get the items close to the latest message, and the spend lands on the starter',
    async () => {
      // Given: a learning deep agent over the cap with billing and refunds records that have vectors of model A; embeddings on model A
      const recordId = randomUUID();
      const library = createLibraryDouble();
      library.add(learningDeepAgent(recordId, [SCOUT]));
      const starter = newUser();
      const refundsMessage = 'Now look into the refunds';
      const model = createScriptedModel();
      model.script({ agent: KNOWLEDGE_EXTRACT_AGENT }, [], {
        thereafter: RECORDS_NOTHING,
      });
      const scout = compactingScoutScript(model, 'Scout the billing logs');

      await withLibraryRow(database.db, recordId, () =>
        withKnowledgeLimit(
          database.db,
          KNOWLEDGE_LIMIT_TOKENS_MIN,
          async () => {
            await seedOverLimit(database.db, recordId, [
              'billing',
              'fact',
              'refunds',
            ]);
            const harness = await learningHarness(model, library, {
              variables: COMPACTING,
            });
            harness.embeddingVerdict = TEST_EMBEDDING_MODEL_A;
            harness.embeddings.vectorOf = topicVector;
            try {
              // When: a run about billing - the deep agent starts the scout, the scout searches, compacts and reports, the run ends
              const run = await startLearningRun(harness, model, {
                ownerId: starter,
                recordId,
                turns: [
                  {
                    text: 'Coordinate the billing question',
                    scout: 'Scout the billing logs',
                  },
                  { text: refundsMessage, scout: null },
                ],
              });
              const scoutId = await startedChild(harness, run.deepAgentId);
              const first = await waitForRound(database.db, run.deepAgentId);
              await waitForEmbedPass(
                database.db,
                recordId,
                first.lastAt ?? new Date(0),
              );
              const [passTask, ...morePasses] = await knowledgeTasksOf(
                database.db,
                { recordId },
              );
              if (passTask === undefined) throw new Error('no vector pass');
              const beforeMessage = run.deepAgent.calls.length;

              // When: the employee writes the deep agent about refunds; the run ends again
              const second = await roundAfterTurn(
                harness,
                {
                  ownerId: starter,
                  runId: run.deepAgentId,
                  text: refundsMessage,
                },
                first,
              );
              await waitForEmbedPass(
                database.db,
                recordId,
                second.lastAt ?? new Date(0),
              );

              // Then (KD-6, Invariant 12): one question vector for each session and one for the message, in that order, however many
              // model and compaction steps ran
              expect(morePasses).toEqual([]);
              expect(scout.calls).toHaveLength(3);
              expect(lastUserText(scout.calls[1])).toContain(
                COMPACTION_REQUEST_START,
              );
              expect(
                embeddingRequestsOf(harness, 'query').map(
                  (call) => `${call.model} ${call.texts.join(' | ')}`,
                ),
              ).toEqual([
                `${MODEL_A} Coordinate the billing question`,
                `${MODEL_A} Scout the billing logs`,
                `${MODEL_A} ${refundsMessage}`,
              ]);

              // Then (AC-18.2): before the message every step of both sessions got the billing records; after it the deep agent's
              // steps get the refunds record and not the billing ones
              expect(
                distinctBlocks([
                  ...run.deepAgent.calls.slice(0, beforeMessage),
                  ...scout.calls,
                ]),
              ).toEqual([BILLING_BLOCK]);
              expect(
                distinctBlocks(run.deepAgent.calls.slice(beforeMessage)),
              ).toEqual([REFUNDS_BLOCK]);

              // Then (AC-08.1, DC-14): the session vectors are the starter's under each session's task, the pass's vectors of the
              // archives the starter's under the pass's task; nothing on the author or the platform; the month on model A is their sum
              expect(
                await embeddingSpendOf(database.db, starter, run.deepAgentId),
              ).toEqual([`${MODEL_A} 10`, `${MODEL_A} 10`]);
              expect(
                await embeddingSpendOf(database.db, starter, scoutId),
              ).toEqual([`${MODEL_A} 10`]);
              expect(
                await embeddingSpendOf(database.db, starter, passTask.taskId),
              ).toEqual([`${MODEL_A} 40`]);
              for (const taskId of [
                run.deepAgentId,
                scoutId,
                passTask.taskId,
              ]) {
                expect(
                  await embeddingSpendOf(
                    database.db,
                    PLATFORM_OWNER_ID,
                    taskId,
                  ),
                ).toEqual([]);
              }
              expect(await ledgerRowsOf(database.db, TEST_AUTHOR_ID)).toEqual(
                [],
              );
              const month = new Date().toISOString().slice(0, 7);
              expect(
                (
                  await harness.runtime.ledger.monthSpendByModel(starter, month)
                ).get(MODEL_A),
              ).toBe(0.0000175);
            } finally {
              await closeAll([harness]);
            }
          },
        ),
      );
    },
    TEST_TIMEOUT_MS,
  );
});
