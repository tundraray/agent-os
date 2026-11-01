/**
 * The status of a claim is decided by code against source records (KD-6, invariant 7): the model only chose which
 * records to fetch. A claim is `supported` when each of its atoms is found in the records fetched for it, `refuted`
 * only when a fetched record contradicts a number or an interval, and `insufficient` otherwise — an atom not found, a
 * failed collection or an unreadable snapshot gives no record and so never refutes (DC-10). The worker's summary is
 * not a record: only what the verification round fetched counts (AC-08.2).
 */

/** An atom as the model stated it (flat: the value is text in every kind). */
export interface Atom {
  readonly kind: string;
  readonly value: string;
}

export type AtomVerdict = 'found' | 'missing' | 'contradicted';

/** One record of a fetched page (a log record or an aggregate bucket) and the evidence that holds it. */
export interface SourceRecord {
  readonly evidenceId: string;
  readonly record: unknown;
}

export interface ClaimToVerify {
  readonly atoms: readonly Atom[];
  /** The records the round fetched for this claim; empty when its collections failed or created no task. */
  readonly records: readonly SourceRecord[];
}

export interface ClaimVerdict {
  readonly status: 'supported' | 'refuted' | 'insufficient';
  /** Each atom with its verdict, as the new revision stores it in `atoms`. */
  readonly atoms: readonly (Atom & { readonly verdict: AtomVerdict })[];
  /** Evidence the status rests on: the records that found the atoms, or the contradicting record (`evidenceIds`). */
  readonly basis: readonly string[];
  readonly missingAtoms: readonly Atom[];
}

/** Atom kinds compared by equality with the record field of the same name. */
const FIELD_KINDS: ReadonlySet<string> = new Set(['traceId', 'service', 'event']);

type Judged = { readonly verdict: AtomVerdict; readonly evidenceIds: readonly string[] };
const missing: Judged = { verdict: 'missing', evidenceIds: [] };

const fieldOf = (record: unknown, field: string): unknown =>
  typeof record === 'object' && record !== null ? (record as Record<string, unknown>)[field] : undefined;

const evidenceOf = (records: readonly SourceRecord[]): string[] => [...new Set(records.map((item) => item.evidenceId))];

/** Log records of the claim's subject: those that agree with every field atom whose field they carry. */
function subjectRecords(claim: ClaimToVerify): SourceRecord[] {
  const fieldAtoms = claim.atoms.filter((atom) => FIELD_KINDS.has(atom.kind));
  return claim.records.filter(
    ({ record }) =>
      typeof fieldOf(record, 'ts') === 'string' &&
      fieldAtoms.every((atom) => fieldOf(record, atom.kind) === undefined || fieldOf(record, atom.kind) === atom.value),
  );
}

/** Equal to the record field of the atom's kind, or to the key of an aggregate bucket grouped by that field. */
function judgeField(atom: Atom, claim: ClaimToVerify): Judged {
  const found = claim.records.filter(
    ({ record }) =>
      fieldOf(record, atom.kind) === atom.value ||
      (typeof fieldOf(record, 'count') === 'number' && fieldOf(record, 'key') === atom.value),
  );
  return found.length > 0 ? { verdict: 'found', evidenceIds: evidenceOf(found) } : missing;
}

/** `start/end` in ISO time: found when every subject record lies within it, contradicted by one outside it. */
function judgeInterval(atom: Atom, claim: ClaimToVerify): Judged {
  const [start, end, ...rest] = atom.value.split('/').map((part) => Date.parse(part));
  if (start === undefined || end === undefined || rest.length > 0 || Number.isNaN(start) || Number.isNaN(end)) return missing;
  const subject = subjectRecords(claim);
  if (subject.length === 0) return missing;
  const outside = subject.filter(({ record }) => {
    const at = Date.parse(fieldOf(record, 'ts') as string);
    return at < start || at > end;
  });
  if (outside.length > 0) return { verdict: 'contradicted', evidenceIds: evidenceOf(outside) };
  return { verdict: 'found', evidenceIds: evidenceOf(subject) };
}

/**
 * A number against the aggregate buckets fetched for the claim (those keyed by one of its field atoms when there are
 * such): found when it equals a bucket's count or their total, contradicted when buckets exist and none agrees.
 */
function judgeNumber(atom: Atom, claim: ClaimToVerify): Judged {
  const stated = Number(atom.value);
  if (atom.value.trim() === '' || !Number.isFinite(stated)) return missing;
  const buckets = claim.records.filter(({ record }) => typeof fieldOf(record, 'count') === 'number');
  if (buckets.length === 0) return missing;
  const keys = new Set(claim.atoms.filter((other) => FIELD_KINDS.has(other.kind)).map((other) => other.value));
  const keyed = buckets.filter(({ record }) => keys.has(fieldOf(record, 'key') as string));
  const subject = keyed.length > 0 ? keyed : buckets;
  const counts = subject.map(({ record }) => fieldOf(record, 'count') as number);
  const total = counts.reduce((sum, count) => sum + count, 0);
  if (counts.includes(stated) || total === stated) return { verdict: 'found', evidenceIds: evidenceOf(subject) };
  return { verdict: 'contradicted', evidenceIds: evidenceOf(subject) };
}

function judgeAtom(atom: Atom, claim: ClaimToVerify): Judged {
  if (FIELD_KINDS.has(atom.kind)) return judgeField(atom, claim);
  if (atom.kind === 'interval') return judgeInterval(atom, claim);
  if (atom.kind === 'number') return judgeNumber(atom, claim);
  return missing;
}

export function verifyClaim(claim: ClaimToVerify): ClaimVerdict {
  const judged = claim.atoms.map((atom) => ({ atom, ...judgeAtom(atom, claim) }));
  const atoms = judged.map(({ atom, verdict }) => ({ kind: atom.kind, value: atom.value, verdict }));
  const missingAtoms = judged.filter((item) => item.verdict === 'missing').map(({ atom }) => atom);
  const basisOf = (verdict: AtomVerdict) => [...new Set(judged.filter((item) => item.verdict === verdict).flatMap((item) => item.evidenceIds))];
  if (judged.some((item) => item.verdict === 'contradicted')) {
    return { status: 'refuted', atoms, basis: basisOf('contradicted'), missingAtoms };
  }
  // A claim without atoms states nothing code can find: it is never supported.
  const status = judged.length > 0 && missingAtoms.length === 0 ? 'supported' : 'insufficient';
  return { status, atoms, basis: basisOf('found'), missingAtoms };
}
