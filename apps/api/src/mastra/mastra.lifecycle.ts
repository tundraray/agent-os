import {
  Inject,
  Injectable,
  Logger,
  OnApplicationShutdown,
} from '@nestjs/common';
import type { Mastra } from '@mastra/core/mastra';
import { MASTRA } from './mastra.constants.js';

@Injectable()
export class MastraLifecycle implements OnApplicationShutdown {
  private readonly logger = new Logger(MastraLifecycle.name);

  constructor(@Inject(MASTRA) private readonly mastra: Mastra) {}

  /** Called from main.ts after app.listen(). */
  async start() {
    await this.mastra.startWorkers();
    this.logger.log('Mastra workers started');
  }

  async onApplicationShutdown() {
    await this.mastra.shutdown();
  }
}
