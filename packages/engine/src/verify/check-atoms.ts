import { z } from 'zod';

/**
 * The atom check (design-engine.md, «Сверка атомов», KD-9; DC-9): each atom of a claim is compared with every value of
 * the records of its pointer, at any depth and in list elements, without reading their keys — code does not know what
 * a field means. Its result is evidence for the verifier call and a feature of the profile; it sets no status.
 *
 * - `text` is found when a string value equals it exactly; `number` when a numeric value equals it, in one record — a
 *   sum over several records is never sought. A `number` is a decimal literal (`412`, `-3`, `0.5`); any other
 *   writing (`0x19C`, `4.12e2`, `+412`, padded with spaces) is missing. Neither can be contradicted: without a field name code cannot tell which
 *   value the claim is about.
 * - `time` is a moment or an ISO 8601 interval `start/end`: found when a date field equals the moment or lies in
 *   `[start, end)`, as the `[from, to)` of the fixture tools; contradicted when the records have date fields and none
 *   does; missing when they have none. A date field is a string value in the ISO 8601 date-time format with a zone —
 *   a check of its format, not a reading of its meaning.
 * - Stored revisions keep the former kinds: `traceId`, `service` and `event` are compared as `text`, `interval` as
 *   `time`. The output keeps the kind as written.
 */

/** An atom as the model stated it (flat: the value is text in every kind). */
export interface Atom {
  readonly kind: string;
  readonly value: string;
}

export type AtomVerdict = 'found' | 'missing' | 'contradicted';

export interface AtomCheckInput {
  readonly atoms: readonly Atom[];
  /**
   * The records of the claim's pointer in pointer order (log records or aggregate buckets); a record's number is its
   * index here, from zero.
   */
  readonly records: readonly unknown[];
}

export interface CheckedAtom extends Atom {
  readonly verdict: AtomVerdict;
  /** Numbers of the records the atom is found in. */
  readonly records: readonly number[];
}

/** `matched`: every atom found; `unmatched`: one is missing or contradicted; `not_applicable`: no atoms. */
export type ValueCheck = 'matched' | 'unmatched' | 'not_applicable';

export interface AtomCheck {
  readonly atoms: readonly CheckedAtom[];
  readonly valueCheck: ValueCheck;
}

type Primitive = 'text' | 'number' | 'time';

const PRIMITIVE_OF_KIND: Readonly<Record<string, Primitive>> = {
  text: 'text',
  number: 'number',
  time: 'time',
  traceId: 'text',
  service: 'text',
  event: 'text',
  interval: 'time',
};

const IsoDateTime = z.iso.datetime({ offset: true });

/** A decimal literal: digits with an optional minus and fraction — a check of the atom's format, as for a date. */
const DECIMAL_LITERAL = /^-?\d+(\.\d+)?$/;

/** Milliseconds of an ISO 8601 date-time with a zone, or undefined for any other value. */
function instantOf(value: unknown): number | undefined {
  return IsoDateTime.safeParse(value).success ? Date.parse(value as string) : undefined;
}

/** Every leaf value of a record, at any depth; keys are not read. */
function leavesOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.flatMap(leavesOf);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(leavesOf);
  return [value];
}

type Judged = Pick<CheckedAtom, 'verdict' | 'records'>;
const missing: Judged = { verdict: 'missing', records: [] };

function judgeByEquality(leaves: readonly unknown[][], matches: (leaf: unknown) => boolean): Judged {
  const records = leaves.flatMap((values, number) => (values.some(matches) ? [number] : []));
  return records.length > 0 ? { verdict: 'found', records } : missing;
}

/** `[start, end)` of a time atom; a moment is the interval holding only itself. */
function rangeOf(value: string): { readonly start: number; readonly within: (at: number) => boolean } | undefined {
  const parts = value.split('/');
  const [start, end] = parts.map(instantOf);
  if (start === undefined) return undefined;
  if (parts.length === 1) return { start, within: (at) => at === start };
  if (parts.length !== 2 || end === undefined) return undefined;
  return { start, within: (at) => at >= start && at < end };
}

function judgeTime(value: string, leaves: readonly unknown[][]): Judged {
  const range = rangeOf(value);
  if (range === undefined) return missing;
  const instants = leaves.map((values) => values.map(instantOf).filter((at) => at !== undefined));
  if (instants.every((ats) => ats.length === 0)) return missing;
  const records = instants.flatMap((ats, number) => (ats.some(range.within) ? [number] : []));
  return records.length > 0 ? { verdict: 'found', records } : { verdict: 'contradicted', records: [] };
}

function judgeAtom(atom: Atom, leaves: readonly unknown[][]): Judged {
  switch (PRIMITIVE_OF_KIND[atom.kind]) {
    case 'text':
      return judgeByEquality(leaves, (leaf) => leaf === atom.value);
    case 'number': {
      if (!DECIMAL_LITERAL.test(atom.value)) return missing;
      const stated = Number(atom.value);
      return judgeByEquality(leaves, (leaf) => leaf === stated);
    }
    case 'time':
      return judgeTime(atom.value, leaves);
    default:
      return missing;
  }
}

export function checkAtoms({ atoms, records }: AtomCheckInput): AtomCheck {
  const leaves = records.map(leavesOf);
  const checked = atoms.map((atom) => ({ kind: atom.kind, value: atom.value, ...judgeAtom(atom, leaves) }));
  if (checked.length === 0) return { atoms: checked, valueCheck: 'not_applicable' };
  return { atoms: checked, valueCheck: checked.every((atom) => atom.verdict === 'found') ? 'matched' : 'unmatched' };
}
