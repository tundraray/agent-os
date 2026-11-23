// agent-platform / runtime E2E - Design Doc: docs/features/agent-platform/design-runtime.md (Test Strategy UC-2, UC-6, UC-7, UC-E1; Flows 1 and 2)
// PRD: docs/features/agent-platform/prd.md (FR-01 AC-01.1..AC-01.3; NFR-04, NFR-05). ADR-0001 (runtime owner: one transaction per transition, recovery of lost steps at the start).
// Test type: End-to-End (child processes running the runtime from source + real Postgres), CI job `e2e-runtime`.
// Counterpart in-process file: agent-platform-runtime.int.e2e-spec.ts (INT-1..INT-5). This file owns what an in-process test cannot do: a process that really dies between two writes.
//
// File name follows the project convention (`*.e2e-spec.ts` under packages/runtime/test, run with `pnpm --filter @agent-os/runtime test:e2e`: vitest.config.e2e.ts).
//
// The Given/When/Then comments are the rows' specification.
// How the rows run: the test process creates each tree through its own runtime (`RUNTIME_WORKERS=off`, the same handler types registered only to create tasks) and reads rows; children run the steps. A dying child registers only the
//   type it must crash on (C1's writer, unless the row says otherwise), so the pass number `:n` of `RUNTIME_CRASH_AT` counts that task's passes alone; the fresh child registers every type of the tree. The handlers are
//   test/support/runtimeChildHandlers.ts. The reference end state is a literal (`REFERENCE_END`); every kill row asserts the same literal, which is the comparison with the reference run. P's own step count depends on whether
//   the two child notices arrive in one step or two, so it is compared as "P's step rows are numbered 0 to stepNo" and not as a number.
//
// Environment (Design Doc "Test Strategy"):
// - Postgres 16 from infra/docker-compose.yml. Child-process harness (test/support/runtimeChild.ts): spawns the child (`test/support/runtimeChildMain.ts`, from source through `tsx`), which runs the packages with test handlers under unique task types, with
//   `RUNTIME_CRASH_AT=<point>[:n]` (never read under `NODE_ENV=production`), `RUNTIME_WORKERS=on`, short `RUNTIME_REAPER_MS`, `RUNTIME_POLL_MS`, `RUNTIME_MAX_RECOVERIES` 3. The crash is `process.exit(137)` from the point;
//   the harness reads the rows the dead child left, then starts a fresh child without `RUNTIME_CRASH_AT`.
// - The crash points are the old ones renamed for steps (Design Doc "Что сохраняется, меняется и уходит": `CrashPoints` kept, points renamed). Each is a named, test-only hook in the runtime: after the claim; after a `guard` write; before the step's
//   commit transaction; inside it, after the handler's rows and before the delivery marks; after it, before its log records; after a message enqueue, before the wake-up; after the sweeper's requeue. The plan fixes the exact names.
// - Isolation (project convention, no truncate): a unique `ownerId` (`newUser()`) and a unique task type per row; a row reads only its own tree.
// - "Resume within the PRD target" (NFR-05, 60 s) is the harness timeout of the wait for the end state; no latency is asserted (the latency is the on-demand script `test/verify/runtime-latency.verify.ts`, UC-N1).
// - No model, no network, no MCP. The "external action" of the guard row is a counter in a test double the handler calls.
//
// Budget: E2E 1 of 2 (the second slot is left free). E2E-1 is one journey - "a restart anywhere ends in the same state as an uninterrupted run" - with the rows below. Nothing below this level can prove it: a held in-process handler is still alive and may
//   write later, a dead process cannot. An in-process zombie proves the fence (INT-3), not the recovery.
//
// AC -> proving test: AC-01.1 (steps neither lost nor repeated), DC-1 (the commit as one), DC-2 (the next process redoes the lost step with the loss flag), AC-01.3 (a pending message delivered once across a restart), NFR-04 (restart half), NFR-05 = E2E-1 reference
//   and kill rows; AC-01.2 (the action is not repeated, the intent is seen) = row "guard"; DC-3 = row "recovery exhausted".

import type { Task } from '@agent-os/runtime';
import { afterAll, describe, expect, it } from 'vitest';
import { newUser } from '@agent-os/db/testing';
import { Children } from './support/runtimeChild';
import {
  type ChildTypes,
  EXTERNAL_NOTE,
  handlersFor,
  INTENT_NOTE,
  STEP_DONE,
  STEP_UNKNOWN,
} from './support/runtimeChildHandlers';
import {
  closeRuntimeDb,
  type HandlerRow,
  handlerRowsOf,
  inboxOf,
  recoveriesOf,
  statusesOf,
} from './support/runtimeDb';
import {
  createRuntimeHarness,
  type RuntimeHarness,
} from './support/runtimeHarness';
import { uniqueType } from './support/testHandlers';

/** NFR-05: the work interrupted by a restart resumes within 60 s — the harness timeout of the finish. */
const RESUME_TARGET_MS = 60_000;
const TEST_TIMEOUT_MS = 300_000;
/** `RUNTIME_MAX_RECOVERIES` of the kill-matrix settings (runtimeChild.ts). */
const MAX_RECOVERIES = 3;
/** Bound of the restart loops; each loop ends far earlier when the runtime is right. */
const MAX_STARTS = 10;

/** The message the test sends to C2 before the run. */
const NOTE_TO_READER = { text: 'hello C2' };

/**
 * The test process's own runtime: workers off, the tree's handler types registered only so that
 * `tasks.create` accepts them. It creates the trees, sends the messages, answers the questions.
 */
async function testRuntime(types: ChildTypes): Promise<RuntimeHarness> {
  const control = await createRuntimeHarness({
    handlers: [],
    config: { workers: false },
  });
  for (const handler of handlersFor(types, control.runtimeDb))
    control.handlers.register(handler);
  return control;
}

/** The tree of the reference run: P waits for C1 (writer, three steps) and C2 (reader, two steps). */
interface Tree {
  ownerId: string;
  parentId: string;
  writerId: string;
  readerId: string;
}

const treeTypes = (): Required<
  Pick<ChildTypes, 'parent' | 'writer' | 'reader'>
> => ({
  parent: uniqueType('e2e1-parent'),
  writer: uniqueType('e2e1-writer'),
  reader: uniqueType('e2e1-reader'),
});

/** Creates P, C1 and C2 in `queued` and sends C2 its message before any child runs. */
async function createTree(
  control: RuntimeHarness,
  types: ReturnType<typeof treeTypes>,
): Promise<Tree> {
  const ownerId = await newUser();
  const parentId = await control.tasks.create({
    type: types.parent,
    ownerId,
    input: { children: 2 },
  });
  const writerId = await control.tasks.create({
    type: types.writer,
    ownerId,
    input: { steps: 3 },
    parentId,
  });
  const readerId = await control.tasks.create({
    type: types.reader,
    ownerId,
    input: {},
    parentId,
  });
  await control.inbox.enqueue({
    recipientId: readerId,
    ownerId,
    kind: 'note',
    payload: NOTE_TO_READER,
  });
  return { ownerId, parentId, writerId, readerId };
}

type Role = 'parent' | 'writer' | 'reader';

const rolesOf = (tree: Tree): Record<Role, string> => ({
  parent: tree.parentId,
  writer: tree.writerId,
  reader: tree.readerId,
});

const isStepRow = (row: HandlerRow) => row.note?.startsWith('step:') ?? false;

/** Every task of the ids is `completed`. */
async function allCompleted(taskIds: readonly string[]): Promise<boolean> {
  const statuses = await statusesOf(taskIds);
  return taskIds.every((taskId) => statuses.get(taskId) === 'completed');
}

/** P's step rows (`children:<n>`): one per committed step of the parent. */
const isParentStepRow = (row: HandlerRow) =>
  row.note?.startsWith('children:') ?? false;

/** The end state of a tree, free of ids, comparable across runs (the plan's output comparison). */
interface EndState {
  statuses: Record<Role, string>;
  /** Step numbers of the committed step rows of the handler table. */
  stepRows: { writer: number[]; reader: number[] };
  stepNo: { writer: number; reader: number };
  /** P's step rows are numbered 0 to its step number: no step written twice or skipped. */
  parentRowsMatchStepNo: boolean;
  recoveries: Record<Role, number>;
  readerInbox: {
    kind: string;
    payload: unknown;
    delivered: boolean;
  }[];
  /** P's notices by child, each with its status. */
  parentInbox: {
    kind: string;
    child: string;
    delivered: boolean;
    childStatus: unknown;
  }[];
}

/** Steps of the run flagged `resumedAfterLoss` in their committed rows. */
type Flagged = { role: Role; stepNo: number }[];

async function endStateOf(
  control: RuntimeHarness,
  tree: Tree,
): Promise<{ end: EndState; flagged: Flagged }> {
  const roles = rolesOf(tree);
  const ids = Object.values(roles);
  const roleOf = (taskId: string): string =>
    (Object.keys(roles) as Role[]).find((role) => roles[role] === taskId) ??
    taskId;
  const tasks = await control.tasks.listTree(tree.parentId, tree.ownerId);
  const task = (role: Role): Task => {
    const found = tasks.find((candidate) => candidate.taskId === roles[role]);
    if (!found) throw new Error(`Task ${role} is missing from the tree`);
    return found;
  };
  const handlerRows = await handlerRowsOf(ids);
  const stepRows = handlerRows.filter(isStepRow);
  const parentStepNos = handlerRows
    .filter((row) => row.taskId === tree.parentId && isParentStepRow(row))
    .map((row) => row.stepNo);
  const stepsOf = (role: Role) =>
    stepRows
      .filter((row) => row.taskId === roles[role])
      .map((row) => row.stepNo);
  const recoveries = await recoveriesOf(ids);
  const parentInbox = await inboxOf(tree.parentId);
  const readerInbox = await inboxOf(tree.readerId);

  const end: EndState = {
    statuses: {
      parent: task('parent').status,
      writer: task('writer').status,
      reader: task('reader').status,
    },
    stepRows: { writer: stepsOf('writer'), reader: stepsOf('reader') },
    stepNo: { writer: task('writer').stepNo, reader: task('reader').stepNo },
    parentRowsMatchStepNo:
      parentStepNos.join() ===
      Array.from(
        { length: task('parent').stepNo },
        (_, stepNo) => stepNo,
      ).join(),
    recoveries: {
      parent: recoveries.get(tree.parentId) ?? -1,
      writer: recoveries.get(tree.writerId) ?? -1,
      reader: recoveries.get(tree.readerId) ?? -1,
    },
    readerInbox: readerInbox.map(({ kind, payload, delivered }) => ({
      kind,
      payload,
      delivered,
    })),
    parentInbox: parentInbox
      .map((message) => {
        const notice = message.payload as { taskId: string; status?: unknown };
        return {
          kind: message.kind,
          child: roleOf(notice.taskId),
          delivered: message.delivered,
          childStatus: notice.status,
        };
      })
      .sort((left, right) => left.child.localeCompare(right.child)),
  };
  const flagged = stepRows
    .filter((row) => row.resumedAfterLoss)
    .map((row) => ({ role: roleOf(row.taskId) as Role, stepNo: row.stepNo }));
  return { end, flagged };
}

/** The reference end state (no crash), fixed by assertion; every kill row ends in it too. */
const REFERENCE_END: EndState = {
  statuses: { parent: 'completed', writer: 'completed', reader: 'completed' },
  stepRows: { writer: [0, 1, 2], reader: [0, 1] },
  stepNo: { writer: 3, reader: 2 },
  parentRowsMatchStepNo: true,
  recoveries: { parent: 0, writer: 0, reader: 0 },
  readerInbox: [
    {
      kind: 'note',
      payload: { text: 'hello C2' },
      delivered: true,
    },
  ],
  parentInbox: [
    {
      kind: 'child_finished',
      child: 'reader',
      delivered: true,
      childStatus: 'completed',
    },
    {
      kind: 'child_finished',
      child: 'writer',
      delivered: true,
      childStatus: 'completed',
    },
  ],
};

/** Starts a fresh child of every type of the tree and waits for the tree to complete (NFR-05). */
async function finishTree(
  children: Children,
  types: ReturnType<typeof treeTypes>,
  tree: Tree,
): Promise<void> {
  const fresh = await children.start({ types });
  await fresh.until(() => allCompleted(Object.values(rolesOf(tree))), {
    what: 'the tree to complete after the restart',
    timeoutMs: RESUME_TARGET_MS,
  });
  await fresh.stop();
}

/** Committed step rows of one task: step numbers of the commits that happened. */
async function stepRowsOf(taskId: string): Promise<number[]> {
  return (await handlerRowsOf([taskId]))
    .filter(isStepRow)
    .map((row) => row.stepNo);
}

async function statusOf(taskId: string): Promise<string | undefined> {
  return (await statusesOf([taskId])).get(taskId);
}

/** One row of the kill matrix: where the dying child exits and what it leaves. */
interface KillRow {
  name: string;
  /** `RUNTIME_CRASH_AT` of the dying child, which registers only C1's type. */
  crashAt: string;
  /** Then children die at the sweeper's requeue until C1 is requeued (the second kill). */
  thenSweeperKill: boolean;
  /** C1's committed step rows the dead child left. */
  leftRows: number[];
  /** C1's status the dead child left. */
  leftStatus: string;
  /** C1's step that was lost and redone, flagged `resumedAfterLoss`; `null` when none was lost. */
  lostStep: number | null;
}

// C1's handler passes each point once per step (`step.inside-commit`: once per commit try), so `:2`
// is C1's step 1. Its first message is the notice of its last step, step 2.
const KILL_ROWS: KillRow[] = [
  {
    name: 'after the claim',
    crashAt: 'step.after-claim:2',
    thenSweeperKill: false,
    leftRows: [0],
    leftStatus: 'running',
    lostStep: 1,
  },
  {
    name: 'after a guard write',
    crashAt: 'step.after-guard:2',
    thenSweeperKill: false,
    leftRows: [0],
    leftStatus: 'running',
    lostStep: 1,
  },
  {
    name: 'before the commit',
    crashAt: 'step.before-commit:2',
    thenSweeperKill: false,
    leftRows: [0],
    leftStatus: 'running',
    lostStep: 1,
  },
  // One row for a crash anywhere inside a commit transaction — the handler's writes, the delivery
  // marks, the notice to the parent and its wake-up roll back together.
  {
    name: 'inside the commit (handler rows written, delivery marks not yet)',
    crashAt: 'step.inside-commit:2',
    thenSweeperKill: false,
    leftRows: [0],
    leftStatus: 'running',
    lostStep: 1,
  },
  {
    name: 'after the commit, before its log records',
    crashAt: 'step.after-commit:2',
    thenSweeperKill: false,
    leftRows: [0, 1],
    leftStatus: 'queued',
    lostStep: null,
  },
  {
    name: "after the sweeper's requeue (second kill)",
    crashAt: 'step.after-claim:2',
    thenSweeperKill: true,
    leftRows: [0],
    leftStatus: 'running',
    lostStep: 1,
  },
];

/**
 * Kills children at the sweeper's requeue until C1 is no longer `running`: a child's sweeper may
 * first requeue a stale row of another run in the shared database and die on it.
 */
async function killAtSweeperRequeue(
  children: Children,
  types: ReturnType<typeof treeTypes>,
  tree: Tree,
): Promise<void> {
  for (let start = 0; start < MAX_STARTS; start += 1) {
    const dying = await children.start({
      types: { writer: types.writer },
      crashAt: 'sweeper.after-requeue',
    });
    await dying.crashed();
    if ((await statusOf(tree.writerId)) !== 'running') return;
  }
  throw new Error(`C1 was not requeued by ${MAX_STARTS} sweeper kills`);
}

afterAll(closeRuntimeDb);

describe('agent-platform / runtime - E2E (real Postgres, child processes)', () => {
  // ---------------------------------------------------------------------------------------------------------------
  // E2E-1  Killing the runtime process at each commit point ends in the same state as an uninterrupted run
  // ---------------------------------------------------------------------------------------------------------------
  // User journey: an employee's agent tree (a parent task and two child tasks of several steps, one with a message waiting) is running when the server dies at a chosen point; after the server is started again the work finishes - every step recorded once,
  // every message delivered once, the parent told once - as if the server had never stopped.
  // Covers (original statements):
  // AC-01.1: "Given агент выполняет многошаговое задание, when сервер останавливают посреди работы и запускают снова, then агент продолжает и сдаёт отчёт, а в его истории нет потерянных и повторённых шагов."
  // AC-01.2: "Given изменяющее действие начато до остановки сервера, when сервер запускается снова, then действие не повторяется само, а в истории агента виден его результат или пометка «исход неизвестен»." (the runtime's share: the handler gets the loss flag and its own intent; the mark in the agent history is the `agents` part)
  // AC-01.3: "Given сообщение агенту ждало в очереди, when сервер перезапускается, then сообщение доставляется агенту один раз."
  // DC-2: "Если воркер умер посреди шага, другой экземпляр или перезапущенный сервер выполняет этот шаг заново, и обработчик видит, что прежняя попытка шага потеряна."
  // DC-3: "Если один и тот же шаг теряет процесс `RUNTIME_MAX_RECOVERIES` раз подряд, задача падает с причиной `recovery_exhausted`, и родитель получает уведомление."
  // DC-7: "Запрос решения переживает рестарт и решается один раз; повторное решение получает `already_resolved`."
  // NFR-05: "После запуска сервера прерванная рестартом работа возобновляется не позже чем через 60 с. Измеряется тестом с остановкой сервера посреди работы агента."
  // Use cases: UC-2, UC-6, UC-7, UC-E1 (and UC-E4's kill half). EARS: When. Design flow: Flow 2 (crash in the middle of a step and recovery), Flow 1 (commit), KD-2.
  //
  // Catches: a transaction boundary or guard wrong at exactly one point of the step - a handler row committed without its delivery marks (the message arrives twice), the marks without the rows (the step's work is lost and not redone), a retry that writes the step
  //   twice or repeats the external action, a lost-step flag the handler never sees, an open question or a pending message dropped by the restart, a step that kills its process forever and is requeued forever.
  // Behavior: perturbation (process killed at point P) -> a fresh process continues -> the end state equals the uninterrupted reference run; each effect counted once
  // @category: e2e
  // @dependency: full-system (a child process running DbModule + RuntimeModule through test/support/runtimeChildMain.ts: Dispatcher, Inbox, TaskControl, RecoverySweeper, CrashPoints; Postgres)
  // @complexity: high
  //
  // Verification items (table-driven by perturbation; every row compares its end state to the reference end state):
  // - Reference run (no crash): parent P waits for its children's reports; child C1 does three steps, each writing one row to a handler table through `commit`; child C2 does two steps and receives one message (sent by the test before the run) in its first step;
  //   both finish. End state fixed by assertion, not only by comparison: P, C1, C2 `completed`; C1's table holds rows 0, 1, 2 and C2's rows 0, 1; the message is `delivered` once with C2's first step number; P's inbox holds one `child_finished` per child; no task
  //   `running`, none `waiting` over a pending message.
  // - Rows by crash point (one child killed with exit code 137, then a fresh child started without `RUNTIME_CRASH_AT`; the row crashes on a step of C1):
  //     after the claim | after a `guard` write | before the commit | inside the commit (handler rows written, delivery marks not yet) | after the commit, before its log records |
  //     after the sweeper's requeue (second kill: the first death leaves a `running` task, the restarted child dies at the sweeper point, the third start finishes).
  //   After each row: the end state equals the reference; each step number appears once in the handler table (a step whose commit did not happen is redone, not duplicated); the redone step's context had `resumedAfterLoss` true (the handler table records the flag);
  //   the message is `delivered` exactly once, in order; each step commits once; `stepNo` has no gap; the loss counter of each task is back to 0 after the redone step commits; the work resumes within the harness timeout (NFR-05).
  // - Row "guard" (UC-7): the handler writes its intent through `guard`, then calls the external-action double, then the process is killed before the step commits. After the restart the step's context has `resumedAfterLoss` true; the handler finds the intent
  //   without a result and does not call the double again; the double was called exactly once in total; the step then commits with the outcome "unknown", which the test reads from the handler table.
  // - Row "recovery exhausted" (UC-E1): the step kills its process on every attempt (the crash point fires at every claim of that step). After `RUNTIME_MAX_RECOVERIES` lost attempts the task is `failed` with reason `recovery_exhausted`, the parent's inbox holds one
  //   `child_finished` with status `failed`, and no further claim of the step happens (a fresh child that does not crash leaves the task failed).
  it(
    'E2E-1 reference: the parent and two children of several steps finish with each step written once, the message delivered once and the parent told once',
    async () => {
      const types = treeTypes();
      const control = await testRuntime(types);
      const children = new Children();
      try {
        const tree = await createTree(control, types);

        await finishTree(children, types, tree);

        const { end, flagged } = await endStateOf(control, tree);
        expect(end).toEqual(REFERENCE_END);
        expect(flagged).toEqual([]);
        // Without a crash every step of C1 calls the external action once.
        const external = (await handlerRowsOf([tree.writerId]))
          .filter((row) => row.note === EXTERNAL_NOTE)
          .map((row) => row.stepNo);
        expect(external).toEqual([0, 1, 2]);
      } finally {
        await children.killAll();
        await control.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it.each(KILL_ROWS)(
    'E2E-1 kill $name: ends in the reference state with every step and message once',
    async (row) => {
      const types = treeTypes();
      const control = await testRuntime(types);
      const children = new Children();
      try {
        const tree = await createTree(control, types);

        // The dying child runs only C1, so `:n` counts C1's passes of the point.
        const dying = await children.start({
          types: { writer: types.writer },
          crashAt: row.crashAt,
        });
        await dying.crashed();
        // What the dead child left: a lost step has no row, a committed one has exactly one.
        expect(await stepRowsOf(tree.writerId)).toEqual(row.leftRows);
        expect(await statusOf(tree.writerId)).toBe(row.leftStatus);
        if (row.thenSweeperKill) {
          await killAtSweeperRequeue(children, types, tree);
          expect(await statusOf(tree.writerId)).toBe('queued');
          expect((await recoveriesOf([tree.writerId])).get(tree.writerId)).toBe(
            1,
          );
        }
        await finishTree(children, types, tree);

        const { end, flagged } = await endStateOf(control, tree);
        expect(end).toEqual(REFERENCE_END);
        expect(flagged).toEqual(
          row.lostStep === null
            ? []
            : [{ role: 'writer', stepNo: row.lostStep }],
        );
      } finally {
        await children.killAll();
        await control.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    "E2E-1 guard: after a kill between the intent and the step's commit the redone step sees the loss flag and the intent and does not repeat the external action",
    async () => {
      const types = treeTypes();
      const control = await testRuntime(types);
      const children = new Children();
      try {
        const tree = await createTree(control, types);
        const rowsOfWriter = async (note: string) =>
          (await handlerRowsOf([tree.writerId]))
            .filter((row) => row.note === note)
            .map((row) => row.stepNo);

        // C1's step 1: intent through `guard`, the external action, then the kill before the commit.
        const dying = await children.start({
          types: { writer: types.writer },
          crashAt: 'step.before-commit:2',
        });
        await dying.crashed();
        expect(await rowsOfWriter(INTENT_NOTE)).toEqual([0, 1]);
        expect(await rowsOfWriter(EXTERNAL_NOTE)).toEqual([0, 1]);
        expect(await stepRowsOf(tree.writerId)).toEqual([0]);

        await finishTree(children, types, tree);

        const stepRows = (await handlerRowsOf([tree.writerId]))
          .filter(isStepRow)
          .map(({ stepNo, resumedAfterLoss, note }) => ({
            stepNo,
            resumedAfterLoss,
            note,
          }));
        expect(stepRows).toEqual([
          { stepNo: 0, resumedAfterLoss: false, note: STEP_DONE },
          { stepNo: 1, resumedAfterLoss: true, note: STEP_UNKNOWN },
          { stepNo: 2, resumedAfterLoss: false, note: STEP_DONE },
        ]);
        // The action of step 1 happened once, in the dead process; the redone step found the intent.
        expect(await rowsOfWriter(EXTERNAL_NOTE)).toEqual([0, 1, 2]);
        expect(await rowsOfWriter(INTENT_NOTE)).toEqual([0, 1, 2]);
        expect((await endStateOf(control, tree)).end).toEqual(REFERENCE_END);
      } finally {
        await children.killAll();
        await control.close();
      }
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'E2E-1 recovery exhausted: a step that kills its process every time fails the task with recovery_exhausted after the permitted losses and tells the parent once',
    async () => {
      const types = {
        parent: uniqueType('e2e1-parent'),
        writer: uniqueType('e2e1-killer'),
      };
      const control = await testRuntime(types);
      const children = new Children();
      try {
        const ownerId = await newUser();
        const parentId = await control.tasks.create({
          type: types.parent,
          ownerId,
          input: { children: 1 },
        });
        const killerId = await control.tasks.create({
          type: types.writer,
          ownerId,
          input: { steps: 3 },
          parentId,
        });

        // Each child dies at its first claim; once the sweeper has failed the task, a child no
        // longer claims it and lives.
        let crashes = 0;
        let failedWhileAlive = false;
        for (
          let start = 0;
          start < MAX_STARTS && !failedWhileAlive;
          start += 1
        ) {
          const child = await children.start({
            types: { writer: types.writer },
            crashAt: 'step.after-claim',
          });
          const end = await child.untilOrExit(
            async () => (await statusOf(killerId)) === 'failed',
            {
              what: 'its crash or the failure of the task',
              timeoutMs: RESUME_TARGET_MS,
            },
          );
          if (end === 'exited') {
            await child.crashed();
            crashes += 1;
          } else {
            await child.stop();
            failedWhileAlive = true;
          }
        }
        expect(failedWhileAlive).toBe(true);

        // A fresh child that does not crash lets P take the notice and leaves the task failed.
        const fresh = await children.start({ types });
        await fresh.until(() => allCompleted([parentId]), {
          what: 'the parent to complete',
          timeoutMs: RESUME_TARGET_MS,
        });
        await fresh.stop();

        // The step was lost `RUNTIME_MAX_RECOVERIES` times and requeued, then lost once more.
        expect(crashes).toBe(MAX_RECOVERIES + 1);
        const killer = await control.tasks.get(killerId, ownerId);
        expect(killer.status).toBe('failed');
        expect(killer.failure?.reason).toBe('recovery_exhausted');
        expect(killer.stepNo).toBe(0);
        expect(await stepRowsOf(killerId)).toEqual([]);
        const notices = (await inboxOf(parentId)).map((message) => ({
          kind: message.kind,
          child: (message.payload as { taskId?: unknown }).taskId,
          delivered: message.delivered,
          childStatus: (message.payload as { status?: unknown }).status,
        }));
        expect(notices).toEqual([
          {
            kind: 'child_finished',
            child: killerId,
            delivered: true,
            childStatus: 'failed',
          },
        ]);
        expect(await statusOf(parentId)).toBe('completed');
      } finally {
        await children.killAll();
        await control.close();
      }
    },
    TEST_TIMEOUT_MS,
  );
});
