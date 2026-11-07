import {
  type Database,
  researchInvestigations,
  researchLlmTranscripts,
} from '@agent-os/db';
import type { InvestigationService, ThreadRef } from '@agent-os/runtime';
import { and, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import type { SelfCheckLogger } from './scenario-assembly.js';
import { parseThreadId } from './thread-ids.js';

/** What the removal of expired copies works with; the main database is only read. */
export interface ExpiredCopiesInput {
  /** The self-check database: the copies are found and the `show` judge transcripts are deleted here. */
  readonly selfCheckDb: Database;
  /** Deletes the repeats of an original: every investigation of the conversation, with all its rows. */
  readonly investigations: Pick<InvestigationService, 'purgeThread'>;
  /**
   * The main database, read-only; called only when a copy of a main original exists, so a self-check database
   * without such copies never connects to it.
   */
  readonly mainDb: () => Database;
  /** The retention term of the main database (`TRANSCRIPT_RETENTION_DAYS`). */
  readonly retention: { readonly days: number };
  readonly logger: SelfCheckLogger;
}

/** A repeat conversation and the `show` runs of the self-check database, each with the main original it refers to. */
interface MainCopies {
  readonly repeats: readonly (ThreadRef & { readonly originId: string })[];
  readonly shows: readonly {
    readonly selfCheckRunId: string;
    readonly originId: string;
  }[];
}

/**
 * Removes the employee-data copies whose original is gone (design-self-check.md, Data Model, «Где копия помнит
 * оригинал»; DC-4, invariant 3): a copy refers to a main original through an id the program wrote itself, and it is
 * removed when that original is deleted from the main database or was created before the main retention term — the
 * investigations of a repeat through `InvestigationService.purgeThread` (all investigations of its conversation), the
 * judge transcripts of a `show` by their `selfCheckRunId`. Copies of a self-check original and scenario runs are kept
 * without a term: their ids do not name a main original.
 */
export async function removeExpiredCopies(
  input: ExpiredCopiesInput,
): Promise<void> {
  const copies = await findMainCopies(input.selfCheckDb);
  const originIds = new Set([
    ...copies.repeats.map(({ originId }) => originId),
    ...copies.shows.map(({ originId }) => originId),
  ]);
  if (originIds.size === 0) return;
  const kept = await retainedOriginals(
    input.mainDb(),
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
    await input.selfCheckDb
      .delete(researchLlmTranscripts)
      .where(inArray(researchLlmTranscripts.selfCheckRunId, expiredShows));
  }
  input.logger.log('self-check expired copies removed', {
    repeats: expiredRepeats.length,
    shows: expiredShows.length,
  });
}

/** The copies of main originals, read from the ids by the program's own schema (`parseThreadId`). */
async function findMainCopies(db: Database): Promise<MainCopies> {
  const conversations = await db
    .selectDistinct({
      threadId: researchInvestigations.threadId,
      resourceId: researchInvestigations.resourceId,
    })
    .from(researchInvestigations);
  const repeats = conversations.flatMap((conversation) => {
    const id = parseThreadId(conversation.threadId);
    return id?.kind === 'copy' && id.base === 'main'
      ? [{ ...conversation, originId: id.investigationId }]
      : [];
  });
  const runs = await db
    .selectDistinct({ selfCheckRunId: researchLlmTranscripts.selfCheckRunId })
    .from(researchLlmTranscripts)
    .where(isNotNull(researchLlmTranscripts.selfCheckRunId));
  const shows = runs.flatMap(({ selfCheckRunId }) => {
    const id = selfCheckRunId === null ? null : parseThreadId(selfCheckRunId);
    return selfCheckRunId !== null && id?.kind === 'show' && id.base === 'main'
      ? [{ selfCheckRunId, originId: id.investigationId }]
      : [];
  });
  return { repeats, shows };
}

/**
 * The originals that still exist in the main database and were created within its retention term, measured on the
 * main database's clock as its transcript reads measure it.
 */
async function retainedOriginals(
  mainDb: Database,
  investigationIds: readonly string[],
  retention: { readonly days: number },
): Promise<ReadonlySet<string>> {
  const rows = await mainDb
    .select({ investigationId: researchInvestigations.investigationId })
    .from(researchInvestigations)
    .where(
      and(
        inArray(researchInvestigations.investigationId, [...investigationIds]),
        gte(
          researchInvestigations.createdAt,
          sql`now() - make_interval(days => ${retention.days})`,
        ),
      ),
    );
  return new Set(rows.map(({ investigationId }) => investigationId));
}
