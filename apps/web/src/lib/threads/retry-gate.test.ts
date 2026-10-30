import { describe, expect, it } from 'vitest';
import { createRetryGate } from './retry-gate';
import { ThreadsApiError } from './threads-api-error';

describe('RetryGate', () => {
  it('release resolves the parked waiter of that thread', async () => {
    const gate = createRetryGate();
    const waiting = gate.wait('a');

    gate.release('a');

    await expect(waiting).resolves.toBeUndefined();
  });

  it("drop rejects the parked waiter with ThreadsApiError('not_found')", async () => {
    const gate = createRetryGate();
    const waiting = gate.wait('a');

    gate.drop('a');

    await expect(waiting).rejects.toBeInstanceOf(ThreadsApiError);
    await expect(waiting).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('release and drop without a parked waiter do nothing', () => {
    const gate = createRetryGate();

    expect(() => {
      gate.release('a');
      gate.drop('a');
    }).not.toThrow();
  });

  it('drop after release leaves the already resolved waiter resolved', async () => {
    const gate = createRetryGate();
    const waiting = gate.wait('a');

    gate.release('a');
    gate.drop('a');

    await expect(waiting).resolves.toBeUndefined();
  });

  it('release of one thread leaves the waiter of another thread parked', async () => {
    const gate = createRetryGate();
    const waitingA = gate.wait('a');
    const waitingB = gate.wait('b');

    gate.release('a');
    gate.drop('b');

    await expect(waitingA).resolves.toBeUndefined();
    await expect(waitingB).rejects.toMatchObject({ kind: 'not_found' });
  });
});
