import { z } from 'zod';
import { argsHash, canonicalJson } from './canonical-json.js';
import { DatasetVersionSchema } from './versions.js';

/**
 * Opaque fixture cursor: base64url of canonical JSON with the dataset version and snapshot the page came from,
 * the hash of the query it continues and the offset of the next record among the query's matches.
 */
const CursorPayloadSchema = z.strictObject({
  datasetVersion: DatasetVersionSchema,
  snapshot: z.string().min(1),
  queryHash: z.string().regex(/^[0-9a-f]{64}$/),
  offset: z.int().min(0),
});
export type CursorPayload = z.infer<typeof CursorPayloadSchema>;

/** Text of the `isError` result for a cursor that is not a continuation of the query. */
const INVALID_CURSOR = 'invalid cursor';

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(canonicalJson(payload), 'utf8').toString('base64url');
}

/**
 * Decodes a cursor of the query with `queryHash`; `undefined` when it does not decode or belongs to another query.
 * A cursor from another snapshot is accepted, so a snapshot change surfaces as the page's `snapshot`.
 */
function decodeCursor(cursor: string, queryHash: string): CursorPayload | undefined {
  const payload = CursorPayloadSchema.safeParse(parseJson(Buffer.from(cursor, 'base64url').toString('utf8')));
  return payload.success && payload.data.queryHash === queryHash ? payload.data : undefined;
}

/** The page of `matched` a paged tool call asks for: `items` and the cursor of the next page, or null on the last. */
export interface Page<Item> {
  items: Item[];
  nextCursor: string | null;
}

/**
 * The page of `matched` that `args` asks for; the query is `args` without `cursor`, so a cursor continues only the
 * query it came from. Returns `INVALID_CURSOR` for a cursor of another query.
 */
export function pageOf<Item>(
  matched: readonly Item[],
  args: { cursor?: string; pageSize: number },
  dataset: Pick<CursorPayload, 'snapshot'> & { version: CursorPayload['datasetVersion'] },
): Page<Item> | typeof INVALID_CURSOR {
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
  const end = offset + args.pageSize;
  return {
    items: matched.slice(offset, end),
    nextCursor:
      end < matched.length
        ? encodeCursor({ datasetVersion: dataset.version, snapshot: dataset.snapshot, queryHash, offset: end })
        : null,
  };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
