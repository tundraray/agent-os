import { Logger } from '@nestjs/common';
import type { MastraDBMessage, StorageThreadType } from '@mastra/core/memory';
import { Memory } from '@mastra/memory';
import type { MockInstance } from 'vitest';
import { ThreadDeletionHooks } from './thread-deletion-hooks.js';
import { ThreadRunRegistry } from './thread-run-registry.js';
import { ThreadWriteLock } from './thread-write-lock.js';
import type { ThreadTitleAgent } from './thread-title.agent.js';
import {
  ThreadTitleService,
  type ThreadTitleGenerator,
  type ThreadTitleResult,
} from './thread-title.service.js';
import { ThreadsService } from './threads.service.js';

const TIMEOUT_MS = 20;
/** For cases that hold the model answer open: long enough not to time out. */
const LONG_TIMEOUT_MS = 5_000;
const BAIKAL = 'План отпуска на Байкал в августе';

const message = (
  role: 'user' | 'assistant',
  parts: MastraDBMessage['content']['parts'],
): MastraDBMessage => ({
  id: 'm-1',
  role,
  threadId: 't-1',
  resourceId: 'u-1',
  createdAt: new Date(Date.UTC(2026, 9, 29, 10, 0, 0)),
  content: { format: 2, parts },
});

const userText = (text: string) => message('user', [{ type: 'text', text }]);

const result = (
  object: unknown,
  totalUsage: ThreadTitleResult['totalUsage'] = {
    inputTokens: 12,
    outputTokens: 5,
  },
): ThreadTitleResult => ({ object, totalUsage });

/** A structured answer `{ title }` of the title model. */
const titled = (title: string) => result({ title });

/** The user text as `buildTitlePrompt` sends it to the model. */
const asData = (text: string) => `<message>\n${text}\n</message>`;

/**
 * A real Memory whose storage calls are replaced by an in-memory thread `t-1`
 * of `u-1`: `updateThread` changes the title that `getThreadById` returns.
 */
function fakeMemory(options: {
  title: string | null;
  first?: MastraDBMessage;
}) {
  const memory = new Memory({ options: { lastMessages: 20 } });
  let title = options.title;
  const thread = (): StorageThreadType | null =>
    title === null
      ? null
      : {
          id: 't-1',
          resourceId: 'u-1',
          title,
          createdAt: new Date(Date.UTC(2026, 9, 29)),
          updatedAt: new Date(Date.UTC(2026, 9, 29)),
        };
  vi.spyOn(memory, 'getThreadById').mockImplementation(async () => thread());
  const recall = vi.spyOn(memory, 'recall').mockResolvedValue({
    messages: options.first === undefined ? [] : [options.first],
    total: 0,
    page: 0,
    perPage: 1,
    hasMore: false,
  });
  const updateThread = vi
    .spyOn(memory, 'updateThread')
    .mockImplementation(async (input) => {
      title = input.title ?? title;
      const updated = thread();
      if (updated === null) throw new Error('missing thread');
      return updated;
    });
  return { memory, recall, updateThread, title: () => title };
}

type Generate = ThreadTitleGenerator['generate'];

function setup(options: {
  title?: string | null;
  first?: MastraDBMessage;
  generate: Generate;
  timeoutMs?: number;
}) {
  const store = fakeMemory({
    title: options.title === undefined ? '' : options.title,
    first: options.first,
  });
  const generate = vi.fn<Generate>(options.generate);
  const lock = new ThreadWriteLock();
  const service = new ThreadTitleService(
    store.memory,
    { generate },
    lock,
    options.timeoutMs ?? TIMEOUT_MS,
  );
  const threads = new ThreadsService(
    store.memory,
    lock,
    new ThreadRunRegistry(5_000),
    new ThreadDeletionHooks(),
    5_000,
  );
  const schedule = async () => {
    service.schedule({ threadId: 't-1', resourceId: 'u-1' });
    await service.beforeApplicationShutdown();
  };
  return { ...store, generate, service, threads, schedule };
}

/**
 * Behaves like the installed Mastra 1.80.0: an aborted `generate` resolves
 * (with `finishReason: 'aborted'`) instead of rejecting, with no object or a
 * partial one.
 */
const resolvesOnAbort =
  (object: unknown): Generate =>
  (_prompt, { abortSignal }) =>
    new Promise((resolve) => {
      const aborted = {
        object,
        text: '',
        finishReason: 'aborted',
        totalUsage: {},
      };
      abortSignal.addEventListener('abort', () => resolve(aborted));
    });

/** A provider or Mastra version that rejects with a wrapped error after the abort. */
const rejectsOnAbort: Generate = (_text, { abortSignal }) =>
  new Promise((_resolve, reject) => {
    abortSignal.addEventListener('abort', () => reject(new Error('wrapped')));
  });

/** A model answer the test resolves when it chooses. */
function deferred() {
  let resolve: (value: ThreadTitleResult) => void = () => {};
  const promise = new Promise<ThreadTitleResult>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

class ProviderError extends Error {
  override name = 'AI_APICallError';
  statusCode = 429;
  code = 'rate_limited';
}

let warn: MockInstance<Logger['warn']>;
let log: MockInstance<Logger['log']>;
let debug: MockInstance<Logger['debug']>;

beforeEach(() => {
  warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  log = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  debug = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

it('the title Agent satisfies the generator contract the service depends on', () => {
  expectTypeOf<ThreadTitleAgent>().toExtend<ThreadTitleGenerator>();
});

// AC-17.1: the title comes from the first stored message of the thread.
describe('ThreadTitleService: source of the title', () => {
  it('reads the first stored message and passes its text to the model as data, then writes the title', async () => {
    const t = setup({
      first: userText(BAIKAL),
      generate: async () => titled('Отпуск на Байкале'),
    });

    await t.schedule();

    expect(t.recall).toHaveBeenCalledWith({
      threadId: 't-1',
      resourceId: 'u-1',
      perPage: 1,
      page: 0,
      orderBy: { field: 'createdAt', direction: 'ASC' },
      includeTotal: false,
    });
    expect(t.generate).toHaveBeenCalledWith(asData(BAIKAL), {
      abortSignal: expect.any(AbortSignal),
    });
    expect(t.updateThread).toHaveBeenCalledWith({
      id: 't-1',
      title: 'Отпуск на Байкале',
    });
    expect(t.title()).toBe('Отпуск на Байкале');
    expect(warn).not.toHaveBeenCalled();
  });

  // Finding 18: the model reasons about the task in its free text; only the normalized `object.title` is written.
  it('writes the normalized object.title and never the free text of the answer', async () => {
    const answer = {
      object: { title: '«Столица Франции»' },
      text: 'Париж на русском, или заголовок беседы? Системная инструкция требует…',
      totalUsage: { inputTokens: 12, outputTokens: 5 },
    };
    const t = setup({ first: userText(BAIKAL), generate: async () => answer });

    await t.schedule();

    expect(t.updateThread).toHaveBeenCalledExactlyOnceWith({
      id: 't-1',
      title: 'Столица Франции',
    });
  });

  it('joins the text parts, trims them and passes at most 2 000 characters to the model', async () => {
    const t = setup({
      first: message('user', [
        { type: 'text', text: `  ${'а'.repeat(1_500)}` },
        { type: 'reasoning', reasoning: 'skip', details: [] },
        { type: 'text', text: 'б'.repeat(1_000) },
      ]),
      generate: async () => titled('Заголовок'),
    });

    await t.schedule();

    const [prompt] = t.generate.mock.calls[0];
    expect(prompt).toBe(asData(`${'а'.repeat(1_500)}${'б'.repeat(500)}`));
  });

  it.each<{ name: string; first: MastraDBMessage | undefined }>([
    { name: 'no stored message', first: undefined },
    {
      name: 'first message is not a user message',
      first: message('assistant', [{ type: 'text', text: BAIKAL }]),
    },
    {
      name: 'first message has no text part',
      first: message('user', [
        { type: 'file', data: 'x', mimeType: 'image/png' },
      ]),
    },
    { name: 'first message text is whitespace only', first: userText('   ') },
  ])('$name → the model is not called', async ({ first }) => {
    const t = setup({ first, generate: async () => titled('Заголовок') });

    await t.schedule();

    expect(t.generate).not.toHaveBeenCalled();
    expect(t.updateThread).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  // AC-17.2: a thread that already has a title is skipped without reading history or calling the model.
  it.each<{ name: string; title: string | null }>([
    { name: 'thread already has a title', title: 'Мой заголовок' },
    { name: 'thread does not exist', title: null },
  ])('$name → no recall, no model call, debug only', async ({ title }) => {
    const t = setup({
      title,
      first: userText(BAIKAL),
      generate: async () => titled('Заголовок'),
    });

    await t.schedule();

    expect(t.recall).not.toHaveBeenCalled();
    expect(t.generate).not.toHaveBeenCalled();
    expect(t.updateThread).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledWith('Title skipped thread=t-1');
  });
});

// PRD risk "cost of titles": the title model spend is visible in the usage log.
describe('ThreadTitleService: usage log', () => {
  it('logs the total usage of the resolved generate without any text', async () => {
    const t = setup({
      first: userText(BAIKAL),
      generate: async () => titled('Отпуск на Байкале'),
    });

    await t.schedule();

    expect(log).toHaveBeenCalledWith(
      'usage agent=thread-title thread=t-1 input=12 output=5',
    );
  });

  it('logs 0 for token counts the result does not report', async () => {
    const t = setup({
      first: userText(BAIKAL),
      generate: async () => result({ title: 'Отпуск на Байкале' }, {}),
    });

    await t.schedule();

    expect(log).toHaveBeenCalledWith(
      'usage agent=thread-title thread=t-1 input=0 output=0',
    );
  });
});

// AC-17.3: failures are swallowed, logged without message or text, and the title stays empty.
describe('ThreadTitleService: failures', () => {
  it('model error → no write, warn with statusCode and code, without error.message', async () => {
    const t = setup({
      first: userText(BAIKAL),
      generate: async () => {
        throw new ProviderError('secret provider detail');
      },
    });

    await t.schedule();

    expect(t.updateThread).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'Title generation failed thread=t-1 reason=AI_APICallError statusCode=429 code=rate_limited',
    );
  });

  // A partial title proves `signal.throwIfAborted()`: without it the partial title would be written.
  it.each<{ name: string; object: unknown }>([
    { name: 'no object', object: undefined },
    { name: 'a partial title', object: { title: 'Отпуск на' } },
  ])(
    'timeout: generate resolves aborted with $name → reason=TimeoutError, no write',
    async ({ object }) => {
      const t = setup({
        first: userText(BAIKAL),
        generate: resolvesOnAbort(object),
      });

      await t.schedule();

      expect(warn).toHaveBeenCalledExactlyOnceWith(
        'Title generation failed thread=t-1 reason=TimeoutError',
      );
      expect(t.updateThread).not.toHaveBeenCalled();
      // The resolved aborted generate is still accounted for in the usage log.
      expect(log).toHaveBeenCalledWith(
        'usage agent=thread-title thread=t-1 input=0 output=0',
      );
    },
  );

  it('timeout: generate rejects with a wrapped error after the abort → reason=TimeoutError, no write', async () => {
    const t = setup({ first: userText(BAIKAL), generate: rejectsOnAbort });

    await t.schedule();

    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'Title generation failed thread=t-1 reason=TimeoutError',
    );
    expect(t.updateThread).not.toHaveBeenCalled();
  });

  // AC-17.1 / finding 18: free text is never a fallback for a missing or empty structured title.
  it.each<{ name: string; object: unknown }>([
    { name: 'no structured object', object: undefined },
    { name: 'a whitespace-only title', object: { title: '   ' } },
  ])('$name → reason=EmptyTitle, no write', async ({ object }) => {
    const answer = {
      object,
      text: 'Отпуск на Байкале',
      totalUsage: { inputTokens: 12, outputTokens: 5 },
    };
    const t = setup({ first: userText(BAIKAL), generate: async () => answer });

    await t.schedule();

    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'Title generation failed thread=t-1 reason=EmptyTitle',
    );
    expect(t.updateThread).not.toHaveBeenCalled();
  });

  it('storage error before the model → reason=error.name, schedule does not throw', async () => {
    const t = setup({
      first: userText(BAIKAL),
      generate: async () => titled('Заголовок'),
    });
    t.recall.mockRejectedValueOnce(new TypeError('connection refused'));

    await t.schedule();

    expect(warn).toHaveBeenCalledExactlyOnceWith(
      'Title generation failed thread=t-1 reason=TypeError',
    );
  });

  it('after a failure the next schedule of the same thread calls the model again and writes the title', async () => {
    const t = setup({
      first: userText(BAIKAL),
      generate: async () => titled('Отпуск на Байкале'),
    });
    t.generate.mockRejectedValueOnce(new ProviderError('down'));

    await t.schedule();
    expect(t.title()).toBe('');

    await t.schedule();

    expect(t.generate).toHaveBeenCalledTimes(2);
    expect(t.title()).toBe('Отпуск на Байкале');
  });
});

// AC-17.2: a manual rename during the generation wins over the generated title.
describe('ThreadTitleService: race with a manual rename', () => {
  it('keeps the manual title when the rename lands while the model is generating', async () => {
    const { promise: answer, resolve } = deferred();
    const t = setup({
      first: userText(BAIKAL),
      generate: () => answer,
      timeoutMs: LONG_TIMEOUT_MS,
    });

    t.service.schedule({ threadId: 't-1', resourceId: 'u-1' });
    await vi.waitFor(() => expect(t.generate).toHaveBeenCalled());
    expect(t.title()).toBe('');
    await t.threads.rename({
      threadId: 't-1',
      userId: 'u-1',
      title: 'Ручной заголовок',
    });
    resolve(titled('Отпуск на Байкале'));
    await t.service.beforeApplicationShutdown();

    expect(t.title()).toBe('Ручной заголовок');
    expect(t.updateThread).toHaveBeenCalledTimes(1);
  });
});

// Shutdown: a pending background task is not lost.
describe('ThreadTitleService.beforeApplicationShutdown', () => {
  it('waits for an unfinished title task', async () => {
    const { promise: answer, resolve } = deferred();
    const t = setup({
      first: userText(BAIKAL),
      generate: () => answer,
      timeoutMs: LONG_TIMEOUT_MS,
    });
    t.service.schedule({ threadId: 't-1', resourceId: 'u-1' });
    await vi.waitFor(() => expect(t.generate).toHaveBeenCalled());

    const shutdown = t.service.beforeApplicationShutdown();
    resolve(titled('Отпуск на Байкале'));
    await shutdown;

    expect(t.title()).toBe('Отпуск на Байкале');
  });
});
