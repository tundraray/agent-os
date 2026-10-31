import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FactoryProvider } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Mastra } from '@mastra/core/mastra';
import { mastraProvider } from './mastra.provider.js';

const SRC_DIR = fileURLToPath(new URL('..', import.meta.url));
const THIS_FILE = fileURLToPath(import.meta.url);

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

function createMastra(): Mastra {
  const config = new ConfigService({
    DATABASE_URL: 'postgres://unused:unused@127.0.0.1:1/unused',
  });
  const { useFactory } = mastraProvider as FactoryProvider<Mastra>;
  return useFactory(config) as Mastra;
}

// AC-RT-7 / ADR-0001: Mastra must not resume runs on boot, or it would
// duplicate effects the research runtime already owns.
describe('mastraProvider (AC-RT-7)', () => {
  it('turns run recovery off and registers no application workflows', () => {
    const mastra = createMastra();

    expect(mastra.recoveryConfig.workflows).toBe('off');
    expect(mastra.recoveryConfig.durableAgents).toBe('off');
    expect(Object.keys(mastra.listWorkflows())).toEqual([]);
  });

  it('never calls restartAllActiveWorkflowRuns anywhere in apps/api/src', () => {
    const callers = listSourceFiles(SRC_DIR).filter(
      (file) =>
        file !== THIS_FILE &&
        readFileSync(file, 'utf8').includes('restartAllActiveWorkflowRuns'),
    );

    expect(callers).toEqual([]);
  });
});
