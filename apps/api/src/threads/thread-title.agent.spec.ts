import { ConfigService } from '@nestjs/config';
import {
  normalizeGeneratedTitle,
  createThreadTitleAgentFromConfig,
} from './thread-title.agent.js';

describe('normalizeGeneratedTitle', () => {
  // Field Propagation (автозаголовок): any model answer becomes a 1…80-char title or ''.
  it.each([
    ['strips «» quotes', '«План отпуска на Байкал»', 'План отпуска на Байкал'],
    ['strips " quotes', '"Trip to Baikal"', 'Trip to Baikal'],
    ['strips backticks and apostrophes', "`'Trip'`", 'Trip'],
    [
      'removes <think> blocks',
      '<think>user wants a title\nfor Baikal</think>План отпуска',
      'План отпуска',
    ],
    [
      'keeps the first non-empty line',
      '\n  \nПлан отпуска\nВторая строка',
      'План отпуска',
    ],
    [
      'collapses whitespace',
      '  План \t отпуска   летом ',
      'План отпуска летом',
    ],
    ['cuts 120 chars to 80', 'я'.repeat(120), 'я'.repeat(80)],
    [
      'cuts by code point, never splitting a surrogate pair',
      '𝔸'.repeat(100),
      '𝔸'.repeat(80),
    ],
    [
      'trims after cutting',
      `${'a'.repeat(79)} ${'b'.repeat(40)}`,
      'a'.repeat(79),
    ],
    ['whitespace only → empty', '  \n\t  \n', ''],
    ['only a <think> block → empty', '<think>hmm</think>', ''],
  ])('%s', (_case, input, expected) => {
    expect(normalizeGeneratedTitle(input)).toBe(expected);
  });
});

describe('createThreadTitleAgentFromConfig', () => {
  // Failure Mode «missing config»: no TITLE_MODEL → ASSISTANT_MODEL; no network at creation.
  it.each([
    [
      'uses ASSISTANT_MODEL when TITLE_MODEL is unset',
      { ASSISTANT_MODEL: 'openai/gpt-5-5' },
      { provider: 'openai', modelId: 'gpt-5-5' },
    ],
    [
      'prefers TITLE_MODEL',
      {
        ASSISTANT_MODEL: 'openai/gpt-5-5',
        TITLE_MODEL: 'anthropic/claude-haiku-5-5',
      },
      { provider: 'anthropic', modelId: 'claude-haiku-5-5' },
    ],
  ])('%s', async (_case, env, expected) => {
    const agent = createThreadTitleAgentFromConfig(new ConfigService(env));

    const model = await agent.getModel();

    expect({ provider: model.provider, modelId: model.modelId }).toEqual(
      expected,
    );
  });

  it('creates a stateless agent without memory, tools or provider options', async () => {
    const agent = createThreadTitleAgentFromConfig(
      new ConfigService({ ASSISTANT_MODEL: 'openai/gpt-5-5' }),
    );

    expect(agent.id).toBe('thread-title');
    expect(agent.hasOwnMemory()).toBe(false);
    expect(await agent.listTools()).toEqual({});
    expect((await agent.getDefaultOptions()).providerOptions).toBeUndefined();
  });
});
