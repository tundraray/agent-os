import { parseRuntimeConfig, type TaskHandler } from '@agent-os/runtime';
import {
  createRuntimeHarness,
  type RuntimeHarness,
} from './runtimeHarness.js';
import {
  CHILD_SCENARIO_ENV,
  type ChildMessage,
  type ChildScenario,
  completed,
  evidenceInput,
  type Latch,
  latch,
  SCENARIO_STEPS,
  SCENARIO_SUBSCRIBER,
  scenarioHandler,
  scenarioRequester,
  scenarioSpec,
  type ScenarioStep,
  type StopMessage,
  taskSpec,
  testHandler,
} from './testHandlers.js';

/**
 * Entry of the kill-matrix child process (E2E-1), run only compiled (`pnpm --filter
 * @agent-os/runtime build:child` → `dist/test-child/`). It builds the runtime from the package's
 * own `dist` (imported by name) with the scenario handler and Runtime Settings taken from its
 * environment (the harness sets `RUNTIME_WORKERS=on`, short
 * lease and reaper periods and, for the dying start, `RUNTIME_CRASH_AT`). The first start creates
 * the thread and the investigation; every start then admits the steps not admitted yet — all of
 * them on the first start, none after a death past admission — and releases the handlers.
 * `{ kind: 'stop' }` over IPC stops the runtime, closes its pool and exits 0.
 *
 * Modes ({@link ChildMode}): `kill-matrix` is the scenario above; `cancel` adds the cancel of an
 * unrelated investigation whose one task is running; `two-instances` is one of two processes
 * executing `taskCount` independent tasks of one workflow type.
 */

/** What the child runs. */
export type ChildMode = 'kill-matrix' | 'cancel' | 'two-instances';

interface InvestigationRef {
  investigationId: string;
  threadId: string;
}

/** The {@link ChildScenario} of a mode; a restart names the investigations created before. */
export interface ModeScenario extends ChildScenario {
  mode: ChildMode;
  /** `cancel` mode: the investigation the scenario cancels, once created. */
  cancelInvestigation?: InvestigationRef;
  /** `two-instances` mode: how many tasks the first instance admits. */
  taskCount?: number;
}

/** Messages of the child to the harness (IPC), the shared ones included. */
export type ModeMessage =
  | ChildMessage
  /** `cancel` mode: the investigation the scenario cancels was created. */
  | ({ kind: 'cancel-investigation' } & InvestigationRef)
  /** `two-instances` mode: this process called the handler of the task. */
  | { kind: 'executed'; taskId: string };

/** Messages of the harness to the child (IPC): `go` lets the first two-instance child admit. */
export type HarnessMessage = StopMessage | { kind: 'go' };

/** Workflow type of the task of the cancelled investigation. */
const cancelWorkflowType = (workflowType: string): string =>
  `${workflowType}-cancel`;

/** Step name of the task of the cancelled investigation. */
const CANCEL_STEP = 'D';

function readScenario(): ModeScenario {
  const raw = process.env[CHILD_SCENARIO_ENV];
  if (!raw) throw new Error(`${CHILD_SCENARIO_ENV} is not set`);
  return JSON.parse(raw) as ModeScenario;
}

/** Sends a message and resolves once it left the process: a crash right after loses nothing. */
function send(message: ModeMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) {
      reject(new Error('The child process has no IPC channel'));
      return;
    }
    process.send(message, undefined, undefined, (error) =>
      error ? reject(error) : resolve(),
    );
  });
}

async function createInvestigation(
  runtime: RuntimeHarness,
  resourceId: string,
  maxTasks: number,
): Promise<InvestigationRef> {
  const threadId = await runtime.createThread(resourceId);
  const { investigationId } = await runtime.investigations.create({
    resourceId,
    threadId,
    query: 'E2E-1 kill matrix',
    // Each test task reserves 2 tool calls.
    budget: { maxTasks, maxToolCalls: 2 * maxTasks },
  });
  return { investigationId, threadId };
}

/**
 * Admits the steps of the scenario that have no task yet, in order: A, the second subscriber of
 * A, B after A, C. A proposal is matched by its requester key, which names one step of the
 * scenario, so a restart never proposes again what the dead process committed (a finished task is
 * not live: proposing it again would create a second one). The dedup-key rule stays inside the
 * package: its public entry does not open it.
 */
async function admitMissingSteps(
  runtime: RuntimeHarness,
  scenario: ChildScenario,
  investigation: InvestigationRef,
): Promise<void> {
  const [current] = await runtime.investigations.listForThread(
    scenario.resourceId,
    investigation.threadId,
  );
  const existing = current?.tasks ?? [];
  const taskIds = new Map<ScenarioStep, string>();
  const propose = async (step: ScenarioStep, requesterKey: string) => {
    const spec = scenarioSpec({
      investigationId: investigation.investigationId,
      workflowType: scenario.workflowType,
      step,
      dependsOn: step === 'B' ? [taskIdOf('A')] : [],
    });
    const task = existing.find((known) =>
      known.subscribers.includes(requesterKey),
    );
    if (task) {
      taskIds.set(step, task.taskId);
      return;
    }
    const result = await runtime.scheduler.propose(spec, requesterKey);
    if (result.outcome === 'rejected') {
      throw new Error(`Step ${step} rejected: ${JSON.stringify(result)}`);
    }
    taskIds.set(step, result.taskId);
  };
  const taskIdOf = (step: ScenarioStep): string => {
    const taskId = taskIds.get(step);
    if (!taskId) throw new Error(`Step ${step} has no task yet`);
    return taskId;
  };

  for (const step of SCENARIO_STEPS) {
    await propose(step, scenarioRequester(step));
    if (step === 'A') await propose('A', SCENARIO_SUBSCRIBER);
  }
}

/** Handler of the cancelled task: reports its start, then holds its slot until aborted. */
function cancelHandler(workflowType: string, started: Latch): TaskHandler {
  return testHandler(cancelWorkflowType(workflowType), async (ctx) => {
    started.release();
    await new Promise<void>((resolve) => {
      if (ctx.signal.aborted) return resolve();
      ctx.signal.addEventListener('abort', () => resolve(), { once: true });
    });
    return completed();
  });
}

/**
 * The first start creates the unrelated investigation, proposes its one task and waits for the
 * task's handler: proposed before the scenario's steps, it takes a slot before they do. A restart
 * gets the investigation from the scenario.
 */
async function startUnrelatedInvestigation(
  runtime: RuntimeHarness,
  scenario: ModeScenario,
  started: Latch,
): Promise<InvestigationRef> {
  if (scenario.cancelInvestigation) return scenario.cancelInvestigation;
  const target = await createInvestigation(runtime, scenario.resourceId, 1);
  await send({ kind: 'cancel-investigation', ...target });
  const result = await runtime.scheduler.propose(
    taskSpec({
      investigationId: target.investigationId,
      workflowType: cancelWorkflowType(scenario.workflowType),
      input: { step: CANCEL_STEP },
    }),
    `scenario-${CANCEL_STEP}`,
  );
  if (result.outcome === 'rejected') {
    throw new Error(`Step ${CANCEL_STEP} rejected: ${JSON.stringify(result)}`);
  }
  await started.promise;
  return target;
}

/** Handler of the two-instance row: reports the call, stores the task's evidence, completes. */
function twoInstanceHandler(
  workflowType: string,
  admitted: Promise<void>,
): TaskHandler {
  return testHandler(workflowType, async (ctx) => {
    await send({ kind: 'executed', taskId: ctx.taskId });
    await admitted;
    const { step } = ctx.input;
    if (typeof step !== 'string') {
      throw new Error(`Unknown task step ${JSON.stringify(step)}`);
    }
    const ref = await ctx.putEvidence(
      evidenceInput(`page-${step}`, new TextEncoder().encode(`page ${step}`)),
    );
    return completed({ evidenceRefs: [ref.evidenceId] });
  });
}

/** Step name of the n-th (1-based) two-instance task. */
const twoInstanceStep = (n: number): string => `T${String(n).padStart(2, '0')}`;

/** Tasks of the investigation the scenario creates: the two-instance tasks, or room for A-C. */
const maxTasksOf = (scenario: ModeScenario): number => scenario.taskCount ?? 10;

async function admitTwoInstanceTasks(
  runtime: RuntimeHarness,
  scenario: ModeScenario,
  investigationId: string,
): Promise<void> {
  for (let n = 1; n <= maxTasksOf(scenario); n += 1) {
    const step = twoInstanceStep(n);
    const result = await runtime.scheduler.propose(
      taskSpec({
        investigationId,
        workflowType: scenario.workflowType,
        input: { step },
      }),
      `scenario-${step}`,
    );
    if (result.outcome === 'rejected') {
      throw new Error(`Task ${step} rejected: ${JSON.stringify(result)}`);
    }
  }
}

function handlersOf(
  scenario: ModeScenario,
  admitted: Latch,
  cancelStarted: Latch,
): TaskHandler[] {
  switch (scenario.mode) {
    case 'two-instances':
      return [twoInstanceHandler(scenario.workflowType, admitted.promise)];
    case 'cancel':
      return [
        scenarioHandler(scenario.workflowType, admitted.promise),
        cancelHandler(scenario.workflowType, cancelStarted),
      ];
    case 'kill-matrix':
      return [scenarioHandler(scenario.workflowType, admitted.promise)];
  }
}

async function main(): Promise<void> {
  const scenario = readScenario();
  const admitted = latch();
  const cancelStarted = latch();
  const go = latch();
  const runtime = await createRuntimeHarness({
    handlers: handlersOf(scenario, admitted, cancelStarted),
    // The environment is authoritative here, over the in-process test defaults: the child is the
    // composition root of its runtime, so it reads the environment itself (NODE_ENV included).
    runtime: parseRuntimeConfig(process.env),
    echoLogs: true,
  });
  process.on('message', (message: HarnessMessage) => {
    if (message.kind === 'go') go.release();
    if (message.kind !== 'stop') return;
    runtime.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error('Closing the child runtime failed', error);
        process.exit(1);
      },
    );
  });

  const investigation =
    scenario.investigation ??
    (await createInvestigation(
      runtime,
      scenario.resourceId,
      maxTasksOf(scenario),
    ));
  await send({ kind: 'investigation', ...investigation });
  if (scenario.mode === 'two-instances') {
    // Only the first instance admits, once the harness saw the second one ready.
    if (!scenario.investigation) {
      await go.promise;
      await admitTwoInstanceTasks(
        runtime,
        scenario,
        investigation.investigationId,
      );
    }
  } else {
    const unrelated =
      scenario.mode === 'cancel'
        ? await startUnrelatedInvestigation(runtime, scenario, cancelStarted)
        : undefined;
    await admitMissingSteps(runtime, scenario, investigation);
    // A repeated cancel after a restart changes nothing once the first one committed.
    if (unrelated) {
      await runtime.investigations.cancel(
        unrelated.investigationId,
        scenario.resourceId,
      );
    }
  }
  admitted.release();
  await send({ kind: 'admitted' });
}

main().catch((error: unknown) => {
  console.error('Runtime child failed', error);
  process.exit(1);
});
