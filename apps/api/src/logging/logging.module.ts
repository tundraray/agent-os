import { Global, Module } from '@nestjs/common';
import { APP_LOGGER, createAppLogger } from './app-logger.js';
import { NestLoggerAdapter } from './nest-logger.adapter.js';

/** The application logger, built once at start and available to every module (logging.md). */
@Global()
@Module({
  providers: [
    { provide: APP_LOGGER, useFactory: () => createAppLogger(process.env) },
    NestLoggerAdapter,
  ],
  exports: [APP_LOGGER, NestLoggerAdapter],
})
export class LoggingModule {}
