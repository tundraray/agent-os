import { z } from 'zod';
import { argsHash } from '../canonical-json.js';
import { decodeCursor, encodeCursor, INVALID_CURSOR } from '../cursor.js';
import { defineTool } from './fixture-tool.js';
import { LogQueryShape, matchingRecords, WINDOW_ORDER_MESSAGE, windowIsOrdered } from './log-query.js';

const SEARCH_PAGE_SIZE_MAX = 500;

const SearchLogsArgsSchema = z
  .strictObject({
    ...LogQueryShape,
    pageSize: z.int().min(1).max(SEARCH_PAGE_SIZE_MAX).default(SEARCH_PAGE_SIZE_MAX),
    cursor: z.string().min(1).max(1024).optional(),
  })
  .refine(windowIsOrdered, { message: WINDOW_ORDER_MESSAGE, path: ['to'] });

/**
 * Records of a time window in time order, a page at a time. Every page reports the exact match count;
 * `nextCursor` is null on the last page.
 */
export const searchLogsTool = defineTool({
  name: 'search_logs',
  description:
    'Search payment logs in [from, to) with optional service, level, event and status filters. ' +
    'Returns up to pageSize records in time order; pass nextCursor back as cursor for the next page.',
  argsSchema: SearchLogsArgsSchema,
  run(args, dataset) {
    const { cursor, ...query } = args;
    const queryHash = argsHash(query);
    let offset = 0;
    if (cursor !== undefined) {
      const position = decodeCursor(cursor, queryHash);
      if (position === undefined) {
        return INVALID_CURSOR;
      }
      offset = position.offset;
    }
    const matched = matchingRecords(dataset, query);
    const end = offset + query.pageSize;
    return {
      snapshot: dataset.snapshot,
      records: matched.slice(offset, end),
      totalMatched: matched.length,
      totalRelation: 'eq',
      nextCursor:
        end < matched.length
          ? encodeCursor({ datasetVersion: dataset.version, snapshot: dataset.snapshot, queryHash, offset: end })
          : null,
    };
  },
});
