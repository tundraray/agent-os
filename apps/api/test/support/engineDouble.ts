import type { EvidenceInput } from '@agent-os/contracts';
import type {
  Engine,
  InvestigationView,
  ReadInvestigationResult,
  SourceMode,
  StartInvestigationInput,
  StartInvestigationResult,
} from '@agent-os/engine';
import type {
  HandlerResult,
  Runtime,
  TaskContext,
  TaskHandler,
} from '@agent-os/runtime';
import {
  completed,
  type Latch,
  latch,
  query,
  taskSpec,
  testHandler,
  uniqueWorkflowType,
} from './wiring-handlers.js';

/**
 * The engine port double of the chat-entry integration file (design-chat-entry.md, Test Strategy): the engine's
 * contract (design-engine.md, Contract Definitions) is the boundary, the runtime under it is real. A start creates a
 * real investigation of the thread whose controller task is a test handler held until the test settles it; a read
 * answers a scripted `InvestigationView`. Nothing here talks to a model or a source.
 */

/** Workflow types of the double's controller tasks; the leftover fence of the harness finds them by it. */
export const DOUBLE_CONTROLLER_PREFIX = 'chat-entry-controller';

/** The answer of a view (`InvestigationView.answer` once answered). */
export type ScriptedAnswer = NonNullable<InvestigationView['answer']>;

/** A scripted refusal of a start: the engine's own refusal, or an exception of the call. */
export type StartRefusal =
  Extract<StartInvestigationResult, { outcome: 'rejected' }> | Error;

/** How the controller task succeeds. */
export interface ControllerSuccess {
  /** Evidence the controller stores first, through the real runtime (a sourced answer cites it). */
  evidence?: readonly EvidenceInput[];
  /** The view's answer, built from the ids of `evidence` in the same order. */
  answer: (evidenceIds: readonly string[]) => ScriptedAnswer;
}

/** A start the double accepted. */
export interface StartedInvestigation {
  input: StartInvestigationInput;
  investigationId: string;
  controllerTaskId: string;
  /** The double's `sourceMode` at the start, kept by the view for good (DC-16 of the engine). */
  sourceMode: SourceMode;
}

/** Investigations are created with these runtime budgets; the controller is the only task. */
const INVESTIGATION_BUDGET = { maxTasks: 10, maxToolCalls: 20 } as const;
/** The view's `tokenBudget` of a start without one (the engine would take its configuration's default). */
const DEFAULT_TOKEN_BUDGET = 200_000;
const REQUESTER_KEY = 'chat-entry-engine-double';
const PROCESS_ID = 'deep-research';

type ControllerOutcome =
  | { kind: 'succeed'; success: ControllerSuccess }
  | { kind: 'fail'; message: string };

interface InvestigationRecord {
  readonly started: StartedInvestigation;
  readonly resourceId: string;
  /** Resolves when the controller attempt runs (the handler was entered). */
  readonly running: Latch;
  readonly outcome: Promise<ControllerOutcome>;
  settle(outcome: ControllerOutcome): void;
  /** The handler was entered and has not returned: a controller attempt is held. */
  held: boolean;
  /** The handler returned (the attempt ended), or the harness already cancelled the investigation. */
  done: boolean;
  /** The scripted answer, stored when the controller succeeds; the view shows it once the task is `succeeded`. */
  answer: ScriptedAnswer | null;
}

/** Final statuses of the controller task, as the engine maps them (design-engine.md, InvestigationView). */
const TERMINAL_STATUSES: Readonly<Record<string, InvestigationView['status']>> =
  {
    succeeded: 'completed',
    failed: 'failed',
    cancelled: 'cancelled',
  };

export interface EngineDouble extends Engine {
  /** The handler of the double's controller tasks; the harness registers it before the workers start. */
  readonly controllerHandler: TaskHandler;
  /** Every `startInvestigation` input in call order, refused ones included. */
  readonly startCalls: readonly StartInvestigationInput[];
  /** Accepted starts in call order. */
  readonly started: readonly StartedInvestigation[];
  /** The mode of the next starts and of `sourceMode` (the stand-in for a restart with another set of sources). */
  setSourceMode(mode: SourceMode): void;
  /** Holds every start until the returned latch is released: the launch row stays `launching`. */
  holdStarts(): Latch;
  /** Refuses the following starts with `refusal`; `null` accepts them again. */
  refuseStarts(refusal: StartRefusal | null): void;
  /** Resolves once the controller attempt of the investigation is running. */
  controllerRunning(investigationId: string): Promise<void>;
  /** The controller stores the evidence and succeeds; the view shows the answer once the task row is `succeeded`. */
  succeed(investigationId: string, success: ControllerSuccess): void;
  /** The controller task fails (`TaskFailed`). */
  fail(investigationId: string, message?: string): void;
  /**
   * Starts whose controller has not ended and that were not taken before: the harness cancels their investigations
   * after each test.
   */
  takeUnsettled(): StartedInvestigation[];
  /** Whether a controller attempt is held right now (entered, not returned): moving the clock would fake a lease expiry. */
  hasRunningController(): boolean;
  /**
   * `EngineModule.onModuleInit` binds the engine it creates to the provider this double replaces; the double keeps
   * answering by itself and ignores it.
   */
  bind(engine: Engine): void;
  /**
   * Releases the start latch, waits until every start in flight has settled (its errors ignored), then goes back to the
   * initial mode, accepting starts, with the call records emptied: a held start never lands after the reset.
   */
  reset(): Promise<void>;
}

/** Resolves when `signal` aborts (the runtime cancelled the attempt). */
function whenAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

function failedResult(message: string, attempt: number): HandlerResult {
  return {
    ...completed(),
    kind: 'failed',
    failure: {
      class: 'internal',
      code: 'engine_double_failure',
      message,
      cause: null,
      attempt,
      toolCalls: 0,
      retries: 0,
    },
  };
}

/**
 * A double over the real runtime: `runtime` gives it `InvestigationService.create` and `TaskScheduler.propose`, the
 * same ports the engine starts an investigation with.
 */
export function createEngineDouble(
  runtime: () => Pick<Runtime, 'investigations' | 'scheduler'>,
  initialSourceMode: SourceMode,
): EngineDouble {
  const workflowType = uniqueWorkflowType(DOUBLE_CONTROLLER_PREFIX);
  const records = new Map<string, InvestigationRecord>();
  const byLaunchKey = new Map<string, StartedInvestigation>();
  const startCalls: StartInvestigationInput[] = [];
  const started: StartedInvestigation[] = [];
  let sourceMode = initialSourceMode;
  let startGate: Latch | null = null;
  let refusal: StartRefusal | null = null;
  const inFlight = new Set<Promise<StartInvestigationResult>>();

  const recordOf = (investigationId: string): InvestigationRecord => {
    const record = records.get(investigationId);
    if (!record) {
      throw new Error(
        `engine double: investigation ${investigationId} was not started by the double`,
      );
    }
    return record;
  };

  async function runController(ctx: TaskContext): Promise<HandlerResult> {
    const record = recordOf(ctx.investigationId);
    record.held = true;
    record.running.release();
    try {
      const outcome = await Promise.race([
        record.outcome,
        whenAborted(ctx.signal).then(() => null),
      ]);
      if (outcome === null) return failedResult('cancelled', ctx.attempt);
      if (outcome.kind === 'fail') {
        return failedResult(outcome.message, ctx.attempt);
      }
      const evidenceIds: string[] = [];
      for (const evidence of outcome.success.evidence ?? []) {
        evidenceIds.push((await ctx.putEvidence(evidence)).evidenceId);
      }
      record.answer = outcome.success.answer(evidenceIds);
      return completed({ evidenceRefs: evidenceIds });
    } finally {
      record.held = false;
      record.done = true;
    }
  }

  async function createInvestigation(
    input: StartInvestigationInput,
  ): Promise<StartedInvestigation> {
    const { investigations, scheduler } = runtime();
    const { investigationId } = await investigations.create({
      resourceId: input.resourceId,
      threadId: input.threadId,
      query: input.query,
      budget: INVESTIGATION_BUDGET,
    });
    const proposed = await scheduler.propose(
      taskSpec({ investigationId, workflowType, input: {} }),
      REQUESTER_KEY,
    );
    if (proposed.outcome !== 'created') {
      throw new Error(
        `engine double: controller task refused: ${JSON.stringify(proposed)}`,
      );
    }
    return {
      input,
      investigationId,
      controllerTaskId: proposed.taskId,
      sourceMode,
    };
  }

  function track(start: StartedInvestigation): void {
    let settle: (outcome: ControllerOutcome) => void = () => undefined;
    const outcome = new Promise<ControllerOutcome>((resolve) => {
      settle = resolve;
    });
    records.set(start.investigationId, {
      started: start,
      resourceId: start.input.resourceId,
      running: latch(),
      outcome,
      settle,
      held: false,
      done: false,
      answer: null,
    });
    byLaunchKey.set(
      `${start.input.resourceId}:${start.input.launchKey}`,
      start,
    );
    started.push(start);
  }

  /**
   * The view's status from the real rows, as the engine derives it: the controller task's final status decides;
   * until it ends, an active investigation is `running` and any other `cancelled`. `undefined` when the owner's
   * investigation row is gone or belongs to someone else.
   */
  async function statusOf(
    record: InvestigationRecord,
    resourceId: string,
  ): Promise<InvestigationView['status'] | undefined> {
    const [row] = await query<{
      investigationStatus: string;
      taskStatus: string | null;
    }>(
      `SELECT i.status AS "investigationStatus", t.status AS "taskStatus"
         FROM app.research_investigations i
         LEFT JOIN app.research_tasks t ON t.task_id = $3
        WHERE i.investigation_id = $1 AND i.resource_id = $2`,
      [
        record.started.investigationId,
        resourceId,
        record.started.controllerTaskId,
      ],
    );
    if (!row) return undefined;
    const final =
      row.taskStatus === null ? undefined : TERMINAL_STATUSES[row.taskStatus];
    if (final) return final;
    return row.investigationStatus === 'active' ? 'running' : 'cancelled';
  }

  async function start(
    input: StartInvestigationInput,
  ): Promise<StartInvestigationResult> {
    startCalls.push(input);
    await startGate?.promise;
    if (refusal instanceof Error) throw refusal;
    if (refusal !== null) return refusal;
    // A repeated start with the same launch key returns the recorded investigation, as the engine does.
    const recorded = byLaunchKey.get(`${input.resourceId}:${input.launchKey}`);
    if (recorded) {
      return {
        outcome: 'existing',
        investigationId: recorded.investigationId,
        controllerTaskId: recorded.controllerTaskId,
      };
    }
    const created = await createInvestigation(input);
    track(created);
    return {
      outcome: 'created',
      investigationId: created.investigationId,
      controllerTaskId: created.controllerTaskId,
    };
  }

  const view = (
    record: InvestigationRecord,
    status: InvestigationView['status'],
  ): InvestigationView => ({
    investigationId: record.started.investigationId,
    status,
    controllerTaskId: record.started.controllerTaskId,
    processId: PROCESS_ID,
    version: 1,
    sourceMode: record.started.sourceMode,
    answer: status === 'completed' ? record.answer : null,
    usage: {
      byRoleAndModel: [],
      totalTokens: 0,
      totalCostUsd: 0,
      tokenBudget: record.started.input.tokenBudget ?? DEFAULT_TOKEN_BUDGET,
    },
  });

  return {
    get sourceMode() {
      return sourceMode;
    },
    controllerHandler: testHandler(workflowType, runController),
    startCalls,
    started,

    startInvestigation(input) {
      const pending = start(input);
      inFlight.add(pending);
      void pending.then(
        () => inFlight.delete(pending),
        () => inFlight.delete(pending),
      );
      return pending;
    },

    async readInvestigation({ investigationId, resourceId }) {
      const notFound: ReadInvestigationResult = {
        outcome: 'rejected',
        code: 'investigation_not_found',
      };
      const record = records.get(investigationId);
      if (record === undefined) return notFound;
      const status = await statusOf(record, resourceId);
      return status === undefined
        ? notFound
        : { outcome: 'found', view: view(record, status) };
    },

    recordSignal() {
      return Promise.reject(
        new Error(
          'engine double: recordSignal is not part of the chat-entry boundary',
        ),
      );
    },

    setSourceMode(mode) {
      sourceMode = mode;
    },

    holdStarts() {
      startGate?.release();
      startGate = latch();
      return startGate;
    },

    refuseStarts(next) {
      refusal = next;
    },

    controllerRunning: (investigationId) =>
      recordOf(investigationId).running.promise,

    succeed(investigationId, success) {
      recordOf(investigationId).settle({ kind: 'succeed', success });
    },

    fail(investigationId, message = 'scripted controller failure') {
      recordOf(investigationId).settle({ kind: 'fail', message });
    },

    takeUnsettled: () =>
      [...records.values()]
        .filter((record) => !record.done)
        .map((record) => {
          record.done = true;
          return record.started;
        }),

    hasRunningController: () =>
      [...records.values()].some((record) => record.held),

    bind: () => undefined,

    async reset() {
      startGate?.release();
      await Promise.allSettled(inFlight);
      startGate = null;
      refusal = null;
      sourceMode = initialSourceMode;
      startCalls.length = 0;
      started.length = 0;
    },
  };
}
