import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import { LOGGER, type Logger } from '@agent-os/common';
import { builtinRecords } from './builtin-records';
import { LibraryService } from './library.service';

/**
 * Seeds the built-in records (design-runtime.md, KD-7, DC-1): at application bootstrap — after every
 * `onModuleInit`, the migration check of `ApiRuntimeModule` among them, and before requests are taken. A
 * missing record is created with its constant id; an existing one, edited or renamed, is left as it is.
 */
@Injectable()
export class BuiltinRecordsSeeder implements OnApplicationBootstrap {
  private readonly logger: Logger;

  constructor(
    private readonly library: LibraryService,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'library.seed' });
  }

  async onApplicationBootstrap(): Promise<void> {
    for (const record of builtinRecords()) {
      const created = await this.library.seedBuiltin(record);
      this.logger.info(
        created ? 'built-in record created' : 'built-in record exists',
        {
          builtinKey: record.builtinKey,
          recordId: record.id,
          outcome: created ? 'created' : 'exists',
        },
      );
    }
  }
}
