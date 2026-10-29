import { randomUUID } from 'node:crypto';
import type { MastraDBMessage } from '@mastra/core/memory';
import type { Memory } from '@mastra/memory';

/** A fresh, test-unique resource id (sent as `x-user-id`). */
export function newUser(): string {
  return `e2e-${randomUUID()}`;
}

export interface SeedThread {
  updatedAt: Date;
  /** Stored as given; omitted → `''` (what Mastra stores for an untitled thread). */
  title?: string;
  /** Number of format-2 text messages, alternating user/assistant, user first. */
  messages?: number;
}

export interface SeededThreads {
  /** Per-call `randomUUID()`; thread ids are `${prefix}-t-${nnn}`. */
  prefix: string;
  /** Thread number (1-based, order of `threads`) → thread id. */
  ids: ReadonlyMap<number, string>;
}

/** `${prefix}-t-001`, `${prefix}-t-002`, … */
export function seededThreadId(prefix: string, n: number): string {
  return `${prefix}-t-${String(n).padStart(3, '0')}`;
}

/** `count` dates, the first `newest`, each next `stepMs` older. */
export function descendingDates(
  count: number,
  newest: Date,
  stepMs = 60_000,
): Date[] {
  return Array.from(
    { length: count },
    (_, i) => new Date(newest.getTime() - i * stepMs),
  );
}

function buildMessages(
  threadId: string,
  resourceId: string,
  thread: SeedThread,
): MastraDBMessage[] {
  const count = thread.messages ?? 0;
  return Array.from({ length: count }, (_, i) => {
    const n = String(i + 1).padStart(3, '0');
    return {
      id: `${threadId}-m-${n}`,
      threadId,
      resourceId,
      role: i % 2 === 0 ? 'user' : 'assistant',
      // Strictly increasing, all before the thread's updatedAt.
      createdAt: new Date(thread.updatedAt.getTime() - (count - i) * 1_000),
      content: { format: 2, parts: [{ type: 'text', text: `message ${n}` }] },
    };
  });
}

/**
 * Creates threads (with explicit `updatedAt`) and their format-2 messages
 * through `Memory.saveThread` / `saveMessages`. Ids get a fresh per-call
 * prefix, so equal numbers in different tests never collide on
 * `mastra_threads.id` across parallel e2e files.
 */
export async function seed(
  memory: Memory,
  options: { resourceId: string; threads: SeedThread[] },
): Promise<SeededThreads> {
  const prefix = randomUUID();
  const ids = new Map<number, string>();
  for (const [index, spec] of options.threads.entries()) {
    const id = seededThreadId(prefix, index + 1);
    const thread = {
      id,
      resourceId: options.resourceId,
      title: spec.title ?? '',
      createdAt: new Date(spec.updatedAt.getTime() - 3_600_000),
      updatedAt: spec.updatedAt,
    };
    await memory.saveThread({ thread });
    const messages = buildMessages(id, options.resourceId, spec);
    if (messages.length > 0) {
      await memory.saveMessages({ messages });
      // saveMessages bumps updatedAt to now(); restore the requested value (saveThread upserts).
      await memory.saveThread({ thread });
    }
    ids.set(index + 1, id);
  }
  return { prefix, ids };
}

/** Deletes every thread (and its messages) owned by the given resource ids. */
export async function cleanupUsers(
  memory: Memory,
  resourceIds: Iterable<string>,
): Promise<void> {
  for (const resourceId of resourceIds) {
    const { threads } = await memory.listThreads({
      filter: { resourceId },
      perPage: false,
    });
    for (const thread of threads) await memory.deleteThread(thread.id);
  }
}
