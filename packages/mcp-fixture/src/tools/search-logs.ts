import { z } from 'zod';
import { pageOf } from '../cursor.js';
import { defineTool } from './fixture-tool.js';
import { LogQueryShape, matchingRecords, WINDOW_ORDER_MESSAGE, windowIsOrdered } from './log-query.js';

const SEARCH_PAGE_SIZE_MAX = 500;

const SearchLogsArgsSchema = z
  .strictObject({
    ...LogQueryShape,
    pageSize: z.int().min(1).max(SEARCH_PAGE_SIZE_MAX).default(SEARCH_PAGE_SIZE_MAX).meta({ title: 'Размер страницы' }),
    cursor: z.string().min(1).max(1024).optional().meta({ title: 'Курсор' }),
  })
  .refine(windowIsOrdered, { message: WINDOW_ORDER_MESSAGE, path: ['to'] });

/**
 * Records of a time window in time order, a page at a time. Every page reports the exact match count;
 * `nextCursor` is null on the last page.
 */
export const searchLogsTool = defineTool({
  name: 'search_logs',
  title: 'Найти записи в логах платежей',
  description:
    'Search payment logs in [from, to) with optional service, level, event and status filters. ' +
    'Returns up to pageSize records in time order; pass nextCursor back as cursor for the next page.',
  readOnly: true,
  argsSchema: SearchLogsArgsSchema,
  run(args, dataset) {
    const matched = matchingRecords(dataset, args);
    const page = pageOf(matched, args, dataset);
    if (typeof page === 'string') {
      return page;
    }
    return {
      snapshot: dataset.snapshot,
      records: page.items,
      totalMatched: matched.length,
      totalRelation: 'eq',
      nextCursor: page.nextCursor,
    };
  },
});
