import { type AgentsConfig, parseAgentsConfig } from './config';

// Runtime settings (design-agents.md, «Сборка»): a wrong setting stops the start, naming the variable.

describe('agents configuration refuses to start naming the variable', () => {
  it.each<[string, () => unknown, RegExp]>([
    [
      'AGENT_MAX_DEPTH=0',
      () => parseAgentsConfig({ AGENT_MAX_DEPTH: '0' }),
      /AGENT_MAX_DEPTH/,
    ],
    [
      'CODE_RUN_MAX_CONCURRENT_PER_USER=0',
      () => parseAgentsConfig({ CODE_RUN_MAX_CONCURRENT_PER_USER: '0' }),
      /CODE_RUN_MAX_CONCURRENT_PER_USER/,
    ],
  ])('refuses %s', (_, start, problem) => {
    expect(start).toThrow(problem);
  });

  it('starts with the defaults of Runtime settings when everything is right', () => {
    const expected: AgentsConfig = {
      maxOutputTokens: 16_000,
      maxDepth: 3,
      compactAtTokens: 200_000,
      mcpCallTimeoutMs: 60_000,
      allowHttpUrls: true,
      codeRun: {
        timeoutMs: 30_000,
        memoryMb: 512,
        maxToolCalls: 50,
        maxConcurrent: 4,
        maxConcurrentPerUser: 2,
        resultMaxBytes: 16_384,
      },
    };

    const config = parseAgentsConfig({ AGENT_MAX_DEPTH: '' });

    expect(config).toEqual(expected);
  });
});
