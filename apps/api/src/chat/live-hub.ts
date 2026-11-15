import {
  Inject,
  Injectable,
  type BeforeApplicationShutdown,
  type MessageEvent,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Logger } from '@agent-os/common';
import type { LiveEvent } from '@agent-os/contracts';
import { RUNTIME_EVENTS_CHANNEL, type CancelTimer, type Clock } from '@agent-os/runtime';
import pg from 'pg';
import { Observable, type Subscriber } from 'rxjs';
import { z } from 'zod';
import { AGENT_TEXT_DELTA_CHANNEL } from '../agents/delta-publisher.js';
import { APP_LOGGER } from '../logging/app-logger.js';
import { RUNTIME_CLOCK } from '../runtime/runtime.tokens.js';
import { ConversationsRepository } from './conversations.repository.js';
import {
  deltaTargets,
  noteTargets,
  type LiveStream,
  type RootConversation,
  type Watch,
} from './live-filter.js';

/** `application_name` of the hub's connection: tells it apart from the pool in `pg_stat_activity`. */
export const LIVE_HUB_APPLICATION_NAME = 'agent-os-live-hub';

/** How long the hub waits before each attempt to open a lost `LISTEN` connection again. */
const RECONNECT_MS = 1000;

/** How often an idle stream gets a `ping`, so that a proxy does not close it. */
const PING_MS = 20_000;

/** The notice of a `runtime_events` NOTIFY (`EventLog.write` of the runtime). */
const TreeNoticeSchema = z.object({ rootId: z.string().min(1) });

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
 * The live updates of the API (design-chat.md, KD-2, KD-3, C3 «живые обновления»): one dedicated
 * connection per process listens on `runtime_events` and `agent_text_delta` and hands the signals to
 * the open SSE streams. A runtime event becomes a `tree` note to every stream of the conversation's
 * owner; a text part goes only to the owner's streams that watch its agent (live-filter.ts).
 *
 * Only the streams and the found «root → conversation» pairs live in memory (ADR-0001): a missing
 * conversation is not cached, because the root's first events can come before `setRoot` commits, and
 * a signal nobody can receive is dropped. A lost connection is reopened every second, and then every
 * stream gets `ready`: the signals of the gap are lost and the web rereads its screen.
 */
@Injectable()
export class LiveHub implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly logger: Logger;
  private readonly streams = new Set<HubStream>();
  /** Found conversations by root id; never a miss. */
  private readonly roots = new Map<string, RootConversation>();
  /** Signals are handled one after another, so the parts of one agent keep their order. */
  private signals: Promise<void> = Promise.resolve();
  private client: pg.Client | undefined;
  private cancelReconnect: CancelTimer | undefined;
  private stopped = false;

  constructor(
    private readonly config: ConfigService,
    private readonly conversations: ConversationsRepository,
    @Inject(RUNTIME_CLOCK) private readonly clock: Clock,
    @Inject(APP_LOGGER) logger: Logger,
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
    client.on('notification', (notice) => this.enqueue(notice.channel, notice.payload));
    client.on('error', (error) => this.lost(client, error));
    client.on('end', () => this.lost(client));
    try {
      await client.connect();
      await client.query(`LISTEN "${RUNTIME_EVENTS_CHANNEL}"`);
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
    this.logger.info('live hub LISTEN restored', { streams: this.streams.size });
    for (const stream of this.streams) stream.subscriber.next(READY);
  }

  private enqueue(channel: string, payload: string | undefined): void {
    this.signals = this.signals
      .then(() => this.handle(channel, payload))
      .catch((error: unknown) => {
        this.logger.warn('live signal dropped', { channel, error });
      });
  }

  private async handle(channel: string, payload: string | undefined): Promise<void> {
    // Nobody to tell: drop before parsing or looking anything up.
    if (this.streams.size === 0 || payload === undefined) return;
    if (channel === RUNTIME_EVENTS_CHANNEL) await this.note(payload);
    else if (channel === AGENT_TEXT_DELTA_CHANNEL) await this.delta(payload);
  }

  /** A runtime event of a tree: a `tree` note to every stream of the conversation's owner. */
  private async note(payload: string): Promise<void> {
    const { rootId } = TreeNoticeSchema.parse(JSON.parse(payload));
    const conversation = await this.conversationOf(rootId);
    if (conversation === null) return;
    const event = messageEvent({ type: 'tree', data: { threadId: conversation.threadId } });
    for (const stream of noteTargets(conversation, this.streams)) stream.subscriber.next(event);
  }

  /** A text part: only to the owner's streams that watch its agent or the root's conversation. */
  private async delta(payload: string): Promise<void> {
    const delta = TextDeltaSchema.parse(JSON.parse(payload));
    const ownerStreams = [...this.streams].filter((stream) => stream.ownerId === delta.ownerId);
    if (ownerStreams.length === 0) return;
    const watchesThread = ownerStreams.some((stream) => stream.watch?.kind === 'thread');
    const conversation =
      delta.agentId === delta.rootId && watchesThread
        ? await this.conversationOf(delta.rootId)
        : null;
    const event = messageEvent({
      type: 'delta',
      data: { agentId: delta.agentId, offset: delta.offset, text: delta.text },
    });
    for (const stream of deltaTargets(delta, conversation, ownerStreams)) {
      stream.subscriber.next(event);
    }
  }

  /** The conversation of a root, from the cache or `chat_conversations`; a miss is not cached. */
  private async conversationOf(rootId: string): Promise<RootConversation | null> {
    const cached = this.roots.get(rootId);
    if (cached !== undefined) return cached;
    const row = await this.conversations.findByRoot(rootId);
    if (row === undefined) return null;
    const found: RootConversation = { threadId: row.id, ownerId: row.ownerId };
    this.roots.set(rootId, found);
    return found;
  }
}
