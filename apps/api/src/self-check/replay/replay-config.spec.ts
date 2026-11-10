import { deepResearchProcessV3, type RunRecord } from '@agent-os/engine';
import { parseReplayArgs } from './replay-command.js';
import { replayConfig, type ReplayConfigInput } from './replay-config.js';

const SONNET = 'anthropic/claude-sonnet-5-5';

/** A frozen configuration without agents: data no swap can apply to. */
const frozenWithoutAgents = {
  processId: 'deep-research',
  version: 3,
} as unknown as ReplayConfigInput['frozen'];

type AgentsForm = Extract<
  RunRecord['config']['processConfig'],
  { agents: unknown }
>;

// AC-18.2: a v3 original is repeated on its own frozen configuration; a swap stays in its agent.
describe('replay configuration on the agents form', () => {
  const shippedV3 = deepResearchProcessV3 as AgentsForm;
  const worker = shippedV3.agents.worker;
  if (worker === undefined) throw new Error('the shipped v3 has a worker');
  /** A frozen v3 that differs from the shipped one in the worker prompt, so the choice is visible. */
  const frozenV3: AgentsForm = {
    ...shippedV3,
    agents: {
      ...shippedV3.agents,
      worker: { ...worker, prompt: `${worker.prompt}\nKeep each step short.` },
    },
  };

  it('takes the frozen configuration without a swap', () => {
    expect(
      replayConfig({
        choice: 'frozen',
        frozen: frozenV3,
        agentModels: [],
      }),
    ).toEqual({ ok: true, choice: 'frozen', processConfig: frozenV3 });
  });

  // The shipped configuration of a replay is v3, whatever the saved one is.
  it.each<[string, ReplayConfigInput['frozen']]>([
    ['a frozen v3', frozenV3],
    ['a frozen configuration without agents', frozenWithoutAgents],
  ])('--config shipped takes the shipped v3 over %s', (_, frozenConfig) => {
    expect(
      replayConfig({
        choice: 'shipped',
        frozen: frozenConfig,
        agentModels: [],
      }),
    ).toEqual({ ok: true, choice: 'shipped', processConfig: shippedV3 });
  });

  it('swaps exactly the named agents of the frozen configuration', () => {
    const result = replayConfig({
      choice: 'frozen',
      frozen: frozenV3,
      agentModels: [
        { agent: 'worker', model: SONNET },
        { agent: 'verifier', model: SONNET },
      ],
    });

    expect(result).toEqual({
      ok: true,
      choice: 'frozen',
      processConfig: {
        ...frozenV3,
        agents: {
          ...frozenV3.agents,
          worker: { ...frozenV3.agents.worker, model: SONNET },
          verifier: { ...frozenV3.agents.verifier, model: SONNET },
        },
      },
    });
  });

  it('refuses --agent-model over a frozen configuration without agents with invalid_arguments', () => {
    expect(
      replayConfig({
        choice: 'frozen',
        frozen: frozenWithoutAgents,
        agentModels: [{ agent: 'worker', model: SONNET }],
      }),
    ).toMatchObject({ ok: false, code: 'invalid_arguments' });
  });

  it('refuses an unknown agent at its path', () => {
    expect(
      replayConfig({
        choice: 'frozen',
        frozen: frozenV3,
        agentModels: [{ agent: 'no-such-agent', model: SONNET }],
      }),
    ).toMatchObject({
      ok: false,
      code: 'process_config_rejected',
      path: ['agents', 'no-such-agent', 'limits'],
    });
  });
});

describe('replay arguments', () => {
  const ORIGINAL = ['--investigation', 'one', '--owner', 'someone'];

  it.each<[string, string[], ReplayConfigInput['choice']]>([
    ['no choice repeats on the frozen configuration', [], 'frozen'],
    [
      '--config shipped takes the shipped one',
      ['--config', 'shipped'],
      'shipped',
    ],
  ])('%s', (_, flags, choice) => {
    expect(parseReplayArgs([...ORIGINAL, ...flags])).toMatchObject({
      ok: true,
      options: { choice },
    });
  });

  it('takes --agent-model repeated', () => {
    expect(
      parseReplayArgs([
        ...ORIGINAL,
        '--agent-model',
        'worker=a/b',
        '--agent-model',
        'planner=c/d',
      ]),
    ).toMatchObject({
      ok: true,
      options: {
        agentModels: [
          { agent: 'worker', model: 'a/b' },
          { agent: 'planner', model: 'c/d' },
        ],
      },
    });
  });

  it('refuses an agent named twice with invalid_arguments', () => {
    expect(
      parseReplayArgs([
        ...ORIGINAL,
        '--agent-model',
        'worker=a/b',
        '--agent-model',
        'worker=c/d',
      ]),
    ).toMatchObject({ ok: false, code: 'invalid_arguments' });
  });
});
