// agent-runtime / agent-core integration tests - Design Doc: docs/features/agent-runtime/design-agent-core.md (v1.2, approved 2026-11-08)
// PRD: docs/features/agent-runtime/prd.md v1.1 (FR-01..FR-11, FR-21, FR-22; NFR-01..NFR-03 for agents). ADRs: ADR-0001 (runtime owner), ADR-0004 (engine package), ADR-0005 / ADR-0009 (process = data), ADR-0006 (stopping). UXRD: none (part without UI).
// Generated: 2026-11-08 | Part: agent-core | Test type: Integration (in-process runtime + engine + real Postgres, scripted model), CI job `e2e-engine`
// Implementation timing: created alongside the slice each test names (INT-1 the turn loop + registry + tree read; INT-2 sibling runs; INT-3 cancellation of the tree; INT-4 the budget share and its return).
//
// File name and placement. Same package, harness and config as `agent-runtime-research-flow.int.e2e-spec.ts` (`test/**/*.e2e-spec.ts` of `vitest.config.e2e.ts`; run with
// `pnpm --filter @agent-os/engine test:e2e`, never in the default `vitest run`). Everything below lives in this package (the agent module, the ledger, the tree read); `apps/api` loads only the shipped
// deep-research (`ENGINE_PROCESSES`) and does not load the probe process, so this part has no api test. The process-kill matrix is the sibling file `agent-runtime-agent-core.e2e-spec.ts` (E2E-1).
//
// Started as `it.todo` skeletons; every row is implemented (plan phases 1-7, fix cycle 1). The Given/When/Then comments are the rows' specification.
//
// Light test process (owner decision): integration and E2E skeletons exist only for the risky UCs of the Test Strategy - the probe-process acceptance (UC-1), concurrency (UC-4 + UC-E5), cancellation (UC-6), budget (UC-E6, UC-E10 for the
// share return) and the restart matrix (UC-E3, UC-E4 -> E2E-1). Every other UC is a unit test named in the plan (list "Proven elsewhere" at the end).
//
// Environment (Design Doc "Test Strategy"):
// - Postgres 16 from infra/docker-compose.yml. Real `createRuntime` and real `createEngine` with the new `AgentRunHandler` (`agent.root`, `agent.run`), the real `ModelGateway` over the real `postgresCallLedger`, the real
//   `ToolRegistry` / `ToolExecutor` / `SessionWindow`. Model boundary only: the scripted language-model double. The probe declares no sources; the harness still connects the counting source
//   as for every other file, and it must stay at zero calls.
// - The process is the PROBE (`agent-probe`, Test Strategy of design 1.6.1): four definitions as data, living in test/support/test-configs.ts and passed through the harness `processes` option; it is never loaded by `apps/api`. `lead` (root; memory_read, memory_write,
//   call_agent -> helper), `helper` (memory_read, memory_write, call_agent -> leaf, recorder), `leaf` (finish only, form `text`), `recorder` (finish only, form `probe_record`, INT-5 only). `agentLimits.maxDepth` 2. Each definition's prompt carries a unique marker (like `SECOND_CONFIG_MARKER`) so the double recognises the agent by the system prompt.
//   Windows, `runTokens`, `deadlineMs`, `maxTurns` are chosen per test through a config builder (like `versionedConfig`), never by editing the shipped numbers.
// - Isolation (project convention, no truncate): a unique `resourceId` and `launchKey` per test (test/support/new-user.ts); `fileParallelism: false`; `cancelStarted()` in afterEach.
// - "Model evaluates, algorithm decides": the double returns only tool calls by schema; no assertion reads a keyword of model text. Codes the engine writes (`tool_not_in_definition`, `budget_exhausted`, ...) are compared as literals from the Design Doc.
// - Time: runtime deadlines and leases ride the injected harness `clock` / `expireLease`; the engine clock (`engineClock.offsetMs`) moves only `notAfter`. No sleeps for ordering, no latency assertions.
//
// Support (in place since the plan's first harness task):
// 1. scriptedModel.ts - an `agent` role. The current double answers one structured JSON per role and tells roles apart by the output-schema marker; an agent turn has no such schema. The double must (a) answer with TOOL-CALL content parts
//    (`type: 'tool-call'`, tool name, input) - a new step kind `{ toolCalls: [{ tool, args }] }` next to `{ output }`, plus `{ text }` for the no-tool-call case (DC-2); (b) recognise the agent by the marker in the call's system prompt and keep a
//    script per agent name (`model.scriptAgent('lead', ...steps)`); (c) record per call the agent name, the tool names offered and `toolChoice`, the whole prompt (messages with their provider options, to read the session view, stubs and cache marks);
//    (d) keep `holdUntil` / `hangUntilAborted` / `providerError` for tool-call steps; (e) offer the existing `fallback` program keyed by agent and by the number of tool-result messages in the prompt, for the process that restarts (E2E-1).
//    Scripted `usage` follows the existing `ScriptedUsage` (cache read/write fields).
// 2. test-configs.ts - `agentProbeConfig(options)` builder (data only; same shape the loader validates) and its marker constants.
// 3. engineDb.ts - read-only snapshots of the new tables: `research_agent_runs`, `research_agent_messages`, `research_agent_tool_calls`, `agent_tool_audit`, `research_agent_memory`; `llmCallsOf(investigationId)` for ledger rows with role `agent`.
// 4. engineHarness.ts - `toolAccessPolicy` option of `createEngine` (default: allow), a way to read the tree (`engine.readAgentTree`) and a hook around the `TaskScheduler` handed to `createEngine` that can hold after `propose` returns (INT-4 B3 only).
//
// Budget (this file): Integration 4 (limit 3; up to 5 under the integration-e2e-testing rule only when each extra test names the defect no other test catches). Core: INT-1, INT-2, INT-3. The one extra is INT-4 - unique defect: the share
//   a parent holds is derived from real journal rows (own spend, open reserves, the descendants' spend), so only the real ledger across several tasks of a tree shows a share that is not returned, returned twice or returned while a grandchild still runs.
//   E2E: 1 of 2, in the sibling file.
//
// AC -> proving test (the plan reads this to avoid a second test for an AC already proven; "unit" = a table-driven unit spec named in the plan):
// - AC-01.2: INT-1 (the offered-but-undefined tool is refused by the executor; the double offers every registry tool in one scripted call to prove the code, not the schema, refuses it)
// - AC-02.1, AC-02.2, DC-3, NFR-03, AC-05.4: E2E-1 (K1..K6)
// - AC-03.1, AC-05.1, AC-09.1, AC-10.2: INT-1
// - AC-05.2, DC-5, AC-03.3: INT-2 (AC-03.3 is exercised by the same scenario, see the limit stated in INT-2)
// - AC-08.1: INT-3 A; AC-08.2 (cancel half), DC-18: INT-3 B (rows B and C)
// - AC-07.1, DC-8 (refusal half), DC-10, DC-16: INT-4 B1, B2; AC-07.2: INT-1 (sum) and INT-4 (sums per row); DC-9, KD-4 return, AC-05.3 (reason `failed`), UC-5: INT-4 B3 (rows B3 and B4)
// - AC-21.1: INT-1 (stable prefix + mark on the last message); the cache-read price: the cache rows of cost.spec.ts
// - NFR-02: INT-1 (every recorded model call went to the definition's model)
// - AC-01.1, AC-13.2, DC-1 (UC-2); DC-2, DC-7, DC-14, DC-17 (UC-E7); DC-6 table, AC-06.1 limits (UC-E1), AC-05.3 reasons (UC-E2); DC-8 share = min(runTokens, remainder); DC-13 and the window steps (UC-7); AC-04.1/AC-04.2 (UC-3);
//   DC-4, AC-03.2 (UC-E9); DC-11, NFR-01 (UC-N1); DC-12, AC-10.1 (UC-11); DC-15, AC-22.1..AC-22.6 (UC-9, UC-10); KD-6 `yield` (UC-E8): unit, see "Proven elsewhere"

import { type AgentTree, type AgentTreeRun, readRunRecord, readTranscripts, type StartInvestigationResult } from '@agent-os/engine';
import { type Clock, type RuntimeConfig, systemClock } from '@agent-os/runtime';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { agentRowsOf, auditOf, closeEngineDb, llmCallsOf, llmTranscriptsOf, sessionOf, tasksOf } from './support/engineDb.js';
import { createEngineHarness, type EngineHarness, type EngineHarnessOptions } from './support/engineHarness.js';
import { newLaunchKey, newUser } from './support/new-user.js';
import { PROBE_DEADLINE_RESULT, PROBE_FORMS, PROBE_FORMS_READING, type RecordAssignment } from './support/probe-forms.js';
import { PROBE_READS_SOURCES_TOOL, PROBE_SOURCE_IDS, PROBE_SOURCE_PAIRS, probeSources } from './support/probe-sources.js';
import { agentMarker, type RecordedModelCall, type ScriptedStep, type ScriptedToolCall, type ScriptedUsage } from './support/scriptedModel.js';
import { agentProbeConfig, PROBE_MODELS, PROBE_PROCESS_ID, type ProbeAgent } from './support/test-configs.js';

// Task text over the skeleton (plan 1.2, rule 7): the probe has four definitions (lead, helper, leaf, recorder), `helper`
// has `memory_read`, so INT-1 asserts both directions of the cross-agent read; INT-3 C (a row of INT-3 B), INT-4 B4 (a row
// of INT-4 B3) and INT-5 are added by the plan. `recorder` is not called in INT-1..INT-4: they run on the base form `text`.

/** The usage every scripted turn reports unless a row needs its own: 1 050 charged tokens a turn. */
const TURN_USAGE: ScriptedUsage = { inputTokens: 1_000, outputTokens: 50 };
const TURN_CHARGE = 1_050;
/** How long a test waits for a state the investigation reaches by itself (a harness timeout, not a latency assertion). */
const SETTLE_MS = 30_000;
/** The vitest timeout of one case: several runtime hops and tens of turns, above the 5 s default (e2e config). */
const CASE_MS = 60_000;

/** A gate a test opens once; waiting on an open gate goes on at once. */
function latch() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open: () => open() };
}

const call = (tool: string, args: unknown): ScriptedToolCall => ({ tool, args });
/** One turn with the given calls and the standard usage. */
const turn = (...toolCalls: ScriptedToolCall[]): ScriptedStep => ({ toolCalls, usage: TURN_USAGE });
const finishWith = (summary: string): ScriptedStep => turn(call('finish', { summary, refs: [] }));

/** The probe harness: the probe configurations as data, the probe forms through `composeEngine` (ADR-0010). */
function probeHarness(options: EngineHarnessOptions = {}): Promise<EngineHarness> {
  return createEngineHarness({ processes: [agentProbeConfig()], resultForms: PROBE_FORMS, ...options });
}

interface Started {
  readonly investigationId: string;
  readonly rootTaskId: string;
  readonly resourceId: string;
}

async function startProbe(
  harness: EngineHarness,
  options: { readonly processId?: string; readonly tokenBudget?: number; readonly query?: string } = {},
): Promise<Started> {
  const resourceId = newUser();
  const started: StartInvestigationResult = await harness.engine.startInvestigation({
    resourceId,
    threadId: await harness.createThread(resourceId),
    query: options.query ?? 'Which part of the probe fails first?',
    processId: options.processId ?? PROBE_PROCESS_ID,
    launchKey: newLaunchKey(),
    ...(options.tokenBudget === undefined ? {} : { tokenBudget: options.tokenBudget }),
  });
  if (started.outcome === 'rejected') throw new Error(`start refused: ${started.code}`);
  return { investigationId: started.investigationId, rootTaskId: started.controllerTaskId, resourceId };
}

/** Waits until the investigation is closed (rule 9: each test waits for its own end); returns its view status. */
async function closedStatus(harness: EngineHarness, { investigationId, resourceId }: Started): Promise<string> {
  return vi.waitFor(
    async () => {
      const read = await harness.engine.readInvestigation({ investigationId, resourceId });
      if (read.outcome !== 'found') throw new Error(`investigation ${investigationId} not found`);
      if (read.view.status === 'running') throw new Error(`investigation ${investigationId} is still running`);
      return read.view.status;
    },
    { timeout: SETTLE_MS, interval: 50 },
  );
}

async function treeOf(harness: EngineHarness, { investigationId, resourceId }: Started): Promise<AgentTree> {
  const read = await harness.engine.readAgentTree({ investigationId, resourceId });
  if (read.outcome !== 'found') throw new Error(`tree of ${investigationId} not found`);
  return read.tree;
}

function runOf(tree: AgentTree, agentName: string, index = 0): AgentTreeRun {
  const run = tree.runs.filter((candidate) => candidate.agentName === agentName)[index];
  if (run === undefined) throw new Error(`no run ${index} of ${agentName}`);
  return run;
}

/** Waits until `check` holds over the investigation's rows (a proven state, never a delay). */
function until<T>(check: () => Promise<T | undefined>, what: string): Promise<T> {
  return vi.waitFor(
    async () => {
      const value = await check();
      if (value === undefined) throw new Error(`not yet: ${what}`);
      return value;
    },
    { timeout: SETTLE_MS, interval: 25 },
  );
}

/** The task of the investigation with that id, once it is final. */
async function finalTask(investigationId: string, taskId: string) {
  return until(async () => {
    const task = (await tasksOf(investigationId)).find((candidate) => candidate.taskId === taskId);
    return task !== undefined && ['succeeded', 'failed', 'cancelled'].includes(task.status) ? task : undefined;
  }, `task ${taskId} final`);
}

/**
 * The prompt messages of a call without provider options, of the messages and of their parts: what a stable prefix
 * compares. Mastra stamps each part with its own `mastra.createdAt` per request; the provider does not send it.
 */
function messagesOf(recorded: RecordedModelCall): unknown[] {
  const bare = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(bare);
    if (typeof value !== 'object' || value === null) return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'providerOptions').map(([key, item]) => [key, bare(item)]));
  };
  return recorded.prompt.map(bare);
}

/**
 * Indexes of the prompt messages that carry the provider's cache mark: on the message, or — for a `tool` message, whose
 * message-level options Mastra drops — on its last result part.
 */
function cacheMarked(recorded: RecordedModelCall): number[] {
  const marked = (options: unknown): boolean => JSON.stringify(options ?? {}).includes('cacheControl');
  return recorded.prompt.flatMap((message, index) => {
    const lastPart = Array.isArray(message.content) ? (message.content.at(-1) as { providerOptions?: unknown } | undefined) : undefined;
    return marked(message.providerOptions) || marked(lastPart?.providerOptions) ? [index] : [];
  });
}

/** Orders rows of literals by their first cell, for sets whose order the database does not fix. */
const byFirst = (left: readonly unknown[], right: readonly unknown[]): number => String(left[0]).localeCompare(String(right[0]));

/** The JSON body of a stored session message. */
const contentOf = (message: { readonly content: unknown }) => message.content as Record<string, unknown>;

/** What the journal holds of the investigation: its reserves, its tool calls and the calls the double got. */
async function journalOf(harness: EngineHarness, investigationId: string) {
  const [ledger, rows] = await Promise.all([llmCallsOf(investigationId), agentRowsOf(investigationId)]);
  return {
    reserves: ledger.map((row) => row.callId),
    toolCalls: rows.toolCalls.map((row) => row.id),
    modelCalls: harness.model.calls.length,
  };
}

/** The runtime clock a test moves forward: leases and deadlines of the runtime follow it (INT-3 B). */
function shiftableClock(): Clock & { shiftMs: number } {
  const clock = {
    shiftMs: 0,
    now: () => new Date(systemClock.now().getTime() + clock.shiftMs),
    random: () => systemClock.random(),
    setTimer: (ms: number, callback: () => void) => systemClock.setTimer(ms, callback),
  };
  return clock;
}

/**
 * Runtime settings of the rows where the runtime ends a run by its recovery limit (INT-3 C, INT-4 B3): four slots (two
 * held attempts of helper, leaf and the woken lead), one recovery, a long lease and a fast reaper. The heartbeat is short:
 * it hands a close's cancel to a running attempt (INT-3 C); a beat that renews an expired lease is met by expiring again.
 */
const RECOVERY_RUNTIME: Partial<RuntimeConfig> = {
  concurrency: 4,
  dbPoolMax: 10,
  leaseMs: 120_000,
  heartbeatMs: 500,
  reaperMs: 50,
  maxRecoveries: 1,
};

/**
 * Ends helper's task `failed` with `recovery_exhausted` while the leaf it called works (UC-E10): its first attempt is held
 * between `propose` of the leaf task and the write of its id, its second at its start, and each loses its lease. The
 * holds are released by the caller through `held`, after its checks.
 */
async function exhaustHelperRecovery(harness: EngineHarness, started: Started, held: Array<() => void>) {
  const leafProposed = latch();
  const firstAttempt = latch();
  held.push(firstAttempt.open);
  harness.schedulerHold.afterPropose = async (spec) => {
    if ((spec.input as { agentName?: string }).agentName !== 'leaf') return;
    leafProposed.open();
    await firstAttempt.wait;
  };
  await leafProposed.wait;
  await until(async () => (harness.model.callsOfAgent('leaf').length === 1 ? true : undefined), 'leaf in the model');
  const helperTask = (await tasksOf(started.investigationId)).find((task) => (task.input as { agentName?: string }).agentName === 'helper');
  if (helperTask === undefined) throw new Error('no helper task');
  const secondStarted = latch();
  const secondAttempt = latch();
  held.push(secondAttempt.open);
  harness.handlerHold.at = async (point) => {
    if (point.taskId !== helperTask.taskId || point.attempt !== 2 || point.at !== 'run') return;
    secondStarted.open();
    await secondAttempt.wait;
  };
  let secondRunning = false;
  void secondStarted.wait.then(() => {
    secondRunning = true;
  });
  await expireUntil(harness, helperTask.taskId, 1, () => secondRunning);
  await expireUntil(harness, helperTask.taskId, 2, () => false, started.investigationId);
  return finalTask(started.investigationId, helperTask.taskId);
}

/**
 * Expires the lease of the task's attempt until `done` holds or the task is final: a heartbeat of the held attempt may
 * renew the lease before the reaper sees it expired, so the expiry is repeated (expiring an attempt that no longer runs
 * is refused by the harness and ends the loop's work for that attempt).
 */
async function expireUntil(harness: EngineHarness, taskId: string, attempt: number, done: () => boolean, investigationId?: string) {
  await until(async () => {
    if (done()) return true;
    if (investigationId !== undefined) {
      const task = (await tasksOf(investigationId)).find((candidate) => candidate.taskId === taskId);
      if (task !== undefined && ['succeeded', 'failed', 'cancelled'].includes(task.status)) return true;
    }
    await harness.expireLease(taskId, attempt).catch(() => undefined);
    return undefined;
  }, `attempt ${attempt} of ${taskId} recovered`);
}

/** The probe variant of INT-4 B4: helper's share fits once in the budget of the row, not twice at once. */
const B4_PROCESS_ID = 'agent-probe-b4';
const B4_HELPER_SHARE = 60_000;

/** The variants and settings of INT-5 (T7.4): recorder's one-turn share (UC-12 runs 3, 7), its short deadline (UC-E13),
 * helper with `probe_deadline` over a leaf whose deadline helper's `notAfter` sets (UC-E14). */
const INT5_SHARE_PROCESS_ID = 'agent-probe-int5-share';
const INT5_DEADLINE_PROCESS_ID = 'agent-probe-int5-deadline';
const INT5_WAIT_PROCESS_ID = 'agent-probe-int5-wait';
const INT5_RECORDER_SHARE = 20_000;
/** AGENT_TURN_MS of INT-5, above the engine's RUNTIME_LEASE_MS (UC-E14). */
const INT5_TURN_MS = 60_000;
const INT5_LEASE_MS = 30_000;
/** A counted input over every probe window minus its margin (31 000): the counting double's answer in UC-E15. */
const OVER_WINDOW_TOKENS = 40_000;

/** Literal model ids of the probe by agent (NFR-02). */
const modelOf = (agent: string): string => PROBE_MODELS[agent as ProbeAgent];

describe('agent-runtime / agent-core - integration (in-process runtime + engine + real Postgres, scripted model, probe process)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // INT-1  Probe-process acceptance: lead -> helper -> leaf, data only, from a question to a closed investigation (UC-1, UC-N2)
  // ---------------------------------------------------------------------------------------------------------------
  // AC: "AC-01.2: Given инструмента нет в определении агента, When модель агента просит его вызвать, Then инструмент не исполнен, а агент получает отказ с причиной следующим сообщением сессии."
  // AC: "AC-03.1: Given агент записал заметку в память, When другой агент того же расследования читает память, Then он видит заметку и агента, который её оставил."
  // AC: "AC-05.1: Given родитель вызвал дочернего агента, When тот вернул результат, Then в сессии родителя есть задание и результат и нет ни одного сообщения дочерней сессии."
  // AC: "AC-09.1: Given расследование по v3 завершено, When разработчик открывает его ход, Then у каждого запуска агента видны родитель, задание, результат, расход и транскрипты всех его ходов."
  // AC: "AC-10.2: Given агенты дерева вызвали инструменты, Then на каждый вызов приходится ровно одна запись аудита, и в ней видно, какой агент вызвал инструмент."  (Design Doc split: the audit row holds the fact of the call, the tool-call row names the agent)
  // AC: "AC-21.1: Given агент сделал больше одного хода, Then в журнале вызовов ходы после первого стоят меньше, чем стоил бы тот же вход без повтора начала."  (the stable-prefix half only)
  // AC: "AC-07.2: ... сумма по запускам равна расходу расследования."  and  NFR-02: "сессии и заметки памяти уходят только к провайдерам моделей, которыми уже пользуется расследование."
  // Behavior: question -> `agent.root` (lead) turns: write a note and ask a tool outside its definition -> call_agent(helper) -> helper writes a note and calls leaf -> leaf finish -> helper finish -> lead reads memory, finish
  //           -> root task ends -> `engine.lifecycle` closes the investigation `completed` -> the tree read shows three runs
  // Catches: the engine only works for the domain it was written for (a domain assumption in the agent module: it imports a process module, or the root is not recognised as the root task so the investigation is never closed);
  //   a child's messages leak into the parent's session; a tool outside the definition is executed instead of refused; a tool call without exactly one audit row (zero or two) or an audit row that carries arguments; a turn that makes more than one
  //   provider request (the Mastra one-request assumption of KD-1, read as double calls == journal rows); a session view whose beginning changes between turns, which silently disables the cache.
  // @category: core-functionality
  // @dependency: AgentRunHandler, ToolRegistry, ToolExecutor, SessionWindow, ModelGateway, postgresCallLedger, TaskScheduler, InvestigationService, readAgentTree, real Postgres
  // @complexity: high
  //
  // Given (the probe config as data through `processes`, nothing in `src` names it; one user; the double scripted per agent):
  //   lead turn 1: two calls in one turn - `memory_write` (a `finding` note) and `investigation_read` (a registry tool that is NOT in lead's definition); lead turn 2: `call_agent(helper, task)`; lead turn 3 (after the result): `memory_read`; lead turn 4: `finish`.
  //   helper turn 1: `memory_read` (task text: helper has `memory_read`); turn 2: `memory_write`; turn 3: `call_agent(leaf, task)`; turn 4: `finish`. leaf turn 1: `finish`. Each `finish` is alone in its turn. The usage of every step is explicit, so the sums are exact.
  // When: the investigation is started through `engine.startInvestigation` and the root run ends.
  // Then (verification items):
  //   - Lifecycle: the investigation is `completed` and closed by the consumer from the `agent.root` task alone (`unrecordControllerTask` before the end proves the `isControllerTask` path, not `controller_task_id`)
  //   - Tree (AC-09.1): `readAgentTree` shows exactly three runs, lead -> helper -> leaf, each with parent run, call number, task text, result, status, own spend and subtree spend, turns linked to ledger rows and to transcripts; the transcript of
  //     every turn has role `agent` and reads back its input from the session
  //   - Isolation (AC-05.1): the session messages of lead hold lead's task, its own answers and results, and helper's task and result only - no message row of helper's or leaf's session is in lead's; helper's result is the one text helper finished with
  //   - Memory (AC-03.1): lead's `memory_read` returns helper's note with author agent `helper` and helper's run id, and lead's own note with author `lead`; helper's
  //     first-turn `memory_read` returns lead's note with author `lead` (both directions of UC-1: design 1.6.1 gives `helper` `memory_read`)
  //   - Refusal (AC-01.2): the call outside the definition has state `rejected`, reason `tool_not_in_definition`, no effect (no `investigation_read` side effect); the next message of lead's session is its result with that code; the same turn's `memory_write` was executed
  //   - Audit (AC-10.2): rows of `research_agent_tool_calls` and rows of `agent_tool_audit` match one to one for the whole tree (count equal, every call row references a distinct audit row, including the rejected call); each audit row has the owner user, a time,
  //     the tool, the source (none) and an outcome, and no argument or run reference column holds anything; each call row names the calling agent through its run
  //   - One request per turn (KD-1): `model.calls` of role agent == ledger rows of role `agent` == turns in the sessions; every call's model id equals the definition's model (NFR-02), no other recipient
  //   - Budget sums (AC-07.2): the per-run spend of the tree adds up to the investigation's charged total
  //   - Stable prefix (AC-21.1): for consecutive turns of lead, the prompt messages up to the previous turn's last message are identical (same content, same order), the cache mark is on the system block and on the last message of each view, and
  //     the previous turn's mark is not left behind on an older message
  //   - No domain step: the probe process makes no source call (counting source at zero)
  describe('INT-1', () => {
    let harness: EngineHarness;
    /** Held latches are opened after each test, so a failed test leaves no scripted call pending (rule 9). */
    let leadEnds = latch();

    beforeAll(async () => {
      harness = await probeHarness();
    });

    afterAll(async () => {
      await harness?.close();
      await closeEngineDb();
    });

    beforeEach(() => {
      harness.model.reset();
      harness.countingSource.calls.length = 0;
      leadEnds = latch();
    });

    afterEach(async () => {
      leadEnds.open();
      try {
        expect(harness.model.pendingAgents()).toEqual({ lead: 0, helper: 0, leaf: 0 });
      } finally {
        await harness.cancelStarted();
      }
    });

    it('INT-1: the probe process lead -> helper -> leaf runs from a question to a completed investigation on data only, with isolated sessions, one audit row per call and a stable session prefix', async () => {
      // Given: the probe as data, the double scripted per agent; lead's last turn is held until the start's record of the
      // root task is cleared, so only `isControllerTask` can close the investigation.
      harness.model.scriptAgent(
        'lead',
        turn(call('memory_write', { kind: 'finding', text: 'lead finding', refs: [] }), call('investigation_read', { view: 'plan' })),
        turn(call('call_agent', { agent: 'helper', assignment: 'Check the helper part.' })),
        turn(call('memory_read', {})),
        { toolCalls: [call('finish', { summary: 'lead summary', refs: [] })], usage: TURN_USAGE, holdUntil: leadEnds.wait },
      );
      harness.model.scriptAgent(
        'helper',
        turn(call('memory_read', {})),
        turn(call('memory_write', { kind: 'note', text: 'helper note', refs: [] })),
        turn(call('call_agent', { agent: 'leaf', assignment: 'Answer the leaf part.' })),
        finishWith('helper summary'),
      );
      harness.model.scriptAgent('leaf', finishWith('leaf summary'));

      // When
      const started = await startProbe(harness);
      await until(async () => (harness.model.callsOfAgent('lead').length === 4 ? true : undefined), 'lead in its last turn');
      await harness.unrecordControllerTask(started.investigationId);
      leadEnds.open();

      // Then - lifecycle: closed `completed` from the `agent.root` task alone
      expect(await closedStatus(harness, started)).toBe('completed');
      const tasks = await tasksOf(started.investigationId);
      expect(tasks.map((task) => [task.workflowType, task.status])).toEqual([
        ['agent.root', 'succeeded'],
        ['agent.run', 'succeeded'],
        ['agent.run', 'succeeded'],
      ]);

      // Tree (AC-09.1): three runs lead -> helper -> leaf with parent, call, task, result, status and spending
      const tree = await treeOf(harness, started);
      const [lead, helper, leaf] = [runOf(tree, 'lead'), runOf(tree, 'helper'), runOf(tree, 'leaf')];
      expect(tree.runs.map((run) => run.agentName)).toEqual(['lead', 'helper', 'leaf']);
      expect(lead).toMatchObject({
        parent: null,
        depth: 0,
        status: 'succeeded',
        assignment: 'Which part of the probe fails first?',
        result: { summary: 'lead summary', refs: [] },
      });
      expect(helper).toMatchObject({
        parent: { taskId: lead.runTaskId, callIndex: 2 },
        depth: 1,
        assignment: 'Check the helper part.',
        status: 'succeeded',
        result: { summary: 'helper summary', refs: [] },
      });
      expect(leaf).toMatchObject({
        parent: { taskId: helper.runTaskId, callIndex: 2 },
        depth: 2,
        assignment: 'Answer the leaf part.',
        status: 'succeeded',
        result: { summary: 'leaf summary', refs: [] },
      });
      expect([lead.spentTokens, helper.spentTokens, leaf.spentTokens]).toEqual([4 * TURN_CHARGE, 4 * TURN_CHARGE, TURN_CHARGE]);
      expect([lead.subtreeSpentTokens, helper.subtreeSpentTokens, leaf.subtreeSpentTokens]).toEqual([
        9 * TURN_CHARGE,
        5 * TURN_CHARGE,
        TURN_CHARGE,
      ]);
      const ledger = await llmCallsOf(started.investigationId);
      expect(tree.runs.flatMap((run) => run.turns.map((turnRow) => turnRow.llmCallId)).sort()).toEqual(
        ledger.map((row) => row.callId).sort(),
      );
      expect(tree.runs.flatMap((run) => run.turns).every((turnRow) => turnRow.transcriptCallId === turnRow.llmCallId)).toBe(true);
      expect(tree.runs.map((run) => run.turns.map((turnRow) => turnRow.turn))).toEqual([[1, 2, 3, 4], [1, 2, 3, 4], [1]]);

      // The transcript of every turn has role `agent` and reads its input back from the session
      const transcripts = await readTranscripts(harness.db, {
        investigationId: started.investigationId,
        ownerId: started.resourceId,
        retention: 'no_term',
      });
      if (transcripts.outcome !== 'found') throw new Error('transcripts not found');
      expect(transcripts.transcripts.map((transcript) => [transcript.role, transcript.outcome])).toEqual(
        Array.from({ length: 9 }, () => ['agent', 'answered']),
      );
      for (const agent of ['lead', 'helper', 'leaf']) {
        const sent = harness.model.callsOfAgent(agent);
        const read = transcripts.transcripts.filter((transcript) => transcript.agentName === agent);
        expect(read.map((transcript) => (transcript.input as { messages: unknown[] }).messages.length)).toEqual(
          sent.map((recorded) => recorded.prompt.length - 1),
        );
        expect(read.map((transcript) => (transcript.input as { instructions: string }).instructions)).toEqual(
          sent.map((recorded) => recorded.system),
        );
      }

      // Isolation (AC-05.1): lead's session holds its own task, answers and results, and helper's task and result only
      const rows = await agentRowsOf(started.investigationId);
      const leadSession = await sessionOf(lead.runTaskId);
      expect(leadSession.map((message) => message.kind)).toEqual([
        'assignment',
        'model_answer',
        'tool_result',
        'tool_result',
        'model_answer',
        'tool_result',
        'model_answer',
        'tool_result',
        'model_answer',
        'tool_result',
      ]);
      const childContents = new Set(
        rows.messages.filter((message) => message.runTaskId !== lead.runTaskId).map((message) => JSON.stringify(message.content)),
      );
      expect(leadSession.filter((message) => childContents.has(JSON.stringify(message.content)))).toEqual([]);
      expect(contentOf(leadSession[5]!)).toEqual({
        callIndex: 2,
        toolName: 'call_agent',
        outcome: 'success',
        result: { summary: 'helper summary', refs: [] },
      });

      // Memory (AC-03.1), both directions: helper reads lead's note with author lead; lead reads helper's note with its author
      expect(rows.memory.map((note) => [note.kind, note.text, note.agentName, note.runTaskId])).toEqual([
        ['finding', 'lead finding', 'lead', lead.runTaskId],
        ['note', 'helper note', 'helper', helper.runTaskId],
      ]);
      const [leadNote, helperNote] = rows.memory;
      const leadNoteView = { seq: leadNote!.seq, kind: 'finding', text: 'lead finding', refs: [], agent: 'lead', run: lead.runTaskId };
      const helperNoteView = { seq: helperNote!.seq, kind: 'note', text: 'helper note', refs: [], agent: 'helper', run: helper.runTaskId };
      expect(contentOf((await sessionOf(helper.runTaskId))[2]!)).toEqual({
        callIndex: 0,
        toolName: 'memory_read',
        outcome: 'success',
        result: { notes: [leadNoteView], more: false },
      });
      expect(contentOf(leadSession[7]!)).toEqual({
        callIndex: 3,
        toolName: 'memory_read',
        outcome: 'success',
        result: { notes: [leadNoteView, helperNoteView], more: false },
      });

      // Refusal (AC-01.2): the tool outside lead's definition is refused with its reason as lead's next message, not run;
      // the same turn's write was executed
      const leadCalls = rows.toolCalls.filter((row) => row.runTaskId === lead.runTaskId);
      expect(leadCalls.map((row) => [row.turn, row.callIndex, row.toolName, row.state, row.reason])).toEqual([
        [1, 0, 'memory_write', 'done', null],
        [1, 1, 'investigation_read', 'rejected', 'tool_not_in_definition'],
        [2, 2, 'call_agent', 'done', null],
        [3, 3, 'memory_read', 'done', null],
        [4, 4, 'finish', 'done', null],
      ]);
      expect(contentOf(leadSession[3]!)).toEqual({
        callIndex: 1,
        toolName: 'investigation_read',
        outcome: 'rejected',
        reason: 'tool_not_in_definition',
      });

      // Audit (AC-10.2): one audit row per call of the whole tree, the rejected one included; no argument, no run reference
      const auditById = new Map(rows.audit.map((audit) => [audit.id, audit]));
      const agentOfRun = new Map(rows.runs.map((run) => [run.taskId, run.agentName]));
      expect([rows.toolCalls.length, rows.audit.length, new Set(rows.toolCalls.map((row) => row.auditId)).size]).toEqual([10, 10, 10]);
      expect(
        rows.toolCalls.map((row) => {
          const audit = auditById.get(row.auditId ?? '');
          return [agentOfRun.get(row.runTaskId), row.toolName, audit?.toolName, audit?.resourceId, audit?.sourceId, audit?.outcome];
        }),
      ).toEqual([
        ['lead', 'memory_write', 'memory_write', started.resourceId, null, 'success'],
        ['lead', 'investigation_read', 'investigation_read', started.resourceId, null, 'rejected'],
        ['lead', 'call_agent', 'call_agent', started.resourceId, null, 'success'],
        ['helper', 'memory_read', 'memory_read', started.resourceId, null, 'success'],
        ['helper', 'memory_write', 'memory_write', started.resourceId, null, 'success'],
        ['helper', 'call_agent', 'call_agent', started.resourceId, null, 'success'],
        ['leaf', 'finish', 'finish', started.resourceId, null, 'success'],
        ['helper', 'finish', 'finish', started.resourceId, null, 'success'],
        ['lead', 'memory_read', 'memory_read', started.resourceId, null, 'success'],
        ['lead', 'finish', 'finish', started.resourceId, null, 'success'],
      ]);
      // Every audit row of the owner, also one no call references: zero or two rows for a call show here
      const ownerAudit = await auditOf(started.resourceId);
      expect(ownerAudit).toHaveLength(10);
      expect(ownerAudit.map((audit) => audit.id).sort()).toEqual(rows.toolCalls.flatMap((row) => (row.auditId === null ? [] : [row.auditId])).sort());
      for (const audit of ownerAudit) {
        expect(Object.keys(audit).sort()).toEqual(['id', 'outcome', 'recordedAt', 'resourceId', 'sourceId', 'toolName']);
        expect(audit.recordedAt).toBeInstanceOf(Date);
      }

      // One request per turn (KD-1): double calls == ledger rows of role agent == turns in the sessions; each to the
      // definition's model and to no other recipient (NFR-02)
      const agentCalls = harness.model.calls.filter((recorded) => recorded.role === 'agent');
      const turns = rows.messages.filter((message) => message.kind === 'model_answer');
      expect([agentCalls.length, ledger.length, turns.length]).toEqual([9, 9, 9]);
      expect(harness.model.calls.filter((recorded) => recorded.role !== 'agent')).toEqual([]);
      expect(agentCalls.filter((recorded) => recorded.modelId !== modelOf(recorded.agent ?? ''))).toEqual([]);
      expect(ledger.filter((row) => row.model !== modelOf(agentOfRun.get(row.taskId ?? '') ?? ''))).toEqual([]);

      // Budget sums (AC-07.2): the per-run spend adds up to the investigation's charged total
      const read = await harness.engine.readInvestigation(started);
      if (read.outcome !== 'found') throw new Error('investigation not found');
      expect(read.view.usage.totalTokens).toBe(9 * TURN_CHARGE);
      expect(lead.spentTokens + helper.spentTokens + leaf.spentTokens).toBe(read.view.usage.totalTokens);

      // DC-29 (UC-1): both reads answer `found` without an error, and the calls stand as rows of role `agent`
      expect(read.view.usage.byRoleAndModel.map((row) => [row.role, row.model, row.calls])).toEqual([
        ['agent', 'anthropic/claude-haiku-5-5', 5],
        ['agent', 'anthropic/claude-sonnet-5-5', 4],
      ]);
      const record = await readRunRecord(harness.db, { investigationId: started.investigationId, ownerId: started.resourceId });
      if (record.outcome !== 'found') throw new Error('run record not found');
      expect(record.record.usage.byRoleAndModel.map((row) => [row.role, row.model, row.calls])).toEqual([
        ['agent', 'anthropic/claude-haiku-5-5', 5],
        ['agent', 'anthropic/claude-sonnet-5-5', 4],
      ]);

      // Stable prefix (AC-21.1): each lead turn repeats the previous turn's messages unchanged; the cache mark is on the
      // system block and on the last message only, never left behind on an older one
      const leadTurns = harness.model.callsOfAgent('lead');
      for (const [index, current] of leadTurns.entries()) {
        // Mastra copies the mark of a tool result onto the call it answers (role-agent.ts), so a view that ends with
        // results is marked on that answer too; nothing older is marked
        const last = current.prompt.length - 1;
        expect(cacheMarked(current)).toEqual(current.prompt[last]!.role === 'tool' ? [0, last - 1, last] : [0, last]);
        if (index === 0) continue;
        const previous = messagesOf(leadTurns[index - 1]!);
        expect(messagesOf(current).slice(0, previous.length)).toEqual(previous);
      }

      // No domain step: the probe process makes no source call
      expect(harness.countingSource.calls).toHaveLength(0);
    }, CASE_MS);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-2  Two sibling agents at once: they run concurrently, the parent wakes once, notes do not collide (UC-4, UC-E5)
  // ---------------------------------------------------------------------------------------------------------------
  // AC: "AC-05.2: Given родитель одним ходом вызвал несколько дочерних агентов, Then они работают одновременно, и родитель получает результат каждого."
  // AC: "AC-03.3: Given два агента пишут в память одновременно, Then сохранены обе заметки."
  // AC (Design Doc): "DC-5: Результаты дочерних агентов одного хода приходят родителю одним пробуждением, когда закончились все, и стоят в его сессии в порядке вызовов."
  // Behavior: lead calls `helper` twice in one turn -> both helper runs are in the model at the same time -> each writes a note and finishes -> lead wakes once -> its session holds both results in call order
  // Catches: siblings serialised (the second child starts only after the first ends); the parent woken twice (a second wake runs a duplicate turn or is rejected as a stale attempt); results written in the order the children finished instead of the order of the
  //   calls; two notes written in the same instant get one number, overwrite each other or lose one.
  // @category: core-functionality
  // @dependency: AgentRunHandler, TaskScheduler (waits_for), ToolExecutor (memory_write), research_agent_memory, real Postgres
  // @complexity: high
  //
  // Given: runtime `concurrency` >= 2 (the harness default is 2; lead is `waiting`, so both slots are free for the children). The double holds the FIRST model call of each helper until both have arrived (a latch released when
  //   `model.callsOfAgent('helper')` has two entries): the first helper cannot answer before the second has begun its work. The second call (`finish`) of the helper that was called FIRST is scripted to answer AFTER the one of the helper called second
  //   (the later-finishing child must still be first in lead's session). Both helpers' tool calls of turn 1 are `memory_write`, released together by the same latch so the two writes reach the engine at the same moment.
  // When: both helpers finish.
  // Then:
  //   - Concurrency (AC-05.2): the two helper runs overlapped - both have a recorded model call before either has a result (read from the double's call order and the run rows); neither waited for the other
  //   - One wake (DC-5): lead's task shows one `wait` and one wake; lead has exactly one turn after the calls, and that turn's session shows two results in the order of the calls (call 1 first), although the children ended in the opposite order
  //   - Notes (AC-03.3): `research_agent_memory` holds both notes, with different sequence numbers and different author runs; neither note is missing and `memory_read` returns both with their authors
  //   - Limit of this row: a database cannot be forced to interleave two transactions from a test without a hook in `src`; releasing both writes from one latch makes the collision likely, not certain. A guaranteed proof of the numbering
  //     under concurrent writers is the unit/repository spec of the memory write (two `Promise.all` writes on the real table, repeated), named for the plan; this test proves the wiring of the same scenario, not the lock.
  describe('INT-2', () => {
    let harness: EngineHarness;
    /** The program of the helpers: two runs of one definition share no script, so they answer by their own assignment. */
    let helperProgram: ((recorded: RecordedModelCall) => ScriptedStep | undefined) | undefined;
    let bothInModel = latch();
    let firstMayFinish = latch();

    beforeAll(async () => {
      harness = await probeHarness({ model: { fallback: (recorded) => helperProgram?.(recorded) } });
    });

    afterAll(async () => {
      await harness?.close();
      await closeEngineDb();
    });

    beforeEach(() => {
      harness.model.reset();
      bothInModel = latch();
      firstMayFinish = latch();
    });

    afterEach(async () => {
      bothInModel.open();
      firstMayFinish.open();
      helperProgram = undefined;
      try {
        expect(harness.model.pendingAgents()).toEqual({ lead: 0 });
      } finally {
        await harness.cancelStarted();
      }
    });

    it('INT-2: two helpers called in one turn run at once, wake lead once with results in call order, and both of their simultaneous notes are kept', async () => {
      // Given: concurrency 2 (the harness default; lead waits, so both slots are free). Each helper's first turn is held
      // until both helpers are in the model; the helper called first finishes only after the one called second has ended.
      const partOf = (recorded: RecordedModelCall): 1 | 2 => (recorded.user.includes('[part-1]') ? 1 : 2);
      helperProgram = (recorded) => {
        if (recorded.agent !== 'helper') return undefined;
        if (harness.model.callsOfAgent('helper').length === 2) bothInModel.open();
        const part = partOf(recorded);
        if (recorded.toolResults === 0) {
          const note = call('memory_write', { kind: 'note', text: `helper note ${part}`, refs: [] });
          return { toolCalls: [note], usage: TURN_USAGE, holdUntil: bothInModel.wait };
        }
        const finish = call('finish', { summary: `part ${part} done`, refs: [] });
        return { toolCalls: [finish], usage: TURN_USAGE, ...(part === 1 ? { holdUntil: firstMayFinish.wait } : {}) };
      };
      harness.model.scriptAgent(
        'lead',
        turn(
          call('call_agent', { agent: 'helper', assignment: '[part-1] Check the first part.' }),
          call('call_agent', { agent: 'helper', assignment: '[part-2] Check the second part.' }),
        ),
        turn(call('memory_read', {})),
        finishWith('both parts checked'),
      );

      // When: both helpers finish, the one called second first
      const started = await startProbe(harness);
      const runs = await until(async () => {
        const helpers = (await agentRowsOf(started.investigationId)).runs.filter((run) => run.agentName === 'helper');
        return helpers.length === 2 ? helpers : undefined;
      }, 'two helper runs');
      const [first, second] = [runs.find((run) => run.assignment?.startsWith('[part-1]')), runs.find((run) => run.assignment?.startsWith('[part-2]'))];
      if (first === undefined || second === undefined) throw new Error('helper runs by part not found');
      const secondTask = await finalTask(started.investigationId, second.taskId);
      firstMayFinish.open();
      expect(await closedStatus(harness, started)).toBe('completed');

      // Then - concurrency (AC-05.2): both helpers were in the model before either had a result
      const helperCalls = harness.model.callsOfAgent('helper');
      expect(helperCalls.map((recorded) => recorded.toolResults)).toEqual([0, 0, 1, 1]);
      expect(helperCalls.slice(0, 2).map(partOf).sort((left, right) => left - right)).toEqual([1, 2]);
      const firstTask = await finalTask(started.investigationId, first.taskId);
      expect([secondTask.status, firstTask.status]).toEqual(['succeeded', 'succeeded']);

      // One wake (DC-5): lead's task waited once and was woken once; one turn after the calls reads both results, in the
      // order of the calls although the children ended the other way round
      const leadTask = (await tasksOf(started.investigationId)).find((task) => task.workflowType === 'agent.root');
      expect([leadTask?.status, leadTask?.attempt, leadTask?.recoveryCount]).toEqual(['succeeded', 2, 0]);
      const leadTurns = harness.model.callsOfAgent('lead');
      expect(leadTurns).toHaveLength(3);
      const tree = await treeOf(harness, started);
      const lead = runOf(tree, 'lead');
      expect(lead.turns.map((turnRow) => turnRow.turn)).toEqual([1, 2, 3]);
      const leadSession = await sessionOf(lead.runTaskId);
      const childResults = leadSession.filter((message) => contentOf(message)['toolName'] === 'call_agent').map(contentOf);
      expect(childResults).toEqual([
        { callIndex: 0, toolName: 'call_agent', outcome: 'success', result: { summary: 'part 1 done', refs: [] } },
        { callIndex: 1, toolName: 'call_agent', outcome: 'success', result: { summary: 'part 2 done', refs: [] } },
      ]);
      const afterWake = leadTurns[1]!.prompt.at(-1)!;
      expect(afterWake.role).toBe('tool');
      const wakeResults = afterWake.content as { toolName: string; output: { value: string } }[];
      expect(wakeResults.map((part) => [part.toolName, part.output.value.includes('part 1 done')])).toEqual([
        ['call_agent', true],
        ['call_agent', false],
      ]);

      // Notes (AC-03.3): both notes kept, with different numbers and different author runs; lead reads both with authors
      const memory = (await agentRowsOf(started.investigationId)).memory;
      expect(memory.map((note) => [note.text, note.agentName, note.runTaskId]).sort(byFirst)).toEqual([
        ['helper note 1', 'helper', first.taskId],
        ['helper note 2', 'helper', second.taskId],
      ]);
      expect(new Set(memory.map((note) => note.seq)).size).toBe(2);
      const read = leadSession.find((message) => contentOf(message)['toolName'] === 'memory_read');
      const readNotes = ((contentOf(read!)['result'] as { notes: { text: string; agent: string; run: string }[] }).notes).map(
        (note) => [note.text, note.agent, note.run],
      );
      expect(readNotes.sort(byFirst)).toEqual([
        ['helper note 1', 'helper', first.taskId],
        ['helper note 2', 'helper', second.taskId],
      ]);
    }, CASE_MS);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-3  Stop and close take down the whole tree (UC-6)
  // ---------------------------------------------------------------------------------------------------------------
  // AC: "AC-08.1: Given в дереве работают несколько агентов, When сотрудник останавливает расследование, Then после перехода ни один агент дерева не начинает вызов модели или инструмента."
  // AC: "AC-08.2: ... их запуски отменены тем же переходом." (this part: the cancel half - the child runs are cancelled by the same `closeInTx` transition when the root ends in failure while they work; "completed with a ready answer" is `research-flow`)
  // AC (Design Doc): "DC-18: ... когда корень кончился сбоем - например, сроком, пока дочерний ещё в вызове модели; тот же переход `closeInTx`, что при закрытии с ответом, отменяет их."
  // Behavior: (A) stop while lead waits for two helpers - one in a model call, one queued -> `InvestigationService.cancel` -> every agent task `cancelled`, nothing new starts; (B) lead's deadline passes while a helper is in a model call -> lead ends `failed` -> `closeInTx` cancels the helper
  // Catches: a child run left running or queued after the stop (a run that is not a task of the investigation, or one the cancel transition misses); a model call or a tool call that starts after the transition (the reserve check or the `requireActive` guard missing on one path);
  //   after a root failure the investigation closes `failed` but the children keep spending the budget, because the close did not cancel them.
  // @category: core-functionality
  // @dependency: AgentRunHandler, ModelGateway reserve (`stopping`), ToolExecutor (`requireActive`), InvestigationService.cancel / closeInTx, runtime deadline, real Postgres
  // @complexity: high
  //
  // Row A - stop
  //   Given: runtime `concurrency` 1 so exactly one helper runs and the other is `queued`; lead turn 1 = two `call_agent(helper)`; helper #1's model call is `hangUntilAborted`; the second helper's first step is scripted but must never be consumed.
  //   When: the owner's `InvestigationService.cancel` runs (the real service behind `ResearchLaunchService.stopLaunch`); then the test waits for the `endedRuns` of every agent task.
  //   Then (verification items):
  //   - Every agent task of the investigation (`agent.root`, both `agent.run`) is `cancelled`; the helper's in-flight double call was aborted (its signal fired); the queued helper has no attempt and no session row
  //   - After the transition: a snapshot of `research_llm_calls` ids, `research_agent_tool_calls` ids and `model.calls.length` taken right after `cancel` returns equals the one taken after all runs ended - no new reserve, no new model call, no new tool call (AC-08.1)
  //   - The aborted call's ledger row follows the late-close rule (the in-flight reservation stays counted with the charged total; the repo file's late-close case); this test adds no new rule for it
  //   - The waiting parent is cancelled by the same transition and is not woken by its cancelled children (no wake attempt, no duplicate turn)
  // Row B - close on a root failure
  //   Given: lead's `deadlineMs` is short on the injected runtime clock; lead called one helper and waits; the helper's model call is `hangUntilAborted`.
  //   When: the runtime clock passes lead's deadline (the injected clock and the lease/deadline sweep, not `engineClock.offsetMs`, which moves only `notAfter`).
  //   Then: lead's task is `failed` with class `deadline`; the investigation is `failed`; the helper's task is `cancelled` by the close transition and its model call was aborted; the ledger and tool-call snapshots do not grow after the close.
  // Row C (task text, plan 1.2; the second run of UC-E10 and the second case of DC-18): helper ended by the runtime with
  //   `recovery_exhausted` while leaf is still in a model call; lead, woken with `child_failed`, answers `finish`.
  //   Then: before lead's closing turn leaf is `running` with no cancel request; the root ends `succeeded` and the investigation
  //   `completed`; the close cancels leaf by the same transition, its model call is aborted, and the journal and tool-call
  //   snapshots do not grow after the close (ADR-0006). Absorbs research-flow INT-2 D (the same close on the research forms:
  //   the forms write through the same guarded process code, so the probe form proves it once).
  describe('INT-3', () => {
    afterAll(async () => {
      await closeEngineDb();
    });

    it('INT-3 A: after the owner stops the investigation every run of the tree is cancelled, a queued child never starts, and no reserve, model call or tool call begins after the transition', async () => {
      const harness = await probeHarness({ runtime: { concurrency: 1 } });
      try {
        // Given: one slot, so the first helper runs (its model call hangs) and the second stays queued
        harness.model.scriptAgent(
          'lead',
          turn(
            call('call_agent', { agent: 'helper', assignment: 'First helper.' }),
            call('call_agent', { agent: 'helper', assignment: 'Second helper.' }),
          ),
        );
        harness.model.scriptAgent('helper', { hangUntilAborted: true }, finishWith('never consumed'));
        const started = await startProbe(harness);
        await until(async () => (harness.model.callsOfAgent('helper').length === 1 ? true : undefined), 'first helper in the model');
        const [inFlight] = harness.model.callsOfAgent('helper');

        // When: the owner stops the investigation through the real service
        await harness.runtime.investigations.cancel(started.investigationId, started.resourceId);
        const atTransition = await journalOf(harness, started.investigationId);
        const tasks = await until(async () => {
          const rows = await tasksOf(started.investigationId);
          const ended = rows.filter((task) => task.attempt > 0).every((task) => harness.endedRuns.some((run) => run.taskId === task.taskId));
          return ended && rows.every((task) => task.status === 'cancelled') ? rows : undefined;
        }, 'every agent task cancelled and every attempt ended');

        // Then: every task of the tree is cancelled; the in-flight call was aborted; the queued helper never started
        expect(tasks.map((task) => [task.workflowType, task.status])).toEqual([
          ['agent.root', 'cancelled'],
          ['agent.run', 'cancelled'],
          ['agent.run', 'cancelled'],
        ]);
        expect(inFlight?.abortSignal?.aborted).toBe(true);
        const rows = await agentRowsOf(started.investigationId);
        const queued = tasks[2]!;
        expect(queued.attempt).toBe(0);
        expect(rows.runs.filter((run) => run.taskId === queued.taskId)).toEqual([]);
        expect(rows.messages.filter((message) => message.runTaskId === queued.taskId)).toEqual([]);
        expect(harness.model.pendingAgents()).toEqual({ lead: 0, helper: 1 });

        // No reserve, model call or tool call after the transition (AC-08.1)
        expect(await journalOf(harness, started.investigationId)).toEqual(atTransition);
        // The waiting parent is cancelled by the same transition, never woken by its cancelled children
        expect([tasks[0]!.attempt, harness.model.callsOfAgent('lead').length]).toEqual([1, 1]);
      } finally {
        harness.model.reset();
        await harness.cancelStarted();
        await harness.close();
      }
    }, CASE_MS);

    // Rows B and C are one rule — the end of the root closes the investigation and the close cancels every descendant
    // still in a model call by the same transition — over the two ways a root ends: in failure by its deadline (B) and
    // with a result after `child_failed` (C). Each row runs its own harness: B moves the runtime clock past lead's
    // deadline, C spends helper's recovery limit while leaf works.
    interface ClosedTree {
      readonly closed: string;
      readonly tasks: readonly (readonly [string, string])[];
      readonly rootFailureClass: string | null;
      readonly leadCalls?: readonly (readonly [string, unknown])[];
      readonly inFlightAborted: boolean | undefined;
      readonly nothingAfterClose: boolean;
      readonly pending: Record<string, number>;
      /** `[status, cancelRequestedAt]` of the descendant before the root's closing turn: the cancel can only come from the close. */
      readonly descendantBeforeClose?: readonly [string | undefined, unknown];
    }

    /** What the close left: the tasks once the cancelled descendant's attempts ended, and the journal against `atClose`. */
    async function afterClose(harness: EngineHarness, started: Started, descendant: string, atClose: unknown) {
      const tasks = await until(async () => {
        const rows = await tasksOf(started.investigationId);
        const cancelled = rows.find((task) => (task.input as { agentName?: string }).agentName === descendant);
        const ended = rows.filter((task) => task.attempt > 0).every((task) => harness.endedRuns.filter((run) => run.taskId === task.taskId).length === task.attempt);
        return cancelled?.status === 'cancelled' && ended ? rows : undefined;
      }, `${descendant} cancelled and every attempt ended`);
      return {
        tasks: tasks.map((task) => [task.workflowType, task.status] as const),
        rootFailureClass: (tasks[0]!.failureReason as { class?: string } | null)?.class ?? null,
        nothingAfterClose: JSON.stringify(await journalOf(harness, started.investigationId)) === JSON.stringify(atClose),
      };
    }

    it.each<[string, () => Promise<ClosedTree>, ClosedTree]>([
      [
        'INT-3 B: a root that ends in failure while its child is in a model call closes the investigation failed and cancels the child by the same transition',
        async () => {
          // Given: lead's deadline is short on the runtime clock; the runtime's lease is long, so moving the clock past
          // lead's deadline expires only the waiting lead (the sweep of queued and waiting tasks), not the running
          // helper's lease. The heartbeat is short: it is how the runtime hands the close's cancel to an attempt that
          // runs in its process.
          const clock = shiftableClock();
          const harness = await probeHarness({
            clock,
            processes: [agentProbeConfig({ limits: { lead: { deadlineMs: 20_000 } } })],
            runtime: { leaseMs: 120_000, heartbeatMs: 200, reaperMs: 50 },
            agent: { turnMs: 1_000, deadlineMarginMs: 2_000, leaseMs: 500 },
          });
          try {
            harness.model.scriptAgent('lead', turn(call('call_agent', { agent: 'helper', assignment: 'Hang in the model.' })));
            harness.model.scriptAgent('helper', { hangUntilAborted: true });
            const started = await startProbe(harness);
            await until(async () => (harness.model.callsOfAgent('helper').length === 1 ? true : undefined), 'helper in the model');
            const [inFlight] = harness.model.callsOfAgent('helper');

            // When: the runtime clock passes lead's deadline
            clock.shiftMs = 30_000;
            const closed = await closedStatus(harness, started);
            const atClose = await journalOf(harness, started.investigationId);
            return {
              closed,
              ...(await afterClose(harness, started, 'helper', atClose)),
              inFlightAborted: inFlight?.abortSignal?.aborted,
              pending: harness.model.pendingAgents(),
            };
          } finally {
            clock.shiftMs = 0;
            harness.model.reset();
            await harness.cancelStarted();
            await harness.close();
          }
        },
        {
          closed: 'failed',
          tasks: [
            ['agent.root', 'failed'],
            ['agent.run', 'cancelled'],
          ],
          rootFailureClass: 'deadline',
          inFlightAborted: true,
          nothingAfterClose: true,
          pending: { lead: 0, helper: 0 },
        },
      ],
      [
        'INT-3 C: a root that finishes after child_failed while a grandchild is in a model call completes the investigation and cancels the grandchild by the same transition',
        async () => {
          // Given: helper calls leaf; helper's attempts lose their lease until the recovery limit is spent while leaf's
          // model call hangs; lead answers `finish` as soon as it gets `child_failed`
          const harness = await probeHarness({ runtime: RECOVERY_RUNTIME });
          const held: Array<() => void> = [];
          // The closing turn waits until leaf's state is read, so the root cannot close before it.
          const preconditionRead = latch();
          held.push(preconditionRead.open);
          try {
            harness.model.scriptAgent(
              'lead',
              turn(call('call_agent', { agent: 'helper', assignment: 'Delegate to leaf.' })),
              { ...finishWith('finished without helper'), holdUntil: preconditionRead.wait },
            );
            harness.model.scriptAgent('helper', turn(call('call_agent', { agent: 'leaf', assignment: 'Hang in the model.' })));
            harness.model.scriptAgent('leaf', { hangUntilAborted: true });
            const started = await startProbe(harness);
            const helperTask = await exhaustHelperRecovery(harness, started, held);
            expect((helperTask.failureReason as { code?: string } | null)?.code).toBe('recovery_exhausted');
            const [inFlight] = harness.model.callsOfAgent('leaf');
            // Absorbs research-flow INT-2 D: the failed helper has cancelled nothing before the close.
            const leafBeforeClose = (await tasksOf(started.investigationId)).find((task) => (task.input as { agentName?: string }).agentName === 'leaf');
            const descendantBeforeClose = [leafBeforeClose?.status, leafBeforeClose?.cancelRequestedAt] as const;
            preconditionRead.open();

            // When: lead gets `child_failed` and finishes
            const closed = await closedStatus(harness, started);
            const atClose = await journalOf(harness, started.investigationId);
            for (const release of held) release();
            const ended = await afterClose(harness, started, 'leaf', atClose);
            const lead = runOf(await treeOf(harness, started), 'lead');
            return {
              closed,
              ...ended,
              leadCalls: lead.toolCalls.map((row) => [row.toolName, row.outcome] as const),
              inFlightAborted: inFlight?.abortSignal?.aborted,
              pending: harness.model.pendingAgents(),
              descendantBeforeClose,
            };
          } finally {
            for (const release of held) release();
            harness.schedulerHold.afterPropose = undefined;
            harness.handlerHold.at = undefined;
            harness.model.reset();
            await harness.cancelStarted();
            await harness.close();
          }
        },
        {
          closed: 'completed',
          tasks: [
            ['agent.root', 'succeeded'],
            ['agent.run', 'failed'],
            ['agent.run', 'cancelled'],
          ],
          rootFailureClass: null,
          leadCalls: [
            ['call_agent', { outcome: 'tool_error', reason: 'child_failed', result: { child_failed: 'failed' } }],
            ['finish', { outcome: 'success', result: { summary: 'finished without helper', refs: [] } }],
          ],
          inFlightAborted: true,
          nothingAfterClose: true,
          pending: { lead: 0, helper: 0, leaf: 0 },
          descendantBeforeClose: ['running', null],
        },
      ],
    ])('%s', async (_case, scenario, expected) => {
      // Then: the investigation closed as the root ended; the descendant in a model call was cancelled by the close and its
      // call aborted; no reserve, model call or tool call after the close (ADR-0006)
      expect(await scenario()).toEqual(expected);
    }, CASE_MS);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-4  One budget for the tree: refusals by budget and the return of an unspent share (UC-E6, UC-E10; AC-07.2 sums)
  // ---------------------------------------------------------------------------------------------------------------
  // The one extra under the rule (see Budget): its unique defect is stated above. Rows are one rule (the share and the budget are read from the same ledger).
  // AC: "AC-07.1: Given бюджет расследования меньше требуемого, Then ни один агент дерева не начинает вызов модели сверх бюджета, а расследование завершается с причиной «бюджет исчерпан»." (this part: no call over the budget; the reason in the answer is `research-flow`, here the tree read shows `budgetExhausted`)
  // AC (Design Doc): "DC-8: ... Если остаток меньше одного хода дочернего, вызов отклонён с причиной `budget_exhausted`, и запуск не создан."
  // AC (Design Doc): "DC-9: Когда дочерний запуск кончился и в его поддереве не осталось задач в работе, его неистраченная доля возвращается родителю ... Пока в поддереве есть задачи в работе, доля занята целиком, даже если сам дочерний уже провалился."
  // AC (Design Doc): "DC-10: Запуск, которому на следующий ход не хватает доли или бюджета расследования, завершается причиной `budget_exhausted`; вызова модели сверх доли нет."  and  "DC-16: ... чтение дерева показывает признак `budgetExhausted`."
  // AC: "AC-05.3: ... родитель получает отказ с причиной и продолжает работу, а не ждёт бесконечно."  (B3: the reason `failed` of a child ended by the runtime)
  // Behavior: lead calls helper under a tight budget -> the share/reserve check refuses by the ledger's numbers -> no task, no model call over the budget; or helper ends early -> its unspent share returns to lead
  // Catches: B1 - a child run created although the parent's remainder is below one child turn (the share is not checked before the task is proposed); B2 - a reserve granted past the investigation pool or the run's share, so a call starts over the budget;
  //   B3 - a share that stays held after the subtree ended (budget locked for nothing), or one returned while a grandchild still runs (the same tokens spent twice), or a parent's remainder that counts the failed child's reserve twice.
  // @category: core-functionality
  // @dependency: postgresCallLedger / decideReserve (shares), ToolExecutor (call_agent), AgentRunHandler, readAgentTree, real Postgres
  // @complexity: high
  //
  // Budget numbers are chosen in the test from the probe definitions (`windowTokens + maxOutputTokens` = one turn of that agent, `runTokens`), with the counting token counter (1 token per character) and explicit scripted usage; assertions use literals computed from them.
  //
  // Row B1 (UC-E6, first run): investigation budget < one lead turn + one helper turn.
  //   When: lead (root, share = the whole budget) calls `helper`.
  //   Then: the call is `rejected` with `budget_exhausted`; no child task, no child run row; lead gets the refusal in its session, finishes with what it has and the root ends `completed`; the tree read shows `budgetExhausted: true`; the sum of ledger
  //   charged + open reserves <= the investigation budget; no model call was recorded past the budget (DC-8, DC-16, AC-07.1).
  // Row B2 (UC-E6, second run): investigation budget < two turns of lead itself.
  //   When: lead makes its first turn and needs a second.
  //   Then: the reserve of the second turn is refused (`investigation_tokens_exhausted`), no second model call is recorded, the root task is `failed` with class `budget_exhausted`, the investigation is `failed`, the tree read shows `budgetExhausted: true`;
  //   charged + open reserves <= budget (DC-10, DC-16, AC-07.1).
  // Row B3 (UC-E10): the share of a child that ended before its subtree.
  //   Given: lead calls helper (share = min(helper `runTokens`, lead's remainder)); helper calls leaf, then the runtime ends helper `failed` with `recovery_exhausted` (its attempts lose their lease until the recovery limit is spent, the harness `expireLease` on each attempt)
  //   while leaf's model call is held; lead is woken by the failure.
  //   When: lead makes its next turn; later leaf's call is released and leaf finishes.
  //   Then: lead's session holds `child_failed` with reason `failed` (AC-05.3); while leaf is running, lead's held amount (read from the tree read: own spend + the whole share of helper) still includes helper's whole share and lead's next reserve is checked against
  //   that smaller remainder; after leaf ended, lead's held amount is its own spend + the actual spend of helper's subtree and the remainder is back (a later lead call_agent that needs the returned part is accepted); the sum of per-run spend equals the investigation's charged total (AC-07.2).
  //   Needs a hook that holds the engine between `TaskScheduler.propose` returning and the write that records the child's task id (support item 4): the existing `handlerHold` points sit after guarded writes, none lies in that gap.
  // Row B4 (task text, plan 1.2; UC-5): the budget and helper's `runTokens` let lead grant a share to one helper but not
  //   to two at once; helper spends less than its share and ends `completed`; lead calls helper again.
  //   Then: the second call is accepted and a second helper run is created, its share granted from the returned rest;
  //   the per-run spend by the ledger adds up to the investigation's charged total. Catches: the share of a child that
  //   ended `completed` stays held whole, and the second call is refused `budget_exhausted`.
  describe('INT-4', () => {
    let harness: EngineHarness;

    beforeAll(async () => {
      harness = await probeHarness({
        processes: [agentProbeConfig(), agentProbeConfig({ processId: B4_PROCESS_ID, limits: { helper: { runTokens: B4_HELPER_SHARE } } })],
        runtime: RECOVERY_RUNTIME,
      });
    });

    afterAll(async () => {
      await harness?.close();
      await closeEngineDb();
    });

    beforeEach(() => {
      harness.model.reset();
    });

    afterEach(async () => {
      harness.schedulerHold.afterPropose = undefined;
      harness.handlerHold.at = undefined;
      await harness.cancelStarted();
    });

    /** The ledger's charged tokens and open reservations of the investigation: never above its budget (AC-07.1). */
    async function spentOf(started: Started): Promise<number> {
      const read = await harness.engine.readInvestigation(started);
      if (read.outcome !== 'found') throw new Error('investigation not found');
      return read.view.usage.totalTokens;
    }

    it("INT-4 B1: a call_agent whose share does not fit the parent's remainder is rejected with budget_exhausted, creates no run and the tree read shows budgetExhausted", async () => {
      // Given: a budget that holds lead's reserves (counted input + marginTokens + maxOutputTokens) but leaves lead's free
      // rest below one helper turn (windowTokens + maxOutputTokens = 33 000)
      harness.model.scriptAgent(
        'lead',
        turn(call('call_agent', { agent: 'helper', assignment: 'There is no budget for this.' })),
        finishWith('finished with what it had'),
      );

      // When: lead (root, share = the whole budget) calls helper
      const started = await startProbe(harness, { tokenBudget: 30_000 });
      expect(await closedStatus(harness, started)).toBe('completed');

      // Then: the call is refused before any task; lead finishes; the tree shows `budgetExhausted`
      const tree = await treeOf(harness, started);
      expect(tree.runs.map((run) => [run.agentName, run.status])).toEqual([['lead', 'succeeded']]);
      expect(runOf(tree, 'lead').toolCalls.map((row) => [row.toolName, row.state, row.reason, row.childTaskId])).toEqual([
        ['call_agent', 'rejected', 'budget_exhausted', null],
        ['finish', 'done', null, null],
      ]);
      expect((await tasksOf(started.investigationId)).map((task) => task.workflowType)).toEqual(['agent.root']);
      expect(tree.budgetExhausted).toBe(true);
      expect(harness.model.calls.map((recorded) => recorded.agent)).toEqual(['lead', 'lead']);
      expect((await llmCallsOf(started.investigationId)).map((row) => row.status)).toEqual(['settled', 'settled']);
      expect(await spentOf(started)).toBe(2 * TURN_CHARGE);
    }, CASE_MS);

    it('INT-4 B2: a root without the budget for its next turn starts no further model call, fails with budget_exhausted and spends no more than the budget', async () => {
      // Given: a budget the first reserve (the counted input + marginTokens + maxOutputTokens) fits, but not the charge of
      // the first turn plus the reserve of the second
      harness.model.scriptAgent('lead', {
        toolCalls: [call('memory_write', { kind: 'note', text: 'an expensive first turn', refs: [] })],
        usage: { inputTokens: 18_000, outputTokens: 500 },
      });

      // When: lead makes its first turn and needs a second
      const started = await startProbe(harness, { tokenBudget: 22_000 });
      expect(await closedStatus(harness, started)).toBe('failed');

      // Then: the second reserve is refused by the investigation's budget; no second model call
      const [root] = await tasksOf(started.investigationId);
      expect([root?.status, (root?.failureReason as { class?: string; code?: string } | null)?.class]).toEqual(['failed', 'budget_exhausted']);
      expect((root?.failureReason as { code?: string } | null)?.code).toBe('investigation_tokens_exhausted');
      expect(harness.model.callsOfAgent('lead')).toHaveLength(1);
      expect((await llmCallsOf(started.investigationId)).map((row) => row.status)).toEqual(['settled']);
      const tree = await treeOf(harness, started);
      expect(tree.budgetExhausted).toBe(true);
      expect(await spentOf(started)).toBe(18_500);
    }, CASE_MS);

    // Rows B3 and B4 are one rule — a child's share is held whole while its subtree works and comes back, but for the
    // subtree's actual spend, once it does not — over a child ended by the runtime before its subtree (B3, UC-E10) and a
    // child that completed (B4, UC-5). Both show the returned share paying for a later call and the per-run spend adding
    // up to the investigation's charged total (AC-07.2).
    interface ShareReturn {
      readonly closed: string;
      readonly leadCalls: readonly (readonly [string, string, string | null])[];
      readonly callShares: readonly (number | null)[];
      readonly helpers: readonly (readonly [string, number])[];
      /** B3: lead's first call ended `child_failed(failed)` and the failed helper's subtree spend. */
      readonly childFailed?: unknown;
      readonly failedHelperSubtree?: number;
      readonly perRunSpent: number;
      readonly investigationSpent: number;
    }

    /** What the tree read and the ledger show once the investigation closed. */
    async function shareReturnOf(started: Started, closed: string): Promise<ShareReturn> {
      const tree = await treeOf(harness, started);
      const lead = runOf(tree, 'lead');
      const rows = await agentRowsOf(started.investigationId);
      return {
        closed,
        leadCalls: lead.toolCalls.map((row) => [row.toolName, row.state, row.reason] as const),
        callShares: rows.toolCalls.filter((row) => row.runTaskId === lead.runTaskId && row.toolName === 'call_agent').map((row) => row.shareTokens),
        helpers: tree.runs.filter((run) => run.agentName === 'helper').map((run) => [run.status, run.shareTokens] as const),
        perRunSpent: tree.runs.reduce((sum, run) => sum + run.spentTokens, 0),
        investigationSpent: await spentOf(started),
      };
    }

    it.each<[string, () => Promise<ShareReturn>, ShareReturn]>([
      [
        'INT-4 B3: a child ended by the runtime before its subtree keeps its whole share held until the subtree ends, then only its actual spend, and the parent gets child_failed(failed)',
        async () => {
          // Given: helper's share is 150 000 of a 180 000 budget; helper calls leaf and is then ended by the runtime
          // (`recovery_exhausted`) while leaf's model call is held. While leaf works, lead's free rest (180 000 minus its
          // own spend minus helper's whole share) is below one helper turn (33 000); once leaf has ended it is not.
          const leafRelease = latch();
          const leafEnded = latch();
          const held: Array<() => void> = [];
          harness.model.scriptAgent(
            'lead',
            turn(call('call_agent', { agent: 'helper', assignment: 'Delegate to leaf.' })),
            turn(call('call_agent', { agent: 'helper', assignment: 'Try again while leaf runs.' })),
            { toolCalls: [call('call_agent', { agent: 'helper', assignment: 'Try again after leaf.' })], usage: TURN_USAGE, holdUntil: leafEnded.wait },
            finishWith('done after the returned share'),
          );
          harness.model.scriptAgent(
            'helper',
            turn(call('call_agent', { agent: 'leaf', assignment: 'Work while helper is lost.' })),
            finishWith('second helper done'),
          );
          harness.model.scriptAgent('leaf', { toolCalls: [call('finish', { summary: 'leaf done', refs: [] })], usage: TURN_USAGE, holdUntil: leafRelease.wait });
          try {
            const started = await startProbe(harness, { tokenBudget: 180_000 });
            const helperTask = await exhaustHelperRecovery(harness, started, held);
            expect((helperTask.failureReason as { code?: string } | null)?.code).toBe('recovery_exhausted');

            // When: lead makes its next turn while leaf runs; later leaf's call is released and leaf finishes
            const refused = await until(async () => {
              const lead = runOf(await treeOf(harness, started), 'lead');
              return lead.toolCalls.length === 2 && lead.toolCalls[1]!.state === 'rejected' ? lead : undefined;
            }, 'the call of lead while leaf runs is refused');
            leafRelease.open();
            const leafTask = (await tasksOf(started.investigationId)).find((task) => (task.input as { agentName?: string }).agentName === 'leaf');
            expect((await finalTask(started.investigationId, leafTask!.taskId)).status).toBe('succeeded');
            leafEnded.open();
            const closed = await closedStatus(harness, started);
            const helpers = (await treeOf(harness, started)).runs.filter((run) => run.agentName === 'helper');
            return {
              ...(await shareReturnOf(started, closed)),
              childFailed: refused.toolCalls[0]!.outcome,
              failedHelperSubtree: helpers[0]!.subtreeSpentTokens,
            };
          } finally {
            leafRelease.open();
            leafEnded.open();
            for (const release of held) release();
          }
        },
        {
          closed: 'completed',
          // While leaf ran, helper's whole share stayed held: the next call needing one helper turn was refused; after
          // leaf ended, only helper's subtree's actual spend is held, and the call was accepted
          leadCalls: [
            ['call_agent', 'done', 'child_failed'],
            ['call_agent', 'rejected', 'budget_exhausted'],
            ['call_agent', 'done', null],
            ['finish', 'done', null],
          ],
          callShares: [150_000, null, 150_000],
          helpers: [
            ['failed', 150_000],
            ['succeeded', 150_000],
          ],
          // AC-05.3: the parent gets `child_failed` with the reason `failed`
          childFailed: { outcome: 'tool_error', reason: 'child_failed', result: { child_failed: 'failed' } },
          failedHelperSubtree: 2 * TURN_CHARGE,
          perRunSpent: 7 * TURN_CHARGE,
          investigationSpent: 7 * TURN_CHARGE,
        },
      ],
      [
        'INT-4 B4: a share returned by a completed child pays for the second call of the same child',
        async () => {
          // Given: a 90 000 budget and helper's runTokens 60 000: after the first share lead's free rest is below one
          // helper turn (33 000), so two helpers at once do not fit; one after the other do
          harness.model.scriptAgent(
            'lead',
            turn(call('call_agent', { agent: 'helper', assignment: 'First call.' })),
            turn(call('call_agent', { agent: 'helper', assignment: 'Second call.' })),
            finishWith('two calls paid'),
          );
          harness.model.scriptAgent('helper', finishWith('first done'), finishWith('second done'));

          // When: lead calls helper, helper spends less than its share and ends, and lead calls helper again
          const started = await startProbe(harness, { processId: B4_PROCESS_ID, tokenBudget: 90_000 });
          return shareReturnOf(started, await closedStatus(harness, started));
        },
        {
          closed: 'completed',
          // The completed child's share came back: the second call was accepted with a full share from the returned rest
          leadCalls: [
            ['call_agent', 'done', null],
            ['call_agent', 'done', null],
            ['finish', 'done', null],
          ],
          callShares: [B4_HELPER_SHARE, B4_HELPER_SHARE],
          helpers: [
            ['succeeded', B4_HELPER_SHARE],
            ['succeeded', B4_HELPER_SHARE],
          ],
          perRunSpent: 5 * TURN_CHARGE,
          investigationSpent: 5 * TURN_CHARGE,
        },
      ],
    ])('%s', async (_case, scenario, expected) => {
      expect(await scenario()).toEqual(expected);
    }, CASE_MS);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-5  Process code of a result form, deadlines and the window by the counted input on the real runtime
//        (UC-12 runs 1-8, UC-E13, UC-E14, UC-E15 run 1; task text of plan 1.2, T7.4)
  // ---------------------------------------------------------------------------------------------------------------
  // The fifth INT, at the rule's limit. Unique defect: only the real guarded transaction, the real ledger and the real
  // runtime deadline show that the closure's rows and the run's result commit in one write or not at all, that a forced
  // end replaces a failure decided by a refused reserve on the real ledger or by a deadline, and that nothing is written
  // after a stop. INT-1..INT-4 run on the form `text` and never call this code. The UC-E15 run is a row of the same
  // table: only the real ledger shows that refusals by the window leave no reserve and no row (one row for the turn).
  // AC (Design Doc): "DC-19 ... DC-21, DC-26, DC-27, DC-30; invariant 14: each run of the prologue, the closure and a
  //   forced end writes its rows at most once, in the same guarded write that records it."
  // Behavior: helper calls recorder (form `probe_record`) with a JSON assignment -> the prologue builds the first message
  //   or ends the run -> the closure accepts or refuses `finish` -> a forced end replaces `turn_limit`,
  //   `run_tokens_exhausted`, `not_after`; helper with the form `text` turns over a window the counting double decides.
  // Catches: closure rows without the run's result (or the reverse); a forced end written after a stop; a model call
  //   beyond the share (run 3); a child whose `notAfter` is not before its parent's by `RUNTIME_LEASE_MS` (UC-E14); a
  //   reserve or a ledger row after a refusal by the window, a model call with an input over the window (UC-E15). A
  //   window failure at every stage is the handler's turn rule (`decideView`, `routeFailure`, turn-rules.spec.ts) and the
  //   parent's reason for it the closed list (child-failure.spec.ts).
  // @category: core-functionality
  // @dependency: AgentRunHandler, process-code (prologue, closure, forced end), ModelGateway (counted input), postgresCallLedger, runtime deadlines
  // @complexity: high
  //
  // Time: the engine clock (`engineClock.offsetMs`) moves `notAfter`; the gateway's deadline timer of UC-E14 is held by
  // `engineClock.holdTimers` and fired by the test. Agent settings of the whole describe: AGENT_TURN_MS 60 000 (above the
  // engine's RUNTIME_LEASE_MS 30 000, UC-E14), AGENT_DEADLINE_MARGIN_MS 20 000. No sleeps.
  // UC-12 run 1 runs on the variant of `probe_record` that reads the refused call, in a harness of its own: two engines on one
  // database would both claim its tasks, so it is a sibling of the `describe` below, not a case of it. Runs 2-8 keep the base form.
  describe('INT-5 run 1', () => {
    let harness: EngineHarness;

    beforeAll(async () => {
      harness = await probeHarness({ resultForms: PROBE_FORMS_READING, agent: { turnMs: INT5_TURN_MS, deadlineMarginMs: 20_000, leaseMs: INT5_LEASE_MS } });
    });

    afterAll(async () => {
      await harness?.close();
      await closeEngineDb();
    });

    afterEach(async () => {
      await harness.cancelStarted();
    });

    it('INT-5 UC-12 run 1: the prologue opens the session in the data envelope; a refused finish writes its note with the refusal and its detail, which the model reads next turn and a later closure finds in the call row; an accepted one its note and the result with the bound group', async () => {
      // Given: recorder first answers finish with the refusal field, then a plain finish
      harness.model.scriptAgent('lead', turn(call('call_agent', { agent: 'helper', assignment: 'Have the result recorded.' })), finishWith('lead done'));
      harness.model.scriptAgent(
        'helper',
        turn(call('call_agent', { agent: 'recorder', assignment: JSON.stringify({ task: 'the probe task' } satisfies RecordAssignment) })),
        finishWith('helper done'),
      );
      harness.model.scriptAgent('recorder', turn(call('finish', { note: 'first try', refuse: true })), turn(call('finish', { note: 'second try' })));
      const started = await startProbe(harness);

      // When: the runs go
      expect(await closedStatus(harness, started)).toBe('completed');

      // Then: the first session message is the prologue's, inside the envelope the model gets
      const tree = await treeOf(harness, started);
      const recorder = runOf(tree, 'recorder');
      const session = await sessionOf(recorder.runTaskId);
      expect([session[0]?.kind, contentOf(session[0]!)]).toEqual(['prologue', { text: 'Record this: the probe task' }]);
      expect(recorder.assignment).toBeNull();
      const [firstTurn, secondTurn] = harness.model.callsOfAgent('recorder');
      expect(firstTurn!.user).toBe('<data source="prologue" author="engine">\nRecord this: the probe task\n</data>');
      // The first finish refused `invalid_result` with the closure's reason and detail; its notes were written with the refusal
      expect(recorder.toolCalls.map((row) => [row.toolName, row.state, row.outcome])).toEqual([
        ['finish', 'rejected', { outcome: 'rejected', reason: 'invalid_result', detail: { reason: 'refused_by_probe', detail: { missing: 'the probe field', attempt: 1 } } }],
        ['finish', 'done', { outcome: 'success', result: { note: 'second try', group: 'probe-group-a' } }],
      ]);
      expect((await agentRowsOf(started.investigationId)).memory.filter((note) => note.agentName === 'recorder').map((note) => note.text)).toEqual([
        'probe closure: refused',
        'probe closure detail: {"missing":"the probe field","attempt":1}',
        'probe closure: accepted',
      ]);
      // The model reads the detail with the refusal in its next turn
      const refusedResult = secondTurn!.prompt.at(-1)!;
      expect(refusedResult.role).toBe('tool');
      expect((refusedResult.content as { output: { value: string } }[])[0]!.output.value).toBe(
        '<data source="tool finish" author="engine">\n{&quot;detail&quot;:{&quot;detail&quot;:{&quot;attempt&quot;:1,&quot;missing&quot;:&quot;the probe field&quot;},&quot;reason&quot;:&quot;refused_by_probe&quot;},&quot;reason&quot;:&quot;invalid_result&quot;,&quot;outcome&quot;:&quot;rejected&quot;}\n</data>',
      );
      // The second finish is accepted only because `collect` found the detail in the refused call's row
      expect([recorder.status, recorder.result]).toEqual(['succeeded', { note: 'second try', group: 'probe-group-a' }]);
      expect(runOf(tree, 'helper').toolCalls.find((row) => row.toolName === 'call_agent')?.outcome).toEqual({
        outcome: 'success',
        result: { note: 'second try', group: 'probe-group-a' },
      });
    }, CASE_MS);
  });

  describe('INT-5', () => {
    let harness: EngineHarness;

    beforeAll(async () => {
      harness = await probeHarness({
        processes: [
          agentProbeConfig(),
          agentProbeConfig({ processId: INT5_SHARE_PROCESS_ID, limits: { recorder: { windowTokens: 14_000, runTokens: INT5_RECORDER_SHARE } } }),
          agentProbeConfig({ processId: INT5_DEADLINE_PROCESS_ID, limits: { recorder: { deadlineMs: 120_000 } } }),
          agentProbeConfig({ processId: INT5_WAIT_PROCESS_ID, helperResult: 'probe_deadline', limits: { leaf: { deadlineMs: 900_000 } } }),
        ],
        agent: { turnMs: INT5_TURN_MS, deadlineMarginMs: 20_000, leaseMs: INT5_LEASE_MS },
      });
    });

    afterAll(async () => {
      await harness?.close();
      await closeEngineDb();
    });

    beforeEach(() => {
      harness.model.reset();
    });

    afterEach(async () => {
      harness.tokenCounter.interceptTurn = undefined;
      harness.handlerHold.at = undefined;
      harness.engineClock.offsetMs = 0;
      harness.engineClock.holdTimers = undefined;
      while (harness.engineClock.heldTimers.length > 0) harness.engineClock.heldTimers[0]!.fire();
      await harness.cancelStarted();
    });

    /**
     * Starts a tree where lead calls helper, helper calls recorder with `assignment` (JSON text) and both finish after the
     * child; `recorder` answers by `steps`.
     */
    async function startRecorder(assignment: RecordAssignment, steps: ScriptedStep[], processId?: string): Promise<Started> {
      harness.model.scriptAgent('lead', turn(call('call_agent', { agent: 'helper', assignment: 'Have the result recorded.' })), finishWith('lead done'));
      harness.model.scriptAgent(
        'helper',
        turn(call('call_agent', { agent: 'recorder', assignment: JSON.stringify(assignment) })),
        finishWith('helper done'),
      );
      if (steps.length > 0) harness.model.scriptAgent('recorder', ...steps);
      return startProbe(harness, processId === undefined ? {} : { processId });
    }

    /** The task of the agent's (first) run in the investigation. */
    async function taskOfAgent(started: Started, agent: string) {
      const task = (await tasksOf(started.investigationId)).find((candidate) => (candidate.input as { agentName?: string }).agentName === agent);
      if (task === undefined) throw new Error(`no task of ${agent}`);
      return task;
    }

    /** The ledger rows of the agent's turns. */
    async function ledgerOf(started: Started, agent: string) {
      const task = await taskOfAgent(started, agent);
      return (await llmCallsOf(started.investigationId)).filter((row) => row.taskId === task.taskId);
    }

    /** The texts of the investigation's memory notes the agent wrote, oldest first. */
    async function notesOf(started: Started, agent: string): Promise<string[]> {
      return (await agentRowsOf(started.investigationId)).memory.filter((note) => note.agentName === agent).map((note) => note.text);
    }

    const failureOf = (task: { readonly failureReason: unknown }) => {
      const failure = task.failureReason as { class?: string; code?: string } | null;
      return [failure?.class ?? null, failure?.code ?? null];
    };

    /** The outcome helper's call of recorder ended with. */
    const helperCallOutcome = async (started: Started) =>
      runOf(await treeOf(harness, started), 'helper').toolCalls.find((row) => row.toolName === 'call_agent')?.outcome;

    it('INT-5 UC-12 run 2: a recorder that never finishes ends with the result of its forced end instead of turn_limit', async () => {
      // Given: recorder answers text without a call on each of its four turns, the last one included
      const text: ScriptedStep = { text: 'still thinking', usage: TURN_USAGE };
      const started = await startRecorder({ task: 'the probe task' }, [text, text, text, text]);

      // When
      expect(await closedStatus(harness, started)).toBe('completed');

      // Then: success with the forced end's result and note, a notice of the code it replaced
      const recorder = runOf(await treeOf(harness, started), 'recorder');
      expect([recorder.status, recorder.result]).toEqual(['succeeded', { note: 'probe forced end: turn_limit', forced: 'turn_limit' }]);
      expect(harness.model.callsOfAgent('recorder')).toHaveLength(4);
      expect(await notesOf(started, 'recorder')).toEqual(['probe forced end: turn_limit']);
      const notices = (await sessionOf(recorder.runTaskId)).filter((message) => message.kind === 'code_notice').map(contentOf);
      expect(notices.at(-1)).toEqual({
        turn: 4,
        code: 'forced_end',
        text: '[forced_end] the run ended by its form instead of turn_limit',
        failureCode: 'turn_limit',
      });
    }, CASE_MS);

    it('INT-5 UC-12 run 3: a share that holds one turn ends recorder with the forced end of run_tokens_exhausted, with no model call beyond the share', async () => {
      // Given: recorder's share is 20 000; its first turn answers text and is charged 18 050, so the second reserve
      // (counted input + 1 000 + 1 000) does not fit the 1 950 left
      const started = await startRecorder(
        { task: 'the probe task' },
        [{ text: 'an expensive first turn', usage: { inputTokens: 18_000, outputTokens: 50 } }],
        INT5_SHARE_PROCESS_ID,
      );

      // When
      expect(await closedStatus(harness, started)).toBe('completed');

      // Then
      const recorder = runOf(await treeOf(harness, started), 'recorder');
      expect([recorder.status, recorder.shareTokens, recorder.result]).toEqual([
        'succeeded',
        INT5_RECORDER_SHARE,
        { note: 'probe forced end: run_tokens_exhausted', forced: 'run_tokens_exhausted' },
      ]);
      expect(harness.model.callsOfAgent('recorder')).toHaveLength(1);
      expect((await ledgerOf(started, 'recorder')).map((row) => [row.status, row.chargedTokens])).toEqual([['settled', 18_050]]);
      expect(await notesOf(started, 'recorder')).toEqual(['probe forced end: run_tokens_exhausted']);
    }, CASE_MS);

    it('INT-5 UC-12 run 4: an assignment over the form limit ends recorder prologue_oversize without a model call', async () => {
      // Given: the first message "Record this: " + 3 000 bytes is over the form's 2 048 bytes
      const started = await startRecorder({ task: 'y'.repeat(3_000) }, []);

      // When
      expect(await closedStatus(harness, started)).toBe('completed');

      // Then
      const task = await finalTask(started.investigationId, (await taskOfAgent(started, 'recorder')).taskId);
      expect([task.status, ...failureOf(task)]).toEqual(['failed', 'validation_rejected', 'prologue_oversize']);
      expect(harness.model.callsOfAgent('recorder')).toEqual([]);
      expect(await ledgerOf(started, 'recorder')).toEqual([]);
      expect(await sessionOf(task.taskId)).toEqual([]);
      expect(await helperCallOutcome(started)).toEqual({ outcome: 'tool_error', reason: 'child_failed', result: { child_failed: 'failed' } });
    }, CASE_MS);

    it('INT-5 UC-12 run 5: a ready result in the assignment completes recorder without a model turn, its closure note and result written together', async () => {
      const started = await startRecorder({ task: 'the probe task', ready: { note: 'ready made' } }, []);

      expect(await closedStatus(harness, started)).toBe('completed');

      const recorder = runOf(await treeOf(harness, started), 'recorder');
      expect([recorder.status, recorder.result, recorder.turns.length]).toEqual(['succeeded', { note: 'ready made', group: 'probe-group-a' }, 0]);
      expect(harness.model.callsOfAgent('recorder')).toEqual([]);
      expect(await notesOf(started, 'recorder')).toEqual(['probe closure: accepted']);
      expect(await helperCallOutcome(started)).toEqual({ outcome: 'success', result: { note: 'ready made', group: 'probe-group-a' } });
    }, CASE_MS);

    it('INT-5 UC-12 run 6: a ready result with the refusal field fails recorder prologue_refused with no closure note', async () => {
      const started = await startRecorder({ task: 'the probe task', ready: { note: 'ready made', refuse: true } }, []);

      expect(await closedStatus(harness, started)).toBe('completed');

      const task = await finalTask(started.investigationId, (await taskOfAgent(started, 'recorder')).taskId);
      expect([task.status, ...failureOf(task)]).toEqual(['failed', 'validation_rejected', 'prologue_refused']);
      expect(harness.model.callsOfAgent('recorder')).toEqual([]);
      expect(await notesOf(started, 'recorder')).toEqual([]);
      const recorder = runOf(await treeOf(harness, started), 'recorder');
      expect(recorder.result).toBeNull();
    }, CASE_MS);

    it('INT-5 UC-12 run 7: an investigation stopped before the forced end is written leaves neither its result nor its note, and recorder is cancelled with it', async () => {
      // Given: as run 3; recorder is held right after its refused second reserve, and the owner stops the investigation
      const recorderCounts = latch();
      let counts = 0;
      harness.tokenCounter.interceptTurn = (request) => {
        if (request.system.includes(agentMarker('recorder')) && ++counts === 2) recorderCounts.open();
        return undefined;
      };
      let atStop: Awaited<ReturnType<typeof journalOf>> | undefined;
      let notesAtStop: string[] | undefined;
      const box: { started?: Started } = {};
      let stopped = false;
      harness.handlerHold.at = async (point) => {
        const inTree = box.started;
        if (counts < 2 || stopped || point.at !== 'guarded' || inTree === undefined) return;
        if ((await taskOfAgent(inTree, 'recorder')).taskId !== point.taskId) return;
        stopped = true;
        // When: the owner stops the investigation between the refused reserve and the forced end
        await harness.runtime.investigations.cancel(inTree.investigationId, inTree.resourceId);
        atStop = await journalOf(harness, inTree.investigationId);
        notesAtStop = await notesOf(inTree, 'recorder');
      };
      const started = await startRecorder(
        { task: 'the probe task' },
        [{ text: 'an expensive first turn', usage: { inputTokens: 18_000, outputTokens: 50 } }],
        INT5_SHARE_PROCESS_ID,
      );
      box.started = started;
      await recorderCounts.wait;

      // Then: every task cancelled and every attempt ended; no forced end result, no note, nothing written after the stop
      const tasks = await until(async () => {
        const rows = await tasksOf(started.investigationId);
        const ended = rows.filter((task) => task.attempt > 0).every((task) => harness.endedRuns.filter((run) => run.taskId === task.taskId).length === task.attempt);
        return stopped && ended && rows.every((task) => ['cancelled', 'succeeded', 'failed'].includes(task.status)) ? rows : undefined;
      }, 'every task final and every attempt ended');
      expect(tasks.map((task) => [(task.input as { agentName?: string }).agentName, task.status])).toEqual([
        ['lead', 'cancelled'],
        ['helper', 'cancelled'],
        ['recorder', 'cancelled'],
      ]);
      const recorder = runOf(await treeOf(harness, started), 'recorder');
      expect([recorder.result, recorder.failure]).toEqual([null, null]);
      expect(notesAtStop).toEqual([]);
      expect(await notesOf(started, 'recorder')).toEqual([]);
      expect(harness.model.callsOfAgent('recorder')).toHaveLength(1);
      expect(await journalOf(harness, started.investigationId)).toEqual(atStop);
    }, CASE_MS);

    it('INT-5 UC-12 run 8: a prologue input over 64 KiB ends recorder prologue_oversize without a model call and without the input in its run row', async () => {
      const started = await startRecorder({ task: 'the probe task', padBytes: 70_000 }, []);

      expect(await closedStatus(harness, started)).toBe('completed');

      const task = await finalTask(started.investigationId, (await taskOfAgent(started, 'recorder')).taskId);
      expect([task.status, ...failureOf(task)]).toEqual(['failed', 'validation_rejected', 'prologue_oversize']);
      expect(harness.model.callsOfAgent('recorder')).toEqual([]);
      const run = (await agentRowsOf(started.investigationId)).runs.find((row) => row.taskId === task.taskId);
      expect([run?.prologueInput, run?.result]).toEqual([null, null]);
    }, CASE_MS);

    it('INT-5 UC-E13: with less than AGENT_TURN_MS left to notAfter after its first turn, recorder starts no second turn and its forced end of not_after completes it before its task deadline', async () => {
      // Given: recorder's deadlineMs 120 000, so notAfter = its start + 100 000; its first turn answers text and, while it
      // is in the model, the engine clock moves to 30 000 before notAfter
      const inModel = latch();
      const started = await startRecorder(
        { task: 'the probe task' },
        [{ text: 'a first turn without finish', usage: TURN_USAGE, holdUntil: inModel.wait }],
        INT5_DEADLINE_PROCESS_ID,
      );
      await until(async () => (harness.model.callsOfAgent('recorder').length === 1 ? true : undefined), 'recorder in the model');
      const recorderTask = await taskOfAgent(started, 'recorder');
      const run = (await agentRowsOf(started.investigationId)).runs.find((row) => row.taskId === recorderTask.taskId)!;
      harness.engineClock.offsetMs = run.notAfter.getTime() - Date.now() - 30_000;
      inModel.open();

      // When
      expect(await closedStatus(harness, started)).toBe('completed');

      // Then: no second turn; the forced end of not_after wrote the result before the runtime's deadline of the task
      const task = await finalTask(started.investigationId, recorderTask.taskId);
      expect(harness.model.callsOfAgent('recorder')).toHaveLength(1);
      expect(await ledgerOf(started, 'recorder')).toHaveLength(1);
      const recorder = runOf(await treeOf(harness, started), 'recorder');
      expect([recorder.status, recorder.result]).toEqual(['succeeded', { note: 'probe forced end: not_after', forced: 'not_after' }]);
      expect(await notesOf(started, 'recorder')).toEqual(['probe forced end: not_after']);
      expect(task.finishedAt!.getTime()).toBeLessThan(task.deadlineAt!.getTime());
    }, CASE_MS);

    // Absorbs research-flow INT-3 B (the root's deadline over the chain worker - subworker - verifier): the bound of one lease
    // per level is this row's rule, the root's answer by code on its forced end is research-flow INT-3 A, and the reason
    // `deadline` of `not_after` is stop-reason.spec.ts.
    it("INT-5 UC-E14: leaf, cut by the gateway at its notAfter one lease before helper's, ends not_after; helper wakes with child_failed(deadline), starts no turn and completes by its forced end before its task deadline", async () => {
      // Given: helper with the form probe_deadline; leaf's deadlineMs is above helper's rest, so helper's notAfter sets
      // leaf's; the double never answers leaf's turn; the gateway's deadline timers are held for the test to fire
      harness.engineClock.holdTimers = (ms) => ms >= 100_000;
      harness.model.scriptAgent('lead', turn(call('call_agent', { agent: 'helper', assignment: 'Wait for leaf.' })), finishWith('lead done'));
      harness.model.scriptAgent('helper', turn(call('call_agent', { agent: 'leaf', assignment: 'Never answer.' })));
      harness.model.scriptAgent('leaf', { hangUntilAborted: true });
      const started = await startProbe(harness, { processId: INT5_WAIT_PROCESS_ID });
      await until(async () => (harness.model.callsOfAgent('leaf').length === 1 ? true : undefined), 'leaf in the model');
      const helperTask = await taskOfAgent(started, 'helper');
      const leafTask = await taskOfAgent(started, 'leaf');
      const runs = (await agentRowsOf(started.investigationId)).runs;
      const helperRun = runs.find((row) => row.taskId === helperTask.taskId)!;
      const leafRun = runs.find((row) => row.taskId === leafTask.taskId)!;

      // When: the engine clock passes leaf's notAfter (helper's is still 29 000 ahead) and the gateway's timer fires
      harness.engineClock.offsetMs = leafRun.notAfter.getTime() - Date.now() + 1_000;
      while (harness.engineClock.heldTimers.length > 0) harness.engineClock.heldTimers[0]!.fire();

      // Then: leaf's notAfter is helper's minus RUNTIME_LEASE_MS
      expect(await closedStatus(harness, started)).toBe('completed');
      expect(helperRun.notAfter.getTime() - leafRun.notAfter.getTime()).toBe(30_000);
      const leaf = await finalTask(started.investigationId, leafTask.taskId);
      expect([leaf.status, ...failureOf(leaf)]).toEqual(['failed', 'deadline', 'not_after']);
      expect(leaf.finishedAt!.getTime()).toBeLessThanOrEqual(helperRun.notAfter.getTime());
      // helper got child_failed(deadline), made no new turn, and its forced end completed it before its task deadline
      const helper = runOf(await treeOf(harness, started), 'helper');
      expect(helper.toolCalls.map((row) => row.outcome)).toEqual([{ outcome: 'tool_error', reason: 'child_failed', result: { child_failed: 'deadline' } }]);
      expect(harness.model.callsOfAgent('helper')).toHaveLength(1);
      expect([helper.status, helper.result]).toEqual(['succeeded', PROBE_DEADLINE_RESULT]);
      const helperFinal = await finalTask(started.investigationId, helperTask.taskId);
      expect(helperFinal.finishedAt!.getTime()).toBeLessThan(helperFinal.deadlineAt!.getTime());
    }, CASE_MS);

    it('INT-5 UC-E15 run 1: counted inputs over the window at stages 0 and 1 send helper\'s turn at stage 2 with one reserve and one ledger row', async () => {
      // Given: the counting double counts helper's turn over windowTokens - marginTokens (31 000) on its first two count
      // requests (stages 0 and 1) and by its characters on the third (stage 2)
      let helperCounts = 0;
      harness.tokenCounter.interceptTurn = (request) => {
        if (!request.system.includes(agentMarker('helper'))) return undefined;
        helperCounts += 1;
        return helperCounts <= 2 ? OVER_WINDOW_TOKENS : undefined;
      };
      harness.model.scriptAgent('lead', turn(call('call_agent', { agent: 'helper', assignment: 'Answer at once.' })), finishWith('lead done'));
      harness.model.scriptAgent('helper', finishWith('answered at stage two'));

      // When
      const started = await startProbe(harness);
      expect(await closedStatus(harness, started)).toBe('completed');

      // Then: three count requests, one reserve, one model call; the view that went to the model is stage 2
      expect(helperCounts).toBe(3);
      expect(harness.model.callsOfAgent('helper')).toHaveLength(1);
      const ledger = await ledgerOf(started, 'helper');
      expect(ledger.map((row) => row.status)).toEqual(['settled']);
      const transcripts = (await llmTranscriptsOf(started.investigationId)).filter((row) => row.callId === ledger[0]!.callId);
      expect(transcripts.map((row) => (row.input as { view?: { stage?: number } }).view?.stage)).toEqual([2]);
      expect(runOf(await treeOf(harness, started), 'helper').status).toBe('succeeded');
    }, CASE_MS);
  });

  // ---------------------------------------------------------------------------------------------------------------
  // INT-6  The sources field in a real run and the real `resolveTool` at the load (UC-16, UC-2 wiring; KD-9, DC-31, DC-32)
  // ---------------------------------------------------------------------------------------------------------------
  // Over the file's INT-1..INT-5 limit: the unit tables see neither `row.sources` of a real tree nor the closure over the
  // real source registry that `composeEngine` passes; each row names the defect only the assembled engine shows.
  describe('INT-6', () => {
    // One line per source with its description and tools (design-catalog-planning.md, KD-3), as `probeSources` declares them.
    const lineOf = (sourceId: string) =>
      `{"sourceId":"${sourceId}","description":"Probe source ${sourceId} of the {{sources}} cases.","tools":[{"toolName":"search","description":"Searches the probe source; never called.","argsSchema":{"type":"object","properties":{"query":{"type":"string"},"limit":{"default":10,"type":"number"}},"required":["query"],"additionalProperties":false}}]}`;
    const ALPHA_LINE = lineOf('alpha');
    const BETA_LINE = lineOf('beta');
    const NO_SOURCES = 'No data source is available to this run.';
    const READER = PROBE_READS_SOURCES_TOOL.name;
    const sourcesOptions = {
      sourcesField: ['lead', 'helper', 'leaf'],
      extraTools: { lead: [READER], helper: [READER], leaf: [READER] },
      sources: PROBE_SOURCE_PAIRS,
    } as const;
    const buildOptions = { agentTools: [PROBE_READS_SOURCES_TOOL], connectedSources: PROBE_SOURCE_IDS };

    afterAll(async () => {
      await closeEngineDb();
    });

    // UC-16. Given: the process has sources `alpha` and `beta`; `lead`, `helper` and `leaf` carry `{{sources}}` and the
    // marked tool; `helper` is narrowed to `beta`, `leaf` to none.
    // When: `lead` calls `helper`, `helper` makes two turns and calls `leaf`.
    // Then: the system block of `lead` has both pairs, of `helper` only `beta` and the same bytes on every turn, of `leaf`
    // the text without sources; the transcript of `helper` read through `readTranscripts` carries the block of its turn.
    // Catches: the value taken from the process's sources instead of `row.sources` (guard, rule 15); a value rebuilt
    // differently between turns; the field substituted again at the read.
    it('INT-6 UC-16: each run of the tree sees the source tools of its own sources, the same bytes on every turn', async () => {
      const config = agentProbeConfig({ ...sourcesOptions, definitionSources: { helper: ['beta'], leaf: [] } });
      const harness = await probeHarness({ processes: [config], source: probeSources(), ...buildOptions });
      try {
        harness.model.scriptAgent('lead', turn(call('call_agent', { agent: 'helper', assignment: 'Check beta.' })), finishWith('lead done'));
        harness.model.scriptAgent(
          'helper',
          turn(call('memory_read', {})),
          turn(call('call_agent', { agent: 'leaf', assignment: 'Answer.' })),
          finishWith('helper done'),
        );
        harness.model.scriptAgent('leaf', finishWith('leaf done'));

        const started = await startProbe(harness);
        expect(await closedStatus(harness, started)).toBe('completed');

        const read = await readTranscripts(harness.db, { investigationId: started.investigationId, ownerId: started.resourceId, retention: 'no_term' });
        if (read.outcome !== 'found') throw new Error('the transcripts must read');
        const blocksOf = (agent: string) =>
          read.transcripts.filter((transcript) => transcript.agentName === agent).map((transcript) => (transcript.input as { instructions: string }).instructions);

        const [leadBlock] = blocksOf('lead');
        expect(leadBlock).toContain(`\n\nSources:\n${ALPHA_LINE}\n${BETA_LINE}\n\n`);
        const helperBlocks = blocksOf('helper');
        expect(helperBlocks).toHaveLength(3);
        expect(helperBlocks[0]).toContain(`\n\nSources:\n${BETA_LINE}\n\n`);
        expect(helperBlocks[0]).not.toContain('"sourceId":"alpha"');
        expect(new Set(helperBlocks).size).toBe(1);
        expect(blocksOf('leaf')[0]).toContain(`\n\nSources:\n${NO_SOURCES}\n\n`);

        // The read gives back the block the model got on that turn.
        const sentToHelper = harness.model.callsOfAgent('helper').map((recorded) => recorded.prompt[0]?.content);
        expect(sentToHelper).toEqual(helperBlocks);
      } finally {
        await harness.cancelStarted();
        await harness.close();
      }
    }, CASE_MS);

    // UC-2, the wiring. Given: a real assembly whose source `beta` has an argument schema that makes the value of the field
    // longer than 8 192 bytes. When: the engine is created. Then: `process_config_rejected` at the prompt of the definition
    // that names the field.
    // Catches: `composeEngine` passing no real `resolveTool` (guard, rule 15: one that always answers null): no pair resolves
    // and the oversized configuration loads.
    it('INT-6 UC-2: a real source whose schema makes the value longer than its limit refuses the configuration at the prompt', async () => {
      const oversized = z.strictObject({ query: z.string() }).describe('d'.repeat(8_193));

      await expect(
        probeHarness({
          processes: [agentProbeConfig(sourcesOptions)],
          source: probeSources({ betaArgs: oversized }),
          ...buildOptions,
        }),
      ).rejects.toMatchObject({ code: 'process_config_rejected', path: [0, 'agents', 'lead', 'prompt'] });
    }, CASE_MS);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Proven elsewhere (named for the plan; no skeleton here, by the light test process)
// ---------------------------------------------------------------------------------------------------------------
// Unit (table-driven, packages/engine/src/**/*.spec.ts), one spec per rule:
// - config loader (UC-2: AC-01.1, AC-13.2, DC-1): one table of broken probe configs (tool outside the registry, unknown callee, `rootAgent` outside `agents`, source outside the process, window below the smallest view, unknown key) plus the shipped v2 config; each row names the agent and the field
// - turn rules (UC-E7: DC-2, DC-14, DC-17): `no_tool_call`, `invalid_result`, `finish_not_alone`, only `finish` on the last turn, `turn_limit`
// - limits and share (UC-E1, DC-6, DC-7, DC-8): `depth_limit`, `children_limit`, `task_limit`; share = min(`runTokens`, remainder); the closed list of `child_failed` reasons from the failure class/code table; `deadline` of a child after the parent's `notAfter`
// - session window (UC-7, DC-13): the four steps in order, a reached step holds, the stub names tool, turn, size and the tool to read again, the stored session is not changed
// - access (UC-11: DC-12, AC-10.1): `ToolAccessPolicy` refusal writes `access_denied` and calls nothing; child sources = parent sources INTERSECT definition sources
// - `yield` (UC-E8, KD-6): `HandlerResultSchema` accepts it, `outcomeOfResult` maps it to `released` and `recovery_count` does not grow (a runtime unit/contract spec); the handler returns it after the slice
// - repository-level, real Postgres (the default `vitest run` has no database, so these run in the e2e job as small DB-backed specs, not as scenarios): AC-04.1/AC-04.2 and DC-4 `foreign_ref` / `not_found` (UC-3, UC-E9), AC-03.2, AC-03.4 and NFR-01 (UC-N1: another owner reads
//   `investigation_not_found`, deleting the conversation removes sessions, calls and memory), AC-22.1..AC-22.6 (UC-9, UC-10: snapshot at start, areas, `no_write_right`, `limit_reached` at 8 KiB, records survive the investigation's deletion), the two-writers numbering of the memory write (INT-2 limit)
// - cache price (UC-8, AC-21.1): the cache rows of cost.spec.ts; INT-1 proves only that the view's start is stable
//
// Not observable as an assertion (reported to the caller):
// - The KD-1 assumption "one Mastra `generate` = one request and returns tool calls unexecuted" is a spike the plan runs first; INT-1 reads its consequence (double calls == journal rows) but cannot tell the spike's two outcomes apart (tool-call mode vs the structured-output fallback)
// - INT-2 AC-03.3: the instant of two simultaneous transactions cannot be forced from a test (see the limit in INT-2)
