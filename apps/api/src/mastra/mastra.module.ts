import { Global, Module } from '@nestjs/common';
import { mastraProvider } from './mastra.provider.js';
import { MastraLifecycle } from './mastra.lifecycle.js';
import { MASTRA } from './mastra.constants.js';

@Global()
@Module({
  providers: [mastraProvider, MastraLifecycle],
  exports: [MASTRA, MastraLifecycle],
})
export class MastraModule {}
