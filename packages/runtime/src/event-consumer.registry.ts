import type { EventEnvelope, RuntimeEventType } from '@agent-os/contracts';
import type { RuntimeTx } from './guarded-transition.js';

/**
 * A consumer of outbox events. `handle` only makes database transitions inside the given
 * transaction (the relay's delivery transaction, in a savepoint); it calls no handler or
 * external system.
 */
export interface EventConsumer {
  /** Unique name, stored as `research_event_deliveries.consumer`. */
  readonly name: string;
  readonly eventTypes: readonly RuntimeEventType[];
  /** `schemaVersion`s it understands; any other version is parked as `needs_attention`. */
  readonly schemaVersions: readonly number[];
  handle(tx: RuntimeTx, event: EventEnvelope): Promise<void>;
}

/**
 * Consumers of outbox events, registered before `Runtime.start()`. `EventLog` writes one
 * delivery row per consumer of the event's type in the transaction that writes the event.
 */
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
  consumerNamesFor(type: RuntimeEventType): string[] {
    return [...this.consumers.values()]
      .filter((consumer) => consumer.eventTypes.includes(type))
      .map((consumer) => consumer.name);
  }

  /** The consumer of a delivery row; `undefined` when no longer registered. */
  get(name: string): EventConsumer | undefined {
    return this.consumers.get(name);
  }
}
