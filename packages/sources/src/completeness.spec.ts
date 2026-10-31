import { describe, expect, it } from 'vitest';
import { coverageOf, type CoverageInput } from './completeness.js';

// design-mcp-source.md, Пагинация и охват: one table owns the rule; INT-2 proves only that the executor uses it.

const CURSOR = 'cursor-of-the-next-page';

const base: CoverageInput = {
  returned: 2_500,
  totalMatched: 2_500,
  totalRelation: 'eq',
  nextCursor: null,
  exhausted: false,
};

describe('coverageOf', () => {
  it.each([
    {
      name: 'cursor ended, eq total reached: complete',
      input: base,
      completeness: 'complete',
      truncated: false,
      continuation: null,
      warnings: [],
    },
    {
      name: 'cursor ended, 0 of eq 0 (not found in scope): complete',
      input: { ...base, returned: 0, totalMatched: 0 },
      completeness: 'complete',
      truncated: false,
      continuation: null,
      warnings: [],
    },
    {
      name: 'cursor left, eq total not reached: partial, truncated, continuation is the cursor',
      input: { ...base, returned: 1_500, nextCursor: CURSOR },
      completeness: 'partial',
      truncated: true,
      continuation: CURSOR,
      warnings: [],
    },
    {
      name: 'cursor left although exhausted: partial (a cursor always means more)',
      input: { ...base, returned: 500, totalMatched: null, totalRelation: null, nextCursor: CURSOR, exhausted: true },
      completeness: 'partial',
      truncated: true,
      continuation: CURSOR,
      warnings: [],
    },
    {
      name: 'cursor ended, total unknown (null): partial',
      input: { ...base, totalMatched: null, totalRelation: null },
      completeness: 'partial',
      truncated: false,
      continuation: null,
      warnings: [],
    },
    {
      name: 'cursor ended, gte total (total_cap): partial even when the sum equals it',
      input: { ...base, totalRelation: 'gte' },
      completeness: 'partial',
      truncated: false,
      continuation: null,
      warnings: [],
    },
    {
      name: 'cursor ended below an eq total (page_cap): partial with source_ended_early',
      input: { ...base, returned: 2_300 },
      completeness: 'partial',
      truncated: false,
      continuation: null,
      warnings: ['source_ended_early'],
    },
    {
      name: 'cursor ended, exhausted with no total (aggregate_logs): complete',
      input: { ...base, returned: 48, totalMatched: null, totalRelation: null, exhausted: true },
      completeness: 'complete',
      truncated: false,
      continuation: null,
      warnings: [],
    },
    {
      name: 'cursor ended, exhausted below an eq total: complete, no warning',
      input: { ...base, returned: 2_300, exhausted: true },
      completeness: 'complete',
      truncated: false,
      continuation: null,
      warnings: [],
    },
  ] as const)('$name', ({ input, completeness, truncated, continuation, warnings }) => {
    const result = coverageOf(input);

    expect(result.coverage).toEqual({
      completeness,
      totalMatched: input.totalMatched,
      totalRelation: input.totalRelation,
      returned: input.returned,
      truncated,
      continuation,
    });
    expect(result.warnings).toEqual(warnings);
  });
});
