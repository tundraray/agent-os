import 'reflect-metadata';
import { LOGGER, type Logger } from '@agent-os/common';
import {
  type DynamicModule,
  type FactoryProvider,
  Global,
  Module,
  type ModuleMetadata,
} from '@nestjs/common';
import { systemClock } from './clock';
import { CrashPoints } from './crash-points';
import { TokenLedger } from './ledger/token-ledger';
import { Inbox } from './messaging/inbox';
import type { RuntimeConfig } from './runtime-config';
import { CLOCK, RUNTIME_CONFIG, RUNTIME_LOGGER } from './runtime.tokens';
import { Dispatcher } from './steps/dispatcher';
import { HandlerRegistry } from './steps/handler.registry';
import { LiveTasks } from './steps/live-tasks';
import { StepCommitter } from './steps/step-commit';
import { RunningTaskRegistry } from './tasks/running-task.registry';
import { TaskControl } from './tasks/task-control';
import { TaskEndHooks } from './tasks/task-end-hooks';
import { TaskInterruptHooks } from './tasks/task-interrupt-hooks';
import { Tasks } from './tasks/tasks';
import { BackgroundPasses } from './workers/background-passes';
import { RecoverySweeper } from './workers/recovery.sweeper';
import { RuntimeWorkers } from './workers/runtime-workers';

/** Where the composition root gets the runtime settings from (parsed by `parseRuntimeConfig`). */
type RuntimeModuleOptions = Pick<ModuleMetadata, 'imports'> &
  Pick<
    FactoryProvider<RuntimeConfig | Promise<RuntimeConfig>>,
    'inject' | 'useFactory'
  >;

/** What the modules above the runtime inject. */
const PUBLIC_SERVICES = [
  HandlerRegistry,
  TaskEndHooks,
  TaskInterruptHooks,
  BackgroundPasses,
  TaskControl,
  Inbox,
  TokenLedger,
  RuntimeWorkers,
  LiveTasks,
];

/**
 * The task runtime (ADR-0001, design-runtime.md), available to every module: tasks run in steps,
 * each step ends in one transaction. It works over the pool and the
 * repositories of `DbModule` and logs through `LOGGER`, both provided globally by the composition
 * root; the package reads no environment (ADR-0004).
 *
 * Upper modules register their handlers (`HandlerRegistry`), task end hooks (`TaskEndHooks`), the
 * interrupt hook (`TaskInterruptHooks`) and background passes (`BackgroundPasses`) in `onModuleInit`;
 * `RuntimeWorkers` starts the workers in `onApplicationBootstrap` and stops them in
 * `beforeApplicationShutdown`.
 */
@Global()
@Module({})
export class RuntimeModule {
  static forRootAsync(options: RuntimeModuleOptions): DynamicModule {
    return {
      module: RuntimeModule,
      imports: options.imports ?? [],
      providers: [
        {
          provide: RUNTIME_CONFIG,
          inject: options.inject ?? [],
          useFactory: options.useFactory,
        },
        { provide: CLOCK, useValue: systemClock },
        {
          provide: RUNTIME_LOGGER,
          inject: [LOGGER],
          useFactory: (logger: Logger): Logger =>
            logger.child({ component: 'runtime' }),
        },
        {
          provide: CrashPoints,
          inject: [RUNTIME_CONFIG],
          useFactory: (config: RuntimeConfig): CrashPoints =>
            CrashPoints.fromConfig(config),
        },
        RunningTaskRegistry,
        Tasks,
        StepCommitter,
        Dispatcher,
        RecoverySweeper,
        ...PUBLIC_SERVICES,
      ],
      exports: [CLOCK, ...PUBLIC_SERVICES],
    };
  }
}
