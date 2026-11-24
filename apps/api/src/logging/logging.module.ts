import { Global, Module } from '@nestjs/common';
import { LOGGER } from '@agent-os/common';
import { createAppLogger } from './app-logger';
import { NestLoggerAdapter } from './nest-logger.adapter';

/** The application logger, built once at start and available to every module (logging.md). */
@Global()
@Module({
  providers: [
    { provide: LOGGER, useFactory: () => createAppLogger(process.env) },
    NestLoggerAdapter,
  ],
  exports: [LOGGER, NestLoggerAdapter],
})
export class LoggingModule {}
