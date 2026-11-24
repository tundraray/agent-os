import { z } from 'zod';
import { backOfficeOf } from '../backoffice';
import { defineTool } from './fixture-tool';
import { OrderSchema } from './search-orders';

const GetOrderArgsSchema = z.strictObject({
  orderId: z
    .string()
    .regex(
      /^ord-[0-9a-f]{8}$/,
      'orderId must be ord- and 8 lowercase hex characters',
    )
    .meta({ title: 'Заказ' }),
});

const PaymentSchema = z.strictObject({
  paymentId: z.string(),
  traceId: z.string(),
  amount: z.number(),
  currency: z.literal('EUR'),
  status: z.enum(['authorized', 'failed']),
  failureReason: z.literal('provider_timeout').nullable(),
  requestedAt: z.string(),
  resolvedAt: z.string(),
});

const GetOrderResultSchema = z.strictObject({
  snapshot: z.string(),
  order: OrderSchema.extend({ payments: z.array(PaymentSchema) }).nullable(),
});

/** One back-office order with its payments; an unknown order gives `order: null`. */
export const getOrderTool = defineTool({
  name: 'get_order',
  title: 'Показать заказ',
  description:
    'Get one back-office order (orderId: ord- and 8 lowercase hex characters) with its payments, ' +
    'each with its status, failure reason and the traceId of its payment logs.',
  readOnly: true,
  argsSchema: GetOrderArgsSchema,
  resultSchema: GetOrderResultSchema,
  run(args, dataset) {
    return {
      snapshot: dataset.snapshot,
      order: backOfficeOf(dataset).order(args.orderId) ?? null,
    };
  },
});
