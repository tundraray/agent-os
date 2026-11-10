import {
  researchAgentRuns,
  researchClaims,
  researchEvidence,
  researchEvidenceContents,
  researchPlanRevisions,
} from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';
import { and, asc, desc, eq, isNotNull, or } from 'drizzle-orm';
import { z } from 'zod';
import type { CallEnding } from '../tool-calls.repository.js';
import { cutToFit, fitItems, type ImmediateTool, jsonBytes } from './tool-context.js';

type InvestigationReadArgs =
  | { readonly view: 'plan' }
  | { readonly view: 'claims' | 'record_pages'; readonly cursor?: string }
  | { readonly view: 'runs'; readonly cursor?: string; readonly run?: string; readonly from?: number }
  | { readonly view: 'records'; readonly page: string; readonly from?: number; readonly cursor?: string };

/** A page of records is `{ items: [...] }` (the evidence of a `source.fetch` page). */
const PageContentSchema = z.object({ items: z.array(z.unknown()) });
/** A cursor is the position to continue from, as the previous result gave it. */
const CursorSchema = z.string().regex(/^(0|[1-9]\d{0,8})$/);

const rejected = (reason: string): CallEnding => ({ to: 'rejected', outcome: 'rejected', reason });

/**
 * The items from `start` that fit the result's limit, with the cursor of the next one; `empty` when there are none. An
 * item over half the limit is listed by its position and size only (`omitted`), so every page holds at least one item
 * and the cursor always moves on.
 */
function paged(
  view: string,
  items: readonly unknown[],
  start: number,
  maxBytes: number,
  extra: Record<string, unknown> = {},
): CallEnding {
  const oneItemMaxBytes = Math.floor(maxBytes / 2);
  const rest = items
    .slice(start)
    .map((item, offset) =>
      jsonBytes(item) > oneItemMaxBytes ? { index: start + offset, omitted: true, bytes: jsonBytes(item) } : item,
    );
  const taken = fitItems(rest, maxBytes, (page) => ({ view, ...extra, items: page, next: String(items.length) }));
  const next = taken.length < rest.length ? String(start + taken.length) : null;
  return {
    to: 'done',
    outcome: taken.length === 0 ? 'empty' : 'success',
    result: { view, ...extra, items: taken, next },
  };
}

/**
 * The current plan. A plan over the result's limit comes as the longest prefix of its JSON text that fits, marked
 * `truncated` with its whole size, so the call never ends over the limit.
 */
async function latestPlan(tx: RuntimeTx, investigationId: string, maxBytes: number): Promise<CallEnding> {
  const [latest] = await tx
    .select({ revision: researchPlanRevisions.revision, plan: researchPlanRevisions.plan })
    .from(researchPlanRevisions)
    .where(eq(researchPlanRevisions.investigationId, investigationId))
    .orderBy(desc(researchPlanRevisions.revision))
    .limit(1);
  if (latest === undefined) return { to: 'done', outcome: 'empty', result: { view: 'plan', plan: null } };
  const whole = { view: 'plan', ...latest };
  if (jsonBytes(whole) <= maxBytes) return { to: 'done', outcome: 'success', result: whole };
  const planText = JSON.stringify(latest.plan);
  const result = cutToFit(planText, maxBytes, (cut) => ({
    view: 'plan',
    revision: latest.revision,
    truncated: true,
    bytes: jsonBytes(latest.plan),
    planText: cut,
  }));
  return { to: 'done', outcome: 'success', result };
}

/** Each claim at its latest revision, in the order of those revisions. */
async function latestClaims(tx: RuntimeTx, investigationId: string): Promise<unknown[]> {
  const rows = await tx
    .selectDistinctOn([researchClaims.claimId], {
      claimId: researchClaims.claimId,
      seq: researchClaims.seq,
      text: researchClaims.text,
      status: researchClaims.status,
      confidence: researchClaims.confidence,
    })
    .from(researchClaims)
    .where(eq(researchClaims.investigationId, investigationId))
    .orderBy(researchClaims.claimId, desc(researchClaims.seq));
  return rows
    .sort((left, right) => left.seq - right.seq)
    .map(({ claimId, text, status, confidence }) => ({ claimId, text, status, confidence }));
}

async function recordPages(tx: RuntimeTx, investigationId: string): Promise<unknown[]> {
  const rows = await tx
    .select({
      page: researchEvidence.evidenceId,
      evidenceKey: researchEvidence.evidenceKey,
      provenance: researchEvidence.provenance,
    })
    .from(researchEvidence)
    .where(eq(researchEvidence.investigationId, investigationId))
    .orderBy(asc(researchEvidence.createdAt), asc(researchEvidence.evidenceId));
  return rows.map(({ page, evidenceKey, provenance }) => {
    const { sourceId, toolName } = provenance as { sourceId?: unknown; toolName?: unknown };
    return { page, evidenceKey, sourceId, toolName };
  });
}

/** The records of one page of this investigation; a page of another investigation, or none, is `not_found`. */
async function pageRecords(
  tx: RuntimeTx,
  investigationId: string,
  page: string,
): Promise<{ readonly found: false } | { readonly found: true; readonly records: unknown[] | null }> {
  if (!z.uuid().safeParse(page).success) return { found: false };
  const [content] = await tx
    .select({ bytes: researchEvidenceContents.bytes })
    .from(researchEvidenceContents)
    .innerJoin(researchEvidence, eq(researchEvidence.evidenceId, researchEvidenceContents.evidenceId))
    .where(and(eq(researchEvidence.investigationId, investigationId), eq(researchEvidence.evidenceId, page)));
  if (content === undefined) return { found: false };
  try {
    const parsed = PageContentSchema.safeParse(JSON.parse(Buffer.from(content.bytes).toString('utf8')));
    return { found: true, records: parsed.success ? parsed.data.items : null };
  } catch {
    return { found: true, records: null };
  }
}

async function finishedRuns(tx: RuntimeTx, investigationId: string): Promise<unknown[]> {
  const rows = await tx
    .select({
      run: researchAgentRuns.taskId,
      agent: researchAgentRuns.agentName,
      result: researchAgentRuns.result,
      failure: researchAgentRuns.failure,
    })
    .from(researchAgentRuns)
    .where(
      and(
        eq(researchAgentRuns.investigationId, investigationId),
        or(isNotNull(researchAgentRuns.result), isNotNull(researchAgentRuns.failure)),
      ),
    )
    .orderBy(asc(researchAgentRuns.createdAt), asc(researchAgentRuns.taskId));
  return rows.map(({ run, agent, result, failure }) => (result === null ? { run, agent, failure } : { run, agent, result }));
}

/** The ending of a finished run of this investigation: its result, or its failure when it has none. */
async function runEnding(
  tx: RuntimeTx,
  investigationId: string,
  run: string,
): Promise<{ readonly found: false } | { readonly found: true; readonly ending: unknown }> {
  if (!z.uuid().safeParse(run).success) return { found: false };
  const [row] = await tx
    .select({ result: researchAgentRuns.result, failure: researchAgentRuns.failure })
    .from(researchAgentRuns)
    .where(and(eq(researchAgentRuns.investigationId, investigationId), eq(researchAgentRuns.taskId, run)));
  if (row === undefined || (row.result === null && row.failure === null)) return { found: false };
  return { found: true, ending: row.result ?? { failure: row.failure } };
}

/** A UTF-8 continuation byte: an offset at it falls inside a character. */
const isContinuationByte = (byte: number): boolean => (byte & 0xc0) === 0x80;

/**
 * One piece of a run's ending as JSON text, from byte `from`: the longest prefix of the rest that fits the result's
 * limit, the text's whole size and the offset of the next piece, `null` after the last. The pieces joined from offset 0
 * are the whole text, so a result of any size is read in full (FR-04). An offset past the end or inside a character is
 * `invalid_arguments`.
 */
function runPiece(run: string, ending: unknown, from: number, maxBytes: number): CallEnding {
  const text = Buffer.from(JSON.stringify(ending), 'utf8');
  const bytes = text.length;
  if (from > bytes || (from < bytes && isContinuationByte(text[from]!))) return rejected('invalid_arguments');
  const piece = (chunk: string, next: number | null) => ({ view: 'runs', run, from, chunk, next, bytes });
  // The widest `next` a piece can carry is the whole size: a cut that fits with it fits with the real one.
  const fitted = cutToFit(text.subarray(from).toString('utf8'), maxBytes, (chunk) => piece(chunk, bytes)) as {
    readonly chunk: string;
  };
  const end = from + Buffer.byteLength(fitted.chunk, 'utf8');
  return {
    to: 'done',
    outcome: fitted.chunk.length === 0 ? 'empty' : 'success',
    result: piece(fitted.chunk, end < bytes ? end : null),
  };
}

/**
 * `investigation_read` (`read`): the data of this investigation — the current plan, the claims with their latest
 * statuses, the record pages, the records of one page from a number, the results of finished agent runs (FR-04). The call
 * names no investigation: a page id of another investigation is `not_found` with no record. A long list comes in pages
 * within the result's limit, each with the cursor of the next (`next`); a record too large for a result is listed by its
 * number and size only. One finished run named by `run` comes in pieces of its JSON text from the byte offset `from`;
 * a run of another investigation, or one not finished, is `not_found`.
 */
export function investigationReadTool(resultMaxBytes: number): ImmediateTool {
  return {
    name: 'investigation_read',
    async run({ tx, run, args }) {
      const request = args as InvestigationReadArgs;
      if (request.view === 'plan') return latestPlan(tx, run.investigationId, resultMaxBytes);
      const cursor = request.cursor === undefined ? undefined : CursorSchema.safeParse(request.cursor);
      if (cursor?.success === false) return rejected('invalid_arguments');
      const start = cursor?.data === undefined ? undefined : Number(cursor.data);
      switch (request.view) {
        case 'claims':
          return paged('claims', await latestClaims(tx, run.investigationId), start ?? 0, resultMaxBytes);
        case 'record_pages':
          return paged('record_pages', await recordPages(tx, run.investigationId), start ?? 0, resultMaxBytes);
        case 'runs': {
          if (request.run === undefined) {
            if (request.from !== undefined) return rejected('invalid_arguments');
            return paged('runs', await finishedRuns(tx, run.investigationId), start ?? 0, resultMaxBytes);
          }
          if (request.cursor !== undefined) return rejected('invalid_arguments');
          const found = await runEnding(tx, run.investigationId, request.run);
          if (!found.found) return rejected('not_found');
          return runPiece(request.run, found.ending, request.from ?? 0, resultMaxBytes);
        }
        case 'records': {
          const page = await pageRecords(tx, run.investigationId, request.page);
          if (!page.found) return rejected('not_found');
          if (page.records === null) return { to: 'done', outcome: 'tool_error', result: { view: 'records', page: request.page, error: 'page_unreadable' } };
          const oneRecordMaxBytes = Math.floor(resultMaxBytes / 2);
          const numbered = page.records.map((record, number) =>
            jsonBytes({ number, record }) > oneRecordMaxBytes
              ? { number, omitted: true, bytes: jsonBytes(record) }
              : { number, record },
          );
          return paged('records', numbered, start ?? request.from ?? 0, resultMaxBytes, { page: request.page });
        }
      }
    },
  };
}
