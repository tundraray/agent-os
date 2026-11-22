import type { TaskHandler } from './step-contract';

/**
 * Handlers of this process, registered before `Runtime.start()`. Creation accepts and the
 * dispatcher claims only the types registered here.
 */
export class HandlerRegistry {
  private readonly handlers = new Map<string, TaskHandler>();

  /** Throws on a second handler of the same type, which stops the start. */
  register(handler: TaskHandler): void {
    if (this.handlers.has(handler.type)) {
      throw new Error(`Handler of task type "${handler.type}" is already registered`);
    }
    this.handlers.set(handler.type, handler);
  }

  get(type: string): TaskHandler | undefined {
    return this.handlers.get(type);
  }

  /** Registered task types. */
  types(): string[] {
    return [...this.handlers.keys()];
  }
}
