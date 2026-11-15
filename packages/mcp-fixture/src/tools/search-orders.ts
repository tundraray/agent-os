import { z } from 'zod';
import { backOfficeOf, ORDER_STATUSES, PAYMENT_METHODS } from '../backoffice.js';
import { pageOf } from '../cursor.js';
import { defineTool } from './fixture-tool.js';
import { LogQueryShape, WINDOW_ORDER_MESSAGE, windowIsOrdered } from './log-query.js';

const SEARCH_PAGE_SIZE_MAX = 500;

const SearchOrdersArgsSchema = z
  .strictObject({
    from: LogQueryShape.from,
    to: LogQueryShape.to,
    status: z.enum(ORDER_STATUSES).optional().meta({ title: 'Статус' }),
    paymentMethod: z.enum(PAYMENT_METHODS).optional().meta({ title: 'Способ оплаты' }),
    pageSize: z.int().min(1).max(SEARCH_PAGE_SIZE_MAX).default(SEARCH_PAGE_SIZE_MAX).meta({ title: 'Размер страницы' }),
    cursor: z.string().min(1).max(1024).optional().meta({ title: 'Курсор' }),
  })
  .refine(windowIsOrdered, { message: WINDOW_ORDER_MESSAGE, path: ['to'] });

/** Back-office orders created in a time window, in time order, a page at a time; `nextCursor` is null on the last page. */
export const searchOrdersTool = defineTool({
  name: 'search_orders',
  title: 'Найти заказы',
  description:
    'Search back-office orders created in [from, to) with optional status (paid, failed) and paymentMethod filters. ' +
    'Returns up to pageSize orders in time order; pass nextCursor back as cursor for the next page.',
  readOnly: true,
  argsSchema: SearchOrdersArgsSchema,
  run(args, dataset) {
    const matched = backOfficeOf(dataset)
      .ordersIn(args.from, args.to)
      .filter(
        (order) =>
          (args.status === undefined || order.status === args.status) &&
          (args.paymentMethod === undefined || order.paymentMethod === args.paymentMethod),
      );
    const page = pageOf(matched, args, dataset);
    if (typeof page === 'string') {
      return page;
    }
    return {
      snapshot: dataset.snapshot,
      orders: page.items,
      totalMatched: matched.length,
      totalRelation: 'eq',
      nextCursor: page.nextCursor,
    };
  },
});
