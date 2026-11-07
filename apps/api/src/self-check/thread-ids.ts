/** Which database holds an investigation: the main deployment's or the self-check program's own. */
export type DatabaseBase = 'main' | 'self_check';

/**
 * Identifiers the self-check program writes itself (design-self-check.md, Data Model, «Где копия помнит
 * оригинал»): the conversation id of a scenario run or a repeat, and the `selfCheckRunId` of a `show` run.
 */
export type SelfCheckThreadId =
  | { readonly kind: 'run'; readonly runId: string }
  | {
      readonly kind: 'copy';
      readonly base: DatabaseBase;
      readonly investigationId: string;
    }
  | {
      readonly kind: 'show';
      readonly base: DatabaseBase;
      readonly investigationId: string;
      readonly showId: string;
    };

/** The investigation a repeat or a `show` run is about, with the conversation id it carries there. */
export interface CopySource {
  readonly base: DatabaseBase;
  readonly investigationId: string;
  readonly threadId: string;
}

/** The investigation a copy refers to: the one whose deletion or expiry removes the copy. */
export interface CopyOrigin {
  readonly base: DatabaseBase;
  readonly investigationId: string;
}

const PREFIX = 'self-check';
const SEPARATOR = ':';
const BASES: readonly string[] = [
  'main',
  'self_check',
] satisfies DatabaseBase[];

/** Writes `self-check:run:<runId>`, `self-check:copy:<base>:<id>` or `self-check:show:<base>:<id>:<uuid>`. */
export function formatThreadId(id: SelfCheckThreadId): string {
  const parts = partsOf(id);
  for (const part of parts) {
    if (part === '' || part.includes(SEPARATOR)) {
      throw new Error(
        `a self-check id part must be non-empty and free of "${SEPARATOR}", got "${part}"`,
      );
    }
  }
  return [PREFIX, id.kind, ...parts].join(SEPARATOR);
}

/** Reads an id written by `formatThreadId`; any other string — an employee's conversation id included — is `null`. */
export function parseThreadId(text: string): SelfCheckThreadId | null {
  const [prefix, kind, ...parts] = text.split(SEPARATOR);
  if (prefix !== PREFIX || parts.some((part) => part === '')) return null;
  if (kind === 'run' && parts.length === 1) {
    return { kind, runId: parts[0] };
  }
  const [base, investigationId, showId] = parts;
  if (!isBase(base)) return null;
  if (kind === 'copy' && parts.length === 2) {
    return { kind, base, investigationId };
  }
  if (kind === 'show' && parts.length === 3) {
    return { kind, base, investigationId, showId };
  }
  return null;
}

/**
 * The original a repeat or a `show` run of `source` refers to. A source that is itself a copy from the main
 * database passes on that same original: a reference to the copy would let the employee's data outlive the
 * original (DC-4). Every other source — a scenario run, a repeat of one, an employee's investigation — is the
 * original itself.
 */
export function copyOrigin(source: CopySource): CopyOrigin {
  if (source.base === 'self_check') {
    const id = parseThreadId(source.threadId);
    if (id?.kind === 'copy' && id.base === 'main') {
      return { base: 'main', investigationId: id.investigationId };
    }
  }
  return { base: source.base, investigationId: source.investigationId };
}

function partsOf(id: SelfCheckThreadId): string[] {
  switch (id.kind) {
    case 'run':
      return [id.runId];
    case 'copy':
      return [id.base, id.investigationId];
    case 'show':
      return [id.base, id.investigationId, id.showId];
  }
}

function isBase(value: string | undefined): value is DatabaseBase {
  return value !== undefined && BASES.includes(value);
}
