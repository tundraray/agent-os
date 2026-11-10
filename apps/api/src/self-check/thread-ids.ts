import { SELF_CHECK_OWNER } from '../auth/system-owners.js';

/**
 * Identifiers the self-check program writes itself (design-self-check.md, Data Model, «Где копия помнит
 * оригинал»): the conversation id of a scenario run or a repeat, and the `selfCheckRunId` of a `show` run.
 */
export type SelfCheckThreadId =
  | { readonly kind: 'run'; readonly runId: string }
  | { readonly kind: 'copy'; readonly investigationId: string }
  | {
      readonly kind: 'show';
      readonly investigationId: string;
      readonly showId: string;
    };

/** The investigation a repeat or a `show` run is about, with its owner and the conversation id it carries. */
export interface CopySource {
  readonly investigationId: string;
  readonly ownerId: string;
  readonly threadId: string;
}

const PREFIX = 'self-check';
const SEPARATOR = ':';

/** Writes `self-check:run:<runId>`, `self-check:copy:<id>` or `self-check:show:<id>:<uuid>`. */
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
  const [first, second] = parts;
  if (kind === 'run' && parts.length === 1) {
    return { kind, runId: first };
  }
  if (kind === 'copy' && parts.length === 1) {
    return { kind, investigationId: first };
  }
  if (kind === 'show' && parts.length === 2) {
    return { kind, investigationId: first, showId: second };
  }
  return null;
}

/**
 * The original a repeat or a `show` run of `source` refers to: the investigation whose deletion or expiry removes the
 * copy (DC-4). A source that is itself a repeat passes on its own original — a reference to the repeat would let the
 * employee's data outlive the original. Only the program's own investigation is a repeat: an employee's conversation id
 * that merely looks like a copy id must not point the copy at another investigation. Every other source — a scenario
 * run, an employee's investigation — is the original itself.
 */
export function copyOrigin(source: CopySource): string {
  if (source.ownerId !== SELF_CHECK_OWNER) return source.investigationId;
  const id = parseThreadId(source.threadId);
  return id?.kind === 'copy' ? id.investigationId : source.investigationId;
}

function partsOf(id: SelfCheckThreadId): string[] {
  switch (id.kind) {
    case 'run':
      return [id.runId];
    case 'copy':
      return [id.investigationId];
    case 'show':
      return [id.investigationId, id.showId];
  }
}
