import { parseEngineSettings } from './engine-settings.js';

// Risk: an invalid base starts the engine against a wrong address, or the error does not name the variable; the
// engine picks up the chat agent's base variable (a base with the version) and calls `<base>/v1/v1`.
describe('parseEngineSettings - RESEARCH_ANTHROPIC_BASE_URL', () => {
  it.each<[string, Record<string, string>, string]>([
    ['unset', {}, 'https://api.anthropic.com'],
    ['empty', { RESEARCH_ANTHROPIC_BASE_URL: '' }, 'https://api.anthropic.com'],
    [
      'set with a path',
      { RESEARCH_ANTHROPIC_BASE_URL: 'http://127.0.0.1:8080/proxy' },
      'http://127.0.0.1:8080/proxy',
    ],
    [
      'unset while the chat variable ANTHROPIC_BASE_URL is set',
      { ANTHROPIC_BASE_URL: 'http://chat-proxy.local/v1' },
      'https://api.anthropic.com',
    ],
  ])('takes the base when %s', (_, env, expected) => {
    const settings = parseEngineSettings((name) => env[name]);

    expect(settings.anthropicBaseUrl).toBe(expected);
  });

  it.each([['not-a-url'], ['ftp://api.anthropic.com']])(
    'stops the start naming the variable for %s',
    (value) => {
      const env: Record<string, string> = {
        RESEARCH_ANTHROPIC_BASE_URL: value,
      };

      expect(() => parseEngineSettings((name) => env[name])).toThrow(
        /RESEARCH_ANTHROPIC_BASE_URL/,
      );
    },
  );
});

// Risk: an agent setting starts with a default other than the design's, or an invalid value starts the engine with
// NaN timings instead of stopping the start naming the variable (design-agent-core.md, Runtime Settings).
describe('parseEngineSettings - agent settings', () => {
  it.each<[string, Record<string, string>, Record<string, number | string>]>([
    [
      'all unset',
      {},
      {
        attemptSliceMs: 300000,
        busyWaitMs: 30000,
        turnMs: 60000,
        deadlineMarginMs: 90000,
        memoryAdminRole: 'agent-memory-admin',
      },
    ],
    [
      'all set',
      {
        AGENT_ATTEMPT_SLICE_MS: '1000',
        AGENT_BUSY_WAIT_MS: '2000',
        AGENT_TURN_MS: '3000',
        AGENT_DEADLINE_MARGIN_MS: '4000',
        AGENT_MEMORY_ADMIN_ROLE: 'ops',
      },
      {
        attemptSliceMs: 1000,
        busyWaitMs: 2000,
        turnMs: 3000,
        deadlineMarginMs: 4000,
        memoryAdminRole: 'ops',
      },
    ],
    [
      'all empty',
      {
        AGENT_ATTEMPT_SLICE_MS: '',
        AGENT_BUSY_WAIT_MS: '',
        AGENT_TURN_MS: '',
        AGENT_DEADLINE_MARGIN_MS: '',
        AGENT_MEMORY_ADMIN_ROLE: '',
      },
      {
        attemptSliceMs: 300000,
        busyWaitMs: 30000,
        turnMs: 60000,
        deadlineMarginMs: 90000,
        memoryAdminRole: 'agent-memory-admin',
      },
    ],
  ])('takes the agent settings when %s', (_, env, expected) => {
    expect(parseEngineSettings((name) => env[name]).agent).toEqual(expected);
  });

  it.each([
    ['AGENT_ATTEMPT_SLICE_MS', '0'],
    ['AGENT_BUSY_WAIT_MS', 'abc'],
    ['AGENT_TURN_MS', '1.5'],
    ['AGENT_DEADLINE_MARGIN_MS', '-90000'],
  ])('stops the start naming %s for "%s"', (variable, value) => {
    const env: Record<string, string> = { [variable]: value };

    expect(() => parseEngineSettings((name) => env[name])).toThrow(
      new RegExp(`^${variable} `),
    );
  });
});
