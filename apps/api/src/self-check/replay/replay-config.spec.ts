import {
  deepResearchProcessV2,
  loadProcessConfig,
  type ProcessConfig,
} from '@agent-os/engine';
import { replayConfig, type ReplayConfigInput } from './replay-config.js';

const SONNET = 'anthropic/claude-sonnet-5-5';

function parsed(data: unknown): ProcessConfig {
  const result = loadProcessConfig(data);
  if (!result.ok)
    throw new Error(
      `fixture configuration rejected at ${result.rejection.path.join('.')}`,
    );
  return result.config;
}

const shipped = parsed(deepResearchProcessV2);
/** A frozen configuration that differs from the shipped one in the worker prompt text (UC-6a). */
const frozen = parsed({
  ...shipped,
  roles: {
    ...shipped.roles,
    worker: {
      ...shipped.roles.worker,
      prompt: `${shipped.roles.worker.prompt}\nKeep each step short.`,
    },
  },
});

function rolesExcept(config: ProcessConfig, role: string): unknown {
  return Object.fromEntries(
    Object.entries(config.roles).filter(([name]) => name !== role),
  );
}

// UC-6a, AC-02.2: the configuration the choice names is the one used, a model swap stays in its role.
describe('replay configuration', () => {
  it.each<[string, ReplayConfigInput, ProcessConfig]>([
    [
      'frozen gives the original configuration',
      { choice: 'frozen', frozen, roleModel: null },
      frozen,
    ],
    [
      'shipped gives the shipped deep-research',
      { choice: 'shipped', frozen, roleModel: null },
      shipped,
    ],
  ])('%s', (_, input, expected) => {
    expect(replayConfig(input)).toEqual({
      ok: true,
      choice: input.choice,
      processConfig: expected,
    });
  });

  it.each<[ReplayConfigInput['choice'], ProcessConfig]>([
    ['frozen', frozen],
    ['shipped', shipped],
  ])(
    '%s with another worker model swaps that role only and marks the choice',
    (choice, base) => {
      const result = replayConfig({
        choice,
        frozen,
        roleModel: { role: 'worker', model: SONNET },
      });
      if (!result.ok) throw new Error(`rejected at ${result.path.join('.')}`);
      expect(result.choice).toBe(choice);
      expect(result.processConfig.roles.worker).toEqual({
        ...base.roles.worker,
        model: SONNET,
      });
      expect(rolesExcept(result.processConfig, 'worker')).toEqual(
        rolesExcept(base, 'worker'),
      );
    },
  );

  it.each<[string, ReplayConfigInput['roleModel'], (string | number)[]]>([
    [
      'an unknown role',
      { role: 'planner', model: SONNET },
      ['roles', 'planner'],
    ],
    [
      'a model that is not provider/model',
      { role: 'worker', model: 'sonnet' },
      ['roles', 'worker', 'model'],
    ],
  ])(
    'refuses %s with process_config_rejected and the path',
    (_, roleModel, path) => {
      const result = replayConfig({ choice: 'frozen', frozen, roleModel });
      expect(result).toMatchObject({
        ok: false,
        code: 'process_config_rejected',
        path,
      });
    },
  );
});
