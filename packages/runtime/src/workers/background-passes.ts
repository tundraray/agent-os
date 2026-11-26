import { Injectable } from '@nestjs/common';

/**
 * A periodic pass of an upper layer (schedules KD-3): the runtime runs it in its own `WorkerLoop` together with
 * its workers and knows nothing of what it does.
 */
export interface BackgroundPass {
  /** Name in the log; unique among the passes. */
  readonly name: string;
  /** Delay after a pass that left no work behind. */
  readonly periodMs: number;
  /** One pass; resolves `true` when work may remain, and the next pass runs at once. */
  readonly pass: () => Promise<boolean>;
}

/**
 * The background passes of upper layers: they register in `onModuleInit`; `RuntimeWorkers` starts each in its
 * own loop with the workers — the first pass at once — and stops them with the workers, and none runs while
 * `RUNTIME_WORKERS` is off. A failed pass is logged and repeated with backoff.
 */
@Injectable()
export class BackgroundPasses {
  private readonly passes: BackgroundPass[] = [];

  /** Throws on a second pass of the same name, which stops the start. */
  register(pass: BackgroundPass): void {
    if (this.passes.some((registered) => registered.name === pass.name)) {
      throw new Error(`Background pass "${pass.name}" is already registered`);
    }
    this.passes.push(pass);
  }

  /** The passes in registration order. */
  list(): readonly BackgroundPass[] {
    return this.passes;
  }
}
