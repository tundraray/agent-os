import {
  type BeforeApplicationShutdown,
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import {
  RUNTIME_CONFIG,
  type RuntimeConfig,
} from '../database/runtime-config.js';
import { Dispatcher } from './dispatcher.js';
import { OutboxRelay } from './outbox.relay.js';
import { RecoverySweeper } from './recovery.sweeper.js';

/**
 * Workers of the runtime in the Nest phases (KD-7) — `Dispatcher`, `OutboxRelay` and
 * `RecoverySweeper`: they start in `onApplicationBootstrap` when `RUNTIME_WORKERS` is on and stop
 * in `beforeApplicationShutdown` — running attempts return to `queued`, the relay and the reaper
 * finish their pass in flight — before `DatabaseModule` closes the pool in `onApplicationShutdown`.
 */
@Injectable()
export class RuntimeLifecycle
  implements OnApplicationBootstrap, BeforeApplicationShutdown
{
  private readonly logger = new Logger(RuntimeLifecycle.name);
  private workersStarted = false;

  constructor(
    @Inject(RUNTIME_CONFIG) private readonly config: RuntimeConfig,
    private readonly dispatcher: Dispatcher,
    private readonly relay: OutboxRelay,
    private readonly sweeper: RecoverySweeper,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.workers) {
      this.logger.log('Runtime workers off (RUNTIME_WORKERS=off)');
      return;
    }
    this.dispatcher.start();
    this.relay.start();
    this.sweeper.start();
    this.workersStarted = true;
    this.logger.log(
      `Runtime workers started concurrency=${this.config.concurrency}`,
    );
  }

  async beforeApplicationShutdown(): Promise<void> {
    if (!this.workersStarted) return;
    this.workersStarted = false;
    await Promise.all([
      this.dispatcher.shutdown(),
      this.relay.shutdown(),
      this.sweeper.shutdown(),
    ]);
    this.logger.log('Runtime workers stopped');
  }
}
