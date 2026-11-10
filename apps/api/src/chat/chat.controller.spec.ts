import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { pipeUIMessageStreamToResponse } from 'ai';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { MASTRA } from '../mastra/mastra.constants.js';
import { ResearchLaunchService } from '../research-chat/research-launch.service.js';
import { THREAD_MEMORY } from '../threads/thread-memory.provider.js';
import { ThreadTitleService } from '../threads/thread-title.service.js';
import { ThreadRunRegistry } from '../threads/thread-run-registry.js';
import { threadNotFound } from '../threads/threads.errors.js';
import { ThreadsService } from '../threads/threads.service.js';
import { ChatController } from './chat.controller.js';

// The UI conversion is not under test: an empty agent stream; the SSE pipe is controlled per test.
vi.mock('@mastra/ai-sdk', () => ({
  toAISdkStream: () =>
    new ReadableStream({
      start(controller) {
        controller.close();
      },
    }),
}));
vi.mock('ai', async (importOriginal) => ({
  ...(await importOriginal<typeof import('ai')>()),
  pipeUIMessageStreamToResponse: vi.fn(),
}));

/** A promise with its resolver, settled by the test. */
function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** A fake Mastra output: `finishReason` rejects at once; `consumeStream` ends after the deferred "save". */
function fakeOutput(journal: string[], save: Promise<void>) {
  const finishReason = Promise.reject(new Error('stream error'));
  finishReason.catch(() => undefined);
  return {
    finishReason,
    consumeStream: async () => {
      await save;
      journal.push('save');
    },
  };
}

async function startController(options: {
  signal: AbortSignal;
  output: object;
  journal?: string[];
}) {
  const release = vi.fn();
  const stream = vi.fn(() => Promise.resolve(options.output));
  const runs = {
    register: vi.fn(() => {
      options.journal?.push('register');
      return {
        signal: options.signal,
        abort: vi.fn(),
        mark: vi.fn(() => {
          options.journal?.push('mark');
          return Promise.resolve();
        }),
        release,
      };
    }),
  };
  const moduleRef = await Test.createTestingModule({
    controllers: [ChatController],
    providers: [
      { provide: MASTRA, useValue: { getAgent: () => ({ stream }) } },
      {
        provide: ThreadsService,
        useValue: {
          getOwnedThread: vi.fn(() => {
            options.journal?.push('getOwnedThread');
            return Promise.resolve({ id: 't-1' });
          }),
          discardRepliesAfter: vi.fn(() =>
            Promise.resolve({ repeated: false }),
          ),
        },
      },
      { provide: ThreadTitleService, useValue: { schedule: vi.fn() } },
      { provide: ThreadRunRegistry, useValue: runs },
      { provide: ConfigService, useValue: new ConfigService() },
      {
        provide: ResearchLaunchService,
        useValue: { supersedeProposals: vi.fn(() => Promise.resolve()) },
      },
      { provide: THREAD_MEMORY, useValue: {} },
    ],
  }).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  await app.init();
  return { app, release, stream, runs };
}

const chatBody = {
  id: 't-1',
  messages: [
    { id: 'm-1', role: 'user', parts: [{ type: 'text', text: 'Вопрос' }] },
  ],
};

// AC-16.1 (b), KD-6: the chat registers its run before the ownership check, writes the run's mark only after it, and
// releases the run once Mastra's save is done.
describe('ChatController.chat run registration', () => {
  const apps: INestApplication[] = [];

  afterEach(async () => {
    for (const app of apps.splice(0)) await app.close();
    vi.mocked(pipeUIMessageStreamToResponse).mockReset();
  });

  it('a run cancelled by a delete answers 404 before streaming and is released once', async () => {
    const cancelled = new AbortController();
    cancelled.abort();
    vi.mocked(pipeUIMessageStreamToResponse).mockImplementation(
      ({ response }) => {
        response.writeHead(200).end();
        return Promise.resolve();
      },
    );
    const journal: string[] = [];
    const t = await startController({
      signal: cancelled.signal,
      output: {},
      journal,
    });
    apps.push(t.app);

    const res = await request(t.app.getHttpServer())
      .post('/chat/assistant')
      .set('x-user-id', 'u-1')
      .send(chatBody);

    expect(res.status).toBe(404);
    expect(res.body).toEqual(threadNotFound().getResponse());
    expect(t.runs.register).toHaveBeenCalledWith('t-1');
    expect(journal).toEqual(['register', 'getOwnedThread', 'mark']);
    expect(t.stream).not.toHaveBeenCalled();
    expect(t.release).toHaveBeenCalledTimes(1);
  });

  it('releases the run after consumeStream() has saved, not on the rejected finishReason and not after the SSE pipe', async () => {
    const journal: string[] = [];
    const save = deferred();
    const pipe = deferred();
    let pipeSettled = false;
    // Like the real pipe, the fake settles only when the whole SSE response is written.
    vi.mocked(pipeUIMessageStreamToResponse).mockImplementation(
      async ({ response }) => {
        await pipe.promise;
        response.writeHead(200).end();
        pipeSettled = true;
      },
    );
    const t = await startController({
      signal: new AbortController().signal,
      output: fakeOutput(journal, save.promise),
    });
    apps.push(t.app);
    t.release.mockImplementation(() => journal.push('release'));

    const chat = request(t.app.getHttpServer())
      .post('/chat/assistant')
      .set('x-user-id', 'u-1')
      .send(chatBody)
      .then((res) => res);
    await vi.waitFor(() =>
      expect(pipeUIMessageStreamToResponse).toHaveBeenCalled(),
    );

    // finishReason has already rejected; the save is still running.
    expect(journal).toEqual([]);
    save.resolve();
    await vi.waitFor(() => expect(journal).toEqual(['save', 'release']));
    // The SSE response is not finished yet when the run is released.
    pipe.resolve();
    const res = await chat;
    await vi.waitFor(() => expect(pipeSettled).toBe(true));

    expect(res.status).toBe(200);
    expect(t.stream).toHaveBeenCalledTimes(1);
    expect(t.release).toHaveBeenCalledTimes(1);
  });
});
