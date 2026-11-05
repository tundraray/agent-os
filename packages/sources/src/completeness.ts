import type { Coverage } from '@agent-os/contracts';
import type { NormalizedPage } from './source-adapter.js';

/** The counts the rule reads: one page, or the pages of a task with `returned` summed. */
export type CoverageInput = Pick<NormalizedPage, 'returned' | 'totalMatched' | 'totalRelation' | 'nextCursor' | 'exhausted'>;

export interface CoverageResult {
  readonly coverage: Coverage;
  readonly warnings: readonly string[];
}

/** The cursor ended while the sum stayed below an exact total. */
const SOURCE_ENDED_EARLY = 'source_ended_early';

/**
 * The completeness rule (design-mcp-source.md, Пагинация и охват): `complete` only when the cursor ended and either
 * the sum of `returned` equals an `eq` total or the source says it is `exhausted`. Otherwise `partial`, with the
 * cursor as `continuation`. An unconfirmed count (null or `gte`) never completes a paginated result.
 */
export function coverageOf(input: CoverageInput): CoverageResult {
  const { returned, totalMatched, totalRelation, nextCursor, exhausted } = input;
  const exactTotal = totalRelation === 'eq' ? totalMatched : null;
  const complete = nextCursor === null && (exhausted || returned === exactTotal);
  const endedEarly = nextCursor === null && !exhausted && exactTotal !== null && returned < exactTotal;
  return {
    coverage: {
      completeness: complete ? 'complete' : 'partial',
      totalMatched,
      totalRelation,
      returned,
      truncated: nextCursor !== null,
      continuation: nextCursor,
    },
    warnings: endedEarly ? [SOURCE_ENDED_EARLY] : [],
  };
}
