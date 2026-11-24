import type { TaskEndStatusSchema } from '@agent-os/contracts';
import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { TaskFailure } from './guarded-transition';

/** How a task ended: `completed`, `failed` or `stopped`. */
export type TaskEndStatus = z.infer<typeof TaskEndStatusSchema>;

/** The end of a task as a hook receives it (design-runtime.md, «Крючок конца задачи»). */
export interface TaskEndHookInput {
  readonly taskId: string;
  readonly rootId: string;
  /** `null` for a root task. */
  readonly parentId: string | null;
  /** `null` for the platform's own work. */
  readonly ownerId: string | null;
  readonly type: string;
  readonly status: TaskEndStatus;
  /** The reason of a `failed` task; `null` for the other ends. */
  readonly failure: TaskFailure | null;
  /** The time of the end's transaction. */
  readonly finishedAt: Date;
}

/**
 * A hook of the end of a task: it runs in the end's transaction, in its own savepoint. It calls no
 * model and no network; it writes rows through repositories and may create a task (`TaskControl.create`),
 * which joins the end's transaction.
 */
export type TaskEndHook = (end: TaskEndHookInput) => Promise<void>;

/** A registered hook with the name its failures are logged under. */
export interface NamedTaskEndHook {
  readonly name: string;
  readonly hook: TaskEndHook;
}

/**
 * The hooks of the end of a task (KD-5): an upper layer registers them in `onModuleInit`; `endTask`
 * calls every one on each end — `completed`, `failed`, `stopped` — after the status and the stop of
 * the descendants and before the parent's `child_finished`.
 */
@Injectable()
export class TaskEndHooks {
  private readonly hooks: NamedTaskEndHook[] = [];

  /** Throws on a second hook of the same name, which stops the start. */
  register(name: string, hook: TaskEndHook): void {
    if (this.hooks.some((registered) => registered.name === name)) {
      throw new Error(`Task end hook "${name}" is already registered`);
    }
    this.hooks.push({ name, hook });
  }

  /** The hooks in registration order. */
  list(): readonly NamedTaskEndHook[] {
    return this.hooks;
  }
}
