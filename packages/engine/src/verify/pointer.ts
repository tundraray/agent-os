import { z } from 'zod';

/** At most this many records in one pointer (design-engine.md, Runtime settings). */
const MAX_POINTER_RECORDS = 20;

/**
 * The records a claim rests on, grouped by page: the page id and the numbers of its records — a record's number is its
 * position in the page from zero (KD-1). The schema keeps only the shape, so a worker's empty or broken pointer still
 * reaches `claim_assessment` and ends `insufficient` there without a model call (DC-6); `checkPointer` holds the rules.
 */
export const PointerSchema = z.array(
  z.strictObject({
    pageId: z.string(),
    records: z.array(z.number()),
  }),
);
export type Pointer = z.infer<typeof PointerSchema>;

export type PointerCheck = { readonly valid: true; readonly pointer: Pointer } | { readonly valid: false };

/**
 * The pointer rule (DC-6): 1 to 20 records; each page is one the caller knows (`pageSizes`, the record count of each
 * page of this investigation readable for its owner); each number an integer within its own page; no record twice.
 */
export function checkPointer(raw: unknown, pageSizes: ReadonlyMap<string, number>): PointerCheck {
  const parsed = PointerSchema.safeParse(raw);
  if (!parsed.success) return { valid: false };
  const pointer = parsed.data;
  const named = new Set<string>();
  let total = 0;
  for (const { pageId, records } of pointer) {
    const size = pageSizes.get(pageId);
    if (size === undefined || records.length === 0) return { valid: false };
    for (const number of records) {
      const key = JSON.stringify([pageId, number]);
      if (!Number.isInteger(number) || number < 0 || number >= size || named.has(key)) return { valid: false };
      named.add(key);
    }
    total += records.length;
  }
  if (total === 0 || total > MAX_POINTER_RECORDS) return { valid: false };
  return { valid: true, pointer };
}

/** A page of `source.fetch` evidence: its records are `items` (design-mcp-source.md, evidence of a page). */
export const PageSchema = z.object({ items: z.array(z.unknown()) });

/**
 * A pointer over every record of every page, for a check made outside an investigation (calibration, the influence
 * measure): the pages get ids by position, an empty page is left out, and the records are numbered in page order — the
 * order `buildClaimCheck` numbers them in.
 */
export function pointerOverAll(pages: readonly { readonly records: readonly unknown[] }[]): {
  readonly pointer: Pointer;
  readonly pages: ReadonlyMap<string, readonly unknown[]>;
} {
  const ids = pages.map((_, index) => `page-${index}`);
  return {
    pointer: pages.flatMap((page, index) => (page.records.length === 0 ? [] : [{ pageId: ids[index]!, records: page.records.map((_, n) => n) }])),
    pages: new Map(pages.map((page, index) => [ids[index]!, page.records])),
  };
}

/** A record the pointer names, with the id of its page. */
export interface PointedRecord {
  readonly pageId: string;
  readonly record: unknown;
}

/**
 * The records of a checked pointer in pointer order — the order in which the verifier input numbers them from zero, so
 * an assessment's record number is an index into this list. The pointer must have passed `checkPointer` against the
 * same pages: a page or a record it lacks is a caller error.
 */
export function pointedRecords(pointer: Pointer, pages: ReadonlyMap<string, readonly unknown[]>): PointedRecord[] {
  return pointer.flatMap(({ pageId, records }) =>
    records.map((number) => {
      const page = pages.get(pageId);
      if (page === undefined || number >= page.length) {
        throw new Error(`pointer names record ${number} of page ${pageId}, which was not given`);
      }
      return { pageId, record: page[number] };
    }),
  );
}
