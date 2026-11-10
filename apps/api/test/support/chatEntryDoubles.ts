import {
  buildResearchAnswer,
  type Engine,
  type InvestigationView,
  type ReadAnswerMessageResult,
  type ReadInvestigationResult,
  type StartInvestigationInput,
  type StartInvestigationResult,
} from '@agent-os/engine';
import type {
  EventConsumer,
  HandlerResult,
  Runtime,
  TaskContext,
  TaskHandler,
} from '@agent-os/runtime';
import type { Memory } from '@mastra/memory';
import type pg from 'pg';
import { doubleLifecycleConsumer, viewStatusOf } from './engineDouble.js';
import {
  completed,
  type Latch,
  latch,
  taskSpec,
  testHandler,
} from './wiring-handlers.js';

/**
 * The doubles of the chat-entry child process (E2E-1, design-chat-entry.md Test Strategy) and its crash points. The
 * child is a process that dies and is started again, so nothing a double answers lives in its memory: the engine port
 * double keeps what it started in the runtime's rows (the launch key in the controller task's input) and reads it back
 * from them, so a restarted process answers for the investigation the dead one started.
 *
 * The part's crash points live here, in test code, never in `src` or in the runtime's closed `RUNTIME_CRASH_AT` list
 * (the runtime's contract does not change): `CHAT_ENTRY_CRASH_AT=<point>[:n]`, not read under `NODE_ENV=production`,
 * ends the process with code 137 —
 * - `chat-entry.launch.after-launching` at the `n`-th `Engine.startInvestigation` call, i.e. after the launch row was
 *   written `launching` and before the investigation exists (Flow 1, Flow 2);
 * - `chat-entry.append.after-save` right after the `n`-th `saveMessages` of a `research-answer-*` message resolved, i.e.
 *   before the row is marked `answered` (Flow 3, NFR-03, UC-5).
 */

export const CHAT_ENTRY_CRASH_POINTS = [
  'chat-entry.launch.after-launching',
  'chat-entry.append.after-save',
] as const;
export type ChatEntryCrashPoint = (typeof CHAT_ENTRY_CRASH_POINTS)[number];

/** Exit code of a crash: the code of a process killed by SIGKILL, as the runtime's `CrashPoints` exit. */
export const CRASH_EXIT_CODE = 137;

const CRASH_AT_FORMAT = /^([a-z.-]+)(?::(\d+))?$/;

/** The process's crash point, counting its passes; a no-op when unset or under `NODE_ENV=production`. */
export function crashPoint(
  raw: string | undefined,
  nodeEnv: string | undefined,
): (point: ChatEntryCrashPoint) => void {
  if (nodeEnv === 'production' || raw === undefined || raw === '') {
    return () => undefined;
  }
  const match = CRASH_AT_FORMAT.exec(raw);
  const point = match?.[1];
  if (
    match === null ||
    !(CHAT_ENTRY_CRASH_POINTS as readonly (string | undefined)[]).includes(
      point,
    )
  ) {
    throw new Error(
      `Invalid CHAT_ENTRY_CRASH_AT "${raw}": expected <point>[:n] with a point of ${CHAT_ENTRY_CRASH_POINTS.join(', ')}`,
    );
  }
  const pass = match[2] === undefined ? 1 : Number(match[2]);
  if (pass < 1) {
    throw new Error(
      `Invalid CHAT_ENTRY_CRASH_AT "${raw}": the pass number starts at 1`,
    );
  }
  let passes = 0;
  return (hit) => {
    if (hit !== point) return;
    passes += 1;
    if (passes === pass) process.exit(CRASH_EXIT_CODE);
  };
}

/** Messages of the child to the harness (IPC). */
export interface ReadyMessage {
  readonly kind: 'ready';
  /** The port the api listens on (the child binds port 0). */
  readonly port: number;
}

/** Messages of the harness to the child (IPC). */
export type HarnessMessage =
  | { readonly kind: 'release'; readonly investigationId: string }
  | { readonly kind: 'stop' };

// -------------------------------------------------------------------------------------------
// Engine port double
// -------------------------------------------------------------------------------------------

/** Workflow type of the double's controller tasks: the same in every process, so a restart finds them. */
const CONTROLLER_WORKFLOW = 'test-chat-entry-controller-e2e';
const REQUESTER_KEY = 'chat-entry-e2e-engine-double';
const PROCESS_ID = 'deep-research';
const INVESTIGATION_BUDGET = { maxTasks: 10, maxToolCalls: 20 } as const;
/** The view's `tokenBudget` of a start without one (the engine would take its configuration's default). */
const DEFAULT_TOKEN_BUDGET = 300_000;
/** The text of the answer's one claim; the answer is a function of the investigation id only. */
const ANSWER_CLAIM = 'Платежи падали из-за просроченного сертификата.';

export interface ChildEngine extends Engine {
  /** The handler of the controller tasks; registered before the workers start. */
  readonly controllerHandler: TaskHandler;
  /** Closes the investigation when its controller task ends, as `engine.lifecycle`; registered before the workers start. */
  readonly lifecycleConsumer: EventConsumer;
  /** Lets the controller of the investigation succeed (the harness's IPC `release`), now or once it runs. */
  release(investigationId: string): void;
  /** `EngineModule.onModuleInit` binds the real engine to the provider this double replaces; it is ignored. */
  bind(engine: Engine): void;
}

interface ControllerRow {
  investigationId: string;
  taskId: string;
  investigationStatus: string;
  tokenBudget: string;
  launchKey: string;
  query: string;
}

function whenAborted(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

/**
 * The engine port over the real runtime, as the engine starts an investigation: `InvestigationService.create`, then one
 * controller task through `TaskScheduler.propose`. A start with a launch key that already has a controller task of
 * the user answers `existing` with it (the engine's idempotence by `launchKey`); the controller task is held until the
 * harness releases it, then succeeds, and `lifecycleConsumer` closes the investigation as `engine.lifecycle` does; a read
 * derives the view's status from the investigation row, with a fixed answer of the no-source mode, and
 * `readAnswerMessage` the message the engine's `buildResearchAnswer` builds from that answer once it is `completed`.
 */
export function createChildEngine(deps: {
  runtime: Pick<Runtime, 'investigations' | 'scheduler'>;
  pool: pg.Pool;
  hit: (point: ChatEntryCrashPoint) => void;
}): ChildEngine {
  const { runtime, pool, hit } = deps;
  const releases = new Map<string, Latch>();
  const releaseOf = (investigationId: string): Latch => {
    let gate = releases.get(investigationId);
    if (gate === undefined) {
      gate = latch();
      releases.set(investigationId, gate);
    }
    return gate;
  };

  const controllerOf = async (
    where: string,
    values: unknown[],
  ): Promise<ControllerRow | undefined> => {
    const { rows } = await pool.query<ControllerRow>(
      `SELECT i.investigation_id AS "investigationId", t.task_id AS "taskId",
              i.status AS "investigationStatus",
              t.input->>'tokenBudget' AS "tokenBudget",
              t.input->>'launchKey' AS "launchKey", i.query
         FROM app.research_investigations i
         JOIN app.research_tasks t
           ON t.investigation_id = i.investigation_id AND t.workflow_type = $1
        WHERE ${where}`,
      [CONTROLLER_WORKFLOW, ...values],
    );
    return rows[0];
  };

  async function start(
    input: StartInvestigationInput,
  ): Promise<StartInvestigationResult> {
    hit('chat-entry.launch.after-launching');
    const recorded = await controllerOf(
      `i.resource_id = $2 AND t.input->>'launchKey' = $3`,
      [input.resourceId, input.launchKey],
    );
    if (recorded) {
      return {
        outcome: 'existing',
        investigationId: recorded.investigationId,
        controllerTaskId: recorded.taskId,
      };
    }
    const { investigationId } = await runtime.investigations.create({
      resourceId: input.resourceId,
      threadId: input.threadId,
      query: input.query,
      budget: INVESTIGATION_BUDGET,
    });
    const proposed = await runtime.scheduler.propose(
      taskSpec({
        investigationId,
        workflowType: CONTROLLER_WORKFLOW,
        input: {
          launchKey: input.launchKey,
          tokenBudget: String(input.tokenBudget ?? DEFAULT_TOKEN_BUDGET),
        },
      }),
      REQUESTER_KEY,
    );
    if (proposed.outcome !== 'created') {
      throw new Error(
        `engine double: controller task refused: ${JSON.stringify(proposed)}`,
      );
    }
    return {
      outcome: 'created',
      investigationId,
      controllerTaskId: proposed.taskId,
    };
  }

  async function runController(ctx: TaskContext): Promise<HandlerResult> {
    const released = await Promise.race([
      releaseOf(ctx.investigationId).promise.then(() => true),
      whenAborted(ctx.signal).then(() => false),
    ]);
    if (released) return completed();
    return {
      ...completed(),
      kind: 'failed',
      failure: {
        class: 'internal',
        code: 'engine_double_cancelled',
        message: 'cancelled',
        cause: null,
        attempt: ctx.attempt,
        toolCalls: 0,
        retries: 0,
      },
    };
  }

  const answerOf = (row: ControllerRow) => ({
    answerId: `answer-${row.investigationId}`,
    outcome: 'answered' as const,
    stopReason: null,
    summary: null,
    established: [],
    assumed: [
      {
        claimId: 'c1',
        text: ANSWER_CLAIM,
        evidenceIds: [],
        verified: false,
      },
    ],
    unknown: [],
    removed: [],
  });

  const view = (
    row: ControllerRow,
    status: InvestigationView['status'],
  ): InvestigationView => ({
    investigationId: row.investigationId,
    status,
    controllerTaskId: row.taskId,
    processId: PROCESS_ID,
    version: 1,
    sourceMode: 'model_knowledge',
    answer: status === 'completed' ? answerOf(row) : null,
    usage: {
      byRoleAndModel: [],
      totalTokens: 0,
      totalCostUsd: 0,
      tokenBudget: Number(row.tokenBudget),
    },
  });

  return {
    sourceMode: 'model_knowledge',
    controllerHandler: testHandler(CONTROLLER_WORKFLOW, runController),
    lifecycleConsumer: doubleLifecycleConsumer(
      runtime.investigations,
      (workflowType) => workflowType === CONTROLLER_WORKFLOW,
    ),
    startInvestigation: start,
    async readInvestigation({
      investigationId,
      resourceId,
    }): Promise<ReadInvestigationResult> {
      const row = await controllerOf(
        'i.investigation_id = $2 AND i.resource_id = $3',
        [investigationId, resourceId],
      );
      if (row === undefined) {
        return { outcome: 'rejected', code: 'investigation_not_found' };
      }
      return {
        outcome: 'found',
        view: view(row, viewStatusOf(row.investigationStatus)),
      };
    },
    async readAnswerMessage({
      investigationId,
      resourceId,
    }): Promise<ReadAnswerMessageResult> {
      const row = await controllerOf(
        'i.investigation_id = $2 AND i.resource_id = $3',
        [investigationId, resourceId],
      );
      if (row === undefined) {
        return { outcome: 'rejected', code: 'investigation_not_found' };
      }
      if (viewStatusOf(row.investigationStatus) !== 'completed') {
        return { outcome: 'rejected', code: 'no_answer' };
      }
      return {
        outcome: 'found',
        message: buildResearchAnswer({
          answer: answerOf(row),
          goal: row.query,
          launchKey: row.launchKey,
          sourceMode: 'model_knowledge',
          pages: new Map(),
        }),
      };
    },
    assess: () =>
      Promise.reject(
        new Error(
          'engine double: assess is not part of the chat-entry boundary',
        ),
      ),
    writeDefinitionMemory: () =>
      Promise.reject(
        new Error(
          'engine double: writeDefinitionMemory is not part of the chat-entry boundary',
        ),
      ),
    removeDefinitionMemory: () =>
      Promise.reject(
        new Error(
          'engine double: removeDefinitionMemory is not part of the chat-entry boundary',
        ),
      ),
    listDefinitionMemory: () =>
      Promise.reject(
        new Error(
          'engine double: listDefinitionMemory is not part of the chat-entry boundary',
        ),
      ),
    readAgentTree: () =>
      Promise.reject(
        new Error(
          'engine double: readAgentTree is not part of the chat-entry boundary',
        ),
      ),
    assessAgent: () =>
      Promise.reject(
        new Error(
          'engine double: assessAgent is not part of the chat-entry boundary',
        ),
      ),
    checkCalibration: () =>
      Promise.reject(
        new Error(
          'engine double: checkCalibration is not part of the chat-entry boundary',
        ),
      ),
    release: (investigationId) => releaseOf(investigationId).release(),
    bind: () => undefined,
  };
}

// -------------------------------------------------------------------------------------------
// Thread memory wrapper
// -------------------------------------------------------------------------------------------

const ANSWER_MESSAGE_PREFIX = 'research-answer-';

/** Wraps `saveMessages` of the threads' `Memory` in place: a saved answer message passes the append crash point. */
export function crashAfterAnswerSave(
  memory: Memory,
  hit: (point: ChatEntryCrashPoint) => void,
): Memory {
  const save = memory.saveMessages.bind(memory);
  memory.saveMessages = async (args) => {
    const saved = await save(args);
    if (
      args.messages.some((message) =>
        message.id.startsWith(ANSWER_MESSAGE_PREFIX),
      )
    ) {
      hit('chat-entry.append.after-save');
    }
    return saved;
  };
  return memory;
}
