import { COVERAGE_CONTINUATION_MAX_LENGTH, EVIDENCE_ARGS_MAX_BYTES } from '@agent-os/contracts';
import { z } from 'zod';
import { canonicalJson } from './canonical-json.js';

/** `normalizedArgs` holds the arguments and the cursor, so the arguments leave room for the longest cursor. */
const FETCH_ARGS_MAX_BYTES = EVIDENCE_ARGS_MAX_BYTES - COVERAGE_CONTINUATION_MAX_LENGTH;
const utf8 = new TextEncoder();

/**
 * `TaskSpec.input` of `source.fetch` v1 (design-mcp-source.md, FetchInput и ToolRequest), checked at admission:
 * the source, the tool and its arguments without the cursor.
 */
export const FetchInputSchema = z.object({
  sourceId: z.string().min(1).max(100),
  toolName: z.string().min(1).max(100),
  args: z
    .record(z.string(), z.unknown())
    .refine((args) => utf8.encode(canonicalJson(args)).byteLength <= FETCH_ARGS_MAX_BYTES, {
      message: `args larger than ${FETCH_ARGS_MAX_BYTES} bytes of canonical JSON`,
    }),
});

/**
 * Where a fetch continues after the last stored page. `evidenceIds` are kept because `TaskContext` cannot look
 * evidence up by key; `SOURCE_MAX_PAGES` keeps the list inside the runtime's checkpoint limit.
 */
export const FetchCheckpointSchema = z.object({
  nextPage: z.int().min(1),
  cursor: z.string().max(COVERAGE_CONTINUATION_MAX_LENGTH).nullable(),
  /** Time of the first page of a source without a snapshot; null for a pinned source. */
  unpinnedAt: z.iso.datetime().nullable(),
  evidenceIds: z.array(z.uuid()),
  /** Sum of `returned` over the stored pages. */
  returned: z.int().min(0),
  totalMatched: z.int().min(0).nullable(),
  totalRelation: z.enum(['eq', 'gte']).nullable(),
});
export type FetchCheckpoint = z.infer<typeof FetchCheckpointSchema>;
