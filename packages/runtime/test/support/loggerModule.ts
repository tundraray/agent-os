import { LOGGER, type Logger } from '@agent-os/common';
import { type DynamicModule, Module } from '@nestjs/common';

@Module({})
class LoggerModule {}

/** What the logging module of `apps/api` does for the application: `LOGGER` for every module. */
export function loggerModule(logger: Logger): DynamicModule {
  return {
    module: LoggerModule,
    global: true,
    providers: [{ provide: LOGGER, useValue: logger }],
    exports: [LOGGER],
  };
}
