import { Logger } from '@nestjs/common';
import type { RuntimeLogFields, RuntimeLogger } from '@agent-os/runtime';
import { withFields } from '../common/log-fields.js';

/**
 * `RuntimeLogger` over the Nest `Logger` (design-runtime.md, Logging and Monitoring): the level
 * is kept, and the correlation fields follow the message as `key=value`, in the order the
 * runtime gave them. The runtime never puts task input, evidence content or tool arguments there.
 */
export class NestRuntimeLogger implements RuntimeLogger {
  private readonly logger: Logger;

  constructor(context: string) {
    this.logger = new Logger(context);
  }

  log(message: string, fields?: RuntimeLogFields): void {
    this.logger.log(withFields(message, fields));
  }

  warn(message: string, fields?: RuntimeLogFields): void {
    this.logger.warn(withFields(message, fields));
  }

  error(message: string, fields?: RuntimeLogFields): void {
    this.logger.error(withFields(message, fields));
  }
}
