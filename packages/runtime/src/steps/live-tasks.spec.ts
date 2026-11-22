import type { Logger } from '@agent-os/common';
import type { Database, RuntimeTasksRepository } from '@agent-os/db';
import { z } from 'zod';
import type { Clock } from '../clock';
import type { RuntimeConfig } from '../runtime-config';
import type { RunningStepHandle } from '../tasks/running-task.registry';
import { HandlerRegistry } from './handler.registry';
import { LIVE_TASK_IDLE_MS, LIVE_TASKS_MAX, LiveTasks } from './live-tasks';
import type { StepCommit } from './step-commit';
import type { LiveTask, LiveTaskIdentity, StepContext, TaskHandler } from './step-contract';

const LIVE = 'live';
const PLAIN = 'plain';

interface FakeObject extends LiveTask {
  committed: ReturnType<typeof vi.fn<() => Promise<void>>>;
  dispose: ReturnType<typeof vi.fn<() => void>>;
}

const fakeObject = (): FakeObject => ({
  step: () => Promise.resolve({ outcome: 'wait' }),
  committed: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  dispose: vi.fn<() => void>(),
});

const commit = (outcome: StepCommit['outcome'], more: Partial<StepCommit> = {}): StepCommit => ({
  outcome,
  ended: false,
  adopted: [],
  ...more,
});

function setup() {
  let time = 0;
  const clock: Clock = {
    now: () => new Date(time),
    random: () => 0,
    setTimer: () => () => undefined,
  };
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  logger.child = () => logger;
  const restore = vi.fn((_task: LiveTaskIdentity) => Promise.resolve(fakeObject()));
  const plain: TaskHandler = {
    type: PLAIN,
    inputSchema: z.unknown(),
    step: () => Promise.resolve({ outcome: 'wait' }),
  };
  const handlers = new HandlerRegistry();
  handlers.registerLive({ type: LIVE, inputSchema: z.unknown(), restore });
  handlers.register(plain);
  const active: LiveTaskIdentity[] = [];
  const taskRows = { listActive: () => Promise.resolve(active) } as unknown as RuntimeTasksRepository;
  const config = { workers: true, leaseMs: 1_000 } as RuntimeConfig;
  const live = new LiveTasks(handlers, {} as Database, taskRows, clock, config, logger);

  const task = (taskId: string, type = LIVE): LiveTaskIdentity => ({
    taskId,
    rootId: taskId,
    parentId: null,
    ownerId: 'owner',
    depth: 0,
    type,
    input: {},
  });
  /** A claimed step of the task: its context and the handle that aborts its signal. */
  const claim = (taskId: string, type = LIVE) => {
    const controller = new AbortController();
    const handle: RunningStepHandle = {
      signal: controller.signal,
      abort: (reason) => controller.abort(reason),
      release: () => undefined,
    };
    const ctx = { ...task(taskId, type), signal: controller.signal, logger } as StepContext;
    return { ctx, handle, obtain: () => live.obtain(ctx, handle) };
  };
  return {
    live,
    restore,
    plain,
    active,
    task,
    claim,
    advance: (ms: number) => {
      time += ms;
      return new Date(time);
    },
  };
}

// Catches: a step on a stale or shared object after a cut-off or an uncommitted step, an object
// kept without bound, a child's object kept though its commit was rolled back.
describe('LiveTasks', () => {
  it('runs the next step on the same object after a committed step', async () => {
    const { live, restore, claim } = setup();
    const first = claim('t1');
    const object = (await first.obtain()) as FakeObject;
    // The next claim comes while the first step is still settling: it waits for it.
    const second = claim('t1').obtain();
    await live.settled(first.ctx, commit('committed'));

    expect(await second).toBe(object);
    expect(restore).toHaveBeenCalledTimes(1);
    expect(object.committed).toHaveBeenCalledTimes(1);
    expect(object.dispose).not.toHaveBeenCalled();
  });

  it.each<[string, StepCommit | undefined, number]>([
    ['the step threw, timed out or was shut down', undefined, 0],
    ['the commit was rejected', commit('rejected'), 0],
    ['the result was invalid', commit('invalid'), 0],
    ['the commit was abandoned', commit('abandoned'), 0],
    ['the step finished the task', commit('committed', { ended: true }), 1],
  ])('lets the object go when %s', async (_name, end, committedCalls) => {
    const { live, restore, claim } = setup();
    const step = claim('t1');
    const object = (await step.obtain()) as FakeObject;
    await live.settled(step.ctx, end);

    expect(object.committed).toHaveBeenCalledTimes(committedCalls);
    expect(object.dispose).toHaveBeenCalledTimes(1);
    expect(await claim('t1').obtain()).not.toBe(object);
    expect(restore).toHaveBeenCalledTimes(2);
  });

  it('lets the object go when committed() throws', async () => {
    const { live, claim } = setup();
    const step = claim('t1');
    const object = (await step.obtain()) as FakeObject;
    object.committed.mockRejectedValue(new Error('absorb failed'));
    await live.settled(step.ctx, commit('committed'));

    expect(object.dispose).toHaveBeenCalledTimes(1);
    expect(await claim('t1').obtain()).not.toBe(object);
  });

  it('restores a new object when the previous step was cut off and has not ended', async () => {
    const { live, claim } = setup();
    const cutOff = claim('t1');
    const stale = (await cutOff.obtain()) as FakeObject;
    cutOff.handle.abort('interrupted');

    const next = claim('t1');
    const fresh = await next.obtain();
    expect(fresh).not.toBe(stale);
    expect(stale.dispose).toHaveBeenCalledTimes(1);

    // The cut-off step ends late: it must not touch the new step's object.
    await live.settled(cutOff.ctx, commit('rejected'));
    await live.settled(next.ctx, commit('committed'));
    expect(await claim('t1').obtain()).toBe(fresh);
  });

  it('lets an evicted object go and refuses a step cut off before it got one', async () => {
    const { live, claim } = setup();
    const object = (await claim('t1').obtain()) as FakeObject;
    live.evict(['t1', 'unknown']);
    expect(object.dispose).toHaveBeenCalledTimes(1);

    const late = claim('t1');
    late.handle.abort('stopped');
    await expect(late.obtain()).rejects.toThrow(/cut off/);
  });

  it('lets idle objects go after the TTL, never one in a step', async () => {
    const { live, claim, advance } = setup();
    const inStep = (await claim('busy').obtain()) as FakeObject;
    const idle = fakeObject();
    live.adopt('idle', idle);

    live.sweep(advance(LIVE_TASK_IDLE_MS - 1));
    expect(idle.dispose).not.toHaveBeenCalled();
    live.sweep(advance(1));
    expect(idle.dispose).toHaveBeenCalledTimes(1);
    expect(inStep.dispose).not.toHaveBeenCalled();
  });

  it('over the cap lets go the objects unused longest, never one in a step', async () => {
    const { live, claim, advance } = setup();
    const inStep = (await claim('busy').obtain()) as FakeObject;
    const objects = Array.from({ length: LIVE_TASKS_MAX + 1 }, (_unused, index) => {
      advance(1);
      const object = fakeObject();
      live.adopt(`t${index}`, object);
      return object;
    });

    live.sweep(advance(1));
    // One in a step + MAX + 1 idle: the two oldest idle ones go.
    const dropped = objects.filter((object) => object.dispose.mock.calls.length > 0);
    expect(dropped).toEqual(objects.slice(0, 2));
    expect(inStep.dispose).not.toHaveBeenCalled();
  });

  it('restores a task once for the warm-up and a step that come together', async () => {
    const { live, restore, active, task, claim } = setup();
    active.push(task('t1'), task('t2'));
    const warm = live.warm();
    await Promise.resolve();
    const object = await claim('t1').obtain();
    await warm;

    expect(restore.mock.calls.map(([restored]) => restored.taskId).sort()).toEqual(['t1', 't2']);
    live.clear();
    expect((object as FakeObject).dispose).toHaveBeenCalledTimes(1);
  });

  it.each<[StepCommit['outcome'], boolean]>([
    ['committed', true],
    ['rejected', false],
    ['abandoned', false],
  ])('keeps an adopted object only after a committed step: %s', async (outcome, kept) => {
    const { live, restore, claim } = setup();
    const parent = claim('parent');
    await parent.obtain();
    const child = fakeObject();
    await live.settled(parent.ctx, commit(outcome, { adopted: [{ taskId: 'child', object: child }] }));

    expect((await claim('child').obtain()) === child).toBe(kept);
    // The parent's own restore, and the child's when its object was not kept.
    expect(restore).toHaveBeenCalledTimes(kept ? 1 : 2);
  });

  it('never keeps a stateless handler', async () => {
    const { live, restore, plain, claim } = setup();
    const step = claim('t1', PLAIN);
    expect(await step.obtain()).toBe(plain);
    await live.settled(step.ctx, commit('committed'));
    live.evict(['t1']);
    live.clear();

    expect(await claim('t1', PLAIN).obtain()).toBe(plain);
    expect(restore).not.toHaveBeenCalled();
  });
});
