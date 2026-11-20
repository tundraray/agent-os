import { Inject, Injectable, type OnApplicationBootstrap } from '@nestjs/common';
import type { AgentsConfig } from '@agent-os/agents';
import type { Logger } from '@agent-os/common';
import { AGENTS_SETTINGS } from '../agents/agents.tokens.js';
import { APP_LOGGER } from '../logging/app-logger.js';
import { builtinRecords } from './builtin-records.js';
import { LibraryService } from './library.service.js';

/**
 * Seeds the built-in records (design-runtime.md, KD-7, DC-1): at application bootstrap — after every
 * `onModuleInit`, the migration check of `RuntimeModule` among them, and before requests are taken. A
 * missing record is created with its constant id; an existing one, edited or renamed, is left as it is.
 */
@Injectable()
export class BuiltinRecordsSeeder implements OnApplicationBootstrap {
  private readonly logger: Logger;

  constructor(
    private readonly library: LibraryService,
    @Inject(AGENTS_SETTINGS) private readonly settings: AgentsConfig,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'library.seed' });
  }

  async onApplicationBootstrap(): Promise<void> {
    for (const record of builtinRecords(this.settings.defaultModel)) {
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
