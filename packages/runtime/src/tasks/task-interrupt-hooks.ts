import { Injectable } from '@nestjs/common';

/** The interrupted task as the hook receives it (runtime-fixes design-steps.md, «Крючок прерывания»). */
export interface TaskInterruptHookInput {
  readonly taskId: string;
  readonly rootId: string;
  /** `null` for the platform's own work. */
  readonly ownerId: string | null;
  readonly type: string;
}

/**
 * The hook of an interrupt: `TaskControl.interrupt` calls it in the interrupt's transaction after the fence,
 * in its own savepoint. It calls no model and no network and writes only into that transaction.
 */
export type TaskInterruptHook = (task: TaskInterruptHookInput) => Promise<void>;

/** The registered hook with the name its failures are logged under. */
export interface NamedTaskInterruptHook {
  readonly name: string;
  readonly hook: TaskInterruptHook;
}

/**
 * The one hook of an interrupt (runtime-fixes KD-1): an upper layer registers it in `onModuleInit`, so that
 * an interrupt keeps what the cut-off step held only in memory. An interrupt is no end of a task, so the
 * task end hooks do not see it.
 */
@Injectable()
export class TaskInterruptHooks {
  private registered: NamedTaskInterruptHook | undefined;

  /** Throws on a second registration under any name, which stops the start: there is exactly one handler. */
  register(name: string, hook: TaskInterruptHook): void {
    if (this.registered !== undefined) {
      throw new Error(
        `Task interrupt hook "${name}" refused: "${this.registered.name}" is already registered`,
      );
    }
    this.registered = { name, hook };
  }

  /** The registered hook, if any. */
  current(): NamedTaskInterruptHook | undefined {
    return this.registered;
  }
}
