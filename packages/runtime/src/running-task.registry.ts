import type { StepSignalReason } from './handler.registry.js';

/** One step executing in this process. */
export interface RunningStepHandle {
  /** Aborted with a {@link StepSignalReason} as `signal.reason`; the first abort wins. */
  readonly signal: AbortSignal;
  abort(reason: StepSignalReason): void;
  /** The step is over: its last write is done. Idempotent. */
  release(): void;
}

interface RunningStep {
  taskId: string;
  /** The attempt that claimed the step. */
  attempt: number;
  controller: AbortController;
  /** Resolves on the first `release()`. */
  released: Promise<void>;
}

/**
 * Steps executing in this process, by task. A cut-off step may still run beside the next step of
 * the same task (Invariant 1), so a task can hold more than one entry. Process-local: a step on
 * another instance learns about an interrupt through NOTIFY or its heartbeat.
 */
export class RunningTaskRegistry {
  private readonly running = new Map<string, Set<RunningStep>>();

  register(step: { taskId: string; attempt: number }): RunningStepHandle {
    const controller = new AbortController();
    let markReleased: () => void = () => undefined;
    const entry: RunningStep = {
      ...step,
      controller,
      released: new Promise<void>((resolve) => {
        markReleased = resolve;
      }),
    };
    const steps = this.running.get(step.taskId) ?? new Set<RunningStep>();
    steps.add(entry);
    this.running.set(step.taskId, steps);
    let isReleased = false;
    return {
      signal: controller.signal,
      abort: (reason) => abortWith(controller, reason),
      release: () => {
        if (isReleased) return;
        isReleased = true;
        steps.delete(entry);
        if (steps.size === 0 && this.running.get(step.taskId) === steps) {
          this.running.delete(step.taskId);
        }
        markReleased();
      },
    };
  }

  /**
   * Aborts the task's steps in this process whose attempt is below `currentAttempt` (all of them
   * when it is not given); resolves when they are released.
   */
  abortTask(
    taskId: string,
    reason: StepSignalReason,
    currentAttempt?: number,
  ): Promise<void> {
    const steps = [...(this.running.get(taskId) ?? [])].filter(
      (step) => currentAttempt === undefined || step.attempt < currentAttempt,
    );
    return abortAndWait(steps, reason);
  }

  /** Aborts every step of the process; resolves when they are released. */
  abortAll(reason: StepSignalReason): Promise<void> {
    const steps = [...this.running.values()].flatMap((set) => [...set]);
    return abortAndWait(steps, reason);
  }
}

async function abortAndWait(
  steps: readonly RunningStep[],
  reason: StepSignalReason,
): Promise<void> {
  for (const step of steps) abortWith(step.controller, reason);
  await Promise.all(steps.map((step) => step.released));
}

function abortWith(controller: AbortController, reason: StepSignalReason): void {
  if (controller.signal.aborted) return;
  controller.abort(reason);
}
