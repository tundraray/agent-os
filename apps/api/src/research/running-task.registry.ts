import type { AbortReasonKind } from '@agent-os/contracts';
import { Injectable } from '@nestjs/common';

/** `signal.reason` of an aborted attempt (TaskContext). */
export interface AttemptAbortReason {
  kind: AbortReasonKind;
}

/** One attempt executing in this process. */
export interface RunningTaskHandle {
  /** Aborted with an {@link AttemptAbortReason}; the first abort wins. */
  readonly signal: AbortSignal;
  abort(kind: AbortReasonKind): void;
  /** The attempt is over: its last write is done. Idempotent. */
  release(): void;
}

interface RunningTask {
  taskId: string;
  investigationId: string;
  controller: AbortController;
  /** Resolves on the first `release()`. */
  released: Promise<void>;
}

/** The kind of an attempt's abort, or `undefined` while it is not aborted. */
export function abortKindOf(signal: AbortSignal): AbortReasonKind | undefined {
  if (!signal.aborted) return undefined;
  return (signal.reason as AttemptAbortReason).kind;
}

/**
 * Attempts executing in this process, by task (after the pattern of `ThreadRunRegistry`):
 * cancellation, thread deletion and shutdown abort them and wait for their last write.
 * Process-local: attempts of another instance learn about a cancel through their heartbeat.
 */
@Injectable()
export class RunningTaskRegistry {
  private readonly running = new Map<string, RunningTask>();

  register(task: {
    taskId: string;
    investigationId: string;
  }): RunningTaskHandle {
    const controller = new AbortController();
    let markReleased: () => void = () => undefined;
    const entry: RunningTask = {
      ...task,
      controller,
      released: new Promise<void>((resolve) => {
        markReleased = resolve;
      }),
    };
    this.running.set(task.taskId, entry);
    let isReleased = false;
    return {
      signal: controller.signal,
      abort: (kind) => abortWith(controller, kind),
      release: () => {
        if (isReleased) return;
        isReleased = true;
        if (this.running.get(task.taskId) === entry) {
          this.running.delete(task.taskId);
        }
        markReleased();
      },
    };
  }

  /** Aborts the investigation's attempts in this process; resolves when they are released. */
  abortInvestigation(
    investigationId: string,
    kind: AbortReasonKind,
  ): Promise<void> {
    return this.abortWhere(
      (task) => task.investigationId === investigationId,
      kind,
    );
  }

  /** Aborts every attempt of the process; resolves when they are released. */
  abortAll(kind: AbortReasonKind): Promise<void> {
    return this.abortWhere(() => true, kind);
  }

  private async abortWhere(
    matches: (task: RunningTask) => boolean,
    kind: AbortReasonKind,
  ): Promise<void> {
    const targets = [...this.running.values()].filter(matches);
    for (const task of targets) abortWith(task.controller, kind);
    await Promise.all(targets.map((task) => task.released));
  }
}

function abortWith(controller: AbortController, kind: AbortReasonKind): void {
  if (controller.signal.aborted) return;
  const reason: AttemptAbortReason = { kind };
  controller.abort(reason);
}
