import { Injectable } from '@nestjs/common';

/** An event as stored, with its insertion order. */
export interface StoredEvent {
  eventId: string;
  /** Insertion order in the log; events of a tree are read by it. */
  seq: number;
  type: string;
  schemaVersion: number;
  rootId: string;
  taskId: string | null;
  causationId: string | null;
  /** `step_no` of the task when the event was written. */
  stateRevision: number;
  payload: unknown;
  createdAt: Date;
}

/**
 * A consumer of outbox events. `handle` only makes database writes; they join the
 * relay's delivery transaction, in a savepoint; it calls no handler or external system.
 */
export interface EventConsumer {
  /** Unique name, stored as `runtime_event_deliveries.consumer`. */
  readonly name: string;
  /** Runtime event types and upper-layer types (with their package prefix) it receives. */
  readonly eventTypes: readonly string[];
  /** `schemaVersion`s it understands; any other version is parked as `needs_attention`. */
  readonly schemaVersions: readonly number[];
  handle(event: StoredEvent): Promise<void>;
}

/**
 * Consumers of outbox events, registered in `onModuleInit`, before `RuntimeWorkers.start()`.
 * `EventLog` writes one delivery row per consumer of the event's type in the transaction that
 * writes the event.
 */
@Injectable()
export class EventConsumerRegistry {
  private readonly consumers = new Map<string, EventConsumer>();

  /** Throws on a second consumer with the same name, which stops the start. */
  register(consumer: EventConsumer): void {
    if (this.consumers.has(consumer.name)) {
      throw new Error(
        `Event consumer "${consumer.name}" is already registered`,
      );
    }
    this.consumers.set(consumer.name, consumer);
  }

  /** Names of the consumers subscribed to `type`, whatever their schema versions. */
  consumerNamesFor(type: string): string[] {
    return [...this.consumers.values()]
      .filter((consumer) => consumer.eventTypes.includes(type))
      .map((consumer) => consumer.name);
  }

  /** Names of every consumer registered in this process. */
  names(): string[] {
    return [...this.consumers.keys()];
  }

  /** The consumer of a delivery row; `undefined` when not registered in this process. */
  get(name: string): EventConsumer | undefined {
    return this.consumers.get(name);
  }
}
