import 'reflect-metadata';
import { LOGGER, type Logger } from '@agent-os/common';
import {
  type DynamicModule,
  type FactoryProvider,
  Global,
  Inject,
  Module,
  type ModuleMetadata,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { Db } from './db';
import { DATABASE, DATABASE_CONNECTION } from './db.tokens';
import { REPOSITORIES } from './repositories';
import {
  createDatabase,
  type DatabaseConnection,
  type DatabaseOptions,
  logClientErrors,
} from './database';

const DATABASE_OPTIONS = Symbol('DATABASE_OPTIONS');

/** Where the composition root gets the settings of the pool from. */
type DbModuleOptions = Pick<ModuleMetadata, 'imports'> &
  Pick<FactoryProvider<DatabaseOptions | Promise<DatabaseOptions>>, 'inject' | 'useFactory'>;

/**
 * The database of the process: one pool, its Drizzle client and the repositories, available to
 * every module. The pool logs its clients' errors through `LOGGER`, which the composition root
 * provides globally, and ends in `onApplicationShutdown` — after the runtime workers have stopped
 * in `beforeApplicationShutdown`.
 */
@Global()
@Module({})
export class DbModule implements OnApplicationShutdown {
  static forRootAsync(options: DbModuleOptions): DynamicModule {
    return {
      module: DbModule,
      imports: options.imports ?? [],
      providers: [
        {
          provide: DATABASE_OPTIONS,
          inject: options.inject ?? [],
          useFactory: options.useFactory,
        },
        {
          provide: DATABASE_CONNECTION,
          inject: [DATABASE_OPTIONS, LOGGER],
          useFactory: (settings: DatabaseOptions, logger: Logger): DatabaseConnection => {
            const connection = createDatabase(settings);
            logClientErrors(connection.pool, logger.child({ component: 'db' }));
            return connection;
          },
        },
        {
          provide: DATABASE,
          inject: [DATABASE_CONNECTION],
          useFactory: (connection: DatabaseConnection) => connection.db,
        },
        Db,
        ...REPOSITORIES,
      ],
      exports: [DATABASE_CONNECTION, DATABASE, Db, ...REPOSITORIES],
    };
  }

  constructor(@Inject(DATABASE_CONNECTION) private readonly connection: DatabaseConnection) {}

  async onApplicationShutdown(): Promise<void> {
    await this.connection.close();
  }
}
