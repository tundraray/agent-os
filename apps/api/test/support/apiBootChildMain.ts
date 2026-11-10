import { Test } from '@nestjs/testing';
import { AppModule } from '../../src/app.module.js';
import { configureApp } from '../../src/app.setup.js';
import { ENGINE_GROUP_TABLES } from '../../src/engine/engine.tokens.js';
import { MastraLifecycle } from '../../src/mastra/mastra.lifecycle.js';
import { TEST_GROUP_TABLES } from './testGroupTables.js';

/**
 * Entry of the "api starts" row of `research-runtime-boot.e2e-spec.ts`, run only compiled (`pnpm --filter api
 * build:child` → `dist/test-child/`); `dist/main.js` and `src/` never import it. It starts the api the way `main.ts`
 * does — `AppModule`, `configureApp`, shutdown hooks, `listen(PORT)`, then the Mastra workers — with one difference:
 * `ENGINE_GROUP_TABLES` holds the test group table, so the start does not depend on the owner's real calibration
 * (`Engine.checkCalibration`, DC-10). Nothing else is doubled. A failed start exits non-zero, as `main.ts` does.
 */
async function bootstrap(): Promise<void> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(ENGINE_GROUP_TABLES)
    .useValue(TEST_GROUP_TABLES)
    .compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  app.enableShutdownHooks();
  await app.listen(process.env.PORT ?? 4000);
  await app.get(MastraLifecycle).start();
}

await bootstrap();
