// source-planning / catalog-planning Integration Test Skeletons (engine side) - Design Doc: docs/features/source-planning/design-catalog-planning.md (v1.2, approved 2026-11-10)
// PRD: docs/features/source-planning/prd.md (FR-01..FR-10; AC-05.2 as the design words it: a catalog that does not fit is refused at server start, `process_config_rejected`).
// Consumes: docs/features/agent-runtime/design-agent-core.md and design-research-flow.md (their int skeletons `agent-runtime-agent-core.int.e2e-spec.ts` / `agent-runtime-research-flow.int.e2e-spec.ts`
// already prove the agent's turn, the tool executor in general, the forms and the closure; what they prove is not proven again here). UXRD: none (part without UI; the one card rule, AC-09.2, is in the api E2E file).
// Generated: 2026-11-10 | Part: catalog-planning | Test type: Integration (in-process runtime + engine + real Postgres, scripted model, the SHIPPED v3 configuration), CI job `e2e-engine`
// Implementation timing: created alongside the slice each test names (INT-1 start step + `source_catalog` + `{{sources}}`/`{{catalog}}`; INT-2 `plan_write` gate + `gather` `plan_missing` + stop reason; INT-3 executor checks).
//
// File name and placement. Same package, harness and config as `agent-runtime-research-flow.int.e2e-spec.ts` (`test/**/*.e2e-spec.ts` of `vitest.config.e2e.ts`; run with
// `pnpm --filter @agent-os/engine test:e2e`, never in the default `vitest run`). The api half of the part is `apps/api/test/source-planning-catalog-planning.int.e2e-spec.ts` (INT-4)
// and `apps/api/test/source-planning-catalog-planning.e2e-spec.ts` (E2E-1).
//
// Generated as `it.todo` skeletons so the file loads under lint, typecheck and `vitest run`. Implement each todo following its Given/When/Then comments when its slice lands. Do not convert a todo into a passing stub.
//
// Light test process (owner decision): integration/E2E skeletons exist only for the risky UCs of the Test Strategy - the catalog from start to every agent (UC-1, UC-2, UC-3, UC-E1), the plan gate and the stop it ends in (UC-4, UC-E2, UC-N1),
// the per-call checks and the revoke (UC-E3, UC-E5). Pure rules are unit tests named in the plan (list "Proven elsewhere" at the end).
//
// Environment (Design Doc "Test Strategy": the scenarios run on the shipped v3 with two training sources, each agent's model answers by script with tool calls):
// - Postgres 16 from infra/docker-compose.yml. Real `createRuntime` and real `createEngine`, real `AgentRunHandler`, the real research tools (`gather`, `plan_write`, `claims_write`), the real forms, the real `ToolExecutor`,
//   the real answer gateway. Boundary doubles only: the scripted language-model double (per agent) and TWO counting sources (`countingSource.ts`), one impersonating `fixture` (`search_logs`, `aggregate_logs`, `get_trace`)
//   and one `backoffice` (`search_orders`, `get_order`), each with the declaration's descriptions, so the shipped ceiling passes its source check unchanged. The counting sources are the independent counter of "source called".
// - The process is the SHIPPED `deep-research` v3 (`version: 3`), with `backoffice/search_orders` and `backoffice/get_order` in its ceiling. Rows that need small numbers use `researchFlowV3Config(overrides)`.
// - The rights port is a test double of `ToolAccessPolicy` (a table per owner that a test can change between calls and that counts its questions): it is the boundary the `access-control` feature will replace, and the counter of
//   "the port was not asked". `SourceAccessTable` itself is exercised in the api files.
// - Group table: built from the loaded config, as in the research-flow int file. Isolation: a unique `resourceId` and `launchKey` per test (test/support/new-user.ts); `fileParallelism: false`; `cancelStarted()` in afterEach.
// - "Model evaluates, algorithm decides": the double returns only tool calls by schema; no assertion reads a keyword of model text. The one text check is the transcript check of NFR-02 / AC-07.1 / AC-06.1 (an id or a description is
//   present or absent in a recorded prompt): it compares against the literals of the declaration, not against model output.
//
// Support the plan must add FIRST (existing support files are NOT edited by this skeleton set):
// 1. countingSource.ts - a second source id and a per-source tool list; `backoffice` records shaped like the fixture's order records (the lesson of research-flow UC-R1: a double whose records differ from the real source hides the defect).
// 2. test-configs.ts / engineHarness.ts - `connectedSources` of both sources, the rights-port double as an option, the shipped declaration descriptions passed to the registry double, `researchFlowV3Config` with the two-source ceiling.
// 3. engineDb.ts - read-only snapshots: `research_engine_runs.source_catalog` and `mode`; plan revisions with branch `sources`/`sourceReason`; `research_agent_tool_calls` with outcome, reason and `source`; the audit rows of source calls.
// 4. scriptedModel.ts - `model.promptsOfAgent(name)` (the whole recorded prompt of every call) for the transcript checks, and the `{ toolCalls: (view) => [...] }` step of the research-flow file.
//
// Budget (this file): Integration 3 of the part's 4 (INT-4 is in the api file; limit 3, a fourth only with its named defect). Each test groups the rows of one boundary:
//   INT-1 the catalog (start, storage, what every agent is shown), INT-2 the plan gate and its stop, INT-3 the per-call checks. Nothing here repeats a unit-proven rule's variants.
//
// AC -> proving test (the plan reads this to avoid a second test for an AC already proven; "unit" = a table-driven unit spec named in the plan):
// - AC-03.1, AC-04.1, NFR-02: INT-1 B; AC-03.2, AC-09.1: INT-1 B (the empty-catalog row); AC-04.2: INT-1 C; AC-04.3, AC-05.1, AC-07.1, AC-07.3: INT-1 A
// - AC-05.3, AC-06.1: INT-2 A; AC-06.2: INT-2 B; NFR-03: INT-1 A (no model call before the root's first turn) and INT-2 A (one turn more per rejected call)
// - AC-07.2, NFR-01 (never called): INT-3 A; AC-08.1, AC-08.2: INT-3 B
// - AC-09.2 (the card and the offer): E2E-1 S3; AC-01.2: E2E-1 S1; AC-05.2, DC-2: INT-4 (api); AC-01.1, AC-02.1, AC-02.2, AC-10.1: unit
// - tool_not_in_catalog (UC-E4, AC-07.2 for a tool outside the ceiling of a catalog source): unit of `gather` (a pair check against the ceiling; the source is not reached because the task is never created)

import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { type AccessDouble, createAccessDouble } from './support/accessDouble.js';
import {
  BACKOFFICE_COUNTING_SOURCE_ID,
  COUNTING_SOURCE_ID,
  countingSourceDescription,
  countingSourceTools,
  sourceLogLine,
  sourceOrder,
} from './support/countingSource.js';
import {
  agentRowsOf,
  answerRowOf,
  assertNoActiveInvestigations,
  catalogRowOf,
  claimRevisionsOf,
  closeEngineDb,
  engineRowsOf,
  gatherPagesOf,
  llmCallsOf,
  planRevisionsOf,
  sessionOf,
  tasksOf,
  toolCallAuditsOf,
} from './support/engineDb.js';
import { createEngineHarness, createResearchFlowHarness, type EngineHarness } from './support/engineHarness.js';
import { newLaunchKey, newUser } from './support/new-user.js';
import {
  type AgentCallView,
  assessment,
  finishText,
  type ScriptedStep,
  type ScriptedToolCall,
  type ScriptedUsage,
  verifierPacketOf,
} from './support/scriptedModel.js';
import { type ResearchFlowOverrides, researchFlowGroupTable, researchFlowV3Config } from './support/test-configs.js';

// The usage every scripted turn reports, and how long a case may run: tens of runtime hops.
const TURN_USAGE: ScriptedUsage = { inputTokens: 1_000, outputTokens: 50 };
const SETTLE_MS = 60_000;
const CASE_MS = 120_000;
const RUNTIME = { concurrency: 4, dbPoolMax: 10 } as const;

const FIXTURE = COUNTING_SOURCE_ID;
const BACKOFFICE = BACKOFFICE_COUNTING_SOURCE_ID;

const call = (tool: string, args: unknown): ScriptedToolCall => ({ tool, args });

/** A gate a test opens once; waiting on an open gate goes on at once. */
function gate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open: () => open() };
}

/** The description the declaration gives a tool of a counting source. */
function toolDescription(sourceId: string, toolName: string): string {
  const tool = countingSourceTools(sourceId).find((one) => one.name === toolName);
  if (tool === undefined) throw new Error(`no declared tool ${sourceId}/${toolName}`);
  return tool.description;
}

/** A catalog source as the start records it: the declaration's descriptions, the ceiling tools in code point order and the slice. */
function catalogSource(sourceId: string, toolNames: readonly string[], snapshot: string) {
  return {
    sourceId,
    description: countingSourceDescription(sourceId),
    tools: toolNames.map((toolName) => ({ toolName, description: toolDescription(sourceId, toolName) })),
    snapshot,
  };
}

// The catalog entries of the two training sources on the shipped two-source ceiling (design-catalog-planning.md, KD-1, Data Model).
const FIXTURE_IN_CATALOG = catalogSource(FIXTURE, ['aggregate_logs', 'get_trace', 'search_logs'], 'counting-v1');
const BACKOFFICE_IN_CATALOG = catalogSource(BACKOFFICE, ['get_order', 'search_orders'], 'counting-backoffice-v1');

// The scenario's own texts: the double recognises its script by them, never by reading the engine's text.
const QUERY_PAYMENTS = 'Why did the payment of order ord-4bf92f35 fail at 19:04?';
const PLAN_ASSIGNMENT = 'Plan the investigation of the failed payment';
const BRANCH = 'Branch: find what the payment services logged for the failed payment';
const WINDOW = { from: '2026-09-15T19:00:00.000Z', to: '2026-09-15T20:00:00.000Z' };

interface ScriptedGather {
  readonly sourceId: string;
  readonly toolName: string;
  readonly args: Readonly<Record<string, unknown>>;
}

const SEARCH_LOGS: ScriptedGather = { sourceId: FIXTURE, toolName: 'search_logs', args: { service: 'payment-api', ...WINDOW } };
const SEARCH_ORDERS: ScriptedGather = { sourceId: BACKOFFICE, toolName: 'search_orders', args: { status: 'failed', ...WINDOW } };

interface CatalogRunScript {
  /** The worker's `gather` calls, one a turn, before its `finish`. */
  readonly gathers: readonly ScriptedGather[];
  /** How many investigations run the same script one after another. */
  readonly runs?: number;
  /** Holds the first turn of the first root until it settles. */
  readonly holdFirstRoot?: Promise<void>;
}

/**
 * The tree of a catalog scenario, `runs` times: controller -> planner (`plan_write` of one branch naming only the logs,
 * then `finish`) -> one worker (its `gather` calls, then `finish`) -> the root closes "not established" by code. Programs,
 * not queues: each turn is answered by the turn number of its own session.
 */
function scriptCatalogRuns(harness: EngineHarness, { gathers, runs = 1, holdFirstRoot }: CatalogRunScript): void {
  const controller = (view: AgentCallView): readonly ScriptedToolCall[] => {
    if (view.turn === 1) return [call('call_agent', { agent: 'planner', assignment: PLAN_ASSIGNMENT })];
    if (view.turn === 2) return [call('call_agent', { agent: 'worker', assignment: BRANCH })];
    return [call('finish', { inconclusive: true })];
  };
  const planner = (view: AgentCallView): readonly ScriptedToolCall[] =>
    view.turn === 1
      ? [
          call('plan_write', {
            readinessCriteria: ['the cause of the failed payment is named'],
            branches: [{ question: 'What did the payment services log?', approach: 'search the payment-api errors', sources: [FIXTURE], sourceReason: 'it holds the service logs' }],
            reason: 'there is no plan yet',
          }),
        ]
      : [finishText('The plan has one branch')];
  const worker = (view: AgentCallView): readonly ScriptedToolCall[] => {
    const gather = gathers[view.turn - 1];
    if (gather === undefined) return [finishText('The branch is done')];
    return [call('gather', { sourceId: gather.sourceId, toolName: gather.toolName, args: gather.args, completeness: 'sample' })];
  };
  const steps = (count: number, program: (view: AgentCallView) => readonly ScriptedToolCall[]): ScriptedStep[] =>
    Array.from({ length: count * runs }, () => ({ toolCalls: program, usage: TURN_USAGE }));
  const [firstRoot, ...otherRoots] = steps(3, controller);
  harness.model.scriptAgent('controller', ...(firstRoot === undefined ? [] : [{ ...firstRoot, ...(holdFirstRoot === undefined ? {} : { holdUntil: holdFirstRoot }) }]), ...otherRoots);
  harness.model.scriptAgent('planner', ...steps(2, planner));
  harness.model.scriptAgent('worker', ...steps(gathers.length + 1, worker));
}

/** The records of the scenario: an order with a payment error in the logs and the record of that order in the back office. */
function answerWithTheFailedPayment(harness: EngineHarness): void {
  harness.countingSource.answerWith((source) =>
    source.toolName === 'search_orders' ? [sourceOrder()] : [sourceLogLine({ message: 'payment of ord-4bf92f35 failed: provider timeout' })],
  );
}

interface StartedResearch {
  readonly investigationId: string;
  readonly rootTaskId: string;
  readonly resourceId: string;
  readonly launchKey: string;
  readonly threadId: string;
}

/** Starts deep-research v3 for the owner; a launch key and thread may be given to repeat a start. */
async function startResearch(
  harness: EngineHarness,
  resourceId: string,
  query: string,
  repeat?: { readonly launchKey: string; readonly threadId: string },
): Promise<StartedResearch & { readonly outcome: 'created' | 'existing' }> {
  const threadId = repeat?.threadId ?? (await harness.createThread(resourceId));
  const launchKey = repeat?.launchKey ?? newLaunchKey();
  const started = await harness.engine.startInvestigation({ resourceId, threadId, query, processId: 'deep-research', version: 3, launchKey });
  if (started.outcome === 'rejected') throw new Error(`start refused: ${started.code}`);
  return { outcome: started.outcome, investigationId: started.investigationId, rootTaskId: started.controllerTaskId, resourceId, launchKey, threadId };
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

/** Each run of the investigation with the sources its task got, sorted for comparison. */
async function runSourcesOf(investigationId: string): Promise<readonly (readonly [string, readonly string[]])[]> {
  const { runs } = await agentRowsOf(investigationId);
  return runs.map((run) => [run.agentName, [...run.sources].sort()] as const);
}

/** The texts of the back office that no agent of an owner without it may be shown (NFR-02): its id, its description and its tools'. */
const BACKOFFICE_TEXTS: readonly string[] = [
  BACKOFFICE,
  countingSourceDescription(BACKOFFICE),
  ...countingSourceTools(BACKOFFICE).flatMap((tool) => [tool.name, tool.description]),
];

// Rule 9 of the plan: the suite leaves no `active` investigation of the users it started them for.
afterAll(async () => {
  try {
    await assertNoActiveInvestigations();
  } finally {
    await closeEngineDb();
  }
});

describe('source-planning / catalog-planning - integration (in-process runtime + engine + real Postgres, scripted model, shipped v3, two counting sources)', () => {
  describe('INT-1: the catalog from start to every agent', () => {
    let harness: EngineHarness | undefined;

    /** The shipped v3 on the two-source ceiling with the test's rights table. */
    const assemble = async (access: AccessDouble): Promise<EngineHarness> => {
      harness = await createResearchFlowHarness({ runtime: RUNTIME, toolAccessPolicy: access });
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

    // INT-1 A - UC-1: an answer over two sources
    // AC: AC-04.3 "the developer opens the run and sees the catalog with descriptions"; AC-05.1 "every branch of the accepted plan has at least one source of the catalog and a reason";
    //   AC-07.1 "in the worker transcript every source and every tool has a description"; AC-07.3 "the plan named only logs for the branch, backoffice is in the catalog: the worker's request to backoffice is accepted"; NFR-03
    // Given: the rights table lets the owner read `fixture` and `backoffice`; the scenario has an order with a payment error in the logs and a record of that order in the back office.
    // When: the owner starts the investigation; the planner writes one plan whose only branch names `fixture` and a reason; the worker of that branch gathers from `fixture` and then from `backoffice`; the run is driven to its answer.
    // Then: `readAgentTree` returns a catalog of two sources, each with its description, its ceiling tools with descriptions and its slice; the plan revision has `sources` and `sourceReason` on the branch;
    //   the `backoffice` gather is accepted and reaches the counting source once; the worker's recorded prompt carries a description for each source and each tool; the planner made no turn besides `plan_write` and `finish`;
    //   the model-call ledger has no row before the root's first turn (the catalog costs no model call).
    // Behavior: start -> catalog into the engine row -> `{{catalog}}` / `{{sources}}` into the agents' system blocks -> plan with sources -> gather outside the branch's sources but inside the catalog -> accepted
    // Catches: a catalog that is built but not stored or not passed to the agents (the planner sees an empty `{{catalog}}`); a worker narrowed to the branch's sources instead of the catalog (AC-07.3); descriptions missing from the worker's block.
    // @category: core-functionality
    // @dependency: startInvestigation, SourceAccessPort double, SourceRegistry double, plan_write, gather, readAgentTree, counting sources, real Postgres
    // @complexity: high
    it(
      'INT-1 A (UC-1): two sources reach the planner and the worker with descriptions; a branch may gather beyond its named sources; the catalog costs no model call',
      async () => {
        const owner = newUser();
        const h = await assemble(createAccessDouble({ [owner]: [FIXTURE, BACKOFFICE] }));
        answerWithTheFailedPayment(h);
        scriptCatalogRuns(h, { gathers: [SEARCH_LOGS, SEARCH_ORDERS] });

        const started = await startResearch(h, owner, QUERY_PAYMENTS);
        const view = await closedView(h, started);
        const { investigationId, rootTaskId } = started;

        expect(view.status).toBe('completed');
        expect(h.model.pendingAgents()).toEqual({ controller: 0, planner: 0, worker: 0 });

        // AC-04.3: the catalog of the run, read as the developer reads it, with descriptions, tools and slices.
        const tree = await agentTreeOf(h, started);
        expect(tree.catalog).toEqual([BACKOFFICE_IN_CATALOG, FIXTURE_IN_CATALOG]);
        expect(await catalogRowOf(investigationId)).toMatchObject({ sourceMode: 'sources', sourceCatalog: [BACKOFFICE_IN_CATALOG, FIXTURE_IN_CATALOG] });
        // Every run of the tree got the catalog as its sources: the planner's branch does not narrow the worker.
        expect(await runSourcesOf(investigationId)).toEqual([
          ['controller', [BACKOFFICE, FIXTURE]],
          ['planner', [BACKOFFICE, FIXTURE]],
          ['worker', [BACKOFFICE, FIXTURE]],
        ]);

        // AC-05.1: the one branch of the accepted plan names a catalog source and a reason.
        expect(await planRevisionsOf(investigationId)).toEqual([
          {
            revision: 1,
            reason: 'there is no plan yet',
            branches: [{ question: 'What did the payment services log?', approach: 'search the payment-api errors', sources: [FIXTURE], sourceReason: 'it holds the service logs' }],
          },
        ]);

        // AC-07.3: the back-office gather, outside the branch's sources but inside the catalog, is accepted and reaches its source once.
        const gathers = (await toolCallAuditsOf(investigationId)).filter((row) => row.tool === 'gather');
        expect(gathers.map((row) => [row.agent, row.state, row.outcome, row.auditSourceId, row.auditOutcome, row.auditResourceId])).toEqual([
          ['worker', 'done', 'success', FIXTURE, 'success', owner],
          ['worker', 'done', 'success', BACKOFFICE, 'success', owner],
        ]);
        expect(h.countingSource.callsOf(BACKOFFICE).map((one) => one.toolName)).toEqual(['search_orders']);
        expect(h.countingSource.callsOf(FIXTURE).map((one) => one.toolName)).toEqual(['search_logs']);

        // AC-07.1: the worker's recorded prompt carries the declared description of each source and each tool;
        // the planner's carries each catalog source's description (`{{catalog}}`).
        const [workerPrompt] = h.model.promptsOfAgent('worker');
        const [plannerPrompt] = h.model.promptsOfAgent('planner');
        for (const sourceId of [FIXTURE, BACKOFFICE]) {
          expect(workerPrompt).toContain(countingSourceDescription(sourceId));
          for (const tool of countingSourceTools(sourceId)) expect(workerPrompt).toContain(tool.description);
          expect(plannerPrompt).toContain(countingSourceDescription(sourceId));
        }

        // The planner made no turn besides `plan_write` and `finish`.
        expect(h.model.callsOfAgent('planner')).toHaveLength(2);
        expect((await toolCallAuditsOf(investigationId)).filter((row) => row.agent === 'planner').map((row) => [row.tool, row.state])).toEqual([
          ['plan_write', 'done'],
          ['finish', 'done'],
        ]);

        // NFR-03: the catalog costs no model call - the first ledger row of the investigation, of any role, is the root's turn.
        const { llmCalls } = await engineRowsOf(investigationId);
        expect(llmCalls[0]?.taskId).toBe(rootTaskId);
        expect(h.model.calls[0]?.agent).toBe('controller');
      },
      CASE_MS,
    );

    // INT-1 B - UC-2, UC-E1: the catalog is the owner's, inside the ceiling; an empty catalog is the model-knowledge path (table rows)
    // AC: AC-03.1 "the table lets the user read only logs: the catalog is the logs"; AC-04.1 "connected and allowed but outside the process ceiling: not in the catalog"; AC-03.2 "the user is not in the table: the catalog is empty";
    //   AC-09.1 "the catalog is empty: no source called, the answer is built from model knowledge"; NFR-02 "the transcripts of all agents contain neither the id nor the description of `backoffice`"
    // Rows (one test each, own owner and launch key):
    //   B1 owner allowed only `fixture`; the question does not mention the back office -> catalog = [fixture]; the recorded prompts of EVERY agent of the run contain neither `backoffice` nor the back-office description;
    //   B2 owner allowed both, the process config (second configuration of the test) lists `backoffice` outside its ceiling -> catalog = [fixture]; no `backoffice` in any prompt;
    //   B3 owner absent from the table, both sources connected -> `source_catalog` empty, mode `model_knowledge`, the root is `synthesis`, no controller/planner started; zero slice reads and zero source calls (counting sources);
    //     `Engine.sourceMode` stays `sources` (the deployment flag that the offer uses).
    // Behavior: owner + connected + ceiling -> port answer per source -> catalog -> mode (empty catalog = model_knowledge)
    // Catches: a source the owner may not read appearing in any agent's input (NFR-02, the leak); the empty-catalog employee entering `sources` mode and stopping with "plan did not pass" instead of a model-knowledge answer (the KD-1 defect);
    //   a slice read from a source the owner is denied.
    // @category: integration
    // @dependency: startInvestigation, SourceAccessPort double, process ceiling, readSourceSnapshots, counting sources, real Postgres
    // @complexity: medium

    /** B1 and B2: the logs-only scenario runs to its close, and no agent was shown anything of the back office. */
    async function expectLogsOnlyRun(h: EngineHarness, access: AccessDouble, owner: string): Promise<void> {
      answerWithTheFailedPayment(h);
      scriptCatalogRuns(h, { gathers: [SEARCH_LOGS] });

      const started = await startResearch(h, owner, QUERY_PAYMENTS);
      const view = await closedView(h, started);
      const { investigationId } = started;

      expect(view.status).toBe('completed');
      expect(h.model.pendingAgents()).toEqual({ controller: 0, planner: 0, worker: 0 });
      expect(await catalogRowOf(investigationId)).toMatchObject({ sourceMode: 'sources', sourceCatalog: [FIXTURE_IN_CATALOG] });
      expect((await agentTreeOf(h, started)).catalog).toEqual([FIXTURE_IN_CATALOG]);
      expect(await runSourcesOf(investigationId)).toEqual([
        ['controller', [FIXTURE]],
        ['planner', [FIXTURE]],
        ['worker', [FIXTURE]],
      ]);

      // NFR-02: every agent of the run had prompts, the planner's names the logs, and none names anything of the back office.
      for (const agent of ['controller', 'planner', 'worker']) {
        const prompts = h.model.promptsOfAgent(agent);
        expect(prompts.length).toBeGreaterThan(0);
        for (const prompt of prompts) for (const text of BACKOFFICE_TEXTS) expect(prompt).not.toContain(text);
      }
      expect(h.model.promptsOfAgent('planner')[0]).toContain(countingSourceDescription(FIXTURE));

      // The back office was neither read for its slice nor called; the port was asked about it at most for the catalog.
      // The logs' slice is read twice: once at start for the catalog and once by the run's one gather for its evidence.
      expect(h.countingSource.snapshotReadsOf(BACKOFFICE)).toBe(0);
      expect(h.countingSource.snapshotReadsOf(FIXTURE)).toBe(2);
      expect(h.countingSource.callsOf(BACKOFFICE)).toEqual([]);
      expect(access.questionsOf(owner, BACKOFFICE).filter((question) => question.toolName !== null)).toEqual([]);
    }

    it(
      'INT-1 B1 (UC-2): the owner allowed only logs -> catalog [fixture]; no agent prompt names backoffice',
      async () => {
        const owner = newUser();
        const access = createAccessDouble({ [owner]: [FIXTURE] });
        const h = await assemble(access);

        await expectLogsOnlyRun(h, access, owner);
        // The catalog is the port's answer per ceiling source: both connected sources were asked about, the back office denied.
        expect(access.questionsOf(owner).filter((question) => question.toolName === null).map(({ sourceId, decision }) => [sourceId, decision])).toEqual([
          [BACKOFFICE, 'access_denied'],
          [FIXTURE, 'allowed'],
        ]);
      },
      CASE_MS,
    );

    it(
      'INT-1 B2 (UC-2): backoffice allowed but outside the ceiling -> not in the catalog',
      async () => {
        const owner = newUser();
        const access = createAccessDouble({ [owner]: [FIXTURE, BACKOFFICE] });
        // The second configuration of the test: the shipped v3 whose ceiling names only the logs; `backoffice` stays connected.
        const twoSources = researchFlowV3Config();
        const logsOnly = { ...twoSources, sources: twoSources.sources.filter((pair) => pair.sourceId !== BACKOFFICE) };
        harness = await createEngineHarness({ runtime: RUNTIME, processes: [logsOnly], groupTables: [researchFlowGroupTable(logsOnly)], toolAccessPolicy: access });

        await expectLogsOnlyRun(harness, access, owner);
        // A source outside the ceiling is no candidate: the port was asked only about the logs.
        expect(access.questionsOf(owner).filter((question) => question.toolName === null).map(({ sourceId, decision }) => [sourceId, decision])).toEqual([
          [FIXTURE, 'allowed'],
        ]);
      },
      CASE_MS,
    );

    it(
      'INT-1 B3 (UC-E1): not in the table -> empty catalog, mode model_knowledge, only synthesis runs, no slice read, Engine.sourceMode still sources',
      async () => {
        const owner = newUser();
        const access = createAccessDouble();
        const h = await assemble(access);
        const assumptions = ['A provider timeout usually fails the payment', 'A retry may charge the order twice'];
        h.model.scriptAgent('synthesis', {
          toolCalls: [call('finish', { outcome: 'inconclusive', summaryClaimIds: [], claims: assumptions.map((text) => ({ claimId: null, text, atoms: [], pointer: [] })) })],
          usage: TURN_USAGE,
        });

        const started = await startResearch(h, owner, QUERY_PAYMENTS);
        const view = await closedView(h, started);
        const { investigationId, rootTaskId } = started;

        expect(view.status).toBe('completed');
        expect(h.model.pendingAgents()).toEqual({ synthesis: 0 });
        expect(await catalogRowOf(investigationId)).toMatchObject({ sourceMode: 'model_knowledge', sourceCatalog: [] });
        const tree = await agentTreeOf(h, started);
        expect(tree.catalog).toEqual([]);
        expect(tree.runs.map((run) => [run.agentName, run.parent])).toEqual([['synthesis', null]]);
        expect(h.model.calls.map((one) => one.agent)).toEqual(['synthesis']);
        expect((await engineRowsOf(investigationId)).llmCalls.map((row) => row.taskId)).toEqual([rootTaskId]);

        // AC-09.1: the answer is the model-knowledge answer of a deployment without sources.
        const answer = (await answerRowOf(investigationId))?.engineRun.answer as {
          readonly outcome: string;
          readonly assumed: readonly { readonly text: string; readonly verified: boolean }[];
          readonly message: { readonly metadata: { readonly sourceMode: string } };
        };
        expect(answer.outcome).toBe('answered');
        expect(answer.assumed.map(({ text, verified }) => [text, verified])).toEqual(assumptions.map((text) => [text, false]));
        expect(answer.message.metadata.sourceMode).toBe('model_knowledge');

        // The port was asked about both sources as a whole and denied both, and never about a source call; no slice was read, no source called.
        expect(access.questionsOf(owner).filter((question) => question.sourceId !== null).map(({ toolName, sourceId, decision }) => [toolName, sourceId, decision])).toEqual([
          [null, BACKOFFICE, 'access_denied'],
          [null, FIXTURE, 'access_denied'],
        ]);
        expect([h.countingSource.snapshotReadsOf(FIXTURE), h.countingSource.snapshotReadsOf(BACKOFFICE)]).toEqual([0, 0]);
        expect(h.countingSource.calls).toEqual([]);
        // The deployment flag the offer reads is still the deployment's.
        expect(h.engine.sourceMode).toBe('sources');
      },
      CASE_MS,
    );

    // INT-1 C - UC-3: the catalog is written once
    // AC: AC-04.2 "a source connected or a right given after the start is not in the catalog of the running investigation, but is in the next investigation of the same employee"
    // Given: a running investigation whose catalog is [fixture]; the rights double then starts allowing `backoffice`.
    // When: the first investigation continues (a worker gathers; `readAgentTree` is read); the owner starts a second investigation; and the first launch key is started again.
    // Then: the first run's catalog and every run's `sources` stay [fixture]; the second investigation's catalog is [fixture, backoffice]; the repeated start with the first key returns the existing investigation and the catalog row is unchanged (the rights double is not asked again).
    // Behavior: catalog fixed at start in the row; a repeated start rebuilds the root from the row, not from the port
    // Catches: the catalog recomputed on read or on a repeated start (a second root task with different sources, the reason the catalog lives in the row - KD-1).
    // @category: integration
    // @dependency: startInvestigation, SourceAccessPort double, research_engine_runs, readAgentTree, real Postgres
    // @complexity: medium
    it(
      'INT-1 C (UC-3): the running investigation keeps its catalog; the next one gets the new right; a repeated launch key does not recompute',
      async () => {
        const owner = newUser();
        const access = createAccessDouble({ [owner]: [FIXTURE] });
        const h = await assemble(access);
        answerWithTheFailedPayment(h);
        // The first root's first turn waits until the right has changed and the launch was repeated: the whole tree runs after.
        const rootReleased = gate();
        scriptCatalogRuns(h, { gathers: [SEARCH_LOGS], runs: 2, holdFirstRoot: rootReleased.wait });

        const first = await startResearch(h, owner, QUERY_PAYMENTS);
        const catalogAtStart = await catalogRowOf(first.investigationId);
        expect(catalogAtStart).toMatchObject({ sourceMode: 'sources', sourceCatalog: [FIXTURE_IN_CATALOG] });

        // The right to the back office is given while the first investigation runs.
        access.allow(owner, [FIXTURE, BACKOFFICE]);
        const questionsBeforeRepeat = access.questionsOf(owner).length;

        // The same launch again: the recorded investigation and its root task, nothing asked, nothing recomputed.
        const repeated = await startResearch(h, owner, QUERY_PAYMENTS, { launchKey: first.launchKey, threadId: first.threadId });
        expect([repeated.outcome, repeated.investigationId, repeated.rootTaskId]).toEqual(['existing', first.investigationId, first.rootTaskId]);
        expect(access.questionsOf(owner)).toHaveLength(questionsBeforeRepeat);
        expect((await catalogRowOf(first.investigationId))?.sourceCatalog).toEqual([FIXTURE_IN_CATALOG]);

        rootReleased.open();
        expect((await closedView(h, first)).status).toBe('completed');

        // The first investigation kept its catalog to the end: its row, its tree and the sources of every run.
        expect(await catalogRowOf(first.investigationId)).toMatchObject({ sourceMode: 'sources', sourceCatalog: [FIXTURE_IN_CATALOG] });
        expect((await agentTreeOf(h, first)).catalog).toEqual([FIXTURE_IN_CATALOG]);
        expect(await runSourcesOf(first.investigationId)).toEqual([
          ['controller', [FIXTURE]],
          ['planner', [FIXTURE]],
          ['worker', [FIXTURE]],
        ]);
        expect((await tasksOf(first.investigationId)).filter((task) => task.workflowType === 'agent.root')).toHaveLength(1);

        // The next investigation of the same owner gets the new right.
        const second = await startResearch(h, owner, QUERY_PAYMENTS);
        expect((await closedView(h, second)).status).toBe('completed');
        expect(h.model.pendingAgents()).toEqual({ controller: 0, planner: 0, worker: 0 });
        expect(await catalogRowOf(second.investigationId)).toMatchObject({ sourceMode: 'sources', sourceCatalog: [BACKOFFICE_IN_CATALOG, FIXTURE_IN_CATALOG] });
        expect(await runSourcesOf(second.investigationId)).toEqual([
          ['controller', [BACKOFFICE, FIXTURE]],
          ['planner', [BACKOFFICE, FIXTURE]],
          ['worker', [BACKOFFICE, FIXTURE]],
        ]);
      },
      CASE_MS,
    );
  });

  describe('INT-2: the plan gate and the stop it ends in', () => {
    let harness: EngineHarness | undefined;

    /** The shipped v3 on the two-source ceiling with the test's rights table and, for a row, its named numbers. */
    const assemble = async (access: AccessDouble, overrides?: ResearchFlowOverrides): Promise<EngineHarness> => {
      harness = await createResearchFlowHarness({ runtime: RUNTIME, toolAccessPolicy: access, ...(overrides === undefined ? {} : { overrides }) });
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

    const REVIEW_ASSIGNMENT = 'Review the plan of the investigation of the failed payment';
    const READINESS = ['the cause of the failed payment is named'];
    /** The one branch of every plan here, collected from the given source. */
    const branchOn = (sourceId: string) => ({ question: 'What did the payment services log?', approach: 'search the payment-api errors', sources: [sourceId], sourceReason: 'it holds the service logs' });
    const planWrite = (sourceId: string, reason: string): ScriptedToolCall => call('plan_write', { readinessCriteria: READINESS, branches: [branchOn(sourceId)], reason });
    const step = (toolCalls: readonly ScriptedToolCall[] | ((view: AgentCallView) => readonly ScriptedToolCall[])): ScriptedStep => ({ toolCalls, usage: TURN_USAGE });
    /** The refusal of a plan whose first branch names the back office, outside a logs-only catalog. */
    const BACKOFFICE_NOT_IN_CATALOG = { branches: [{ branch: 1, notInCatalog: [BACKOFFICE] }] };

    /** The model turns the ledger journaled for the runs of one agent of the investigation (role `agent`). */
    async function journaledTurnsOf(investigationId: string, agent: string): Promise<number> {
      const [{ runs }, ledger] = await Promise.all([agentRowsOf(investigationId), llmCallsOf(investigationId)]);
      const runsOfAgent = new Set(runs.filter((run) => run.agentName === agent).map((run) => run.taskId));
      return ledger.filter((row) => row.taskId !== null && runsOfAgent.has(row.taskId)).length;
    }

    /** The failure codes the root's forced ends replaced, from the notices of its session. */
    async function forcedEndsOf(rootTaskId: string): Promise<readonly unknown[]> {
      const notices = (await sessionOf(rootTaskId)).map((message) => ({ kind: message.kind, content: message.content as { code?: string; failureCode?: string } }));
      return notices.filter(({ kind, content }) => kind === 'code_notice' && content.code === 'forced_end').map(({ content }) => content.failureCode);
    }

    /** The ended calls of the plan, the collection and the close: a refusal with its reason and detail, any other with its state. */
    async function gateCallsOf(investigationId: string): Promise<readonly unknown[]> {
      return (await toolCallAuditsOf(investigationId))
        .filter((row) => row.tool !== 'call_agent')
        .map((row) => (row.state === 'rejected' ? [row.agent, row.tool, row.reason, row.detail] : [row.agent, row.tool, row.state]));
    }

    // INT-2 A - UC-4, UC-N1: a rejected plan is corrected, and the revision is checked against the same catalog
    // AC: AC-06.1 "the plan named a source outside the catalog: the planner's next-turn transcript contains the reason with that id"; AC-05.3 "a revised plan is built on the same catalog and passes the same check"; NFR-03 "one extra planner turn per rejected call"
    // Given: catalog [fixture]; the planner first writes a branch naming `backoffice`, then a corrected plan; a later call of the controller asks for a plan review and the planner writes a revised plan.
    // When: the run is driven through the first plan, the correction and the review.
    // Then: the first `plan_write` is `plan_sources_invalid` with `backoffice` and the branch number in `detail`, no revision is written; the planner's recorded prompt on the next turn contains that reason and the id;
    //   the corrected and the reviewed plans are revisions 1 and 2, both with sources inside the catalog; the planner has exactly one turn more than the same run of INT-1 A (the journal count).
    // Behavior: planner -> `plan_write` -> code compares ids with the run's sources -> reject with the reason / write the revision
    // Catches: a plan with a source the owner cannot read being written (the check missing or done on the schema); a rejection that writes a revision anyway; the reason not reaching the model (AC-06.1); a review revision skipping the check.
    // @category: core-functionality
    // @dependency: plan_write, ToolExecutor, planner session, readAgentTree, real Postgres
    // @complexity: medium
    it(
      'INT-2 A (UC-4, UC-N1): plan_sources_invalid names the id, writes no revision, the reason reaches the planner; the revised plan passes against the same catalog; one turn more',
      async () => {
        const owner = newUser();
        const h = await assemble(createAccessDouble({ [owner]: [FIXTURE] }));

        /**
         * The controller calls the planner for the plan, then again for its review, then closes "not established". The planner
         * writes the plan (first naming the back office when `rejectFirst`, then the logs) and finishes; on the review it
         * writes the revised plan and finishes. Steps in arrival order: the controller waits for each planner run.
         */
        let rejectionSeen: readonly unknown[] | undefined;
        const scriptPlanAndReview = (rejectFirst: boolean): void => {
          h.model.scriptAgent(
            'controller',
            step([call('call_agent', { agent: 'planner', assignment: PLAN_ASSIGNMENT })]),
            step([call('call_agent', { agent: 'planner', assignment: REVIEW_ASSIGNMENT })]),
            step([call('finish', { inconclusive: true })]),
          );
          const firstPlan = rejectFirst
            ? [
                step([planWrite(BACKOFFICE, 'there is no plan yet')]),
                step((view) => {
                  rejectionSeen = view.resultsOf('plan_write');
                  return [planWrite(FIXTURE, 'the first plan named a source outside the catalog')];
                }),
              ]
            : [step([planWrite(FIXTURE, 'there is no plan yet')])];
          h.model.scriptAgent(
            'planner',
            ...firstPlan,
            step([finishText('The plan has one branch')]),
            step([planWrite(FIXTURE, 'the review keeps the logs branch')]),
            step([finishText('The plan is reviewed')]),
          );
        };

        // The same scenario without the refusal, in this case: the planner's turns it costs.
        scriptPlanAndReview(false);
        const baseline = await startResearch(h, owner, QUERY_PAYMENTS);
        expect((await closedView(h, baseline)).status).toBe('completed');
        expect(h.model.pendingAgents()).toEqual({ controller: 0, planner: 0 });
        expect((await planRevisionsOf(baseline.investigationId)).map((revision) => revision.revision)).toEqual([1, 2]);
        h.model.calls.length = 0;

        scriptPlanAndReview(true);
        const started = await startResearch(h, owner, QUERY_PAYMENTS);
        const view = await closedView(h, started);
        const { investigationId } = started;

        expect(view.status).toBe('completed');
        expect(h.model.pendingAgents()).toEqual({ controller: 0, planner: 0 });

        // AC-06.1: the first plan is refused with the id and the branch number; the other two plans and both finishes go through.
        expect(await gateCallsOf(investigationId)).toEqual([
          ['planner', 'plan_write', 'plan_sources_invalid', BACKOFFICE_NOT_IN_CATALOG],
          ['planner', 'plan_write', 'done'],
          ['planner', 'finish', 'done'],
          ['planner', 'plan_write', 'done'],
          ['planner', 'finish', 'done'],
          ['controller', 'finish', 'done'],
        ]);
        // The refusal reached the planner's next turn: as its tool result and in its recorded prompt, absent from the turn before.
        expect(rejectionSeen).toMatchObject([{ toolName: 'plan_write', outcome: 'rejected', reason: 'plan_sources_invalid', detail: BACKOFFICE_NOT_IN_CATALOG }]);
        const plannerPrompts = h.model.promptsOfAgent('planner');
        expect(plannerPrompts[0]).not.toContain('notInCatalog');
        expect(plannerPrompts[1]).toContain('notInCatalog');

        // AC-05.3: the refused plan wrote no revision; the corrected and the reviewed plans are revisions 1 and 2, inside the catalog.
        expect(await planRevisionsOf(investigationId)).toEqual([
          { revision: 1, reason: 'the first plan named a source outside the catalog', branches: [branchOn(FIXTURE)] },
          { revision: 2, reason: 'the review keeps the logs branch', branches: [branchOn(FIXTURE)] },
        ]);
        // Both planner runs, the plan and the review, were checked against the same catalog.
        expect(await catalogRowOf(investigationId)).toMatchObject({ sourceMode: 'sources', sourceCatalog: [FIXTURE_IN_CATALOG] });
        expect(await runSourcesOf(investigationId)).toEqual([
          ['controller', [FIXTURE]],
          ['planner', [FIXTURE]],
          ['planner', [FIXTURE]],
        ]);

        // NFR-03: the refused call costs the planner exactly one turn more than the same scenario without it (the ledger's count).
        expect([await journaledTurnsOf(baseline.investigationId, 'planner'), await journaledTurnsOf(investigationId, 'planner')]).toEqual([4, 5]);
        expect(h.countingSource.calls).toEqual([]);
      },
      CASE_MS,
    );

    // INT-2 B - UC-E2: the attempts run out and the investigation stops with its own reason (rows: the root finishes / the root runs out of turns)
    // AC: AC-06.2 "all attempts rejected: the investigation is stopped with the new reason (plan did not pass the source check, MC-25), no source is called, the employee gets an answer with that reason"
    // Given: catalog [fixture]; the controller first tries to call a worker; the planner writes a plan with `backoffice` three times; then writes a fourth.
    // When: the run is driven (row B1: the controller then `finish`es "not established"; row B2: the controller spends its turns without `finish`).
    // Then: the early `gather` is `plan_missing`; the fourth `plan_write` is `plan_attempts_exhausted` with no revision; there is no plan revision; the counting sources have zero calls;
    //   the investigation is `completed` with an answer of outcome `inconclusive` and stop reason `plan_sources_rejected` (both rows); a plan-less `answer` closure is still refused `plan_missing`.
    // Behavior: three rejected attempts -> `gather` blocked -> root closes without a plan -> precedence rule sets `plan_sources_rejected`
    // Catches: work going on without a plan (a source called, invariant 6); the stop reason falling to a generic one (`failed`, `turns_exhausted`) so the employee gets the wrong text; the forced end of the root losing the reason.
    // @category: core-functionality
    // @dependency: plan_write, gather, research_close, stop-reason rule, forced end of the root, answer gateway, real Postgres
    // @complexity: high
    /** The planner's three plans that name the back office, outside a logs-only catalog: every one is a rejected attempt. */
    const threeRejectedPlans = (): ScriptedStep[] => [1, 2, 3].map((attempt) => step([planWrite(BACKOFFICE, `attempt ${attempt} at the plan`)]));

    /** The Then both rows share: no plan, no source called, the investigation completed "not established" with its own stop reason. */
    async function expectStoppedByThePlanGate(h: EngineHarness, started: StartedResearch): Promise<void> {
      const view = await closedView(h, started);
      expect(view.status).toBe('completed');
      expect([view.answer?.outcome, view.answer?.stopReason]).toEqual(['inconclusive', 'plan_sources_rejected']);
      expect(await planRevisionsOf(started.investigationId)).toEqual([]);
      expect(h.countingSource.calls).toEqual([]);
    }

    it(
      'INT-2 B1 (UC-E2): three rejections -> plan_missing for gather, plan_attempts_exhausted for the fourth call, inconclusive answer with plan_sources_rejected, no source call',
      async () => {
        const owner = newUser();
        const h = await assemble(createAccessDouble({ [owner]: [FIXTURE] }));
        answerWithTheFailedPayment(h);
        // The controller first sends a worker before any plan, then calls the planner; with no plan it first tries to close
        // with an answer, then closes "not established".
        h.model.scriptAgent(
          'controller',
          step([call('call_agent', { agent: 'worker', assignment: BRANCH })]),
          step([call('call_agent', { agent: 'planner', assignment: PLAN_ASSIGNMENT })]),
          step([call('finish', { answer: randomUUID() })]),
          step([call('finish', { inconclusive: true })]),
        );
        h.model.scriptAgent(
          'worker',
          step([call('gather', { sourceId: SEARCH_LOGS.sourceId, toolName: SEARCH_LOGS.toolName, args: SEARCH_LOGS.args, completeness: 'sample' })]),
          step([finishText('No plan, nothing gathered')]),
        );
        h.model.scriptAgent('planner', ...threeRejectedPlans(), step([planWrite(BACKOFFICE, 'attempt 4 at the plan')]), step([finishText('The plan did not pass')]));

        const started = await startResearch(h, owner, QUERY_PAYMENTS);
        await expectStoppedByThePlanGate(h, started);
        expect(h.model.pendingAgents()).toEqual({ controller: 0, worker: 0, planner: 0 });

        // The gather before the plan is plan_missing; three attempts are refused with the id, the fourth by the exhausted
        // attempts with no check; the plan-less answer is refused by gate 1 and only "not established" closes.
        expect(await gateCallsOf(started.investigationId)).toEqual([
          ['worker', 'gather', 'plan_missing', null],
          ['worker', 'finish', 'done'],
          ['planner', 'plan_write', 'plan_sources_invalid', BACKOFFICE_NOT_IN_CATALOG],
          ['planner', 'plan_write', 'plan_sources_invalid', BACKOFFICE_NOT_IN_CATALOG],
          ['planner', 'plan_write', 'plan_sources_invalid', BACKOFFICE_NOT_IN_CATALOG],
          ['planner', 'plan_write', 'plan_attempts_exhausted', null],
          ['planner', 'finish', 'done'],
          ['controller', 'finish', 'invalid_result', { reason: 'plan_missing' }],
          ['controller', 'finish', 'done'],
        ]);
      },
      CASE_MS,
    );

    it(
      'INT-2 B2 (UC-E2): the root runs out of turns without finish -> the same answer with the same reason',
      async () => {
        const owner = newUser();
        // Two turns of the root: the second ends without `finish`, it is the last, and the root ends by its forced end.
        const h = await assemble(createAccessDouble({ [owner]: [FIXTURE] }), { agents: { controller: { maxTurns: 2 } } });
        h.model.scriptAgent(
          'controller',
          step([call('call_agent', { agent: 'planner', assignment: PLAN_ASSIGNMENT })]),
          { text: 'I have no plan to close with', usage: TURN_USAGE },
        );
        h.model.scriptAgent('planner', ...threeRejectedPlans(), step([finishText('The plan did not pass')]));

        const started = await startResearch(h, owner, QUERY_PAYMENTS);
        await expectStoppedByThePlanGate(h, started);
        expect(h.model.pendingAgents()).toEqual({ controller: 0, planner: 0 });

        // The root never closed: its forced end turn_limit carries the reason, not step_limit.
        expect(await forcedEndsOf(started.rootTaskId)).toEqual(['turn_limit']);
        expect(await gateCallsOf(started.investigationId)).toEqual([
          ['planner', 'plan_write', 'plan_sources_invalid', BACKOFFICE_NOT_IN_CATALOG],
          ['planner', 'plan_write', 'plan_sources_invalid', BACKOFFICE_NOT_IN_CATALOG],
          ['planner', 'plan_write', 'plan_sources_invalid', BACKOFFICE_NOT_IN_CATALOG],
          ['planner', 'finish', 'done'],
        ]);
      },
      CASE_MS,
    );
  });

  describe('INT-3: the checks before every source call', () => {
    let harness: EngineHarness | undefined;

    /** The shipped v3 on the two-source ceiling with the test's rights table. */
    const assemble = async (access: AccessDouble): Promise<EngineHarness> => {
      harness = await createResearchFlowHarness({ runtime: RUNTIME, toolAccessPolicy: access });
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

    const step = (toolCalls: readonly ScriptedToolCall[] | ((view: AgentCallView) => readonly ScriptedToolCall[])): ScriptedStep => ({ toolCalls, usage: TURN_USAGE });
    const gatherCall = ({ sourceId, toolName, args }: ScriptedGather): ScriptedToolCall => call('gather', { sourceId, toolName, args, completeness: 'sample' });
    const firstPage = (view: AgentCallView): string => {
      const [page] = view.pages;
      if (page === undefined) throw new Error('no gathered page in the session');
      return page.page;
    };

    /**
     * The tree of every case here: the controller calls the planner, then one worker on the branch, then closes "not
     * established"; the planner writes a plan whose one branch names `planSource` and finishes; the worker runs its steps.
     */
    const scriptPlanAndBranch = (h: EngineHarness, planSource: string, worker: readonly ScriptedStep[]): void => {
      h.model.scriptAgent(
        'controller',
        step([call('call_agent', { agent: 'planner', assignment: PLAN_ASSIGNMENT })]),
        step([call('call_agent', { agent: 'worker', assignment: BRANCH })]),
        step([call('finish', { inconclusive: true })]),
      );
      h.model.scriptAgent(
        'planner',
        step([
          call('plan_write', {
            readinessCriteria: ['the cause of the failed payment is named'],
            branches: [{ question: 'What happened to the failed payment?', approach: 'read the records of the failed payment', sources: [planSource], sourceReason: 'it holds the failed payment' }],
            reason: 'there is no plan yet',
          }),
        ]),
        step([finishText('The plan has one branch')]),
      );
      h.model.scriptAgent('worker', ...worker);
    };

    /** The gather calls of the investigation: the ended state, the outcome, reason and detail, whether an audit row exists, and its source, outcome and owner. */
    async function gatherAuditsOf(investigationId: string): Promise<readonly unknown[]> {
      return (await toolCallAuditsOf(investigationId))
        .filter((row) => row.tool === 'gather')
        .map((row) => [row.state, row.outcome, row.reason, row.detail, row.auditId !== null, row.auditSourceId, row.auditOutcome, row.auditResourceId]);
    }

    // INT-3 A - UC-E3 (rows per source): a source the owner may not read is never reached, never asked about, never audited
    // AC: AC-07.2 "the worker asked a source outside the catalog: refused, the source not called, the worker gets the reason"; NFR-01 "the source is not called and the port is not asked"
    // Rows: A1 the owner is allowed only `fixture`; the worker asks `backoffice`; A2 the owner is allowed only `backoffice`; the worker asks `fixture` (the same defect from the other side).
    // Given: the run's sources are the catalog; the rights double counts its questions.
    // When: the worker calls `gather` for the source outside the catalog.
    // Then: the result is `source_not_in_catalog`, no `detail`; the counting source of that id has zero calls; the rights double was not asked about the call; the call's audit row exists and carries no source;
    //   the worker continues its branch on the catalog source.
    // Behavior: executor reads the call's source -> not among the run's sources -> refuse before the port
    // Catches: the port being asked (or the source called) for a source outside the catalog; the audit row naming the unreachable source; the refusal giving the worker any fact about the source (NFR-02).
    // @category: core-functionality
    // @dependency: ToolExecutor, gather (`sourceOf`), SourceAccessPort double, audit table, counting sources, real Postgres
    // @complexity: medium
    interface OutsideRow {
      /** The one source the owner may read: the catalog, and the branch's gather after the refusal. */
      readonly inside: ScriptedGather;
      readonly insideInCatalog: ReturnType<typeof catalogSource>;
      /** The connected source in the ceiling that the owner may not read: outside the catalog. */
      readonly outside: ScriptedGather;
    }

    /** The Then of both rows: the call outside the catalog is refused by code alone, before the port and the source. */
    async function expectOutsideSourceRefused({ inside, insideInCatalog, outside }: OutsideRow): Promise<void> {
      const owner = newUser();
      const access = createAccessDouble({ [owner]: [inside.sourceId] });
      const h = await assemble(access);
      answerWithTheFailedPayment(h);
      let refusalSeen: readonly unknown[] | undefined;
      scriptPlanAndBranch(h, inside.sourceId, [
        step([gatherCall(outside)]),
        step((view) => {
          refusalSeen = view.resultsOf('gather');
          return [gatherCall(inside)];
        }),
        step([finishText('The branch is done')]),
      ]);

      const started = await startResearch(h, owner, QUERY_PAYMENTS);
      const view = await closedView(h, started);
      const { investigationId } = started;

      expect(view.status).toBe('completed');
      expect(h.model.pendingAgents()).toEqual({ controller: 0, planner: 0, worker: 0 });
      expect(await catalogRowOf(investigationId)).toMatchObject({ sourceMode: 'sources', sourceCatalog: [insideInCatalog] });

      // AC-07.2: the worker gets the code alone, no detail; then it goes on with its branch on the catalog source.
      expect(refusalSeen).toEqual([{ toolCallId: expect.any(String), toolName: 'gather', outcome: 'rejected', reason: 'source_not_in_catalog' }]);
      // The refused call has its audit row, and the row names no source; the next gather is audited with its source.
      expect(await gatherAuditsOf(investigationId)).toEqual([
        ['rejected', 'rejected', 'source_not_in_catalog', null, true, null, 'rejected', owner],
        ['done', 'success', null, null, true, inside.sourceId, 'success', owner],
      ]);

      // NFR-01: the source outside the catalog was never called, and the port was never asked about a call to it.
      expect(h.countingSource.callsOf(outside.sourceId)).toEqual([]);
      expect(h.countingSource.callsOf(inside.sourceId).map((one) => one.toolName)).toEqual([inside.toolName]);
      expect(access.questionsOf(owner, outside.sourceId).filter((question) => question.toolName !== null)).toEqual([]);
      expect(access.questionsOf(owner).filter((question) => question.toolName === 'gather').map(({ sourceId, decision }) => [sourceId, decision])).toEqual([
        [inside.sourceId, 'allowed'],
      ]);

      // NFR-02: the refusal showed the worker nothing of the source it named - neither its description nor its tools' descriptions.
      const workerPrompts = h.model.promptsOfAgent('worker');
      expect(workerPrompts).toHaveLength(3);
      const outsideTexts = [countingSourceDescription(outside.sourceId), ...countingSourceTools(outside.sourceId).map((tool) => tool.description)];
      for (const prompt of workerPrompts) for (const text of outsideTexts) expect(prompt).not.toContain(text);
    }

    it(
      'INT-3 A1 (UC-E3): backoffice outside the catalog -> source_not_in_catalog, no port question, audit row without source',
      () => expectOutsideSourceRefused({ inside: SEARCH_LOGS, insideInCatalog: FIXTURE_IN_CATALOG, outside: SEARCH_ORDERS }),
      CASE_MS,
    );

    it(
      'INT-3 A2 (UC-E3): fixture outside the catalog -> the same, from the other side',
      () => expectOutsideSourceRefused({ inside: SEARCH_ORDERS, insideInCatalog: BACKOFFICE_IN_CATALOG, outside: SEARCH_LOGS }),
      CASE_MS,
    );

    // INT-3 B - UC-E5: the right is revoked in the middle
    // AC: AC-08.1 "after the revoke the source is not called, the audit has a refusal row with employee, source, tool and time, the worker continues"; AC-08.2 "after the first refusal there is no new audit row for the source, the branch goes on without it,
    //   the verifier checks a claim against the records collected before, and the claim can stand in 'Established'"
    // Given: catalog [fixture, backoffice]; one page is already gathered from `backoffice` and a claim is written on it; then the rights double denies `backoffice`.
    // When: the worker asks `backoffice` twice and then `fixture`; the verifier checks the claim written on the back-office page.
    // Then: the first call is `access_denied` (the source not called; the audit row has the owner, `gather`, `backoffice`, time and outcome `access_denied`); the second is `source_revoked` and the rights double was not asked; the audit has no new row naming `backoffice` after the first denial
    //   (the second row has no source); the `fixture` gather goes through; the verifier assesses the claim from the collected page and its status is the one the verifier's script gives (supported -> 'Established' group in the answer).
    // Behavior: port denial recorded -> later calls read that fact from the run's calls -> refuse before the port, audit without source -> earlier records stay usable
    // Catches: the port asked again after a denial (the audit keeps growing for the revoked source - invariant 4); a revoked source dropping the earlier evidence (claims on it becoming "not verifiable"); the worker blocked from the other source.
    // @category: core-functionality
    // @dependency: ToolExecutor, SourceAccessPort double, gather, claims_write, verifier, audit table, answer gateway, real Postgres
    // @complexity: high
    it(
      'INT-3 B (UC-E5): first denial is access_denied with an audit row; the second is source_revoked without a port question or a source in the audit; the other source goes on; the earlier page still supports a claim',
      async () => {
        const owner = newUser();
        const access = createAccessDouble({ [owner]: [FIXTURE, BACKOFFICE] });
        const h = await assemble(access);
        answerWithTheFailedPayment(h);
        const GET_ORDER: ScriptedGather = { sourceId: BACKOFFICE, toolName: 'get_order', args: { orderId: 'ord-4bf92f35' } };
        const CLAIM_ON_ORDER = 'order ord-4bf92f35 failed';

        // The worker gathers the orders and writes a claim on that page; the right to the back office is then taken away (the
        // revoke lands between two calls); it asks the back office twice, then the logs, hands the claim to a verifier, finishes.
        let refusalsSeen: readonly unknown[] | undefined;
        scriptPlanAndBranch(h, BACKOFFICE, [
          step([gatherCall(SEARCH_ORDERS)]),
          step((view) => [
            call('claims_write', { claims: [{ text: CLAIM_ON_ORDER, atoms: [{ kind: 'text', value: 'failed' }], pointer: [{ pageId: firstPage(view), records: [0] }] }] }),
          ]),
          step(() => {
            access.allow(owner, [FIXTURE]);
            return [gatherCall(GET_ORDER)];
          }),
          step([gatherCall(GET_ORDER)]),
          step((view) => {
            refusalsSeen = view.resultsOf('gather').slice(1);
            return [gatherCall(SEARCH_LOGS)];
          }),
          step((view) => {
            const [claimId] = view.claimIds;
            if (claimId === undefined) throw new Error('no claim id in the session');
            return [call('call_agent', { agent: 'verifier', assignment: claimId })];
          }),
          step([finishText('The branch is done')]),
        ]);
        h.model.scriptAgent(
          'verifier',
          step((view) => [
            call('finish', assessment({ support: 'yes', claimType: 'observation', records: verifierPacketOf(view).records.map(({ number }) => ({ record: number, relation: 'supports' })) })),
          ]),
        );

        const started = await startResearch(h, owner, QUERY_PAYMENTS);
        const view = await closedView(h, started);
        const { investigationId } = started;

        expect(view.status).toBe('completed');
        expect(h.model.pendingAgents()).toEqual({ controller: 0, planner: 0, worker: 0, verifier: 0 });

        // AC-08.1: the first call after the revoke is denied by the port and audited with owner, tool, source, time and outcome;
        // AC-08.2: the second is refused by the executor and its audit row names no source; the logs gather goes through.
        expect(await gatherAuditsOf(investigationId)).toEqual([
          ['done', 'success', null, null, true, BACKOFFICE, 'success', owner],
          ['rejected', 'access_denied', 'access_denied', null, true, BACKOFFICE, 'access_denied', owner],
          ['rejected', 'rejected', 'source_revoked', null, true, null, 'rejected', owner],
          ['done', 'success', null, null, true, FIXTURE, 'success', owner],
        ]);
        const audits = await toolCallAuditsOf(investigationId);
        expect(audits.find((row) => row.outcome === 'access_denied')?.auditRecordedAt).toBeInstanceOf(Date);
        // Invariant 4: after the first denial no audit row names the back office again.
        expect(audits.filter((row) => row.auditSourceId === BACKOFFICE).map((row) => row.auditOutcome)).toEqual(['success', 'access_denied']);
        // The worker read both refusals as codes, neither with a detail.
        expect(refusalsSeen).toEqual([
          { toolCallId: expect.any(String), toolName: 'gather', outcome: 'access_denied', reason: 'access_denied' },
          { toolCallId: expect.any(String), toolName: 'gather', outcome: 'rejected', reason: 'source_revoked' },
        ]);

        // The port was asked about the back office for the first call and for the denied one, not for the third; the source got only the first.
        expect(access.questionsOf(owner, BACKOFFICE).filter((question) => question.toolName !== null).map(({ toolName, decision }) => [toolName, decision])).toEqual([
          ['gather', 'allowed'],
          ['gather', 'access_denied'],
        ]);
        expect(h.countingSource.callsOf(BACKOFFICE).map((one) => one.toolName)).toEqual(['search_orders']);
        expect(h.countingSource.callsOf(FIXTURE).map((one) => one.toolName)).toEqual(['search_logs']);

        // AC-08.2: the claim on the page gathered before the revoke is checked from that page and stands in "Established".
        expect((await claimRevisionsOf(investigationId)).map((revision) => [revision.text, revision.status])).toEqual([
          [CLAIM_ON_ORDER, 'unverified'],
          [CLAIM_ON_ORDER, 'supported'],
        ]);
        const backofficePages = (await gatherPagesOf(investigationId)).stored
          .filter((page) => (page.provenance as { sourceId?: string }).sourceId === BACKOFFICE)
          .map((page) => page.pageId);
        expect(backofficePages).toHaveLength(1);
        const answer = (await answerRowOf(investigationId))?.engineRun.answer as {
          readonly outcome: string;
          readonly stopReason: string | null;
          readonly established: readonly { readonly text: string; readonly evidenceIds: readonly string[]; readonly verified: boolean }[];
        };
        expect([answer.outcome, answer.stopReason]).toEqual(['inconclusive', null]);
        expect(answer.established.map(({ text, evidenceIds, verified }) => [text, evidenceIds, verified])).toEqual([[CLAIM_ON_ORDER, backofficePages, true]]);
      },
      CASE_MS,
    );
  });
});

// Proven elsewhere (unit specs the plan names; not skeletons here):
// - UC-E4 / `tool_not_in_catalog`: the pair check of `gather` against the ceiling (table over: tool of another source, tool outside the ceiling, tool of a catalog source). The source is not reached because no task is created.
// - The order of the three executor checks and the audit-without-source rule as a pure function of (run sources, run's prior denials, port answer): src spec of `ToolExecutor`; INT-3 proves the wiring with real tables.
// - `buildSourcesField` (a line per source with descriptions, code-point order, the 8 192-byte limit) and the `{{catalog}}` field with `readsRunCatalog` (placement refusal, size refusal): src specs of the field builders and `definition-check`.
// - `plan_write` rule table (branch without source, source outside the run's sources, 0-8 ids, 1-500 reason) and the attempt counter (three in a row, `plan_attempts_exhausted` and schema refusals do not count): src spec of `plan-write`.
// - The precedence rule's first row (`plan_sources_rejected`) and gate 1 of `research_close` without a plan: src spec of the form and of `stop-reason`.
// - Verifier fingerprint unchanged (KD-8): not tested as a constant (a tautology); the shipped group table still being found at boot is proven by every file that boots the shipped v3.
// - Existing research-flow int/E2E files and the recorded-run fixture run on v3 whose planner schema and gather gate change: the plan lists their update (planner scripts name sources; recorded real-model answers may need a re-record).
