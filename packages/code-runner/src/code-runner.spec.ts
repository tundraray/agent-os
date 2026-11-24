import { createLogger } from '@agent-os/common';
import { createCodeRunner } from './code-runner';

// Security review (defense gap): Node's permission model denies network only from v25, and this
// project requires 26; on an older Node the executor would run with TCP and DNS open, so the runner
// refuses to be created. Nothing is spawned at construction.
describe('the code runner refuses a Node that leaves the executor network open', () => {
  const logger = createLogger({ sinks: [], secrets: [], minLevel: 'error' });
  const realVersion = process.versions.node;

  afterEach(() => {
    Object.defineProperty(process.versions, 'node', { value: realVersion });
  });

  it.each([
    ['24.11.0', true],
    ['25.9.0', true],
    ['26.0.0', false],
  ])('Node %s: refused %s', (version, refused) => {
    Object.defineProperty(process.versions, 'node', { value: version });
    const create = (): unknown =>
      createCodeRunner({ maxConcurrent: 1, logger });

    if (refused)
      expect(create).toThrow(`Node ${version} cannot run the code executor`);
    else expect(create).not.toThrow();
  });
});
