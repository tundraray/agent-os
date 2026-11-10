import type { DatabaseConnection } from '@agent-os/db';
import {
  buildResearchAnswer,
  type Engine,
  type ReadAnswerMessageResult,
  type StartInvestigationResult,
} from '@agent-os/engine';
import type { Clock, Runtime } from '@agent-os/runtime';
import type { Memory } from '@mastra/memory';
import type { ThreadRunRegistry } from '../threads/thread-run-registry.js';
import type { ThreadsService } from '../threads/threads.service.js';
import type { LaunchRecord } from './launch-state.js';
import {
  type AnswerAppenderSettings,
  ResearchAnswerAppender,
} from './research-answer.appender.js';
import { researchLaunchRepository } from './research-launch.repository.js';
import { ResearchLaunchService } from './research-launch.service.js';

vi.mock('./research-launch.repository.js', () => ({
  researchLaunchRepository: {
    listAwaitingAnswer: vi.fn(),
    listLaunchingCreatedBefore: vi.fn(),
    findByLaunchKey: vi.fn(),
    transition: vi.fn(),
    copySourceMode: vi.fn(),
  },
}));

const launches = vi.mocked(researchLaunchRepository);

/** A one-shot gate the test opens. */
function gate<T = void>() {
  let open: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

/** Lets the promise chains of the code under test run. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

interface FakeTimer {
  readonly ms: number;
  readonly fire: () => void;
  cancelled: boolean;
}

/** A clock whose timers fire only when the test calls `fire`. */
function fakeClock() {
  const timers: FakeTimer[] = [];
  const clock: Clock = {
    now: () => new Date('2026-11-05T12:00:00Z'),
    random: () => 0,
    setTimer: (ms, callback) => {
      const timer: FakeTimer = { ms, fire: callback, cancelled: false };
      timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  };
  return { clock, timers };
}

const SETTINGS: AnswerAppenderSettings = {
  workers: true,
  pollMs: 50,
  appendGiveUpMs: 300_000,
  launchRecoveryMs: 60_000,
};

/**
 * An appender whose pass is the launch service's recovery call, held by a fresh gate per pass; the queue of answers
 * is empty. `passes` counts started passes.
 */
function appenderUnderTest(settings: AnswerAppenderSettings = SETTINGS) {
  const { clock, timers } = fakeClock();
  const gates: ReturnType<typeof gate<void>>[] = [];
  const recoverLaunching = vi.fn(() => {
    const pass = gate<void>();
    gates.push(pass);
    return pass.promise;
  });
  launches.listAwaitingAnswer.mockResolvedValue([]);
  const appender = new ResearchAnswerAppender(
    settings,
    { db: {} } as unknown as DatabaseConnection,
    {} as Engine,
    clock,
    {} as Memory,
    {} as ThreadsService,
    {} as ThreadRunRegistry,
    { recoverLaunching } as unknown as ResearchLaunchService,
  );
  return {
    appender,
    timers,
    gates,
    passes: () => recoverLaunching.mock.calls.length,
    armed: () => timers.filter((timer) => !timer.cancelled).length,
  };
}

// KD-4, design-chat-entry.md C3 api: the delivery loop runs one pass per RUNTIME_POLL_MS, only with the workers on, its
// passes never overlap, and a stop leaves no pass running and no timer armed (it runs before Runtime.stop).
// Risk: two passes write the same answer at once, the loop keeps running after the runtime stopped, or the loop runs
// with the workers off.
describe('ResearchAnswerAppender loop', () => {
  beforeEach(() => vi.clearAllMocks());

  it('with the workers off, start arms no timer', () => {
    const loop = appenderUnderTest({ ...SETTINGS, workers: false });

    loop.appender.start();

    expect(loop.timers).toHaveLength(0);
  });

  it('start arms one timer of RUNTIME_POLL_MS; its pass arms the next timer only once it has ended', async () => {
    const loop = appenderUnderTest();

    loop.appender.start();
    expect(loop.timers.map((timer) => timer.ms)).toEqual([50]);

    loop.timers[0]?.fire();
    await settle();
    expect(loop.passes()).toBe(1);
    expect(loop.timers).toHaveLength(1);

    loop.gates[0]?.open(undefined);
    await settle();
    expect(loop.timers.map((timer) => timer.ms)).toEqual([50, 50]);
    expect(loop.passes()).toBe(1);
  });

  it('a second fire or runOnce while a pass is in flight starts its pass only after that pass ends', async () => {
    const loop = appenderUnderTest();
    loop.appender.start();

    loop.timers[0]?.fire();
    loop.timers[0]?.fire();
    void loop.appender.runOnce();
    await settle();
    expect(loop.passes()).toBe(1);

    loop.gates[0]?.open(undefined);
    await settle();
    expect(loop.passes()).toBe(2);

    loop.gates[1]?.open(undefined);
    await settle();
    expect(loop.passes()).toBe(3);
    loop.gates[2]?.open(undefined);
    await loop.appender.stop();
  });

  it('stop cancels the timer, waits for the pass in flight and arms nothing afterwards', async () => {
    const loop = appenderUnderTest();
    loop.appender.start();
    loop.timers[0]?.fire();
    await settle();

    let stopped = false;
    const stopping = loop.appender.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped).toBe(false);

    loop.gates[0]?.open(undefined);
    await stopping;
    await settle();
    expect(stopped).toBe(true);
    expect(loop.armed()).toBe(0);
    expect(loop.timers).toHaveLength(1);
  });
});

const launchRow = (fields: Partial<LaunchRecord>): LaunchRecord => ({
  launchKey: 'launch-1',
  resourceId: 'user-1',
  threadId: 'thread-1',
  mode: 'proposal',
  goal: 'Почему растут возвраты',
  tokenBudget: 300_000,
  userMessageId: null,
  state: 'launching',
  investigationId: null,
  controllerTaskId: null,
  sourceMode: null,
  createdAt: new Date('2026-11-05T11:00:00Z'),
  finishedAt: null,
  answeredAt: null,
  appendFailedAt: null,
  nextAppendAt: null,
  ...fields,
});

const REFUSED: StartInvestigationResult = {
  outcome: 'rejected',
  code: 'process_unknown',
};

function serviceUnderTest(
  startInvestigation: Engine['startInvestigation'],
  runtime: unknown = {},
) {
  const engine = {
    sourceMode: 'sources',
    startInvestigation: vi.fn(startInvestigation),
    readInvestigation: vi.fn(),
  };
  const threads = {
    withOwnedThread: (_threadId: string, _userId: string, fn: () => unknown) =>
      fn(),
  };
  const service = new ResearchLaunchService(
    { db: {} } as unknown as DatabaseConnection,
    engine as unknown as Engine,
    runtime as Runtime,
    threads as unknown as ThreadsService,
  );
  return { service, engine };
}

// KD-3: the loop finishes a launch left in `launching` by repeating the start, but never a start this process is still
// running. Risk: a running confirm is started twice.
describe('ResearchLaunchService.recoverLaunching', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not start again a launch whose start is in flight in this process', async () => {
    const proposed = launchRow({ state: 'proposed' });
    const launching = launchRow({ state: 'launching' });
    const held = gate<StartInvestigationResult>();
    let starts = 0;
    // Only the confirm's own start is held; a second start would answer at once.
    const { service, engine } = serviceUnderTest(() => {
      starts += 1;
      return starts === 1 ? held.promise : Promise.resolve(REFUSED);
    });
    launches.findByLaunchKey.mockResolvedValue(proposed);
    launches.transition.mockResolvedValueOnce(launching);
    launches.listLaunchingCreatedBefore.mockResolvedValue([launching]);

    const deciding = service.decide({
      threadId: 'thread-1',
      resourceId: 'user-1',
      decision: { action: 'confirm', launchKey: 'launch-1' },
    });
    await settle();
    await service.recoverLaunching(new Date('2026-11-05T12:00:00Z'));

    expect(engine.startInvestigation).toHaveBeenCalledTimes(1);
    held.open(REFUSED);
    await deciding;
  });
});

// Flow 2, Failure handling: a regenerate discards the card while its confirmed start runs. Risk: the investigation the
// start just created keeps running with no card and no row to deliver it to.
describe('ResearchLaunchService start of a launch discarded meanwhile', () => {
  beforeEach(() => vi.clearAllMocks());

  it('cancels the investigation the start created and answers not_found', async () => {
    const held = gate<StartInvestigationResult>();
    const cancel = vi.fn(() => Promise.resolve());
    const { service } = serviceUnderTest(() => held.promise, {
      investigations: { cancel },
    });
    launches.findByLaunchKey.mockResolvedValueOnce(
      launchRow({ state: 'proposed' }),
    );
    launches.transition.mockResolvedValueOnce(
      launchRow({ state: 'launching' }),
    );

    const deciding = service.decide({
      threadId: 'thread-1',
      resourceId: 'user-1',
      decision: { action: 'confirm', launchKey: 'launch-1' },
    });
    await settle();
    // While the start is held the row is discarded: the `started` write finds it no longer `launching`.
    launches.transition.mockResolvedValueOnce(undefined);
    launches.findByLaunchKey.mockResolvedValueOnce(
      launchRow({ state: 'discarded' }),
    );
    held.open({
      outcome: 'created',
      investigationId: 'inv-1',
      controllerTaskId: 'task-1',
    });

    expect(await deciding).toEqual({
      launch: null,
      decisionError: 'not_found',
    });
    expect(cancel.mock.calls).toEqual([['inv-1', 'user-1']]);
  });
});

const CLAIM_ID = '7b0c2a52-3f0e-4c5a-9d64-1f0b6a3c2e10';
const PAGE_ID = '2f6e8d14-5a7b-4c39-8e21-9d0c3b4a5f67';

/**
 * The message the engine stored for `inv-1`, built as the engine builds it: one established claim with the group words
 * of `high`, citing one page. The delivery takes it as it is.
 */
const ENGINE_MESSAGE = buildResearchAnswer({
  answer: {
    outcome: 'answered',
    stopReason: null,
    summaryItems: [
      {
        claimId: CLAIM_ID,
        text: 'Возвраты растут из-за брака',
        confidence: 'high',
      },
    ],
    established: [
      {
        claimId: CLAIM_ID,
        text: 'Возвраты растут из-за брака',
        evidenceIds: [PAGE_ID],
        verified: true,
        confidence: 'high',
      },
    ],
    assumed: [],
    unknown: [],
  },
  // Goal and key differ from the launch row's: a message re-derived from the row would not match.
  goal: 'Цель из движка',
  launchKey: 'engine-launch-1',
  sourceMode: 'sources',
  pages: new Map([
    [
      PAGE_ID,
      {
        sourceId: 'orders-db',
        toolName: 'query',
        snapshot: '2026-11-05T11:30:00Z',
        truncated: false,
      },
    ],
  ]),
});

/** The text of {@link ENGINE_MESSAGE}, written out: the saved message must carry exactly this. */
const ENGINE_TEXT = [
  '**Ответ ресерча** · Есть ответ\nЦель: Цель из движка',
  '### Главное из установленного\n- Возвраты растут из-за брака (уверенность высокая)',
  '### Установлено\n- Возвраты растут из-за брака [1] (уверенность высокая)',
  '### Источники (1)\n1. orders-db · query · 2026-11-05T11:30:00Z',
].join('\n\n');

type ReadAnswer = () => Promise<ReadAnswerMessageResult>;

const FOUND: ReadAnswer = () =>
  Promise.resolve({ outcome: 'found', message: ENGINE_MESSAGE });

interface SavedMessage {
  id: string;
  content: { parts: { text: string }[]; metadata: Record<string, unknown> };
}

/** An appender over one launch of `inv-1` whose engine answers `readAnswerMessage`; the thread has no chat run. */
function deliveryUnderTest(
  readAnswerMessage: ReadAnswer,
  fields: Partial<LaunchRecord> = {},
) {
  const { clock } = fakeClock();
  const pending = launchRow({
    state: 'answer_pending',
    investigationId: 'inv-1',
    controllerTaskId: 'task-1',
    sourceMode: 'sources',
    ...fields,
  });
  launches.listAwaitingAnswer.mockResolvedValue([pending]);
  launches.findByLaunchKey.mockResolvedValue(pending);
  launches.transition.mockResolvedValue(pending);
  const saveMessages = vi.fn((_args: { messages: SavedMessage[] }) =>
    Promise.resolve({ messages: [] }),
  );
  const read = vi.fn(readAnswerMessage);
  const appender = new ResearchAnswerAppender(
    SETTINGS,
    { db: {} } as unknown as DatabaseConnection,
    { readAnswerMessage: read } as unknown as Engine,
    clock,
    { saveMessages } as unknown as Memory,
    {
      withOwnedThread: (
        _threadId: string,
        _userId: string,
        fn: () => unknown,
      ) => fn(),
    } as unknown as ThreadsService,
    { hasRuns: () => Promise.resolve(false) } as unknown as ThreadRunRegistry,
    {
      recoverLaunching: () => Promise.resolve(),
    } as unknown as ResearchLaunchService,
  );
  const saved = () =>
    saveMessages.mock.calls.flatMap(([args]) =>
      args.messages.map(({ id, content }) => ({
        id,
        text: content.parts.map((part) => part.text).join(''),
        researchAnswer: content.metadata.researchAnswer,
      })),
    );
  return { appender, saved, read };
}

const RETRY = {
  launchKey: 'launch-1',
  from: 'answer_pending',
  to: 'answer_pending',
  set: {
    appendFailedAt: new Date('2026-11-05T12:00:00Z'),
    nextAppendAt: new Date('2026-11-05T12:00:00.050Z'),
  },
};

// Invariant 9, KD-8 (design-engine.md, Contract «Engine.readAnswerMessage»): the chat server takes the engine's message
// as it is and adds only `launch`; an answer not ready (`no_answer`: the investigation is not closed `completed`) or a
// failed read is a failed write retried after the pause (DC-2, AC-19.1 of design-lifecycle.md).
// Risk: the delivery rebuilds or edits the engine's message, writes it without `launch`, or writes it before the
// answer is ready.
describe('ResearchAnswerAppender delivers the engine-built message', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    {
      name: 'a proposal',
      fields: {},
      launch: { toolCallId: 'launch-1' },
    },
    {
      name: 'an explicit launch',
      fields: { mode: 'explicit' as const, userMessageId: 'user-message-1' },
      launch: { messageId: 'user-message-1' },
    },
  ])(
    'found, $name: saves the text as it is and the metadata with launch $launch',
    async ({ fields, launch }) => {
      const delivery = deliveryUnderTest(FOUND, fields);

      await delivery.appender.runOnce();

      expect(delivery.read.mock.calls).toEqual([
        [{ investigationId: 'inv-1', resourceId: 'user-1' }],
      ]);
      expect(delivery.saved()).toEqual([
        {
          id: 'research-answer-inv-1',
          text: ENGINE_TEXT,
          researchAnswer: { ...ENGINE_MESSAGE.metadata, launch },
        },
      ]);
      expect(launches.transition.mock.calls).toEqual([
        [
          {},
          {
            launchKey: 'launch-1',
            from: 'answer_pending',
            to: 'answered',
            set: {
              answeredAt: new Date('2026-11-05T12:00:00Z'),
              appendFailedAt: null,
              nextAppendAt: null,
            },
          },
        ],
      ]);
    },
  );

  it.each([
    {
      name: 'no_answer',
      read: (() =>
        Promise.resolve({
          outcome: 'rejected',
          code: 'no_answer',
        })) as ReadAnswer,
    },
    {
      name: 'investigation_not_found',
      read: (() =>
        Promise.resolve({
          outcome: 'rejected',
          code: 'investigation_not_found',
        })) as ReadAnswer,
    },
    {
      name: 'a read that throws',
      read: (() =>
        Promise.reject(new Error('database unavailable'))) as ReadAnswer,
    },
  ])('$name: saves nothing and retries after the pause', async ({ read }) => {
    const delivery = deliveryUnderTest(read);

    await delivery.appender.runOnce();

    expect(delivery.saved()).toEqual([]);
    expect(launches.transition.mock.calls).toEqual([[{}, RETRY]]);
  });

  it('a repeated write after a regenerate (answer_reappend) saves the same message under the same id', async () => {
    const first = deliveryUnderTest(FOUND);
    await first.appender.runOnce();
    const again = deliveryUnderTest(FOUND, { state: 'answer_reappend' });
    await again.appender.runOnce();

    expect(again.saved()).toEqual(first.saved());
    expect(again.saved().map(({ id, text }) => ({ id, text }))).toEqual([
      { id: 'research-answer-inv-1', text: ENGINE_TEXT },
    ]);
  });
});
