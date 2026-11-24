import { Injectable } from '@nestjs/common';
import {
  type LiveTaskType,
  QUESTION_TASK_TYPE,
  type TaskHandler,
} from './step-contract';

/** What creation checks of a task type, stateless or live. */
export type RegisteredTaskType = Pick<TaskHandler, 'type' | 'inputSchema'>;

/**
 * Task types of this process, registered in `onModuleInit`, before `RuntimeWorkers.start()`.
 * Creation accepts and the dispatcher claims only the types registered here. A stateless handler
 * (`register`) serves every task of its type and keeps nothing between steps; a live type
 * (`registerLive`) gives each task its own object, kept by `LiveTasks`.
 */
@Injectable()
export class HandlerRegistry {
  private readonly handlers = new Map<string, TaskHandler>();
  private readonly liveTypes = new Map<string, LiveTaskType>();

  /**
   * Throws on a second handler of the same type or on the runtime's question type, which stops the
   * start.
   */
  register(handler: TaskHandler): void {
    this.checkFree(handler.type);
    this.handlers.set(handler.type, handler);
  }

  /** Throws on a second registration of the same type, which stops the start. */
  registerLive(type: LiveTaskType): void {
    this.checkFree(type.type);
    this.liveTypes.set(type.type, type);
  }

  get(type: string): RegisteredTaskType | undefined {
    return this.handlers.get(type) ?? this.liveTypes.get(type);
  }

  /** The stateless handler of the type. */
  handler(type: string): TaskHandler | undefined {
    return this.handlers.get(type);
  }

  /** The live type of that name. */
  live(type: string): LiveTaskType | undefined {
    return this.liveTypes.get(type);
  }

  /** Registered task types, stateless and live. */
  types(): string[] {
    return [...this.handlers.keys(), ...this.liveTypes.keys()];
  }

  /** Registered live task types. */
  liveTypeNames(): string[] {
    return [...this.liveTypes.keys()];
  }

  private checkFree(type: string): void {
    if (type === QUESTION_TASK_TYPE) {
      throw new Error(`Task type "${type}" is reserved by the runtime`);
    }
    if (this.handlers.has(type) || this.liveTypes.has(type)) {
      throw new Error(`Handler of task type "${type}" is already registered`);
    }
  }
}
