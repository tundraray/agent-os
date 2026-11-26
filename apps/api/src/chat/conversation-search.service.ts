import { Inject, Injectable } from '@nestjs/common';
import { LOGGER, type Logger } from '@agent-os/common';
import {
  type ConversationMatch,
  type ConversationSearchQuery,
  type ConversationSearchResponse,
  MatchPlaceSchema,
  SEARCH_PAGE_SIZE,
} from '@agent-os/contracts';
import {
  type ConversationSearchInput,
  type ConversationSearchRow,
  ConversationSearchRepository,
} from '@agent-os/db';
import { z } from 'zod';
import {
  CursorTimeSchema,
  decodeCursor,
  encodeCursor,
} from '../common/opaque-cursor';
import { httpError } from './chat.errors';
import { parseHeadline, snippetOf } from './search-snippet';

/**
 * Position of the last place of a page: its time in ms, its key, and `l` when the pages are of the loose query —
 * the mode stays the one the first page chose.
 */
const SearchCursorSchema = z.strictObject({
  u: CursorTimeSchema,
  i: z.string().min(1),
  l: z.literal(true).optional(),
});
type SearchCursor = z.infer<typeof SearchCursorSchema>;

function toMatch(row: ConversationSearchRow): ConversationMatch {
  const place = MatchPlaceSchema.parse(row.place);
  const inTitle = place === MatchPlaceSchema.enum.title;
  return {
    threadId: row.rootId,
    title: row.rootTitle === '' ? null : row.rootTitle,
    at: row.at,
    place,
    agent: row.subagent
      ? { agentId: row.conversationId, name: row.name }
      : null,
    tool: row.tool,
    seq: row.seq,
    callId: row.callId,
    titleMarks: inTitle ? parseHeadline(row.headline ?? '').marks : [],
    snippet: inTitle ? null : snippetOf(row),
  };
}

/**
 * Search over the employee's live conversations (conversation-search design, C3 api): reads one page of
 * found places, turns the headline marks into ranges (KD-6) and the extra row into the next cursor
 * (KD-5). One read, no transaction; a first page the strict query leaves empty is read again by the loose
 * query, and its cursor keeps that mode.
 */
@Injectable()
export class ConversationSearchService {
  private readonly logger: Logger;

  constructor(
    @Inject(ConversationSearchRepository)
    private readonly rows: ConversationSearchRepository,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'chat.search' });
  }

  /** A malformed cursor → 400 `INVALID_CURSOR`; the owner is always the session's (KD-4). */
  async search(
    ownerId: string,
    { q, cursor }: ConversationSearchQuery,
  ): Promise<ConversationSearchResponse> {
    const position =
      cursor === undefined
        ? undefined
        : decodeCursor(cursor, SearchCursorSchema, () =>
            httpError('INVALID_CURSOR'),
          );
    const input: ConversationSearchInput = {
      ownerId,
      query: q,
      after: position && { at: new Date(position.u), key: position.i },
      limit: SEARCH_PAGE_SIZE,
      loose: position?.l === true,
    };
    let rows = await this.rows.search(input);
    let loose = input.loose;
    if (rows.length === 0 && position === undefined) {
      rows = await this.rows.search({ ...input, loose: true });
      loose = true;
    }
    if (loose)
      this.logger.info('search answered by the loose query', {
        ownerId,
        loose: true,
        hasCursor: position !== undefined,
        count: Math.min(rows.length, SEARCH_PAGE_SIZE),
      });
    const page = rows.slice(0, SEARCH_PAGE_SIZE);
    const last = page.at(-1);
    return {
      matches: page.map(toMatch),
      nextCursor:
        rows.length > SEARCH_PAGE_SIZE && last
          ? encodeCursor({
              u: new Date(last.at).getTime(),
              i: last.key,
              ...(loose ? { l: true } : {}),
            } satisfies SearchCursor)
          : null,
    };
  }
}
