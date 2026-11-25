import { z } from 'zod';

/** A time in ms of a cursor: whole and within the range of `Date`, so it never becomes an Invalid Date. */
export const CursorTimeSchema = z.number().int().min(-8.64e15).max(8.64e15);

/** An opaque page cursor: base64url of the JSON of the last row's position. */
export function encodeCursor(position: object): string {
  return Buffer.from(JSON.stringify(position)).toString('base64url');
}

/** The position of a cursor of `encodeCursor` checked by `schema`; anything else throws `onInvalid()`. */
export function decodeCursor<T extends z.ZodType>(
  cursor: string,
  schema: T,
  onInvalid: () => Error,
): z.infer<T> {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw onInvalid();
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw onInvalid();
  return parsed.data;
}
