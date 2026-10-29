import { Injectable } from '@nestjs/common';

/**
 * Serialises async tasks per key (a `threadId`) within this process: tasks of
 * one key run strictly in queue order, tasks of different keys run in
 * parallel. A rejected task never blocks the next one, and a key's tail is
 * removed once its last queued task settles, so the map does not grow.
 *
 * Process-local by design: several API instances are not serialised against
 * each other (Design Doc, Future Extensibility: advisory lock).
 */
@Injectable()
export class ThreadWriteLock {
  /** Per key: a promise that settles (never rejects) when the last queued task settles. */
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(fn);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key);
      }
    }
  }

  /** Whether a task of this key is running or queued. */
  isHeld(key: string): boolean {
    return this.tails.has(key);
  }
}
