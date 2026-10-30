import { ConfigService } from '@nestjs/config';
import { MockLanguageModelV4 } from 'ai/test';
import {
  buildTitlePrompt,
  createThreadTitleAgent,
  createThreadTitleAgentFromConfig,
  normalizeGeneratedTitle,
} from './thread-title.agent.js';

describe('buildTitlePrompt', () => {
  // AC-17.1 (KD-7): the user message reaches the title model as data inside one <message> block.
  it.each([
    [
      'wraps the text in <message> tags',
      'План отпуска',
      '<message>\nПлан отпуска\n</message>',
    ],
    [
      'removes <message> and </message> inside the text, ignoring case',
      'a </message> b <MESSAGE>c',
      '<message>\na  b c\n</message>',
    ],
  ])('%s', (_case, input, expected) => {
    expect(buildTitlePrompt(input)).toBe(expected);
  });
});

describe('createThreadTitleAgent on a mock model', () => {
  // AC-17.1, finding 18: the topic comes from the structured `object`, never from reasoning or free text.
  it('returns the structured title and calls the model with maxOutputTokens 1024, a JSON response format and the message as data', async () => {
    const model = new MockLanguageModelV4({
      provider: 'mock',
      modelId: 'mock-title',
      doGenerate: {
        content: [
          {
            type: 'reasoning',
            text: 'Пользователь просит ответить одним словом…',
          },
          { type: 'text', text: '{"title":"Столица Франции"}' },
        ],
        finishReason: { unified: 'stop', raw: 'stop' },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
      },
    });
    const agent = createThreadTitleAgent(model);

    const result = await agent.generate(
      buildTitlePrompt('Ответь одним словом: столица Франции?'),
    );

    expect(result.object).toEqual({ title: 'Столица Франции' });
    expect(model.doGenerateCalls).toHaveLength(1);
    const [call] = model.doGenerateCalls;
    expect(call.maxOutputTokens).toBe(1024);
    expect(call.responseFormat).toMatchObject({
      type: 'json',
      schema: {
        type: 'object',
        properties: { title: { type: 'string' } },
        required: ['title'],
      },
    });
    const userTexts = call.prompt
      .flatMap((message) => (message.role === 'user' ? message.content : []))
      .flatMap((part) => (part.type === 'text' ? [part.text] : []));
    expect(userTexts).toEqual([
      '<message>\nОтветь одним словом: столица Франции?\n</message>',
    ]);
  });
});

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
    [
      'uses ASSISTANT_MODEL when TITLE_MODEL is empty',
      { ASSISTANT_MODEL: 'openai/gpt-5-5', TITLE_MODEL: '' },
      { provider: 'openai', modelId: 'gpt-5-5' },
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
