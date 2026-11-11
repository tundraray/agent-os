import { backOfficeOf } from './backoffice.js';
import { createLogDataset, type LogDataset } from './dataset.js';
import { createScenarioDataset } from './scenarios/scenario-dataset.js';
import { loadScenarioSet } from './scenarios/scenario-sets.js';

const ORDER_ID = /\bord-[0-9a-f]{8}\b/;

function firstScenarioOfSetFirst(): LogDataset {
  const loaded = loadScenarioSet('first');
  if (!loaded.ok) {
    throw new Error(`scenario set first: ${loaded.reason}`);
  }
  return createScenarioDataset(loaded.set.scenarios[0]);
}

// AC-02.1 (KD-7): the back office is built from the same data as the logs, so an order the payment log names is there.
describe('back office of the same dataset', () => {
  it.each<[string, () => LogDataset]>([
    ['dataset v1', () => createLogDataset('v1')],
    ['dataset v2', () => createLogDataset('v2')],
    ['scenario of set first', firstScenarioOfSetFirst],
  ])('every order of a payment-error log record exists in the back office with the same id (%s)', (_, datasetOf) => {
    const dataset = datasetOf();
    const backOffice = backOfficeOf(dataset);
    let checked = 0;

    for (let index = 0; index < dataset.recordCount; index += 1) {
      const record = dataset.recordAt(index);
      if (record.event !== 'payment.result' || record.status !== 'error') {
        continue;
      }
      const orderId = ORDER_ID.exec(record.message)?.[0];
      expect(orderId, record.message).toBeDefined();
      const order = backOffice.order(orderId as string);
      expect(order?.orderId).toBe(orderId);
      const payment = order?.payments.find((candidate) => candidate.traceId === record.traceId);
      expect(payment?.status).toBe('failed');
      checked += 1;
    }

    expect(checked).toBeGreaterThan(0);
  });
});
