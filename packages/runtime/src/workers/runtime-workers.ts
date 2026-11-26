import type { Logger } from '@agent-os/common';
import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import type { Clock } from '../clock';
import type { RuntimeConfig } from '../runtime-config';
import { CLOCK, RUNTIME_CONFIG, RUNTIME_LOGGER } from '../runtime.tokens';
import { Dispatcher } from '../steps/dispatcher';
import { HandlerRegistry } from '../steps/handler.registry';
import { LiveTasks } from '../steps/live-tasks';
import { BackgroundPasses } from './background-passes';
import { RecoverySweeper } from './recovery.sweeper';
import { WorkerLoop } from './worker-loop';

/**
 * The workers of the runtime — dispatcher, recovery sweeper and the registered background passes. They
 * start in `onApplicationBootstrap`, after every `onModuleInit` has registered its handlers, task end
 * hooks and passes, and stop in `beforeApplicationShutdown`; `DbModule` closes the pool after it, in
 * `onApplicationShutdown`.
 */
@Injectable()
export class RuntimeWorkers
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private started = false;
  private passLoops: WorkerLoop[] = [];

  constructor(
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
    @Inject(RUNTIME_LOGGER) private readonly logger: Logger,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(Dispatcher) private readonly dispatcher: Dispatcher,
    @Inject(RecoverySweeper) private readonly sweeper: RecoverySweeper,
    @Inject(HandlerRegistry) private readonly handlers: HandlerRegistry,
    @Inject(LiveTasks) private readonly live: LiveTasks,
    @Inject(BackgroundPasses) private readonly passes: BackgroundPasses,
  ) {}

  onApplicationBootstrap(): void {
    this.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.stop();
  }

  /** Starts the workers unless `RUNTIME_WORKERS` is off; a second call does nothing. */
  start(): void {
    if (!this.config.workers) {
      this.logger.info('runtime workers off (RUNTIME_WORKERS=off)');
      return;
    }
    if (this.started) return;
    this.dispatcher.start();
    // Not awaited: a step that comes first restores its own object; `warm` never rejects.
    void this.live.warm();
    this.sweeper.start();
    this.passLoops = this.passes.list().map(
      ({ name, periodMs, pass }) =>
        new WorkerLoop({
          name,
          periodMs,
          pollMs: this.config.pollMs,
          clock: this.clock,
          logger: this.logger.child({ worker: name }),
          pass,
        }),
    );
    for (const loop of this.passLoops) loop.start();
    this.started = true;
    this.logger.info('runtime workers started', {
      concurrency: this.config.concurrency,
      handlerTypes: this.handlers.types(),
      backgroundPasses: this.passes.list().map(({ name }) => name),
    });
  }

  /**
   * Stops the workers started by {@link start}: steps in flight get `shutdown` and their tasks go
   * back to `queued`; the sweeper and the background passes finish their pass in flight.
   */
  async stop(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    const startedAt = Date.now();
    const passLoops = this.passLoops;
    this.passLoops = [];
    await Promise.all([
      this.dispatcher.shutdown(),
      this.sweeper.shutdown(),
      ...passLoops.map((loop) => loop.stop()),
    ]);
    this.live.clear();
    this.logger.info('runtime workers stopped', {
      durationMs: Date.now() - startedAt,
    });
  }
}
