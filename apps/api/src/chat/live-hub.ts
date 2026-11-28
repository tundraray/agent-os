import {
  Inject,
  Injectable,
  type BeforeApplicationShutdown,
  type MessageEvent,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LOGGER, type Logger } from '@agent-os/common';
import {
  ConversationChangeSignalSchema,
  type LiveEvent,
  RuntimeTreeSignalSchema,
} from '@agent-os/contracts';
import {
  CLOCK,
  RUNTIME_TREE_CHANNEL,
  type CancelTimer,
  type Clock,
} from '@agent-os/runtime';
import pg from 'pg';
import { Observable, type Subscriber } from 'rxjs';
import { z } from 'zod';
import { CONVERSATION_CHANGE_CHANNEL, ViewOperations } from '@agent-os/agents';
import { AGENT_TEXT_DELTA_CHANNEL } from '../agents/delta-publisher';
import {
  deltaTargets,
  noteTargets,
  runtimeChanges,
  type LiveStream,
  type Watch,
} from './live-filter';

/** `application_name` of the hub's connection: tells it apart from the pool in `pg_stat_activity`. */
export const LIVE_HUB_APPLICATION_NAME = 'agent-os-live-hub';

/** How long the hub waits before each attempt to open a lost `LISTEN` connection again. */
const RECONNECT_MS = 1000;

/** How often an idle stream gets a `ping`, so that a proxy does not close it. */
const PING_MS = 20_000;

/** The payload of an `agent_text_delta` NOTIFY (`notifyPayloads` of `DeltaPublisher`). */
const TextDeltaSchema = z.object({
  ownerId: z.string().min(1),
  rootId: z.string().min(1),
  agentId: z.string().min(1),
  offset: z.number().int().nonnegative(),
  text: z.string(),
});

/** One open SSE stream: the filter's view of it plus where its events go. */
interface HubStream extends LiveStream {
  readonly subscriber: Subscriber<MessageEvent>;
}

/** A contract event as Nest's `MessageEvent`: `type` is the SSE event name, `data` its JSON body. */
function messageEvent(event: LiveEvent): MessageEvent {
  return { type: event.type, data: event.data };
}

const READY = messageEvent({ type: 'ready', data: {} });
const PING = messageEvent({ type: 'ping', data: {} });

/**
 * The live updates of the API (design-chat.md, KD-2, KD-3; live-feed design-server.md, KD-1, KD-2): one dedicated
 * connection per process listens on `runtime_tree`, `conversation_change` and `agent_text_delta` and hands the
 * signals to the open SSE streams. A runtime signal becomes `change` events by the rule of `runtimeChanges`, sent to
 * every stream of the conversation's owner; a `conversation_change` signal carries a ready event and its owner and
 * goes to that owner's streams as it is; a text part goes only to the owner's streams that watch its agent
 * (live-filter.ts).
 *
 * Only the streams live in memory (ADR-0001): a conversation is its root session, so an event names it by the
 * tree's root id, and the owner of a runtime signal is read only when the rule gives an event — one row of
 * `conversations` by its primary key, never remembered. A deleted conversation's root is marked and so has no
 * owner (`rootOwner` answers `undefined`): the runtime signals of its tree go to nobody, on this or another API
 * instance, from the moment the deletion commits; its `deleted` event carries the owner. A root that is no
 * conversation (a tree of another task type) has no owner either, and a signal nobody can receive is dropped. A
 * lost connection is reopened every second, and then every stream gets `ready`: the signals of the gap are lost and
 * the web rereads its screen.
 */
@Injectable()
export class LiveHub
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger: Logger;
  private readonly streams = new Set<HubStream>();
  /** Signals are handled one after another, so the parts of one agent keep their order. */
  private signals: Promise<void> = Promise.resolve();
  private client: pg.Client | undefined;
  private cancelReconnect: CancelTimer | undefined;
  private stopped = false;

  constructor(
    private readonly config: ConfigService,
    @Inject(ViewOperations) private readonly views: ViewOperations,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'chat.live' });
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.open();
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.stopped = true;
    this.cancelReconnect?.();
    for (const stream of Array.from(this.streams)) stream.subscriber.complete();
    const client = this.client;
    this.client = undefined;
    await client?.end();
  }

  /**
   * A stream of the owner: `ready` first, then the notes and parts meant for it and a `ping` every
   * 20 s. Unsubscribing (the tab closed the connection) removes the stream.
   */
  register(ownerId: string, watch: Watch | null): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      if (this.stopped) {
        subscriber.complete();
        return undefined;
      }
      const stream: HubStream = { ownerId, watch, subscriber };
      this.streams.add(stream);
      subscriber.next(READY);
      const ping = setInterval(() => subscriber.next(PING), PING_MS);
      return () => {
        clearInterval(ping);
        this.streams.delete(stream);
      };
    });
  }

  /** Opens the dedicated connection and listens on both channels; throws when it cannot. */
  private async open(): Promise<void> {
    const client = new pg.Client({
      connectionString: this.config.getOrThrow<string>('DATABASE_URL'),
      application_name: LIVE_HUB_APPLICATION_NAME,
    });
    client.on('notification', (notice) =>
      this.enqueue(notice.channel, notice.payload),
    );
    client.on('error', (error) => this.lost(client, error));
    client.on('end', () => this.lost(client));
    try {
      await client.connect();
      await client.query(`LISTEN "${RUNTIME_TREE_CHANNEL}"`);
      await client.query(`LISTEN "${CONVERSATION_CHANGE_CHANNEL}"`);
      await client.query(`LISTEN "${AGENT_TEXT_DELTA_CHANNEL}"`);
    } catch (error) {
      await client.end().catch(() => undefined);
      throw error;
    }
    this.client = client;
  }

  /** The connection failed or ended: drop it and try again every second (unless shutting down). */
  private lost(client: pg.Client, error?: Error): void {
    if (this.client !== client || this.stopped) return;
    this.client = undefined;
    this.logger.warn('live hub connection lost, reconnecting', { error });
    client.removeAllListeners('notification');
    client.end().catch(() => undefined);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.cancelReconnect = this.clock.setTimer(RECONNECT_MS, () => {
      this.cancelReconnect = undefined;
      this.reconnect().catch((error: unknown) => {
        this.logger.warn('live hub reconnect failed, retrying', { error });
        if (!this.stopped) this.scheduleReconnect();
      });
    });
  }

  private async reconnect(): Promise<void> {
    if (this.stopped) return;
    await this.open();
    if (this.stopped) {
      await this.beforeApplicationShutdown();
      return;
    }
    this.logger.info('live hub LISTEN restored', {
      streams: this.streams.size,
    });
    for (const stream of this.streams) stream.subscriber.next(READY);
  }

  private enqueue(channel: string, payload: string | undefined): void {
    this.signals = this.signals
      .then(() => this.handle(channel, payload))
      .catch((error: unknown) => {
        this.logger.warn('live signal dropped', { channel, error });
      });
  }

  private async handle(
    channel: string,
    payload: string | undefined,
  ): Promise<void> {
    // Nobody to tell: drop before parsing or looking anything up.
    if (this.streams.size === 0 || payload === undefined) return;
    if (channel === RUNTIME_TREE_CHANNEL) await this.runtimeSignal(payload);
    else if (channel === CONVERSATION_CHANGE_CHANNEL)
      this.conversationSignal(payload);
    else if (channel === AGENT_TEXT_DELTA_CHANNEL) this.delta(payload);
  }

  /** A task's row was written: its change events, when the rule gives any, to the conversation's owner. */
  private async runtimeSignal(payload: string): Promise<void> {
    const signal = RuntimeTreeSignalSchema.parse(JSON.parse(payload));
    const events = runtimeChanges(signal);
    if (events.length === 0) return;
    const ownerId = await this.views.rootOwner(signal.rootId);
    if (ownerId === undefined) return;
    for (const event of events) this.send(RUNTIME_TREE_CHANNEL, ownerId, event);
  }

  /** A ready event of a conversation's writer: to its owner's streams, without the rule or a read. */
  private conversationSignal(payload: string): void {
    const { ownerId, event } = ConversationChangeSignalSchema.parse(
      JSON.parse(payload),
    );
    this.send(CONVERSATION_CHANGE_CHANNEL, ownerId, event);
  }

  /** One `change` or `attention` event to every stream of the owner, logged by ids and kinds only. */
  private send(
    channel: string,
    ownerId: string,
    event: Extract<LiveEvent, { type: 'change' | 'attention' }>,
  ): void {
    const targets = noteTargets(ownerId, this.streams);
    this.logger.info('live event sent', {
      channel,
      type: event.type,
      kind: event.type === 'change' ? event.data.kind : event.data.event,
      threadId: event.data.threadId,
      agentId: event.type === 'change' ? (event.data.agentId ?? null) : null,
      ownerId,
      streams: targets.length,
    });
    const message = messageEvent(event);
    for (const stream of targets) stream.subscriber.next(message);
  }

  /** A text part: only to the owner's streams that watch its agent or the root's conversation. */
  private delta(payload: string): void {
    const delta = TextDeltaSchema.parse(JSON.parse(payload));
    const event = messageEvent({
      type: 'delta',
      data: { agentId: delta.agentId, offset: delta.offset, text: delta.text },
    });
    for (const stream of deltaTargets(delta, this.streams))
      stream.subscriber.next(event);
  }
}
