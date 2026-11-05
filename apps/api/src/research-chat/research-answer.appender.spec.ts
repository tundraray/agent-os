import type { DatabaseConnection } from '@agent-os/db';
import type { Engine, StartInvestigationResult } from '@agent-os/engine';
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
    {} as Runtime,
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

  it('stop before any fire cancels the armed timer', async () => {
    const loop = appenderUnderTest();
    loop.appender.start();

    await loop.appender.stop();

    expect(loop.armed()).toBe(0);
    expect(loop.passes()).toBe(0);
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
// running; a refused start of a confirmed proposal returns it to its card. Risk: a running confirm is started twice,
// or a refused recovery leaves the proposal stuck in `launching` or fails it.
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

  it('returns a confirmed proposal whose recovered start is refused to proposed', async () => {
    const launching = launchRow({ state: 'launching' });
    const { service, engine } = serviceUnderTest(() =>
      Promise.resolve(REFUSED),
    );
    launches.listLaunchingCreatedBefore.mockResolvedValue([launching]);
    launches.transition.mockResolvedValue(launchRow({ state: 'proposed' }));

    await service.recoverLaunching(new Date('2026-11-05T12:00:00Z'));

    expect(engine.startInvestigation).toHaveBeenCalledTimes(1);
    expect(launches.transition.mock.calls).toEqual([
      [
        {},
        { launchKey: 'launch-1', from: 'launching', to: 'proposed', set: {} },
      ],
    ]);
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
