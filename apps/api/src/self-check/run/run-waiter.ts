import { TaskStatusSchema } from '@agent-os/contracts';
import { researchTasks } from '@agent-os/db';
import {
  type InvestigationView,
  readRunRecord,
  type RunRecord,
} from '@agent-os/engine';
import type { Clock, StoredEvidence } from '@agent-os/runtime';
import { and, count, inArray } from 'drizzle-orm';
import { SELF_CHECK_OWNER } from '../../auth/system-owners.js';
import type { ScenarioAssembly } from '../scenario-assembly.js';

/** How often the program asks the engine for the status of a scenario's runs (design-self-check.md, C3 self-check). */
export const STATUS_POLL_MS = 5_000;

/**
 * The program's own safety margin past the controller task's total deadline (DC-9): a run still `running` this long
 * after the deadline, counted from its start, is cancelled and gets `timeout`.
 */
const TIMEOUT_MARGIN_MS = 10 * 60_000;

/** A task of these statuses may still run, so the scenario's queue is not empty while one is left. */
const UNFINISHED_TASK_STATUSES = [
  TaskStatusSchema.enum.queued,
  TaskStatusSchema.enum.waiting,
  TaskStatusSchema.enum.running,
] as const;

/** What the waiter needs from the scenario assembly; every read is the owner's (`system:self-check`). */
export interface RunWaiterPorts {
  /** The program clock: the run start, the deadline and the 5-second poll are measured on it. */
  readonly clock: Pick<Clock, 'now' | 'setTimer'>;
  /** `Engine.readInvestigation`: the status and the spend of the run. */
  readView(investigationId: string): Promise<InvestigationView>;
  /** One `readRunRecord`. */
  readRecord(investigationId: string): Promise<RunRecord>;
  /** One evidence page through the runtime's `EvidenceReader`. */
  readPage(evidenceId: string): Promise<StoredEvidence>;
  /** The runtime's investigation cancel. */
  cancel(investigationId: string): Promise<void>;
  /** The number of tasks of these investigations that are still queued, waiting or running. */
  unfinishedTasks(investigationIds: readonly string[]): Promise<number>;
}

export interface StartedRun {
  readonly investigationId: string;
  /** The program-clock moment the run was started. */
  readonly startedAt: Date;
}

export interface WaitScenarioRunsInput {
  /** All runs of one scenario, started at once. */
  readonly runs: readonly StartedRun[];
  /** The total deadline of the configuration's controller task (`limits.taskBudgets['research.controller']`). */
  readonly controllerDeadlineMs: number;
}

interface WaitedRunBase {
  readonly investigationId: string;
  /** The investigation's spend read after the scenario's queue emptied, so no task adds to it afterwards. */
  readonly usage: InvestigationView['usage'];
}

export type WaitedRun =
  | (WaitedRunBase & {
      /** The run reached a final status; it was read, then cancelled. */
      readonly outcome: 'finished';
      readonly record: RunRecord;
      /** Every evidence page of the run by evidence id. */
      readonly pages: ReadonlyMap<string, StoredEvidence>;
      /** `no_answer` when the run ended without an answer (DC-9); null when it has one. */
      readonly reason: 'no_answer' | null;
    })
  | (WaitedRunBase & {
      /** The run was still `running` past the controller deadline plus the margin; it was cancelled, then read. */
      readonly outcome: 'timeout';
      readonly record: RunRecord;
    });

type EndedRun =
  | Omit<Extract<WaitedRun, { outcome: 'finished' }>, 'usage'>
  | Omit<Extract<WaitedRun, { outcome: 'timeout' }>, 'usage'>;

const sleep = (clock: RunWaiterPorts['clock'], ms: number): Promise<void> =>
  new Promise((resolve) => {
    clock.setTimer(ms, resolve);
  });

/**
 * Waits for the runs of one scenario (design-self-check.md, C3 self-check, DC-9): every 5 seconds it reads
 * `InvestigationView.status` of each run not yet ended. A run with a final status is read with one `readRunRecord` and
 * its evidence pages, then cancelled, so its remaining tasks spend nothing. A run still `running` longer than the
 * controller deadline plus 10 minutes from its start is cancelled and ends with `timeout`. It returns, in the order of
 * `runs`, only when no task of the scenario is left in the queue, so the next scenario never starts beside them.
 * Decisions read statuses, the clock and whether an answer exists — never a text.
 */
export async function waitForScenarioRuns(
  ports: RunWaiterPorts,
  input: WaitScenarioRunsInput,
): Promise<readonly WaitedRun[]> {
  const timeoutAfterMs = input.controllerDeadlineMs + TIMEOUT_MARGIN_MS;
  const ended = new Map<string, EndedRun>();
  for (;;) {
    for (const run of input.runs) {
      if (ended.has(run.investigationId)) continue;
      const result = await pollRun(ports, run, timeoutAfterMs);
      if (result !== null) ended.set(run.investigationId, result);
    }
    if (ended.size === input.runs.length) break;
    await sleep(ports.clock, STATUS_POLL_MS);
  }

  const investigationIds = input.runs.map((run) => run.investigationId);
  while ((await ports.unfinishedTasks(investigationIds)) > 0) {
    await sleep(ports.clock, STATUS_POLL_MS);
  }

  const waited: WaitedRun[] = [];
  for (const run of input.runs) {
    const { usage } = await ports.readView(run.investigationId);
    waited.push({ ...ended.get(run.investigationId)!, usage });
  }
  return waited;
}

/** One poll of one run: its ending, or null while it keeps running within its time. */
async function pollRun(
  ports: RunWaiterPorts,
  run: StartedRun,
  timeoutAfterMs: number,
): Promise<EndedRun | null> {
  const { investigationId } = run;
  const { status } = await ports.readView(investigationId);
  if (status !== 'running') {
    const record = await ports.readRecord(investigationId);
    const pages = await readPages(ports, record);
    await ports.cancel(investigationId);
    return {
      investigationId,
      outcome: 'finished',
      record,
      pages,
      reason: record.answer === null ? 'no_answer' : null,
    };
  }
  if (ports.clock.now().getTime() - run.startedAt.getTime() > timeoutAfterMs) {
    await ports.cancel(investigationId);
    const record = await ports.readRecord(investigationId);
    return { investigationId, outcome: 'timeout', record };
  }
  return null;
}

async function readPages(
  ports: RunWaiterPorts,
  record: RunRecord,
): Promise<ReadonlyMap<string, StoredEvidence>> {
  const pages = new Map<string, StoredEvidence>();
  for (const { evidenceId } of record.evidence) {
    pages.set(evidenceId, await ports.readPage(evidenceId));
  }
  return pages;
}

/** The waiter's ports over one scenario assembly, for the owner `system:self-check`. */
export function scenarioWaiterPorts(
  assembly: ScenarioAssembly,
  clock: RunWaiterPorts['clock'],
): RunWaiterPorts {
  const { db } = assembly.database;
  return {
    clock,
    async readView(investigationId) {
      const result = await assembly.engine.readInvestigation({
        investigationId,
        resourceId: SELF_CHECK_OWNER,
      });
      if (result.outcome !== 'found')
        throw new Error(`Self-check run ${investigationId} not found`);
      return result.view;
    },
    async readRecord(investigationId) {
      const result = await readRunRecord(db, {
        investigationId,
        ownerId: SELF_CHECK_OWNER,
      });
      if (result.outcome !== 'found')
        throw new Error(`Self-check run ${investigationId} not found`);
      return result.record;
    },
    readPage: (evidenceId) =>
      assembly.runtime.evidence.get(evidenceId, SELF_CHECK_OWNER),
    cancel: (investigationId) =>
      assembly.runtime.investigations.cancel(investigationId, SELF_CHECK_OWNER),
    async unfinishedTasks(investigationIds) {
      if (investigationIds.length === 0) return 0;
      const [row] = await db
        .select({ unfinished: count() })
        .from(researchTasks)
        .where(
          and(
            inArray(researchTasks.investigationId, [...investigationIds]),
            inArray(researchTasks.status, [...UNFINISHED_TASK_STATUSES]),
          ),
        );
      return row?.unfinished ?? 0;
    },
  };
}
