import type { LogDataset, PaymentOrder, PaymentOutcome } from './dataset.js';

export const ORDER_STATUSES = ['paid', 'failed'] as const;
export type OrderStatus = (typeof ORDER_STATUSES)[number];
export const PAYMENT_METHODS = ['card', 'paypal', 'sepa_debit'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

const CURRENCY = 'EUR';

/** An order as the back office lists it; `paid` once any of its payments was authorized. */
export interface BackOfficeOrder {
  orderId: string;
  createdAt: string;
  amount: number;
  currency: typeof CURRENCY;
  status: OrderStatus;
  paymentMethod: PaymentMethod;
}

/** One payment attempt of an order; `traceId` is the trace the payment logs carry. */
export interface BackOfficePayment {
  paymentId: string;
  traceId: string;
  amount: number;
  currency: typeof CURRENCY;
  status: 'authorized' | 'failed';
  /** Why the payment failed; null when it was authorized. */
  failureReason: Exclude<PaymentOutcome, 'ok'> | null;
  requestedAt: string;
  resolvedAt: string;
}

export interface BackOfficeOrderDetails extends BackOfficeOrder {
  payments: BackOfficePayment[];
}

/**
 * Orders and payments of the payment orders a log dataset records: the back office and the logs come from one
 * generator run, so an `ord-…` named in a payment log is an order here, and both report the same snapshot.
 */
export interface BackOffice {
  readonly dataset: LogDataset;
  /** Distinct orders. */
  readonly orderCount: number;
  /** Orders with `from <= createdAt < to`, in time order; an order is created at its first payment. */
  ordersIn(from: string, to: string): BackOfficeOrder[];
  /** One order with its payments; undefined when no order has this id. */
  order(orderId: string): BackOfficeOrderDetails | undefined;
}

const backOffices = new WeakMap<LogDataset, BackOffice>();

/** The back office of `dataset`, built once per dataset object. */
export function backOfficeOf(dataset: LogDataset): BackOffice {
  let backOffice = backOffices.get(dataset);
  if (backOffice === undefined) {
    backOffice = createBackOffice(dataset);
    backOffices.set(dataset, backOffice);
  }
  return backOffice;
}

function createBackOffice(dataset: LogDataset): BackOffice {
  let orderIndex: Map<string, number[]> | undefined;

  /** Indices of the payment orders drawn with this id, in time order. */
  function paymentIndices(orderId: string): number[] | undefined {
    orderIndex ??= buildOrderIndex(dataset);
    return orderIndex.get(orderId);
  }

  function detailsOf(indices: number[]): BackOfficeOrderDetails {
    const payments = indices.map((index) => paymentOf(dataset.orderAt(index)));
    const first = dataset.orderAt(indices[0]);
    return {
      orderId: first.orderId,
      createdAt: first.submittedAt,
      amount: first.amount,
      currency: CURRENCY,
      status: payments.some((payment) => payment.status === 'authorized') ? 'paid' : 'failed',
      paymentMethod: paymentMethodOf(first.traceId),
      payments,
    };
  }

  function firstOrderAtOrAfter(timeMs: number): number {
    let low = 0;
    let high = dataset.orderCount;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (Date.parse(dataset.orderAt(middle).submittedAt) < timeMs) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  }

  return {
    dataset,
    get orderCount() {
      orderIndex ??= buildOrderIndex(dataset);
      return orderIndex.size;
    },
    ordersIn(from, to) {
      const start = firstOrderAtOrAfter(Date.parse(from));
      const end = Math.max(start, firstOrderAtOrAfter(Date.parse(to)));
      const orders: BackOfficeOrder[] = [];
      for (let index = start; index < end; index += 1) {
        const indices = paymentIndices(dataset.orderAt(index).orderId);
        if (indices !== undefined && indices[0] === index) {
          const { payments: _payments, ...order } = detailsOf(indices);
          orders.push(order);
        }
      }
      return orders;
    },
    order(orderId) {
      const indices = paymentIndices(orderId);
      return indices === undefined ? undefined : detailsOf(indices);
    },
  };
}

/** Order id to the indices of its payment orders; a drawn id that repeats is one order with several payments. */
function buildOrderIndex(dataset: LogDataset): Map<string, number[]> {
  const index = new Map<string, number[]>();
  for (let orderIndex = 0; orderIndex < dataset.orderCount; orderIndex += 1) {
    const { orderId } = dataset.orderAt(orderIndex);
    const indices = index.get(orderId);
    if (indices === undefined) {
      index.set(orderId, [orderIndex]);
    } else {
      indices.push(orderIndex);
    }
  }
  return index;
}

function paymentOf(drawn: PaymentOrder): BackOfficePayment {
  return {
    paymentId: `pay-${drawn.traceId.slice(0, 16)}`,
    traceId: drawn.traceId,
    amount: drawn.amount,
    currency: CURRENCY,
    status: drawn.outcome === 'ok' ? 'authorized' : 'failed',
    failureReason: drawn.outcome === 'ok' ? null : drawn.outcome,
    requestedAt: drawn.requestedAt,
    resolvedAt: drawn.resolvedAt,
  };
}

/**
 * The method is read off the random trace id rather than drawn from the block's generator, so adding it leaves every
 * log record, and with them the pinned snapshots, unchanged; no log record names the method.
 */
function paymentMethodOf(traceId: string): PaymentMethod {
  return PAYMENT_METHODS[Number.parseInt(traceId.slice(0, 2), 16) % PAYMENT_METHODS.length];
}
