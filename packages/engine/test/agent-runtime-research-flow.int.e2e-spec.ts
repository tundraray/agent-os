// agent-runtime / research-flow Integration Test Skeletons (engine side) - Design Doc: docs/features/agent-runtime/design-research-flow.md (v1.3, approved 2026-11-08)
// PRD: docs/features/agent-runtime/prd.md v1.1 (FR-12..FR-20). Consumes: docs/features/agent-runtime/design-agent-core.md (v1.6, approved) - its Test Strategy and its skeletons
// `agent-runtime-agent-core.int.e2e-spec.ts` / `agent-runtime-agent-core.e2e-spec.ts` (what they prove is not proven again here). ADRs: ADR-0001, ADR-0004, ADR-0005 / ADR-0009, ADR-0006, ADR-0008, ADR-0010. UXRD: none (part without UI).
// Generated: 2026-11-08 | Part: research-flow | Test type: Integration (in-process runtime + engine + real Postgres, scripted model, the SHIPPED v3 configuration), CI job `e2e-engine`
// Implementation timing: created alongside the slice each test names (INT-1 the v3 tree + the six definitions + the claim/answer code of the forms; INT-2 the shared-row guards under concurrency, stop and close;
//   INT-3 the forced ends of the root; INT-4 after the first real-model runs of v3 have been recorded).
//
// File name and placement. Same package, harness and config as `agent-runtime-agent-core.int.e2e-spec.ts` (`test/**/*.e2e-spec.ts` of `vitest.config.e2e.ts`; run with
// `pnpm --filter @agent-os/engine test:e2e`, never in the default `vitest run`). The api half of the part (self-check run / replay / show / compare on v3, the switch flag in the server) is `apps/api/test/agent-runtime-research-flow.int.e2e-spec.ts`
// (INT-5) and `apps/api/test/agent-runtime-research-flow.e2e-spec.ts` (E2E-2). The process-kill file of this package is `agent-runtime-research-flow.e2e-spec.ts` (E2E-1).
//
// Generated as `it.todo` skeletons so the file loads under lint, typecheck and `vitest run`. Implement each todo following its Given/When/Then comments when its slice lands. Do not convert a todo into a passing stub.
//
// Light test process (owner decision): integration and E2E skeletons exist only for the risky UCs of the Test Strategy - the v3 tree on six definitions (UC-1, UC-2, UC-4, UC-7), concurrency (UC-E4, UC-E7), stop/close (UC-E6),
// the forced ends of the root (UC-3, UC-E8), the recorded-run regression (UC-R3), restart (UC-E5 -> E2E-1 of this package), self-check on v3 and the switch flag (api files). Every other UC is a unit test named in the plan
// (list "Proven elsewhere" at the end).
//
// Environment (Design Doc "Test Strategy": the scenarios run on the shipped v3 configuration, each agent's model answers by script with tool calls):
// - Postgres 16 from infra/docker-compose.yml. Real `createRuntime` and real `createEngine` with the real `AgentRunHandler` (`agent.root`, `agent.run`) of agent-core, the real research tools (`gather`, `claims_write`, `plan_write`), the real
//   forms `research_close` / `answer_draft` / `claim_assessment` with their prologue / closure / forced-end code, the real answer gateway, the real `ModelGateway` over the real `postgresCallLedger`. Boundary doubles only: the scripted
//   language-model double (per agent) and the counting source (`countingSource.ts`, impersonating the fixture source and tool names, so the shipped config passes its source check unchanged); the counting source is the independent counter of "source called once".
// - The process is the SHIPPED `deep-research` v3 (`deepResearchProcessV3` from `deep-research.v3.json`, started with `version: 3`), not a probe: this part's risk is in the shipped definitions, their allowed calls, windows, shares and forms.
//   Rows that need small numbers (budget, deadline, turns, overflow) use `researchFlowV3Config(overrides)`: the shipped data with only the named numbers changed, the result still validated by the loader.
// - Group table: a test table keyed by the pair of fingerprints the harness reads from the LOADED config (`agentFingerprint` of the verifier, `definitionMemoryFingerprint` of its empty memory), every `supported` claim gets group `medium` (plan T5.1: with no table a claim gets `low` too, so `low` would hide the binding). It is built from
//   the loaded config, never hard-coded, so an edit of a shipped prompt does not turn a test red (a changed verifier needs a new shipped table; that is the calibration's test, E2E-2).
// - Isolation (project convention, no truncate): a unique `resourceId` and `launchKey` per test (test/support/new-user.ts); `fileParallelism: false`; `cancelStarted()` in afterEach.
// - "Model evaluates, algorithm decides": the double returns only tool calls (and `finish` results) by schema; no assertion reads a keyword of model text. Codes and reasons the engine writes (`pointer_invalid`, `tool_not_in_definition`,
//   `budget_exhausted`, `repeat`, `context_overflow`, ...) are compared as literals from the Design Doc.
// - Time: runtime deadlines and leases ride the injected harness `clock` / `expireLease`; the engine clock (`engineClock.offsetMs`) moves only `notAfter`. No sleeps for ordering, no latency assertions.
//
// Support the plan must add FIRST (existing support files are NOT edited by this skeleton set; the plan's first harness task does it; items 1, 3 and 4 of the agent-core int file's list are assumed done and are only extended here):
// 1. scriptedModel.ts - the `agent` role of agent-core (tool-call steps, per-agent scripts, per-call records, `holdUntil` / `hangUntilAborted` / `providerError` on tool-call steps, the `fallback` program) EXTENDED for six agents of the shipped config:
//    (a) recognise the agent by the SYSTEM BLOCK of its loaded definition: the harness builds the map agent name -> the leading text of `config.agents[name].systemPrompt` from the loaded config object (the shipped prompts carry no marker, a probe marker
//        cannot be added to shipped data; `worker` and `subworker` prompts differ - "как у worker, без указания про подветку" - so the leading text separates them; if a prompt edit makes two leading texts equal the harness fails loudly);
//    (b) a step kind whose tool-call arguments are computed from the prompt: `{ toolCalls: (view) => [...] }`, where `view` is the parsed session so far (tool results by tool name in order - page ids from `gather`, claim numbers from `claims_write`,
//        run ids from `call_agent`, the plan revision), because the ids a controller or worker must send exist only after earlier results; without it the scenarios cannot be scripted;
//    (c) a latch helper (`model.latch(n)`: the first call of each of n agents is held until n have arrived) for INT-2 A and B, and `model.callsOfAgent(name)`;
//    (d) a "refuse form" step for `claim_assessment` (an answer outside the closed form) for the unit/E2E rows named elsewhere.
// 2. test-configs.ts - `researchFlowV3Config(overrides)` (windows stay valid for the loader's smallest-view rule; overrides: `limits.investigationTokens`, per-agent `runTokens` / `deadlineMs` / `maxTurns` / `maxChildren`, `agentLimits.maxDepth`, root
//    `deadlineMs`), and `researchFlowGroupTable(config)` (the table above).
// 3. engineHarness.ts - export `deepResearchProcessV3` use (`processes: [deepResearchProcessV3]`, `groupTables` from item 2); a source answer with a hold on the first call (INT-2 A) if `countingSource.answerWith` has none; a way to start the
//    investigation in `model_knowledge` mode (no connected source: the harness `source` option with an empty source list) for INT-1 B.
// 4. engineDb.ts - read-only snapshots: `research_agent_runs` with parent run, call number, task text, result, status, own and subtree spend; `research_agent_tool_calls` with agent, tool, outcome, reason and the parent run; claim revisions with the
//    author run (worker / verifier closure / root gate); evidence pages with the `repeat` mark; the engine run row with the written answer; `llmCallsOf(investigationId)` by role `agent`.
// 5. A fixture source with enough records: the scenario `answerWith` records are shaped like the real source's count groups and log lines, so the pointer rules and `checkAtoms` see what they see in production (the UC-R1 lesson: a double whose records differ
//    from the real source hides the defect).
//
// Budget (this file): Integration 4 of the part's 5 (the fifth, INT-5, is in the api file; limit 3, up to 5 under the integration-e2e-testing rule only when each extra test names the defect no other test catches). Core: INT-1, INT-2, INT-3. The extra is
//   INT-4 (the recorded-run regression) - unique defect: the scripted calls of every other test are written by the same author who wrote the definitions and so agree with them; only the answers a REAL model gave, played back by place in the tree,
//   show a call, argument shape or order the definitions do not accept (the design names this its guard against "the scenarios' calls differ from the real model's"). E2E: 1 of the part's 2 in the sibling file (E2E-1), the other is in the api.
//   INT-2 groups its rows of one boundary (the research tables written by several runs at the same time, and the guards that take them down); if the plan needs room it demotes B to a real-Postgres repository spec - A and C are not reproducible below this level.
//
// AC -> proving test (the plan reads this to avoid a second test for an AC already proven; "unit" = a table-driven unit spec named in the plan):
// - AC-12.1: INT-1 A (and INT-4); AC-12.2: INT-1 A (the subworker call without a controller turn between); AC-12.3 and AC-07.1 for this part: INT-3 (the wiring: a forced end of the root becomes an answer by code and a `completed` investigation); the precedence of the reasons: unit
// - AC-12.4: INT-1 B
// - AC-15.1: INT-1 A (the tree ends with an answer built by the same gateway; groups, links, summary), INT-4 (the same on a real model's answers), UC-R1 on v3: unit (recorded-runs.spec.ts); AC-15.2: INT-1 A
// - AC-17.1, AC-17.2: INT-1 A (the controller repeats a read and a worker repeats a collection: no rejection for repeat or novelty; the controller's session shows its calls in order)
// - AC-08.1 (this part's write paths): INT-2 C; AC-08.2 (the completed-with-answer half agent-core left to this part), DC-2: agent-core INT-3 C (absorbed INT-2 D)
//
// Post-implementation cycle 1 (test audit, owner approved): INT-1 C moved to the v3 refusal table of src/config/agent-config.spec.ts; INT-2 D merged into
// agent-runtime-agent-core.int.e2e-spec.ts INT-3 C; INT-2 F is the second row of INT-2 E; INT-3 B merged into agent-core INT-5 UC-E14 and INT-3 A here
// (the reason `deadline` stays in src/research-flow/forms/stop-reason.spec.ts).
// - DC-11 (the repeat): INT-2 A for the race of two workers, unit for the key; UC-E7 (two checks of one claim): INT-2 B
// - DC-8 (the atomic closure after a restart), DC-2 (the answer written once): E2E-1 of this package
// - AC-13.1, AC-13.2, DC-4 (UC-5), DC-5 (the boot refusal) and AC-14.x, AC-16.x, AC-18.x, AC-19.x, AC-20.1: unit and the api files, see their headers
// - DC-6 (UC-E1), DC-7 and DC-8 (UC-E2), DC-9 (UC-E3), DC-10, DC-12, DC-13, UC-R1 on v3, AC-16.3, AC-20.1 metric: unit, see "Proven elsewhere"

import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { AgentProcessConfigSchema } from '../src/config/agent-config.schema.js';
import { promptVersion } from '../src/model/prompt-version.js';
import { readRunRecord } from '../src/runs/run-record.js';
import { createDatabase } from '@agent-os/db';
import { createRuntime, parseRuntimeConfig, systemClock } from '@agent-os/runtime';
import { COUNTING_SOURCE_ID, sourceCountGroup, sourceLogLine } from './support/countingSource.js';
import { databaseUrl } from './support/database-url.js';
import {
  agentRowsOf,
  agentToolCallsOf,
  answerRowOf,
  assertNoActiveInvestigations,
  claimRevisionsOf,
  closeEngineDb,
  engineRunsOf,
  gatherPagesOf,
  llmCallsOf,
  llmTranscriptsOf,
  sessionOf,
  tasksOf,
} from './support/engineDb.js';
import { createResearchFlowHarness, type EngineHarness, type ResearchFlowHarnessOptions } from './support/engineHarness.js';
import { newLaunchKey, newUser } from './support/new-user.js';
import { type AgentCallView, assessment, finishText, type ScriptedStep, type ScriptedToolCall, type ScriptedUsage, verifierPacketOf } from './support/scriptedModel.js';
import { agentPromptsOf, type ResearchFlowAgent, researchFlowGroupTable, researchFlowV3Config } from './support/test-configs.js';

// INT-1: the usage every scripted turn reports (1 050 charged tokens a turn), and how long a case may run: tens of runtime hops.
const TURN_USAGE: ScriptedUsage = { inputTokens: 1_000, outputTokens: 50 };
const SETTLE_MS = 60_000;
const CASE_MS = 120_000;

const RUNTIME = { concurrency: 4, dbPoolMax: 10 } as const;

const call = (tool: string, args: unknown): ScriptedToolCall => ({ tool, args });

/** A gate a test opens once; waiting on an open gate goes on at once. */
function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open: () => open() };
}

/** `turns` answers of one agent from one program: concurrent runs of an agent are told apart by the view, not by arrival order. */
function scriptTurns(harness: EngineHarness, agent: ResearchFlowAgent, turns: number, program: (view: AgentCallView) => readonly ScriptedToolCall[]): void {
  const step: ScriptedStep = { toolCalls: program, usage: TURN_USAGE };
  harness.model.scriptAgent(agent, ...Array.from({ length: turns }, () => step));
}

interface StartedResearch {
  readonly investigationId: string;
  readonly rootTaskId: string;
  readonly resourceId: string;
}

/** Starts the question on `version` of deep-research; with `null`, on the highest loaded version. */
async function startResearch(harness: EngineHarness, query: string, version: number | null = 3): Promise<StartedResearch> {
  const resourceId = newUser();
  const started = await harness.engine.startInvestigation({
    resourceId,
    threadId: await harness.createThread(resourceId),
    query,
    processId: 'deep-research',
    ...(version === null ? {} : { version }),
    launchKey: newLaunchKey(),
  });
  if (started.outcome === 'rejected') throw new Error(`start refused: ${started.code}`);
  return { investigationId: started.investigationId, rootTaskId: started.controllerTaskId, resourceId };
}

/** Waits until the investigation is closed; returns its view. */
function closedView(harness: EngineHarness, { investigationId, resourceId }: StartedResearch) {
  return vi.waitFor(
    async () => {
      const read = await harness.engine.readInvestigation({ investigationId, resourceId });
      if (read.outcome !== 'found') throw new Error(`investigation ${investigationId} not found`);
      if (read.view.status === 'running') throw new Error(`investigation ${investigationId} is still running`);
      return read.view;
    },
    { timeout: SETTLE_MS, interval: 50 },
  );
}

async function agentTreeOf(harness: EngineHarness, { investigationId, resourceId }: StartedResearch) {
  const read = await harness.engine.readAgentTree({ investigationId, resourceId });
  if (read.outcome !== 'found') throw new Error(`tree of ${investigationId} not found`);
  return read.tree;
}

/** The stored answer of the engine row, as the fields INT-1 reads. */
interface StoredResearchAnswer {
  readonly outcome: string;
  readonly stopReason: string | null;
  readonly summaryItems: readonly { readonly claimId: string; readonly text: string; readonly confidence: string }[];
  readonly established: readonly { readonly claimId: string; readonly text: string; readonly evidenceIds: readonly string[]; readonly verified: boolean; readonly confidence: string | null }[];
  readonly assumed: readonly { readonly text: string; readonly verified: boolean }[];
  readonly unknown: readonly { readonly claimId: string; readonly text: string }[];
  readonly removed: readonly { readonly claimId: string; readonly text: string; readonly reason: string }[];
  readonly message: {
    readonly text: string;
    readonly metadata: { readonly sourceMode: string; readonly sources: readonly { readonly number: number; readonly sourceId: string; readonly toolName: string }[] };
  };
}

// The scenario of INT-1 A, as data the double recognises itself by: its own assignments and claim texts, never a reading of the engine's text.
const QUERY_A = 'Why did payments time out between 19:00 and 20:00?';
const BRANCH_A = 'Branch A: search payment-api errors from 19:00 to 20:00';
const BRANCH_B = 'Branch B: search payment-api errors the second way';
const SUB_BRANCH = 'Sub-branch: count payment-api errors by hour';
const SEARCH_ARGS = { service: 'payment-api', from: '2026-09-15T19:00:00.000Z', to: '2026-09-15T20:00:00.000Z' };
const AGGREGATE_ARGS = { service: 'payment-api', groupBy: 'level', bucket: 'hour', from: '2026-09-15T19:00:00.000Z', to: '2026-09-15T20:00:00.000Z' };
const CLAIM_A_SUPPORTED = 'payment-api logged a timeout at 19:04';
const CLAIM_A_REFUTED = 'payment-api logged no error at 19:04';
const CLAIM_B_SUPPORTED = 'payment-api logged the failed payment event';
const CLAIM_SUB_UNDECIDED = 'payment-api logged twelve errors in the hour';
const MEMORY_CONCLUSION = 'The provider contract changed at 18:55 and that caused everything';
const TIMEOUT_ATOM = { kind: 'text', value: 'timeout' } as const;

/** The assessment of each claim, by the exact text the scenario wrote. */
const VERDICTS: Readonly<Record<string, { readonly support: string; readonly relation: string }>> = {
  [CLAIM_A_SUPPORTED]: { support: 'yes', relation: 'supports' },
  [CLAIM_A_REFUTED]: { support: 'no', relation: 'contradicts' },
  [CLAIM_B_SUPPORTED]: { support: 'yes', relation: 'supports' },
  [CLAIM_SUB_UNDECIDED]: { support: 'insufficient', relation: 'unrelated' },
};

/** The `gather` of one branch, with the pair taken from the `{{sources}}` lines of the worker's own system block (UC-13). */
function gatherFromSystemBlock(view: AgentCallView, toolName: string, args: Readonly<Record<string, unknown>>): ScriptedToolCall {
  const line = view.sourceLines.find((candidate) => candidate.toolName === toolName);
  if (line === undefined) throw new Error(`no {{sources}} line for ${toolName} in the system block`);
  return call('gather', { sourceId: line.sourceId, toolName: line.toolName, args, completeness: 'sample' });
}

const firstPage = (view: AgentCallView): string => {
  const [page] = view.pages;
  if (page === undefined) throw new Error('no gathered page in the session');
  return page.page;
};

const verifierCall = (claimId: string | undefined): ScriptedToolCall => {
  if (claimId === undefined) throw new Error('no claim id in the session');
  return call('call_agent', { agent: 'verifier', assignment: claimId });
};

/** The claims of a synthesis packet, read by the packet's own structure. */
function packetClaims(view: AgentCallView): readonly { readonly claimId: string; readonly status: string; readonly text: string; readonly pointer: unknown }[] {
  const open = '<assignment>\n';
  const start = view.assignment.indexOf(open) + open.length;
  const end = view.assignment.indexOf('\n</assignment>', start);
  return (JSON.parse(view.assignment.slice(start, end)) as { claims: ReturnType<typeof packetClaims> }).claims;
}

// Rule 9 of the plan: the suite leaves no `active` investigation of the users it started them for.
afterAll(async () => {
  try {
    await assertNoActiveInvestigations();
  } finally {
    await closeEngineDb();
  }
});

describe('agent-runtime / research-flow - integration (in-process runtime + engine + real Postgres, scripted model, shipped v3)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-1  The v3 tree on its six definitions: a question to an answer, and the same without sources (UC-1, UC-2, UC-7, UC-4)
  // ---------------------------------------------------------------------------------------------------------------
  // AC: "AC-12.1: Given расследование по v3 завершено, Then в его дереве есть запуски агентов плана, controller, worker, проверяющего и synthesis."
  // AC: "AC-12.2: Given определение worker-агента разрешает вызов другого агента, When worker вызывает его посреди своего задания, Then вызов исполнен, и шага controller между ними нет."
  // AC: "AC-15.1: Given расследование по v3, Then выполняются критерии FR-09, FR-11, FR-12, FR-13, FR-14 и FR-16 PRD agent-quality."  (the assembly half: answer sections, groups, links, summary)
  // AC: "AC-15.2: Given агент записал в память или вернул в результате вывод, которого нет среди проверенных утверждений, Then в «Установлено» и в сводке ответа этого вывода нет."
  // AC: "AC-17.1: Given controller-агент в расследовании по v3 сделал несколько ходов, When разработчик открывает его сессию, Then в ней по порядку видны все его прежние вызовы и их результаты, и ни один его вызов код не отклонил за отсутствие новизны."
  // AC: "AC-17.2: Given расследование по v3, Then ни один вызов controller-агента не отклонён кодом за повтор или за отсутствие новизны."
  // AC: "AC-12.4: Given в развёртывании не подключён ни один источник данных, When расследование идёт по v3, Then выполняются критерии FR-25 и FR-27 PRD deep-research: ответ на знаниях модели с пометкой у каждого утверждения и предупреждением в беседе."
  // AC (Design Doc): "DC-3: В режиме без источников корень - определение `modelKnowledgeRoot`, и журнал вызовов показывает только его ходы."
  // Behavior: A - question -> controller calls planner -> two workers on two branches (worker A calls subworker mid-task) -> every claim written by `claims_write` is handed to a `verifier` run -> controller calls synthesis -> `finish(research_close, answer)`
  //   -> the root's closure passes the gates, the answer gateway builds the answer, ONE guarded write stores answer + message + root result -> `engine.lifecycle` closes the investigation `completed`;
  //   B - no connected source -> the root is `synthesis` alone -> `finish(answer_draft)` -> the root's closure screens the draft in `model_knowledge` mode and writes the answer.
  // Catches: A - the root not recognised as the root task so the investigation never closes; or the answer written after the root's result instead of with it; a subworker call that still passes through a controller turn;
  //   a verification revision written by anything but the verifier's closure, or a status taken from the model's text instead of the assessment's fields; a conclusion kept in memory or in a child's result promoted into "Установлено";
  //   a repeated collection or a repeated read refused for "no novelty"; a controller session that loses an earlier call. B - the mode ignored (a controller and a planner called for a question with no sources), a claim not marked
  //   as model knowledge, a missing warning, an outcome other than `answered`.
  // @category: core-functionality
  // @dependency: AgentRunHandler, the six definitions of deep-research v3, gather / claims_write / plan_write, forms research_close / answer_draft / claim_assessment, answer gateway, engine.lifecycle, TaskScheduler, readAgentTree, real Postgres
  // @complexity: high
  //
  // Row A (UC-1, UC-2, UC-7; the two workers' scripts are written so the other asserted facts are exact)
  //   Given (the shipped v3, `version: 3`, one user, the counting source answering the scenario's records; every scripted step has explicit `usage`):
  //     controller: turn 1 `memory_read` + `investigation_read` (and again in turn 2 - a deliberate repeat), turn 3 `call_agent(planner)`, turn 4 two `call_agent(worker)` with one branch each; after both results, `call_agent(synthesis)` (every
  //       claim was already handed to a verifier by the workers, so the controller checks nothing itself); then `finish(research_close, { answer: <the synthesis run> })`.
  //     planner: `investigation_read`, `plan_write`, `finish`. worker A: `gather`, `claims_write` (2 claims), `call_agent(verifier)` for the first, `call_agent(subworker)` with a sub-branch, `call_agent(verifier)` for the second, `memory_write` of a
  //       CONCLUSION that is not among its claims, `finish` whose result text repeats that conclusion. worker B: the SAME `gather` as worker A (same source, tool, args, slice), then `claims_write` (1 claim), `call_agent(verifier)`, `finish`.
  //       subworker: `gather`, `claims_write` (1 claim), `call_agent(verifier)`, `finish`. verifier (one script per run, taken by the claim number in the task): `finish` with an assessment that supports one claim and does not support another.
  //       synthesis: `finish(answer_draft)` over the supported claims, summary ids from them.
  //   When: the investigation is started through `engine.startInvestigation` and the root run ends.
  //   Then (verification items):
  //   - Tree (AC-12.1): `readAgentTree` shows runs of `controller` (root), `planner`, two `worker`, one `subworker`, one `verifier` per written claim and `synthesis`; every run has parent run, call number, task text, result, own and subtree spend;
  //     the transcripts of its turns have role `agent`
  //   - No controller between (AC-12.2): between the moment worker A's `call_agent(subworker)` is recorded and the subworker's result in worker A's session, the controller's turn count did not change (the controller is waiting; the call went from worker to subworker
  //     by `call_agent`, not through the controller)
  //   - Verification (KD-2): every claim a worker or the subworker wrote has two revisions - the author's `unverified` and a verification revision whose task is a `verifier` run; its status follows the assessment's fields (the supported claim `supported`, the other not),
  //     its group is the test table's `medium`; no revision of any claim was written by another path
  //   - The result of a verifier handed to the worker is the claim number, status and group only - no packet and no model text in the worker's session (KD-2)
  //   - Answer (AC-15.1): the answer sections are those of the config; "Установлено" holds exactly the claims whose last revision is a verification revision with status `supported`, with links from their basis; the summary is built from them
  //   - Memory is data (AC-15.2): the conclusion worker A put in memory and in its result text is in neither "Установлено" nor the summary
  //   - Controller session (AC-17.1): the messages of the controller's session hold its calls and their results in the order of the turns, the repeated `investigation_read` included
  //   - No patch (AC-17.2): no tool call of any run of the tree is `rejected` for repeat or novelty; worker B's `gather` is NOT rejected (its result carries the mark `repeat`, DC-11 - the race of the same call is INT-2 A, here only the sequence is read)
  //   - Single write (KD-3): the engine run row holds the answer and the message, and the root's result in the same record (read as one row version / one `ts`); the investigation is `completed` and its reserves are closed
  //   - Task set: the investigation has exactly the tasks of the agent tree and of the source (`agent.root` 1, `agent.run` 9, `source.fetch` 2)
  // Row C (the {{sources}} refusal at the assembly) moved to the v3 refusal table of src/config/agent-config.spec.ts.
  // Row B (UC-4)
  //   Given: no connected source (mode `model_knowledge`); `synthesis` scripted with `finish(answer_draft)` with claims and an outcome other than `answered` in the draft (the code, not the model, sets the outcome); no other agent has a script (a call to it would be an unscripted step and fail the test).
  //   When: the investigation is started and finishes.
  //   Then: `completed`; the tree holds one run, `synthesis`, as the root (no controller, planner, worker or verifier run); every claim of the answer is in "Предположения" with the model-knowledge mark, the warning opens the answer, the outcome is `answered`;
  //     the ledger rows of role `agent` belong to `synthesis` only (DC-3); the counting source got no call.
  describe('INT-1', () => {
    let harness: EngineHarness | undefined;

    const assemble = async (options: ResearchFlowHarnessOptions = {}): Promise<EngineHarness> => {
      harness = await createResearchFlowHarness({ runtime: RUNTIME, ...options });
      return harness;
    };

    afterEach(async () => {
      try {
        await harness?.cancelStarted();
      } finally {
        await harness?.close();
        harness = undefined;
      }
    });

    it(
      'INT-1 A: the shipped v3 tree - planner, two workers (one with a subworker), a verifier per claim, synthesis, research_close - ends with an answer of verified claims only, written with the root\'s result, without a controller turn inside a worker\'s call',
      async () => {
        const h = await assemble();
        h.countingSource.answerWith((source) =>
          source.toolName === 'aggregate_logs'
            ? [sourceCountGroup('error', 12)]
            : [sourceLogLine(), sourceLogLine({ spanSeq: 2, traceId: '5cf92f3577b34da7', event: 'payment.retry' })],
        );

        // Worker B collects after worker A's collection has ended, so the sequence (not the race, INT-2 A) is what is read.
        const firstGatherEnded = gate();
        h.tokenCounter.interceptTurn = async (request) => {
          if (JSON.stringify(request.messages).includes(BRANCH_B)) await firstGatherEnded.wait;
          return undefined;
        };

        scriptTurns(h, 'controller', 7, (view) => {
          switch (view.turn) {
            case 1:
            case 2:
              return [call('memory_read', {}), call('investigation_read', { view: 'claims' })];
            case 3:
              return [call('call_agent', { agent: 'planner', assignment: QUERY_A })];
            case 4:
              return [call('call_agent', { agent: 'worker', assignment: BRANCH_A }), call('call_agent', { agent: 'worker', assignment: BRANCH_B })];
            case 5:
              return [call('call_agent', { agent: 'synthesis', assignment: 'Write the answer' })];
            case 6:
              return [call('investigation_read', { view: 'runs' })];
            default: {
              const synthesis = view.runs.filter((run) => run.agent === 'synthesis').at(-1);
              if (synthesis === undefined) throw new Error('no finished synthesis run listed');
              return [call('finish', { answer: synthesis.run })];
            }
          }
        });
        scriptTurns(h, 'planner', 3, (view) => {
          if (view.turn === 1) return [call('investigation_read', { view: 'plan' })];
          if (view.turn === 2) {
            return [
              call('plan_write', {
                readinessCriteria: ['the cause of the timeouts is named'],
                branches: [{ question: 'What did payment-api log?', approach: 'search its errors' }],
                reason: 'there is no plan yet',
              }),
            ];
          }
          return [finishText('The plan has one branch')];
        });

        const controllerTurns: { atSubworkerCall?: number; atSubworkerResult?: number } = {};
        const workerViews: AgentCallView[] = [];
        const programA = (view: AgentCallView): readonly ScriptedToolCall[] => {
          switch (view.turn) {
            case 1:
              return [gatherFromSystemBlock(view, 'search_logs', SEARCH_ARGS)];
            case 2:
              firstGatherEnded.open();
              return [
                call('claims_write', {
                  claims: [
                    { text: CLAIM_A_SUPPORTED, atoms: [TIMEOUT_ATOM], pointer: [{ pageId: firstPage(view), records: [0] }] },
                    { text: CLAIM_A_REFUTED, atoms: [TIMEOUT_ATOM], pointer: [{ pageId: firstPage(view), records: [1] }] },
                  ],
                }),
              ];
            case 3:
              return [verifierCall(view.claimIds[0])];
            case 4:
              controllerTurns.atSubworkerCall = h.model.callsOfAgent('controller').length;
              return [call('call_agent', { agent: 'subworker', assignment: SUB_BRANCH })];
            case 5:
              controllerTurns.atSubworkerResult = h.model.callsOfAgent('controller').length;
              return [verifierCall(view.claimIds[1])];
            case 6:
              return [call('memory_write', { kind: 'finding', text: MEMORY_CONCLUSION, refs: [] })];
            default:
              workerViews.push(view);
              return [finishText(MEMORY_CONCLUSION)];
          }
        };
        const programB = (view: AgentCallView): readonly ScriptedToolCall[] => {
          switch (view.turn) {
            case 1:
              return [gatherFromSystemBlock(view, 'search_logs', SEARCH_ARGS)];
            case 2:
              return [call('claims_write', { claims: [{ text: CLAIM_B_SUPPORTED, atoms: [TIMEOUT_ATOM], pointer: [{ pageId: firstPage(view), records: [0] }] }] })];
            case 3:
              return [verifierCall(view.claimIds[0])];
            default:
              return [finishText('Branch B is done')];
          }
        };
        scriptTurns(h, 'worker', 11, (view) => (view.assignment === BRANCH_A ? programA(view) : programB(view)));
        scriptTurns(h, 'subworker', 4, (view) => {
          switch (view.turn) {
            case 1:
              return [gatherFromSystemBlock(view, 'aggregate_logs', AGGREGATE_ARGS)];
            case 2:
              return [call('claims_write', { claims: [{ text: CLAIM_SUB_UNDECIDED, atoms: [{ kind: 'number', value: '12' }], pointer: [{ pageId: firstPage(view), records: [0] }] }] })];
            case 3:
              return [verifierCall(view.claimIds[0])];
            default:
              return [finishText('The sub-branch is done')];
          }
        });
        const verifierViews: AgentCallView[] = [];
        scriptTurns(h, 'verifier', 4, (view) => {
          verifierViews.push(view);
          const packet = verifierPacketOf(view);
          const verdict = VERDICTS[packet.claimText];
          if (verdict === undefined) throw new Error(`no verdict for ${packet.claimText}`);
          return [
            call('finish', assessment({ support: verdict.support, claimType: 'observation', records: packet.records.map(({ number }) => ({ record: number, relation: verdict.relation })) })),
          ];
        });
        scriptTurns(h, 'synthesis', 1, (view) => {
          const claims = packetClaims(view);
          return [
            call('finish', {
              outcome: 'answered',
              summaryClaimIds: claims.filter((claim) => claim.status === 'supported').map((claim) => claim.claimId),
              claims: claims.filter((claim) => claim.status === 'supported').map(({ claimId, text, pointer }) => ({ claimId, text, atoms: [], pointer })),
            }),
          ];
        });

        const started = await startResearch(h, QUERY_A);
        const view = await closedView(h, started);
        h.tokenCounter.interceptTurn = undefined;
        const { investigationId, rootTaskId } = started;

        expect(view.status).toBe('completed');
        expect(h.model.pendingAgents()).toEqual({ controller: 0, planner: 0, worker: 0, subworker: 0, verifier: 0, synthesis: 0 });

        // Tree (AC-12.1): every run with its parent, call number, task text, result and spend (1 050 tokens a turn).
        const tree = await agentTreeOf(h, started);
        const nameOf = new Map(tree.runs.map((run) => [run.runTaskId, run.assignment === BRANCH_A ? 'worker A' : run.assignment === BRANCH_B ? 'worker B' : run.agentName]));
        const treeRows = tree.runs
          .map((run) => [nameOf.get(run.runTaskId), run.parent === null ? null : nameOf.get(run.parent.taskId), run.parent?.callIndex ?? null, run.assignment, run.status, run.spentTokens, run.subtreeSpentTokens])
          .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
        expect(treeRows).toEqual([
          ['controller', null, null, QUERY_A, 'succeeded', 7_350, 31_500],
          ['planner', 'controller', 4, QUERY_A, 'succeeded', 3_150, 3_150],
          ['subworker', 'worker A', 3, SUB_BRANCH, 'succeeded', 4_200, 5_250],
          ['synthesis', 'controller', 7, null, 'succeeded', 1_050, 1_050],
          ['verifier', 'subworker', 2, null, 'succeeded', 1_050, 1_050],
          ['verifier', 'worker A', 2, null, 'succeeded', 1_050, 1_050],
          ['verifier', 'worker A', 4, null, 'succeeded', 1_050, 1_050],
          ['verifier', 'worker B', 2, null, 'succeeded', 1_050, 1_050],
          ['worker A', 'controller', 5, BRANCH_A, 'succeeded', 7_350, 14_700],
          ['worker B', 'controller', 6, BRANCH_B, 'succeeded', 4_200, 5_250],
        ]);
        expect(tree.runs.every((run) => run.result !== null && run.failure === null)).toBe(true);
        expect(tree.budgetExhausted).toBe(false);

        // Every model call of the tree went through the ledger and the transcripts as an agent turn.
        const [ledger, transcripts, engineRows] = await Promise.all([llmCallsOf(investigationId), llmTranscriptsOf(investigationId), agentRowsOf(investigationId)]);
        expect(ledger).toHaveLength(30);
        expect(ledger.every((row) => row.status === 'settled')).toBe(true);
        expect(transcripts).toHaveLength(30);
        expect(new Set(transcripts.map((row) => row.role))).toEqual(new Set(['agent']));

        // No controller between (AC-12.2): the controller made its fourth turn, the workers', and no other while the subworker worked.
        expect(controllerTurns).toEqual({ atSubworkerCall: 4, atSubworkerResult: 4 });

        // Verification (KD-2): the author's revision and a revision of the closure of the verifier run called with that claim.
        const [revisions, calls] = await Promise.all([claimRevisionsOf(investigationId), agentToolCallsOf(investigationId)]);
        const claimOfVerifierRun = new Map(
          calls.flatMap((row) => (row.tool === 'call_agent' && (row.arguments as { agent: string }).agent === 'verifier' && row.childTaskId !== null ? [[row.childTaskId, (row.arguments as { assignment: string }).assignment] as const] : [])),
        );
        const revisionRows = revisions
          .map((row) => [row.text, row.authorAgent, row.status, row.confidence, row.authorAgent === 'verifier' ? claimOfVerifierRun.get(row.authorTaskId) === row.claimId : null])
          .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
        expect(revisionRows).toEqual(
          [
            [CLAIM_A_SUPPORTED, 'worker', 'unverified', null, null],
            [CLAIM_A_SUPPORTED, 'verifier', 'supported', 'medium', true],
            [CLAIM_A_REFUTED, 'worker', 'unverified', null, null],
            [CLAIM_A_REFUTED, 'verifier', 'refuted', null, true],
            [CLAIM_B_SUPPORTED, 'worker', 'unverified', null, null],
            [CLAIM_B_SUPPORTED, 'verifier', 'supported', 'medium', true],
            [CLAIM_SUB_UNDECIDED, 'subworker', 'unverified', null, null],
            [CLAIM_SUB_UNDECIDED, 'verifier', 'insufficient', null, true],
          ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
        );

        // The result of a verifier in the worker's session: the number, the status and the group, nothing of the packet or the answer.
        const idOf = (text: string): string => {
          const found = revisions.find((row) => row.text === text);
          if (found === undefined) throw new Error(`no claim ${text}`);
          return found.claimId;
        };
        const [lastTurnOfA] = workerViews;
        expect(lastTurnOfA?.children.filter((child) => child.agent === 'verifier').map(({ outcome, result }) => ({ outcome, result }))).toEqual([
          { outcome: 'success', result: { claimId: idOf(CLAIM_A_SUPPORTED), status: 'supported', group: 'medium' } },
          { outcome: 'success', result: { claimId: idOf(CLAIM_A_REFUTED), status: 'refuted', group: null } },
        ]);

        // UC-13: the pairs of the source come from the {{sources}} field of the worker alone; the former list is gone.
        const workerSystem = h.model.callsOfAgent('worker')[0]?.system ?? '';
        const anyArgsSchema = { type: 'object', propertyNames: { type: 'string' }, additionalProperties: {} };
        expect(lastTurnOfA?.sourceLines).toEqual([
          { sourceId: 'fixture', toolName: 'aggregate_logs', argsSchema: anyArgsSchema },
          { sourceId: 'fixture', toolName: 'get_trace', argsSchema: anyArgsSchema },
          { sourceId: 'fixture', toolName: 'search_logs', argsSchema: anyArgsSchema },
        ]);
        for (const tool of ['search_logs', 'aggregate_logs', 'get_trace']) expect(workerSystem).not.toContain(`- ${tool}:`);
        expect(verifierViews).toHaveLength(4);
        expect(verifierViews.flatMap((one) => one.sourceLines)).toEqual([]);

        // The answer (AC-15.1): sections of the config, established holds the supported claims with their basis, and the summary is built from them.
        const pages = await gatherPagesOf(investigationId);
        const row = await answerRowOf(investigationId);
        const answer = row?.engineRun.answer as StoredResearchAnswer;
        const searchPage = pages.gathered.find((one) => one.repeat === false && one.agent === 'worker')?.page;
        expect({ outcome: answer.outcome, stopReason: answer.stopReason }).toEqual({ outcome: 'answered', stopReason: null });
        expect([...answer.established].sort((left, right) => left.text.localeCompare(right.text))).toEqual(
          [CLAIM_A_SUPPORTED, CLAIM_B_SUPPORTED].sort((left, right) => left.localeCompare(right)).map((text) => ({ claimId: idOf(text), text, evidenceIds: [searchPage], verified: true, confidence: 'medium' })),
        );
        // The two supported claims of the summary, whichever verification ended first.
        expect([...answer.summaryItems].sort((left, right) => left.text.localeCompare(right.text))).toEqual(
          [CLAIM_A_SUPPORTED, CLAIM_B_SUPPORTED].sort((left, right) => left.localeCompare(right)).map((text) => ({ claimId: idOf(text), text, confidence: 'medium' })),
        );
        expect(answer.assumed).toEqual([]);
        expect(answer.unknown).toEqual([]);
        expect(answer.removed).toEqual([]);
        expect(answer.message.metadata.sources).toEqual([{ number: 1, sourceId: 'fixture', toolName: 'search_logs', snapshot: 'counting-v1', truncated: false }]);
        // The whole message, so the refuted and undecided claims and the conclusion in memory are absent by equality. The two
        // supported claims stand in the order their verifications ended, which the sorted checks above leave free.
        const [firstEstablished, secondEstablished] = answer.established.map((claim) => claim.text);
        expect(answer.message.text).toBe(
          [
            '**Ответ ресерча** · Есть ответ',
            `Цель: ${QUERY_A}`,
            '',
            '### Главное из установленного',
            `- ${firstEstablished} (уверенность средняя)`,
            `- ${secondEstablished} (уверенность средняя)`,
            '',
            '### Установлено',
            `- ${firstEstablished} [1] (уверенность средняя)`,
            `- ${secondEstablished} [1] (уверенность средняя)`,
            '',
            '### Источники (1)',
            '1. fixture · search_logs · counting-v1',
          ].join('\n'),
        );

        // Memory is data (AC-15.2): the conclusion was really written and returned, and stands nowhere in the answer.
        expect(engineRows.memory.map((note) => [note.agentName, note.text])).toEqual([['worker', MEMORY_CONCLUSION]]);
        const resultOfA = tree.runs.find((run) => run.assignment === BRANCH_A)?.result;
        expect(resultOfA).toEqual({ summary: MEMORY_CONCLUSION, refs: [] });
        expect(JSON.stringify(answer)).not.toContain(MEMORY_CONCLUSION);

        // The controller's session (AC-17.1): its calls and their results in the order of its turns, the repeated read included.
        const session = await sessionOf(rootTaskId);
        const sessionRows = session.flatMap((message) => {
          const content = message.content as { toolCalls?: { callIndex: number; toolName: string }[]; callIndex?: number; toolName?: string; outcome?: string };
          if (message.kind === 'model_answer') return (content.toolCalls ?? []).map((one) => ['call', one.callIndex, one.toolName]);
          if (message.kind === 'tool_result') return [['result', content.callIndex, content.toolName, content.outcome]];
          return [[message.kind]];
        });
        expect(sessionRows).toEqual([
          ['assignment'],
          ['call', 0, 'memory_read'],
          ['call', 1, 'investigation_read'],
          ['result', 0, 'memory_read', 'empty'],
          ['result', 1, 'investigation_read', 'empty'],
          ['call', 2, 'memory_read'],
          ['call', 3, 'investigation_read'],
          ['result', 2, 'memory_read', 'empty'],
          ['result', 3, 'investigation_read', 'empty'],
          ['call', 4, 'call_agent'],
          ['result', 4, 'call_agent', 'success'],
          ['call', 5, 'call_agent'],
          ['call', 6, 'call_agent'],
          ['result', 5, 'call_agent', 'success'],
          ['result', 6, 'call_agent', 'success'],
          ['call', 7, 'call_agent'],
          ['result', 7, 'call_agent', 'success'],
          ['call', 8, 'investigation_read'],
          ['result', 8, 'investigation_read', 'success'],
          ['call', 9, 'finish'],
          ['result', 9, 'finish', 'success'],
        ]);

        // No patch (AC-17.2, DC-11): nothing of the tree refused; worker B's same collection is answered from the stored page.
        expect(calls.filter((row) => row.state === 'rejected')).toEqual([]);
        expect(h.countingSource.calls.map((source) => source.toolName)).toEqual(['search_logs', 'aggregate_logs']);
        const gatheredBy = (runTaskId: string | undefined) =>
          pages.gathered.filter((one) => one.runTaskId === runTaskId).map(({ page, returned, repeat }) => ({ page, returned, repeat }));
        const runOf = (assignment: string) => tree.runs.find((run) => run.assignment === assignment)?.runTaskId;
        expect(gatheredBy(runOf(BRANCH_A))).toEqual([{ page: searchPage, returned: 2, repeat: false }]);
        expect(gatheredBy(runOf(BRANCH_B))).toEqual([{ page: searchPage, returned: 2, repeat: true }]);
        expect(gatheredBy(runOf(SUB_BRANCH)).map(({ returned, repeat }) => ({ returned, repeat }))).toEqual([{ returned: 1, repeat: false }]);
        expect(pages.stored).toHaveLength(2);

        // A single write (KD-3): the answer and the root's result in one row version; the investigation is closed with its reserves.
        expect(row?.engineVersion).toBe(row?.rootVersion);
        expect({ ...(row?.rootResult as object), message: answer.message }).toEqual(answer);
        expect(row?.engineRun.tokensReserved).toBe(0);
        expect(row?.engineRun.tokensSpent).toBe(31_500);

        // Task set: exactly the tasks of the agent tree and of the source.
        const workflowCounts = (await tasksOf(investigationId)).reduce<Record<string, number>>((counts, task) => ({ ...counts, [task.workflowType]: (counts[task.workflowType] ?? 0) + 1 }), {});
        expect(workflowCounts).toEqual({ 'agent.root': 1, 'agent.run': 9, 'source.fetch': 2 });

        // Carried over from agent-quality-self-check INT-1 T2: every turn's transcript carries the fingerprint of its own
        // definition's template. Defect caught: a turn that passes no prompt version, or another definition's.
        const config = AgentProcessConfigSchema.parse(researchFlowV3Config());
        const agentOfRun = new Map(tree.runs.map((run) => [run.runTaskId, run.agentName]));
        const versions = [...new Set((await llmTranscriptsOf(investigationId)).map((one) => `${agentOfRun.get(one.taskId ?? '')} ${one.promptVersion}`))];
        expect(versions.sort()).toEqual(
          ['controller', 'planner', 'subworker', 'synthesis', 'verifier', 'worker'].map((agent) => `${agent} ${promptVersion(config.agents[agent]!.prompt)}`),
        );

        // Carried over from agent-quality-engine INT-1 V1: the run record gives each claim's latest revision with its pointer,
        // type, group and assessment. Defect caught: the record drops the fields of the check, or gives an earlier revision.
        const record = await readRunRecord(h.db, { investigationId, ownerId: started.resourceId });
        if (record.outcome !== 'found') throw new Error('run record not found');
        const supported = record.record.claims.find((claim) => claim.text === CLAIM_A_SUPPORTED);
        expect(supported).toMatchObject({ status: 'supported', claimType: 'observation', confidence: 'medium', pointer: [{ pageId: searchPage, records: [0] }] });
        expect(supported?.assessment).toMatchObject({ answer: { support: 'yes' }, invalidForm: false });
      },
      CASE_MS,
    );

    it(
      'INT-1 B: with no source connected the root is synthesis alone, and its draft becomes an answer of model-knowledge assumptions with the warning and the outcome answered',
      async () => {
        const h = await assemble({ noSources: true });
        const assumptions = ['A timeout usually means the provider did not answer', 'Retries can multiply the load'];
        scriptTurns(h, 'synthesis', 1, () => [
          call('finish', { outcome: 'inconclusive', summaryClaimIds: [], claims: assumptions.map((text) => ({ claimId: null, text, atoms: [], pointer: [] })) }),
        ]);

        const started = await startResearch(h, 'Why do payments usually time out?');
        const view = await closedView(h, started);
        const { investigationId, rootTaskId } = started;

        expect(view.status).toBe('completed');
        const tree = await agentTreeOf(h, started);
        expect(tree.runs.map((run) => [run.agentName, run.parent, run.status])).toEqual([['synthesis', null, 'succeeded']]);

        const row = await answerRowOf(investigationId);
        const answer = row?.engineRun.answer as StoredResearchAnswer;
        expect({ outcome: answer.outcome, stopReason: answer.stopReason }).toEqual({ outcome: 'answered', stopReason: null });
        expect(answer.established).toEqual([]);
        expect(answer.assumed.map(({ text, verified }) => [text, verified])).toEqual(assumptions.map((text) => [text, false]));
        expect(answer.message.metadata.sourceMode).toBe('model_knowledge');
        expect(answer.message.text).toBe(
          [
            'Источники данных не подключены — ответ опирается только на знания модели и не проверен по данным.',
            '',
            '**Ответ ресерча** · Есть ответ',
            'Цель: Why do payments usually time out?',
            '',
            '### Предположения',
            '- A timeout usually means the provider did not answer (из знаний модели, без источника)',
            '- Retries can multiply the load (из знаний модели, без источника)',
          ].join('\n'),
        );
        expect(row?.engineVersion).toBe(row?.rootVersion);

        // DC-3: the journal holds only the turns of synthesis, and no source was asked.
        const ledger = await llmCallsOf(investigationId);
        expect(ledger.map((one) => one.taskId)).toEqual([rootTaskId]);
        expect(h.model.calls.map((one) => one.agent)).toEqual(['synthesis']);
        expect(h.countingSource.calls).toEqual([]);
      },
      CASE_MS,
    );
  });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2  Several runs at once on the shared research rows, stop and close (UC-E4, UC-E7, UC-E6)
  // ---------------------------------------------------------------------------------------------------------------
  // AC: "AC-17.2 / DC-11: Повтор запроса отдаёт сохранённую страницу без нового вызова источника и без отказа; результат вызова говорит, что страница прежняя, и называет число её записей."  (the race half)
  // AC: "AC-15.1 (UC-E7): worker и controller одновременно вызывают проверяющего на одно утверждение; у утверждения две ревизии проверки, ответ берёт последнюю; ворота закрытия пройдены."
  // AC: "AC-08.1: Given в дереве работают несколько агентов, When сотрудник останавливает расследование, Then после перехода ни один агент дерева не начинает вызов модели или инструмента."  (the research write paths)
  // AC: "AC-08.2: ... закрытие расследования с готовым ответом, пока дочерние запуски работают ... их запуски отменены тем же переходом."  (the completed-with-answer half; the failure half is agent-core INT-3 B)
  // AC (Design Doc): "DC-2: Корень, который закрыл расследование ответом, пока запуски его поддерева ещё работают, кончается успехом, а расследование становится `completed` и тем же переходом отменяет эти запуски."
  // Behavior: A - two workers send the same `gather` in the same moment -> the source is called once -> both get the same page; B - worker and controller call `verifier` on one claim at once -> two revisions; C - the owner stops while three verifiers run -> nothing is written afterwards;
  // Catches: A - the second `gather` of the same request starting a second source call (the repeat lookup reads only saved pages and misses the call still in flight), or waiting forever on the first, or being refused; B - two closures numbering their revision the same
  //   (a unique violation fails one verifier run and leaves its claim unchecked), or the second one overwriting the first, or the gate reading the earlier of two; C - a verifier closure, an answer write or a `claims_write` that lands after the stop (the guarded write
  //   without `requireActive` on one research path), or a model call that starts after the transition.
  // @category: core-functionality
  // @dependency: gather (source.fetch task and its dedupe), claim_assessment closure, research_close closure, TaskScheduler, InvestigationService.cancel / closeInTx, engine.lifecycle, counting source, real Postgres
  // @complexity: high
  //
  // Row A (UC-E4): Given: runtime `concurrency` >= 2; two workers whose first step is the same `gather` (support item 1c: both held until both have arrived; the counting source holds its first call). When: both are released. Then: `countingSource.calls` has ONE call for that request;
  //   both workers' results carry the same page number, the number of its records and the mark `repeat` on the later one (or on the one that waited); neither is `rejected`; exactly one `source.fetch` task and one stored page exist for the request (DC-11, AC-17.2).
  // Row B (UC-E7): Given: a claim written by a worker; the worker and the controller (a second wave) call `verifier` with that claim number in the same turn-moment (latch), the two assessments differ (one supported, one not). When: both end.
  //   Then: the claim has two verification revisions with different revision numbers, written by two different verifier runs; the answer takes the LAST one (by revision number); the closing gate 2 passes (each call ended); neither verifier run failed.
  // Row C (UC-E6, first run): Given: three `verifier` runs, each in a held model call (concurrency high enough that all three are in the model at the same time). When: the owner's `InvestigationService.cancel` runs and the runs end.
  //   Then: the investigation is `cancelled`; every agent task of the tree is `cancelled` or ended before the transition; after the transition: no new verification revision, no new claim revision, no new answer or message, no new ledger row, no new model call
  //   (snapshots of row ids taken right after `cancel` returns and after all runs ended are equal); the aborted calls' reserves are read as in agent-core INT-3 A (nothing new asserted for them).
  // Row D (UC-E6, second run) merged into agent-core INT-3 C: a root that closes while a grandchild works, whose parent already failed, cancels it by the close.
  // Row F is the second row of INT-2 E (what a run recorded survives a rebuild of the engine).
  describe('INT-2', () => {
    let harness: EngineHarness | undefined;
    /** Everything a test holds open: released before the harness closes, also when the test failed midway. */
    const opened: (() => void)[] = [];

    const assemble = async (options: ResearchFlowHarnessOptions = {}): Promise<EngineHarness> => {
      harness = await createResearchFlowHarness({ runtime: RUNTIME, ...options });
      return harness;
    };
    const heldGate = () => {
      const held = gate();
      opened.push(held.open);
      return held;
    };

    afterEach(async () => {
      for (const open of opened.splice(0)) open();
      try {
        if (harness !== undefined) {
          harness.handlerHold.at = undefined;
          harness.schedulerHold.afterPropose = undefined;
          harness.tokenCounter.interceptTurn = undefined;
        }
        await harness?.cancelStarted();
      } finally {
        await harness?.close();
        harness = undefined;
      }
    });

    const until = <T>(probe: () => Promise<T | undefined>, what: string): Promise<T> =>
      vi.waitFor(
        async () => {
          const value = await probe();
          if (value === undefined) throw new Error(`still waiting for ${what}`);
          return value;
        },
        { timeout: SETTLE_MS, interval: 25 },
      );

    const agentOfTask = (task: { readonly input: unknown }): string | undefined => (task.input as { agentName?: string }).agentName;

    const scriptPlanner = (h: EngineHarness): void => {
      scriptTurns(h, 'planner', 2, (view) =>
        view.turn === 1
          ? [call('plan_write', { readinessCriteria: ['the cause is named'], branches: [{ question: 'What did payment-api log?', approach: 'search its errors' }], reason: 'there is no plan yet' })]
          : [finishText('The plan is written')],
      );
    };

    /** The verifier's answer for the claim of the packet it was given, with every record of the packet read the same way. */
    const verdictStep = (support: string, relation: string, holdUntil?: Promise<void>): ScriptedStep => ({
      toolCalls: (view) => [
        call('finish', assessment({ support, claimType: 'observation', records: verifierPacketOf(view).records.map(({ number }) => ({ record: number, relation })) })),
      ],
      usage: TURN_USAGE,
      ...(holdUntil === undefined ? {} : { holdUntil }),
    });

    const gatherCallsOf = async (investigationId: string) => (await agentToolCallsOf(investigationId)).filter((row) => row.tool === 'gather');

    /** The ids of what the investigation wrote: the ledger rows, the claim revisions, and the calls the double got. */
    async function writtenRows(h: EngineHarness, investigationId: string) {
      const [ledger, revisions] = await Promise.all([llmCallsOf(investigationId), claimRevisionsOf(investigationId)]);
      return { ledger: ledger.map((row) => row.callId), revisions: revisions.map((row) => row.seq), modelCalls: h.model.calls.length };
    }

    const COLLECTOR_ONE = 'Collector one: search payment-api errors';
    const COLLECTOR_TWO = 'Collector two: search payment-api errors';

    // Row A: both calls pass the search for a live task before either proposes, so the runtime's own deduplication decides. A
    // later call that finds the running task by the search ends in the same `subscribed` and the same mark (gather.spec.ts).
    it(
      'INT-2 A: two workers sending the same collection at once call the source once and both get the same stored page, marked as a repeat, without a refusal',
      async () => {
        const h = await assemble();
        h.countingSource.answerWith(() => [sourceLogLine(), sourceLogLine({ spanSeq: 2, traceId: '5cf92f3577b34da7', event: 'payment.retry' })]);
        const sourceAnswers = heldGate();
        h.countingSource.holdNextCall(sourceAnswers.wait);

        // No turn starts before the test knows the investigation: the hold below reads its tool calls by its id.
        const investigation = { id: '' };
        const launched = heldGate();
        h.tokenCounter.interceptTurn = async () => {
          await launched.wait;
          return undefined;
        };
        // Each collection is held after the write that took it past the search; the first to arrive proposes first, the
        // second only once the first's task is recorded.
        const arrived: string[] = [];
        const bothPastTheSearch = heldGate();
        h.handlerHold.at = async (point) => {
          if (point.at !== 'guarded' || point.workflowType !== 'agent.run' || arrived.includes(point.taskId)) return;
          const collecting = (await gatherCallsOf(investigation.id)).some((row) => row.runTaskId === point.taskId && row.state === 'starting');
          if (!collecting) return;
          arrived.push(point.taskId);
          if (arrived.length === 2) bothPastTheSearch.open();
          await bothPastTheSearch.wait;
          if (arrived[0] === point.taskId) return;
          await until(async () => ((await gatherCallsOf(investigation.id)).some((row) => row.runTaskId === arrived[0] && row.state === 'waiting') ? true : undefined), 'the creator waiting on its task');
        };

        scriptPlanner(h);
        scriptTurns(h, 'controller', 3, (view) => {
          if (view.turn === 1) return [call('call_agent', { agent: 'planner', assignment: QUERY_A })];
          if (view.turn === 2) return [call('call_agent', { agent: 'worker', assignment: COLLECTOR_ONE }), call('call_agent', { agent: 'worker', assignment: COLLECTOR_TWO })];
          return [call('finish', { inconclusive: true })];
        });
        scriptTurns(h, 'worker', 4, (view) => (view.turn === 1 ? [gatherFromSystemBlock(view, 'search_logs', SEARCH_ARGS)] : [finishText('Collected')]));

        const started = await startResearch(h, QUERY_A);
        investigation.id = started.investigationId;
        launched.open();

        const creator = await until(async () => (arrived.length === 2 ? arrived[0] : undefined), 'both collections past their search');
        // Both calls wait on one task while the source has not answered: the second met the first in flight.
        const waitingCalls = await until(async () => {
          const rows = await gatherCallsOf(started.investigationId);
          return rows.length === 2 && rows.every((row) => row.state === 'waiting') ? rows : undefined;
        }, 'both collections waiting');
        expect(new Set(waitingCalls.map((row) => row.childTaskId)).size).toBe(1);
        // A call waits as soon as its task exists; the fetch task reaches the source only after that.
        await until(async () => (h.countingSource.calls.length === 1 ? true : undefined), 'the held source call');
        expect(h.countingSource.calls).toHaveLength(1);
        sourceAnswers.open();

        const view = await closedView(h, started);
        expect(view.status).toBe('completed');
        h.tokenCounter.interceptTurn = undefined;
        h.handlerHold.at = undefined;

        // DC-11, AC-17.2: one call of the source, one task, one page; the mark on the second only, nothing refused.
        expect(h.countingSource.calls.map((source) => source.toolName)).toEqual(['search_logs']);
        const [calls, tasks, pages] = await Promise.all([agentToolCallsOf(started.investigationId), tasksOf(started.investigationId), gatherPagesOf(started.investigationId)]);
        expect(calls.filter((row) => row.state === 'rejected')).toEqual([]);
        expect(tasks.filter((task) => task.workflowType === 'source.fetch')).toHaveLength(1);
        expect(pages.stored).toHaveLength(1);
        const page = pages.stored[0]?.pageId;
        const other = pages.gathered.map((row) => row.runTaskId).find((run) => run !== creator);
        expect(new Map(pages.gathered.map(({ runTaskId, ...rest }) => [runTaskId, { page: rest.page, returned: rest.returned, repeat: rest.repeat }]))).toEqual(
          new Map([
            [creator, { page, returned: 2, repeat: false }],
            [other, { page, returned: 2, repeat: true }],
          ]),
        );
      },
      CASE_MS,
    );

    it(
      'INT-2 B: a worker and the controller checking one claim at the same time leave two verification revisions with different numbers, and the answer takes the later one',
      async () => {
        const h = await assemble();
        h.countingSource.answerWith(() => [sourceLogLine()]);
        const WRITER = 'Writer: search payment-api errors';
        let claimId: string | undefined;
        const claimed = (): string => {
          if (claimId === undefined) throw new Error('the worker wrote no claim yet');
          return claimId;
        };
        scriptPlanner(h);
        scriptTurns(h, 'worker', 5, (view) => {
          if (view.assignment !== WRITER) return view.turn === 1 ? [verifierCall(view.assignment)] : [finishText('Checked')];
          if (view.turn === 1) return [gatherFromSystemBlock(view, 'search_logs', SEARCH_ARGS)];
          if (view.turn === 2) return [call('claims_write', { claims: [{ text: CLAIM_A_SUPPORTED, atoms: [TIMEOUT_ATOM], pointer: [{ pageId: firstPage(view), records: [0] }] }] })];
          [claimId] = view.claimIds;
          return [finishText('Written')];
        });
        scriptTurns(h, 'controller', 6, (view) => {
          switch (view.turn) {
            case 1:
              return [call('call_agent', { agent: 'planner', assignment: QUERY_A })];
            case 2:
              return [call('call_agent', { agent: 'worker', assignment: WRITER })];
            case 3:
              // Two checks of one claim in one moment: the root's own, and the one the second worker makes.
              return [verifierCall(claimed()), call('call_agent', { agent: 'worker', assignment: claimed() })];
            case 4:
              return [call('call_agent', { agent: 'synthesis', assignment: 'Write the answer' })];
            case 5:
              return [call('investigation_read', { view: 'runs' })];
            default: {
              const synthesis = view.runs.filter((run) => run.agent === 'synthesis').at(-1);
              if (synthesis === undefined) throw new Error('no finished synthesis run listed');
              return [call('finish', { answer: synthesis.run })];
            }
          }
        });
        // The two verifiers meet at the latch; the second answers only after the first's revision is written, so the later one is known.
        const verifiersAtOnce = h.model.latch(2, 'verifier');
        const firstRevisionWritten = heldGate();
        h.model.scriptAgent('verifier', verdictStep('no', 'contradicts'), verdictStep('yes', 'supports', firstRevisionWritten.wait));
        scriptTurns(h, 'synthesis', 1, (view) => {
          const claims = packetClaims(view).filter((claim) => claim.status === 'supported');
          return [call('finish', { outcome: 'answered', summaryClaimIds: claims.map((claim) => claim.claimId), claims: claims.map(({ claimId: id, text, pointer }) => ({ claimId: id, text, atoms: [], pointer })) })];
        });

        const started = await startResearch(h, QUERY_A);
        await verifiersAtOnce;
        await until(async () => {
          const revisions = await claimRevisionsOf(started.investigationId);
          return revisions.filter((row) => row.authorAgent === 'verifier').length === 1 ? true : undefined;
        }, 'the first verification revision');
        firstRevisionWritten.open();

        const view = await closedView(h, started);
        expect(view.status).toBe('completed');

        // UC-E7: two verification revisions of two runs, numbered apart; the author's revision stays first.
        const revisions = await claimRevisionsOf(started.investigationId);
        expect(revisions.map((row) => [row.authorAgent, row.status, row.confidence])).toEqual([
          ['worker', 'unverified', null],
          ['verifier', 'refuted', null],
          ['verifier', 'supported', 'medium'],
        ]);
        expect(new Set(revisions.map((row) => row.claimId))).toEqual(new Set([claimId]));
        expect(revisions[1]!.seq).toBeLessThan(revisions[2]!.seq);
        expect(revisions[1]!.authorTaskId).not.toBe(revisions[2]!.authorTaskId);

        // Neither verifier run failed and the closing gate was passed: nothing refused, the root succeeded.
        const [tasks, calls] = await Promise.all([tasksOf(started.investigationId), agentToolCallsOf(started.investigationId)]);
        expect(tasks.filter((task) => agentOfTask(task) === 'verifier').map((task) => task.status)).toEqual(['succeeded', 'succeeded']);
        expect(calls.filter((row) => row.state === 'rejected')).toEqual([]);

        // AC-15.1: the answer is built on the later revision, the supported one.
        const row = await answerRowOf(started.investigationId);
        const answer = row?.engineRun.answer as StoredResearchAnswer;
        const pages = await gatherPagesOf(started.investigationId);
        expect(answer.established).toEqual([{ claimId, text: CLAIM_A_SUPPORTED, evidenceIds: [pages.stored[0]?.pageId], verified: true, confidence: 'medium' }]);
        expect(answer.removed).toEqual([]);
        expect(answer.unknown).toEqual([]);
      },
      CASE_MS,
    );

    it(
      'INT-2 C: a stop while three verifiers run leaves no verification revision, claim, answer, ledger row or model call after the transition',
      async () => {
        // The stop comes from another instance, so nothing aborts the three attempts here: only the guarded writes stand between their late answers and the tables.
        const h = await assemble({ runtime: { ...RUNTIME, leaseMs: 120_000, heartbeatMs: 60_000 } });
        const anotherInstance = createDatabase({ connectionString: databaseUrl(), poolMax: 2 });
        const silent = { log: () => undefined, warn: () => undefined, error: () => undefined };
        const elsewhere = createRuntime({
          database: anotherInstance,
          config: { ...parseRuntimeConfig({}), workers: false },
          threads: { withOwnedThread: (_threadId, _resourceId, work) => work() },
          logger: silent,
          clock: systemClock,
        });
        try {
          h.countingSource.answerWith(() => [sourceLogLine(), sourceLogLine({ spanSeq: 2 }), sourceLogLine({ spanSeq: 3 })]);
          const answersAfterTheStop = heldGate();
          scriptTurns(h, 'controller', 1, () => [call('call_agent', { agent: 'worker', assignment: BRANCH_A })]);
          scriptTurns(h, 'worker', 3, (view) => {
            if (view.turn === 1) return [gatherFromSystemBlock(view, 'search_logs', SEARCH_ARGS)];
            if (view.turn === 2) {
              return [
                call('claims_write', {
                  claims: [0, 1, 2].map((record) => ({ text: `${CLAIM_A_SUPPORTED} (${record})`, atoms: [TIMEOUT_ATOM], pointer: [{ pageId: firstPage(view), records: [record] }] })),
                }),
              ];
            }
            return view.claimIds.map((claimId) => verifierCall(claimId));
          });
          const held = verdictStep('yes', 'supports', answersAfterTheStop.wait);
          h.model.scriptAgent('verifier', held, held, held);

          const started = await startResearch(h, QUERY_A);
          await until(async () => (h.model.callsOfAgent('verifier').length === 3 ? true : undefined), 'three verifiers in the model');
          const beforeStop = await claimRevisionsOf(started.investigationId);
          expect(beforeStop.map((row) => row.status)).toEqual(['unverified', 'unverified', 'unverified']);

          await elsewhere.investigations.cancel(started.investigationId, started.resourceId);
          const read = await h.engine.readInvestigation({ investigationId: started.investigationId, resourceId: started.resourceId });
          expect(read.outcome === 'found' ? read.view.status : read.outcome).toBe('cancelled');
          const atStop = await writtenRows(h, started.investigationId);
          answersAfterTheStop.open();

          // Each verifier got its answer, tried its closure and was refused: the runs end cancelled, their `finish` never ran.
          const tasks = await until(async () => {
            const rows = await tasksOf(started.investigationId);
            const verifiers = rows.filter((task) => agentOfTask(task) === 'verifier');
            const ended = verifiers.every((task) => task.status === 'cancelled' && h.endedRuns.some((run) => run.taskId === task.taskId));
            return ended && verifiers.length === 3 ? rows : undefined;
          }, 'the three verifier attempts ended');
          const statusOf = (agent: string) => tasks.filter((task) => agentOfTask(task) === agent).map((task) => task.status);
          expect({ controller: statusOf('controller'), worker: statusOf('worker'), verifier: statusOf('verifier') }).toEqual({
            controller: ['cancelled'],
            worker: ['cancelled'],
            verifier: ['cancelled', 'cancelled', 'cancelled'],
          });
          const calls = await agentToolCallsOf(started.investigationId);
          expect(calls.filter((row) => row.agent === 'verifier').map((row) => [row.tool, row.state])).toEqual([
            ['finish', 'requested'],
            ['finish', 'requested'],
            ['finish', 'requested'],
          ]);

          // AC-08.1: after the transition no revision, no answer, no ledger row, no model call.
          expect(await writtenRows(h, started.investigationId)).toEqual(atStop);
          expect((await claimRevisionsOf(started.investigationId)).map((row) => row.status)).toEqual(['unverified', 'unverified', 'unverified']);
          const row = await answerRowOf(started.investigationId);
          expect(row?.engineRun.answer).toBeNull();
          expect(row?.rootResult).toBeNull();
        } finally {
          await anotherInstance.close();
        }
      },
      CASE_MS,
    );

    // Row E, first row (UC-14, AC-14.2; C6 of the removed `deep-research-engine.int`, «версия из записи переживает пересборку движка»):
    // two investigations started on versions 4 and 3 of the process wait in their root's model call; the engine is rebuilt
    // over the same database with an EDITED version 4 and a new version 5, keeping the parked tasks; the workers of the new
    // assembly resume them. Catches: a resumed run that reads its configuration from the loaded versions instead of its
    // frozen copy (version 4's resumed turn would carry the edited prompt), a version lost or changed by the rebuild, and a
    // start without a version after the rebuild that does not take the new highest one.
    async function frozenConfigurationSurvivesRebuild(): Promise<void> {
      const marker = (label: string) => `\n[version ${label} of the controller prompt]`;
      // One turn of the root: a turn that ends without `finish` is its last, and the root answers by code.
      const versioned = (version: number, label: string) =>
        researchFlowV3Config({ version, promptSuffix: { controller: marker(label) }, agents: { controller: { maxTurns: 1 } } });
      const [version3, version4, editedVersion4, version5] = [versioned(3, '3'), versioned(4, '4'), versioned(4, '4 edited'), versioned(5, '5')];
      const groupTables = [researchFlowGroupTable(version3)];
      const h = await assemble({ processes: [version3, version4], groupTables });
      h.model.scriptAgent('controller', { hangUntilAborted: true }, { hangUntilAborted: true });

      const onHighest = await startResearch(h, 'Which version answers the question without a version?', null);
      const onThree = await startResearch(h, 'Which version answers the question on version 3?', 3);
      await until(async () => (h.model.callsOfAgent('controller').length === 2 ? true : undefined), 'both roots in their model call');
      const versionOf = async (started: StartedResearch) => {
        const read = await h.engine.readInvestigation(started);
        return read.outcome === 'found' ? [read.view.version, read.view.status] : read;
      };
      expect([await versionOf(onHighest), await versionOf(onThree)]).toEqual([
        [4, 'running'],
        [3, 'running'],
      ]);

      h.model.calls.length = 0;
      const noFinish: ScriptedStep = { text: 'I close without a plan', usage: TURN_USAGE };
      await h.rebuildEngine({ processes: [version3, editedVersion4, version5], groupTables }, { fence: false });
      // The resumed turns carry the frozen prompts, which the new assembly no longer loads: the double is told all four.
      h.model.recognizeAgents([version3, version4, editedVersion4, version5].flatMap(agentPromptsOf));
      h.model.scriptAgent('controller', noFinish, noFinish, noFinish);
      const afterRebuild = await startResearch(h, 'Which version answers a question started after the rebuild?', null);

      const views = await Promise.all([onHighest, onThree, afterRebuild].map((started) => closedView(h, started)));
      expect(views.map((view) => [view.version, view.status, view.answer?.outcome, view.answer?.stopReason])).toEqual([
        [4, 'completed', 'inconclusive', 'step_limit'],
        [3, 'completed', 'inconclusive', 'step_limit'],
        [5, 'completed', 'inconclusive', 'step_limit'],
      ]);
      const markersOf = (query: string) =>
        h.model
          .callsOfAgent('controller')
          .filter((one) => one.system.includes(query))
          .map((one) => ['3', '4', '4 edited', '5'].filter((label) => one.system.includes(marker(label))));
      expect(markersOf('without a version?')).toEqual([['4']]);
      expect(markersOf('on version 3?')).toEqual([['3']]);
      expect(markersOf('started after the rebuild?')).toEqual([['5']]);
    }

    // Row E, second row (former INT-2 F; UC-4, KD-8; the rebuild half of C7 of the removed `deep-research-engine.int`): an investigation started with no
    // source connected keeps the mode it recorded when it is resumed by an engine rebuilt with a source, and a new start on
    // that engine records `sources`. Catches: the mode of a resumed run read from the live `connectedSources` instead of
    // the recorded `sourceMode` (the resumed root would be the controller, not synthesis, and the source would be called).
    async function recordedModeSurvivesRebuild(): Promise<void> {
      const h = await assemble({ noSources: true });
      h.model.scriptAgent('synthesis', { hangUntilAborted: true });
      const parked = await startResearch(h, 'Why do payments usually time out?');
      await until(async () => (h.model.callsOfAgent('synthesis').length === 1 ? true : undefined), 'the synthesis root in its model call');

      h.model.calls.length = 0;
      await h.rebuildEngine({ connectedSources: [COUNTING_SOURCE_ID] }, { fence: false });
      scriptTurns(h, 'synthesis', 1, () => [
        call('finish', { outcome: 'answered', summaryClaimIds: [], claims: [{ claimId: null, text: 'Timeouts follow slow providers', atoms: [], pointer: [] }] }),
      ]);
      const parkedView = await closedView(h, parked);
      // The new start's root waits in its model call until the test's cancel: only its recorded mode is read.
      h.model.scriptAgent('controller', { hangUntilAborted: true });
      const sourced = await startResearch(h, 'Why did payments time out at 19:04?');
      const sourcedRead = await h.engine.readInvestigation(sourced);
      await h.runtime.investigations.cancel(sourced.investigationId, sourced.resourceId);

      expect([parkedView.status, parkedView.sourceMode, parkedView.answer?.outcome]).toEqual(['completed', 'model_knowledge', 'answered']);
      expect(sourcedRead.outcome === 'found' ? sourcedRead.view.sourceMode : sourcedRead).toBe('sources');
      expect(h.model.calls.filter((one) => one.system.includes('usually time out')).map((one) => one.agent)).toEqual(['synthesis']);
      expect(h.countingSource.calls).toEqual([]);
    }

    it.each([
      ['the frozen configuration: an edited shipped version does not reach it, and a new start takes the highest loaded version', frozenConfigurationSurvivesRebuild],
      ['the recorded mode: a start without sources keeps model_knowledge after a source is connected, and a new start records sources', recordedModeSurvivesRebuild],
    ])('INT-2 E: an investigation finishes on what it recorded after the engine is rebuilt - %s', async (_row, row) => row(), CASE_MS);

    // Row G (KD-9, DC-19; C8 of the removed `deep-research-engine.int`): a start repeated after a failed one takes the shell
    // it left (an active investigation of the same thread, question and budget, without an engine row or a task), and two
    // starts of one launch at the same time keep one investigation and one engine row, the loser's investigation cancelled.
    // Defects caught: a second investigation beside the shell; two investigations or two engine rows for one `launchKey`.
    it(
      'INT-2 G: a repeated start takes the shell a failed start left, and two starts of one launch at once keep one investigation',
      async () => {
        const h = await assemble();
        h.model.scriptAgent('controller', { hangUntilAborted: true }, { hangUntilAborted: true });
        const resourceId = newUser();
        const threadId = await h.createThread(resourceId);
        const start = (query: string, launchKey: string) => h.engine.startInvestigation({ resourceId, threadId, query, processId: 'deep-research', launchKey });
        const shell = await h.seedShell({ resourceId, threadId, query: 'Why did the refunds fail?' });

        const repeated = await start('Why did the refunds fail?', newLaunchKey());
        const launchKey = newLaunchKey();
        const racing = await Promise.all([start('Why did the refunds fail twice?', launchKey), start('Why did the refunds fail twice?', launchKey)]);

        expect(repeated).toMatchObject({ outcome: 'created', investigationId: shell.investigationId });
        expect(racing.map((one) => one.outcome).sort()).toEqual(['created', 'existing']);
        const [winner, other] = racing.map((one) => (one.outcome === 'rejected' ? one : [one.investigationId, one.controllerTaskId]));
        expect(other).toEqual(winner);
        const active = (await h.runtime.investigations.listForThread(resourceId, threadId)).filter((one) => one.status === 'active');
        expect(active.map((one) => one.investigationId).sort()).toEqual([shell.investigationId, (winner as string[])[0]].sort());
        expect(await engineRunsOf(resourceId)).toHaveLength(2);
        for (const { investigationId } of active) await h.runtime.investigations.cancel(investigationId, resourceId);
      },
      CASE_MS,
    );
  });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-3  The forced ends of the root: an answer by code, and the right reason (UC-3, UC-E8)
  // ---------------------------------------------------------------------------------------------------------------
  // AC: "AC-12.3: Given расследование по v3 остановлено принудительно, Then причина остановки - одна из тех, что сотрудник видит и в v2."
  // AC: "AC-07.1 (agent-core, answered here): Given бюджет расследования меньше требуемого, Then ни один агент дерева не начинает вызов модели сверх бюджета, а расследование завершается с причиной «бюджет исчерпан»."
  // AC (Design Doc): "DC-1: Принудительный конец корня даёт ответ кодом и причину остановки по правилу старшинства; расследование закрывается `completed`."
  // AC (Design Doc): "ворота 3: Если запуск агента ответа кончился прологом с признаком `overflow` - пакет длиннее предела, - закрытие не отказывает: оно собирает ответ кодом с причиной `context_overflow`, и корень кончается успехом." (UC-E8)
  // Behavior: the root cannot make its next turn (reserve refused / turn limit after a budget refusal in the tree / the chain of deadlines) or the synthesis packet overflows -> the forced end / the overflow end of the form -> `buildCodeAnswer` from the verified claims
  //   -> ONE guarded write -> the root ends `succeeded` -> the investigation is `completed`, the answer carries the reason.
  // Catches: a root failed by the budget (investigation `failed`, no answer) instead of an answer by code; a model call started past the budget; the reason read from the wrong source (the `budgetExhausted` flag of the tree not read, so a root that ran out of turns after its branches were
  //   cut by the budget says `step_limit`); a root woken too late to write: the chain worker -> subworker -> verifier ending at the SAME instant as the root (each level must end `RUNTIME_LEASE_MS` before its parent) so the answer is lost to the task deadline;
  //   a synthesis packet that overflows and the root dies on `draft_invalid` instead of answering `context_overflow`.
  // @category: core-functionality
  // @dependency: forced-end code of research_close, AgentRunHandler (notAfter / reserve), gate 3, buildCodeAnswer, collect (budgetExhausted flag, tool-call rows), runtime clock, real Postgres
  // @complexity: high
  //
  // Table-driven. The mapping code -> reason and the precedence are a unit table (named in "Proven elsewhere"); these rows prove the wiring from a REAL end to a written answer. The small numbers come from `researchFlowV3Config(overrides)`.
  // Common Then: the root's task is `succeeded`, the investigation `completed`, the answer exists once, its outcome is `partial` when at least one claim is `supported` and `inconclusive` otherwise, there is no summary, the reason is the literal of the row;
  //   `charged + open reserves <= the investigation budget`; no model call was recorded after the refusal point (compare `model.calls` before/after).
  // Row A (UC-3 run 1 - budget): Given: `limits.investigationTokens` below what the scripted tree needs (the second worker's share is refused `budget_exhausted` by the code); the controller still has turns. When: the controller asks for the next turn and its reserve is refused.
  //   Then: reason `budget_exhausted`; claims already `supported` appear in "Установлено" (the task narrows the skeleton: `buildCodeAnswer` writes no assumptions, OQ-6).
  // Row B (UC-3 run 5 - the chain of deadlines) merged into agent-core INT-5 UC-E14 (one lease per level, the child ends `not_after` before its parent, the parent's
  //   forced end before its task deadline) and Row A here (the root's forced end writes the answer by code); the reason `deadline` of `not_after` is stop-reason.spec.ts.
  // Row C (UC-3 run 6 - precedence by the tree flag): Given: a worker call refused `budget_exhausted` earlier in the tree, then the root's `maxTurns` exhausted. When: the root cannot make a turn. Then: reason `budget_exhausted`, not `step_limit` (the flag is read from the tool-call rows).
  // Row D (UC-E8): Given: so many verified claims that the synthesis packet exceeds 32 000 bytes (the prologue's `overflow`). When: the controller calls `synthesis` and then closes with `answer`. Then: the synthesis run ended without a model call (no ledger row, no transcript);
  //   the closing does not refuse `draft_invalid`; the answer is by code with reason `context_overflow`; the investigation is `completed`.
  describe('INT-3', () => {
    let harness: EngineHarness | undefined;

    /** Every turn counts the same: a reserve is this plus the definition's margin and output ceiling, whatever the shipped prompts say. */
    const COUNTED_INPUT = 1_000;

    const assemble = async (options: ResearchFlowHarnessOptions = {}): Promise<EngineHarness> => {
      harness = await createResearchFlowHarness({ runtime: RUNTIME, ...options });
      harness.tokenCounter.interceptTurn = () => COUNTED_INPUT;
      return harness;
    };

    afterEach(async () => {
      try {
        if (harness !== undefined) {
          harness.tokenCounter.interceptTurn = undefined;
          harness.engineClock.offsetMs = 0;
          harness.engineClock.holdTimers = undefined;
          while (harness.engineClock.heldTimers.length > 0) harness.engineClock.heldTimers[0]!.fire();
        }
        await harness?.cancelStarted();
      } finally {
        await harness?.close();
        harness = undefined;
      }
    });

    const budgetOf = (tokens: number) => ({ default: tokens, max: tokens });

    /** The verifier's answer for the claim of its packet, every record read the same way. */
    const checked = (verdictOf: (claimText: string) => { readonly support: string; readonly relation: string } | undefined) => (view: AgentCallView): readonly ScriptedToolCall[] => {
      const packet = verifierPacketOf(view);
      const verdict = verdictOf(packet.claimText);
      if (verdict === undefined) throw new Error(`no verdict for ${packet.claimText}`);
      return [call('finish', assessment({ support: verdict.support, claimType: 'observation', records: packet.records.map(({ number }) => ({ record: number, relation: verdict.relation })) }))];
    };

    /** The failure codes the root's forced ends replaced, from the notices of its session. */
    async function forcedEndsOf(rootTaskId: string): Promise<readonly unknown[]> {
      const notices = (await sessionOf(rootTaskId)).map((message) => ({ kind: message.kind, content: message.content as { code?: string; failureCode?: string } }));
      return notices.filter(({ kind, content }) => kind === 'code_notice' && content.code === 'forced_end').map(({ content }) => content.failureCode);
    }

    interface CodeAnswerExpected {
      readonly stopReason: string;
      readonly outcome: string;
      /** The claims of "Установлено", as texts; each has the group the test table gives. */
      readonly established: readonly string[];
      readonly tokensSpent: number;
    }

    /** The common Then: the root ended by code, the investigation `completed`, one answer written with the root's result, and the budget kept. */
    async function expectCodeAnswer(h: EngineHarness, started: StartedResearch, expected: CodeAnswerExpected): Promise<StoredResearchAnswer> {
      const view = await closedView(h, started);
      expect(view.status).toBe('completed');
      const [tasks, row, revisions, pages] = await Promise.all([tasksOf(started.investigationId), answerRowOf(started.investigationId), claimRevisionsOf(started.investigationId), gatherPagesOf(started.investigationId)]);
      expect(tasks.find((task) => task.taskId === started.rootTaskId)?.status).toBe('succeeded');

      const answer = row?.engineRun.answer as StoredResearchAnswer;
      expect({ outcome: answer.outcome, stopReason: answer.stopReason, summaryItems: answer.summaryItems }).toEqual({ outcome: expected.outcome, stopReason: expected.stopReason, summaryItems: [] });
      const claimIdOf = (text: string): string | undefined => revisions.find((revision) => revision.text === text)?.claimId;
      expect([...answer.established].sort((left, right) => left.text.localeCompare(right.text))).toEqual(
        [...expected.established]
          .sort((left, right) => left.localeCompare(right))
          .map((text) => ({ claimId: claimIdOf(text), text, evidenceIds: pages.stored.map((page) => page.pageId), verified: true, confidence: 'medium' })),
      );

      expect(row?.engineVersion).toBe(row?.rootVersion);
      expect({ ...(row?.rootResult as object), message: answer.message }).toEqual(answer);
      expect(row?.engineRun.tokensReserved).toBe(0);
      expect(row?.engineRun.tokensSpent).toBe(expected.tokensSpent);
      return answer;
    }

    /** A collection and the claims of one run: its first two turns. */
    const collectAndClaim = (view: AgentCallView, claims: readonly string[]): readonly ScriptedToolCall[] =>
      view.turn === 1
        ? [gatherFromSystemBlock(view, 'search_logs', SEARCH_ARGS)]
        : [call('claims_write', { claims: claims.map((text, record) => ({ text, atoms: [TIMEOUT_ATOM], pointer: [{ pageId: firstPage(view), records: [record] }] })) })];

    const twoLogLines = () => [sourceLogLine(), sourceLogLine({ spanSeq: 2, traceId: '5cf92f3577b34da7', event: 'payment.retry' })];

    it(
      'INT-3 A: a root whose next turn the budget refuses answers by code from the verified claims with the reason budget_exhausted and starts no model call past the budget',
      async () => {
        // 110 000 fits one worker (a turn of it holds 104 000) only while nothing is spent. The controller's two expensive turns
        // leave 1 500, less than its reserve of 6 200 (1 000 counted + 3 200 margin + 2 000 output).
        const tokenBudget = 110_000;
        const h = await assemble({ overrides: { investigationTokens: budgetOf(tokenBudget) } });
        h.countingSource.answerWith(twoLogLines);
        const expensive: ScriptedUsage = { inputTokens: 50_000, outputTokens: 50 };
        h.model.scriptAgent(
          'controller',
          { toolCalls: [call('call_agent', { agent: 'worker', assignment: BRANCH_A })], usage: TURN_USAGE },
          { toolCalls: [call('call_agent', { agent: 'worker', assignment: BRANCH_B })], usage: expensive },
          { toolCalls: [call('investigation_read', { view: 'claims' })], usage: expensive },
        );
        scriptTurns(h, 'worker', 5, (view) => {
          if (view.turn <= 2) return collectAndClaim(view, [CLAIM_A_SUPPORTED, CLAIM_A_REFUTED]);
          if (view.turn === 3) return [verifierCall(view.claimIds[0])];
          if (view.turn === 4) return [verifierCall(view.claimIds[1])];
          return [finishText('Branch A is done')];
        });
        scriptTurns(h, 'verifier', 2, checked((text) => VERDICTS[text]));

        const started = await startResearch(h, QUERY_A);
        const answer = await expectCodeAnswer(h, started, {
          stopReason: 'budget_exhausted',
          outcome: 'partial',
          established: [CLAIM_A_SUPPORTED],
          // Turns at 1 050: the controller's first, five of the worker, two of the verifiers; and the controller's two at 50 050.
          tokensSpent: 108_500,
        });

        expect(await forcedEndsOf(started.rootTaskId)).toEqual(['investigation_tokens_exhausted']);
        expect(answer.message.text).toBe(
          [
            '**Ответ ресерча** · Частичный ответ',
            `Цель: ${QUERY_A}`,
            'Остановлен: исчерпан бюджет',
            '',
            '### Установлено',
            `- ${CLAIM_A_SUPPORTED} [1] (уверенность средняя)`,
            '',
            '### Источники (1)',
            '1. fixture · search_logs · counting-v1',
          ].join('\n'),
        );

        // The second worker was refused by code, and no agent started a model call past the budget.
        const [calls, tasks, ledger] = await Promise.all([agentToolCallsOf(started.investigationId), tasksOf(started.investigationId), llmCallsOf(started.investigationId)]);
        expect(calls.filter((row) => row.state === 'rejected').map((row) => [row.agent, row.tool, row.reason, row.childTaskId])).toEqual([['controller', 'call_agent', 'budget_exhausted', null]]);
        expect(tasks.filter((task) => (task.input as { agentName?: string }).agentName === 'worker')).toHaveLength(1);
        expect(h.model.callsOfAgent('controller')).toHaveLength(3);
        expect(h.model.calls).toHaveLength(10);
        expect(ledger).toHaveLength(10);
        expect(ledger.every((row) => row.status === 'settled')).toBe(true);
        expect(h.model.pendingAgents()).toEqual({ controller: 0, worker: 0, verifier: 0 });

        // Carried over from deep-research-engine INT-2 L3 (DC-13): a ledger row keeps both the input counted for its reserve
        // and the input the provider reported. Defect caught: a row that stores one of them as the other.
        expect(ledger.filter((row) => row.inputTokens === 50_000).map((row) => row.countedInputTokens)).toEqual([1_000, 1_000]);
        expect(ledger.filter((row) => row.inputTokens !== 50_000).map((row) => [row.countedInputTokens, row.inputTokens])).toEqual(Array.from({ length: 8 }, () => [1_000, 1_000]));

        // Carried over from agent-quality-engine INT-2 A1: the delivery read returns the stored message; another owner gets
        // investigation_not_found. Defects caught: a stored message rebuilt or changed by the read; another owner's answer read.
        expect(await h.engine.readAnswerMessage(started)).toEqual({ outcome: 'found', message: answer.message });
        expect(await h.engine.readAnswerMessage({ ...started, resourceId: newUser() })).toEqual({ outcome: 'rejected', code: 'investigation_not_found' });
      },
      CASE_MS,
    );

    it(
      'INT-3 C: a root that runs out of turns after a branch was refused by the budget says budget_exhausted, not step_limit',
      async () => {
        // 100 000 is below one turn of a worker (104 000), so its call is refused; the second turn is the root's last and ends the run without a result.
        const tokenBudget = 100_000;
        const h = await assemble({ overrides: { investigationTokens: budgetOf(tokenBudget), agents: { controller: { maxTurns: 2 } } } });
        h.model.scriptAgent(
          'controller',
          { toolCalls: [call('call_agent', { agent: 'worker', assignment: BRANCH_A })], usage: TURN_USAGE },
          { text: 'I have nothing to close with', usage: TURN_USAGE },
        );

        const started = await startResearch(h, QUERY_A);
        await expectCodeAnswer(h, started, { stopReason: 'budget_exhausted', outcome: 'inconclusive', established: [], tokensSpent: 2_100 });

        expect(await forcedEndsOf(started.rootTaskId)).toEqual(['turn_limit']);
        const calls = await agentToolCallsOf(started.investigationId);
        expect(calls.map((row) => [row.tool, row.state, row.reason])).toEqual([['call_agent', 'rejected', 'budget_exhausted']]);
        expect((await agentTreeOf(h, started)).budgetExhausted).toBe(true);
        expect(h.model.calls).toHaveLength(2);
      },
      CASE_MS,
    );

    it(
      'INT-3 D: a synthesis packet over the limit makes no model call and the root answers by code with the reason context_overflow instead of refusing the draft',
      async () => {
        const h = await assemble();
        h.countingSource.answerWith(() => [0, 1, 2, 3].map((number) => sourceLogLine({ spanSeq: number + 1 })));
        // Four claims a verifier can still take (24 000 bytes each) whose texts together are over the packet's 32 000.
        const claims = [0, 1, 2, 3].map((number) => `${number} ${'payment-api logged a timeout '.repeat(310)}`);
        scriptTurns(h, 'controller', 5, (view) => {
          switch (view.turn) {
            case 1:
              return [call('call_agent', { agent: 'planner', assignment: QUERY_A })];
            case 2:
              return [call('call_agent', { agent: 'worker', assignment: BRANCH_A })];
            case 3:
              return [call('call_agent', { agent: 'synthesis', assignment: 'Write the answer' })];
            case 4:
              return [call('investigation_read', { view: 'runs' })];
            default: {
              const synthesis = view.runs.filter((run) => run.agent === 'synthesis').at(-1);
              if (synthesis === undefined) throw new Error('no finished synthesis run listed');
              return [call('finish', { answer: synthesis.run })];
            }
          }
        });
        scriptTurns(h, 'planner', 2, (view) =>
          view.turn === 1
            ? [call('plan_write', { readinessCriteria: ['the cause is named'], branches: [{ question: 'What did payment-api log?', approach: 'search its errors' }], reason: 'there is no plan yet' })]
            : [finishText('The plan is written')],
        );
        scriptTurns(h, 'worker', 4, (view) => {
          if (view.turn <= 2) return collectAndClaim(view, claims);
          if (view.turn === 3) return view.claimIds.map((claimId) => verifierCall(claimId));
          return [finishText('Branch A is done')];
        });
        scriptTurns(h, 'verifier', 4, checked(() => ({ support: 'yes', relation: 'supports' })));

        const started = await startResearch(h, QUERY_A);
        await expectCodeAnswer(h, started, {
          stopReason: 'context_overflow',
          outcome: 'partial',
          established: claims,
          // Fifteen turns at 1 050: the controller's five, the planner's two, the worker's four, the verifiers' four.
          tokensSpent: 15_750,
        });

        // UC-E8: this is gate 3, no forced end, and the run of the answer agent reached no model.
        expect(await forcedEndsOf(started.rootTaskId)).toEqual([]);
        const tree = await agentTreeOf(h, started);
        const synthesis = tree.runs.find((run) => run.agentName === 'synthesis');
        expect([synthesis?.status, synthesis?.result, synthesis?.spentTokens]).toEqual(['succeeded', { overflow: true }, 0]);
        expect(h.model.callsOfAgent('synthesis')).toEqual([]);
        const [ledger, transcripts, calls] = await Promise.all([llmCallsOf(started.investigationId), llmTranscriptsOf(started.investigationId), agentToolCallsOf(started.investigationId)]);
        expect(ledger.filter((row) => row.taskId === synthesis?.runTaskId)).toEqual([]);
        expect(transcripts.filter((row) => row.taskId === synthesis?.runTaskId)).toEqual([]);

        // The closing refused nothing.
        expect(calls.filter((row) => row.state === 'rejected')).toEqual([]);
      },
      CASE_MS,
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Proven elsewhere (named for the plan; no skeleton here, by the light test process)
// ---------------------------------------------------------------------------------------------------------------
// Unit (table-driven, packages/engine/src/**/*.spec.ts), one spec per rule:
// - config loader and engine start (UC-5: AC-13.1, AC-13.2, DC-4; DC-5): one table of broken v3 variants (unknown key; `research_close` on a non-root; `answer_draft` on a definition that is not `modelKnowledgeRoot`; two `claim_assessment` definitions; none; a tool on the verifier)
//   with the agent, form and constraint in the error; the shipped v3 loads; a default version without a group table for the verifier's pair -> `calibration_missing` with both fingerprints
//   (the server-start half is E2E-2 S1); `createProcessSet.resolve` without a version takes the default (KD-5); `investigationTokenLimits` reads the default version's limits (800 000 / 10 000 000 for v3)
// - `claims_write` against real Postgres, small DB-backed specs (UC-E1, DC-6): a pointer to a page of another investigation, a record number outside the page, more than 20 records -> `pointer_invalid` with the ordinal numbers of the bad claims and NO revision written (all-or-nothing); a good call writes `unverified` revisions and returns numbers in call order
// - `gather` (DC-11): the key of a repeat (source, tool, arguments, slice) and the `repeat` mark; refusals `access_denied`, `invalid_arguments`; `source_unavailable` on a failed task. The race of two callers is INT-2 A
// - the `claim_assessment` prologue and closure (UC-E2: DC-7, DC-8; UC-R1 on v3; AC-16.3; DC-10): packet longer than 24 000 bytes -> `end` with `needs_narrowing` -> revision `insufficient`, no model call; a non-form answer twice -> `invalid_result` then `insufficient`/`invalid_assessment`;
//   a task that is not a claim number of this investigation -> `not_a_claim` -> `prologue_refused`; the forced end `turn_limit` -> `insufficient`/`invalid_assessment`, the other codes -> `none`; the six recorded claims of UC-R1 give the recorded statuses of `checkAtoms` + `decideClaim`
//   (`recorded-runs.spec.ts`, the prologue/closure path); the pair packet of `calibrate` equals the prologue packet built from the same records; with no table for the pair the supported claim gets the lowest group (the self-check run) and under `Engine.assessAgent` it gets none
// - the `research_close` gates (UC-E3: DC-9), for `answer` and for `inconclusive`: `plan_missing`, `unverified_claims` with numbers (an attempted call satisfies gate 2: `done`, `child_failed`, or refused `budget_exhausted`, `children_limit`, `task_limit`; any other refusal does not), `needs_verification` once and then no new draft claims written,
//   `draft_invalid` (run missing / not succeeded / wrong form / ended before a `needs_verification`); the `answer_draft` prologue overflow flag; a table over the collected input, no database
// - the order of reasons (AC-12.3): codes `run_tokens_exhausted` / `investigation_tokens_exhausted` / `model_unavailable` / `not_after` / `turn_limit` x the `budgetExhausted` flag x close `inconclusive` x overflow -> `budget_exhausted`, `model_unavailable`, `deadline`, `step_limit`, `context_overflow`, none; outcome `partial` / `inconclusive`
// - the self-check rules on v3 (AC-18.3, DC-12): see the api file header
// - fingerprints (AC-16.1): `agentFingerprint` and `definitionMemoryFingerprint` change with model, effort, prompt, tools, form version, ceiling, and with a write or a delete in the verifier's `deployment` memory (the registry-wide check is agent-core's)
//
// Not observable as an assertion (reported to the caller):
// - UC-1 "в дереве есть запуски агентов всех пяти стадий" is observable by agent name, but "worker сам решает, кого и когда вызвать" is not: the double decides in the script, so the test proves that the definitions ALLOW and the code EXECUTES the calls the design describes, not that a real model chooses them.
//   That is INT-4 on recorded answers of real models (the main risk of the design); no CI test reads it.
// - UC-3 "корень пишет ответ раньше срока своей задачи" holds with a free dispatcher slot; with all slots busy the root may not wake in time (design risk). agent-core INT-5 UC-E14 keeps a slot free and asserts the ordering of `notAfter` values and of the ends, not a latency.
// - INT-2 A and B ask for two things at the same instant; a database cannot be forced to interleave two transactions from a test without a hook in `src`. Latches make the collision likely, not certain; the guaranteed proof of the revision numbering and of the
//   repeat lookup under two writers is a repository-level spec on the real table (two `Promise.all` calls, repeated), which the plan names next to the DB-backed `claims_write` spec.
// - INT-4: the group of a claim depends on the table for the recorded fingerprint pair, and a prompt edit changes the pair; whether the comparison uses the recorded table or leaves the group out is a plan decision, the design says only "те же утверждения по разделам и те же статусы".
// - INT-4: the fixture does not exist yet and cannot be made before v3 runs on real models; it records one provider's answers on one date and has to be re-recorded when a definition's tools change.
