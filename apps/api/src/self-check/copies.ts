import {
  type Database,
  researchInvestigations,
  researchLlmTranscripts,
} from '@agent-os/db';
import type { InvestigationService, ThreadRef } from '@agent-os/runtime';
import { and, eq, gte, inArray, isNotNull, or, sql } from 'drizzle-orm';
import { SELF_CHECK_OWNER } from '../auth/system-owners.js';
import type { SelfCheckLogger } from './scenario-assembly.js';
import { parseThreadId } from './thread-ids.js';

/** What the removal of expired copies works with. */
export interface ExpiredCopiesInput {
  /** The database of `DATABASE_URL`: the copies, their originals and the `show` judge transcripts are all here. */
  readonly db: Database;
  /** Deletes the repeats of an original: every investigation of the conversation, with all its rows. */
  readonly investigations: Pick<InvestigationService, 'purgeThread'>;
  /** The retention term of the employees' transcripts (`TRANSCRIPT_RETENTION_DAYS`). */
  readonly retention: { readonly days: number };
  readonly logger: SelfCheckLogger;
}

/** The repeat conversations and the `show` runs, each with the original it refers to. */
interface Copies {
  readonly repeats: readonly (ThreadRef & { readonly originId: string })[];
  readonly shows: readonly {
    readonly selfCheckRunId: string;
    readonly originId: string;
  }[];
}

/**
 * Removes the employee-data copies whose original is gone (design-self-check.md, Data Model, «Где копия помнит
 * оригинал»; DC-4, invariant 3): a copy refers to its original through an id the program wrote itself, and it is
 * removed when that original no longer exists, or is an investigation of an owner other than `system:self-check`
 * created before the retention term — the investigations of a repeat through `InvestigationService.purgeThread` (all
 * investigations of its conversation), the judge transcripts of a `show` by their `selfCheckRunId`. Copies of a
 * `system:self-check` original — a scenario run — and the scenario runs themselves are kept without a term.
 */
export async function removeExpiredCopies(
  input: ExpiredCopiesInput,
): Promise<void> {
  const copies = await findCopies(input.db);
  const originIds = new Set([
    ...copies.repeats.map(({ originId }) => originId),
    ...copies.shows.map(({ originId }) => originId),
  ]);
  if (originIds.size === 0) return;
  const kept = await retainedOriginals(
    input.db,
    [...originIds],
    input.retention,
  );
  const expiredRepeats = copies.repeats.filter(
    ({ originId }) => !kept.has(originId),
  );
  for (const { threadId, resourceId } of expiredRepeats) {
    await input.investigations.purgeThread({ threadId, resourceId });
  }
  const expiredShows = copies.shows
    .filter(({ originId }) => !kept.has(originId))
    .map(({ selfCheckRunId }) => selfCheckRunId);
  if (expiredShows.length > 0) {
    await input.db
      .delete(researchLlmTranscripts)
      .where(inArray(researchLlmTranscripts.selfCheckRunId, expiredShows));
  }
  input.logger.log('self-check expired copies removed', {
    repeats: expiredRepeats.length,
    shows: expiredShows.length,
  });
}

/** The repeats of `system:self-check` and the `show` runs, read from the ids by the program's own schema (`parseThreadId`). */
async function findCopies(db: Database): Promise<Copies> {
  const conversations = await db
    .selectDistinct({
      threadId: researchInvestigations.threadId,
      resourceId: researchInvestigations.resourceId,
    })
    .from(researchInvestigations)
    .where(eq(researchInvestigations.resourceId, SELF_CHECK_OWNER));
  const repeats = conversations.flatMap((conversation) => {
    const id = parseThreadId(conversation.threadId);
    return id?.kind === 'copy'
      ? [{ ...conversation, originId: id.investigationId }]
      : [];
  });
  const runs = await db
    .selectDistinct({ selfCheckRunId: researchLlmTranscripts.selfCheckRunId })
    .from(researchLlmTranscripts)
    .where(isNotNull(researchLlmTranscripts.selfCheckRunId));
  const shows = runs.flatMap(({ selfCheckRunId }) => {
    const id = selfCheckRunId === null ? null : parseThreadId(selfCheckRunId);
    return selfCheckRunId !== null && id?.kind === 'show'
      ? [{ selfCheckRunId, originId: id.investigationId }]
      : [];
  });
  return { repeats, shows };
}

/**
 * The originals that still exist and are either investigations of `system:self-check` (kept without a term) or were
 * created within the retention term, measured on the database clock as the transcript reads measure it.
 */
async function retainedOriginals(
  db: Database,
  investigationIds: readonly string[],
  retention: { readonly days: number },
): Promise<ReadonlySet<string>> {
  const rows = await db
    .select({ investigationId: researchInvestigations.investigationId })
    .from(researchInvestigations)
    .where(
      and(
        inArray(researchInvestigations.investigationId, [...investigationIds]),
        or(
          eq(researchInvestigations.resourceId, SELF_CHECK_OWNER),
          gte(
            researchInvestigations.createdAt,
            sql`now() - make_interval(days => ${retention.days})`,
          ),
        ),
      ),
    );
  return new Set(rows.map(({ investigationId }) => investigationId));
}
