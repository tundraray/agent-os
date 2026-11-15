import type { OnModuleDestroy } from '@nestjs/common';
import type { TextDelta } from '@agent-os/agents';
import type { Logger } from '@agent-os/common';
import type { CancelTimer, Clock } from '@agent-os/runtime';

/** The NOTIFY channel of text parts (design-chat.md, KD-3); `LiveHub` listens on it. */
export const AGENT_TEXT_DELTA_CHANNEL = 'agent_text_delta';

/** How long the parts after the first one are coalesced before they go out together. */
const COALESCE_MS = 100;

/** The largest JSON payload sent: below the 8000-byte NOTIFY payload limit. */
const MAX_PAYLOAD_BYTES = 7900;

export interface DeltaPublisherDeps {
  /** Sends one JSON payload to `AGENT_TEXT_DELTA_CHANNEL` (`pg_notify` on the application pool). */
  readonly notify: (payload: string) => Promise<void>;
  readonly clock: Pick<Clock, 'setTimer'>;
  readonly logger: Logger;
}

/** The parts of one agent waiting for the window's timer. */
interface AgentWindow {
  pending: TextDelta | null;
  cancel: CancelTimer;
}

/**
 * The `onTextDelta` hook of `createAgents` (design-chat.md KD-3, C3 «живые обновления»): publishes an
 * agent's text parts to NOTIFY. A part opening an answer (`offset` 0) or arriving after a pause goes at
 * once and opens a 100 ms window; the parts arriving within the window go out as one coalesced part
 * with the offset of its first part, and that opens the next window. A part with `offset` 0 (a retry)
 * drops the unsent parts of the earlier attempt. Parts live only in this buffer (ADR-0001): a lost one
 * is healed by the reader rereading the history, so a failed send is a `warn` and nothing more.
 */
export class DeltaPublisher implements OnModuleDestroy {
  private readonly windows = new Map<string, AgentWindow>();
  /** Keeps the payloads in the order they were published: pool connections would race otherwise. */
  private sending: Promise<void> = Promise.resolve();

  constructor(private readonly deps: DeltaPublisherDeps) {}

  publish(delta: TextDelta): void {
    const window = this.windows.get(delta.agentId);
    if (window === undefined || delta.offset === 0) {
      window?.cancel();
      this.send(delta);
      this.openWindow(delta.agentId);
      return;
    }
    window.pending =
      window.pending === null
        ? delta
        : { ...window.pending, text: window.pending.text + delta.text };
  }

  onModuleDestroy(): void {
    for (const window of this.windows.values()) window.cancel();
    this.windows.clear();
  }

  private openWindow(agentId: string): void {
    const window: AgentWindow = { pending: null, cancel: () => {} };
    window.cancel = this.deps.clock.setTimer(COALESCE_MS, () =>
      this.closeWindow(agentId, window),
    );
    this.windows.set(agentId, window);
  }

  private closeWindow(agentId: string, window: AgentWindow): void {
    if (this.windows.get(agentId) !== window) return;
    if (window.pending === null) {
      this.windows.delete(agentId);
      return;
    }
    this.send(window.pending);
    this.openWindow(agentId);
  }

  private send(delta: TextDelta): void {
    const payloads = notifyPayloads(delta);
    if (payloads.length === 0) return;
    this.sending = this.sending
      .then(async () => {
        for (const payload of payloads) await this.deps.notify(payload);
      })
      .catch((error: unknown) => {
        this.deps.logger.warn('text delta notify failed', {
          agentId: delta.agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }
}

/**
 * The NOTIFY payloads of one part: JSON `{ownerId, rootId, agentId, offset, text}` of at most
 * `MAX_PAYLOAD_BYTES` UTF-8 bytes each. A longer part is split between code points, so a surrogate
 * pair is never cut; each piece carries its own offset. An empty part sends nothing.
 */
function notifyPayloads(delta: TextDelta): string[] {
  if (delta.text === '') return [];
  const whole = payload(delta, delta.offset, delta.text);
  if (Buffer.byteLength(whole) <= MAX_PAYLOAD_BYTES) return [whole];

  // The envelope with the largest offset any piece can carry: the offset's digits only grow.
  const envelopeBytes = Buffer.byteLength(
    payload(delta, delta.offset + delta.text.length, ''),
  );
  const budget = MAX_PAYLOAD_BYTES - envelopeBytes;
  const payloads: string[] = [];
  let offset = delta.offset;
  let piece = '';
  let pieceBytes = 0;
  for (const char of delta.text) {
    // The bytes the character takes inside a JSON string, escapes included.
    const charBytes = Buffer.byteLength(JSON.stringify(char)) - 2;
    if (piece !== '' && pieceBytes + charBytes > budget) {
      payloads.push(payload(delta, offset, piece));
      offset += piece.length;
      piece = '';
      pieceBytes = 0;
    }
    piece += char;
    pieceBytes += charBytes;
  }
  payloads.push(payload(delta, offset, piece));
  return payloads;
}

function payload(delta: TextDelta, offset: number, text: string): string {
  return JSON.stringify({
    ownerId: delta.ownerId,
    rootId: delta.rootId,
    agentId: delta.agentId,
    offset,
    text,
  });
}
