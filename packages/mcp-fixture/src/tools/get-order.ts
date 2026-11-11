import { z } from 'zod';
import { backOfficeOf } from '../backoffice.js';
import { defineTool } from './fixture-tool.js';

const GetOrderArgsSchema = z.strictObject({
  orderId: z.string().regex(/^ord-[0-9a-f]{8}$/, 'orderId must be ord- and 8 lowercase hex characters'),
});

/** One back-office order with its payments; an unknown order gives `order: null`. */
export const getOrderTool = defineTool({
  name: 'get_order',
  description:
    'Get one back-office order (orderId: ord- and 8 lowercase hex characters) with its payments, ' +
    'each with its status, failure reason and the traceId of its payment logs.',
  argsSchema: GetOrderArgsSchema,
  run(args, dataset) {
    return { snapshot: dataset.snapshot, order: backOfficeOf(dataset).order(args.orderId) ?? null };
  },
});
