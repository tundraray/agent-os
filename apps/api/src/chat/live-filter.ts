import { isUuid } from './conversations.service.js';

/** What a stream watches besides the owner's tree notes: a conversation's root or one agent. */
export type Watch = { kind: 'thread'; threadId: string } | { kind: 'agent'; agentId: string };

/** A stream as the filter sees it: whose it is and what it watches. */
export interface LiveStream {
  readonly ownerId: string;
  readonly watch: Watch | null;
}

/** The conversation a root agent belongs to (a row of `chat_conversations`). */
export interface RootConversation {
  readonly threadId: string;
  readonly ownerId: string;
}

/** The addressing part of a text part: its owner, its tree and the agent that wrote it. */
export interface DeltaAddress {
  readonly ownerId: string;
  readonly rootId: string;
  readonly agentId: string;
}

/**
 * `watch` of `GET /events` (design-chat.md, Contract «Поток»): `thread:<uuid>` or `agent:<uuid>`.
 * Anything else — absent, empty, another prefix, not a UUID — watches nothing; it is not an error.
 */
export function parseWatch(value: string | undefined): Watch | null {
  if (value === undefined) return null;
  const separator = value.indexOf(':');
  if (separator < 0) return null;
  const prefix = value.slice(0, separator);
  const id = value.slice(separator + 1);
  if (!isUuid(id)) return null;
  if (prefix === 'thread') return { kind: 'thread', threadId: id };
  if (prefix === 'agent') return { kind: 'agent', agentId: id };
  return null;
}

/** A `tree` note of a conversation goes to every stream of the conversation's owner (DC-4). */
export function noteTargets<S extends LiveStream>(
  conversation: RootConversation,
  streams: Iterable<S>,
): S[] {
  return [...streams].filter((stream) => stream.ownerId === conversation.ownerId);
}

/**
 * A text part goes only to streams of its owner (Invariant 3) that watch the agent that wrote it, or
 * — for a part of the root — that watch the root's conversation. The conversation is looked up per
 * signal, so a `thread:` stream opened before the conversation got its root receives the root's parts
 * once the conversation is found; `null` (not found yet) reaches only the `agent:` streams.
 */
export function deltaTargets<S extends LiveStream>(
  delta: DeltaAddress,
  conversationOfRoot: RootConversation | null,
  streams: Iterable<S>,
): S[] {
  const rootThreadId =
    delta.agentId === delta.rootId && conversationOfRoot?.ownerId === delta.ownerId
      ? conversationOfRoot.threadId
      : null;
  return [...streams].filter((stream) => {
    if (stream.ownerId !== delta.ownerId || stream.watch === null) return false;
    if (stream.watch.kind === 'agent') return stream.watch.agentId === delta.agentId;
    return stream.watch.threadId === rootThreadId;
  });
}
