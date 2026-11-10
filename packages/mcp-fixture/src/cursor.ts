import { z } from 'zod';
import { canonicalJson } from './canonical-json.js';
import { LogDatasetVersionSchema } from './versions.js';

/**
 * Opaque fixture cursor: base64url of canonical JSON with the dataset version and snapshot the page came from,
 * the hash of the query it continues and the offset of the next record among the query's matches.
 */
const CursorPayloadSchema = z.strictObject({
  datasetVersion: LogDatasetVersionSchema,
  snapshot: z.string().min(1),
  queryHash: z.string().regex(/^[0-9a-f]{64}$/),
  offset: z.int().min(0),
});
export type CursorPayload = z.infer<typeof CursorPayloadSchema>;

/** Text of the `isError` result for a cursor that is not a continuation of the query. */
export const INVALID_CURSOR = 'invalid cursor';

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(canonicalJson(payload), 'utf8').toString('base64url');
}

/**
 * Decodes a cursor of the query with `queryHash`; `undefined` when it does not decode or belongs to another query.
 * A cursor from another snapshot is accepted, so a snapshot change surfaces as the page's `snapshot`.
 */
export function decodeCursor(cursor: string, queryHash: string): CursorPayload | undefined {
  const payload = CursorPayloadSchema.safeParse(parseJson(Buffer.from(cursor, 'base64url').toString('utf8')));
  return payload.success && payload.data.queryHash === queryHash ? payload.data : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
