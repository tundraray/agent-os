import { Inject, Injectable } from '@nestjs/common';
import {
  type ConversationMatch,
  type ConversationSearchQuery,
  type ConversationSearchResponse,
  MatchPlaceSchema,
  SEARCH_PAGE_SIZE,
} from '@agent-os/contracts';
import {
  type ConversationSearchRow,
  ConversationSearchRepository,
} from '@agent-os/db';
import { parseHeadline, snippetOf } from './search-snippet';
import { decodeThreadCursor, encodeThreadCursor } from './thread-cursor';

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
 * (KD-5). One read, no transaction.
 */
@Injectable()
export class ConversationSearchService {
  constructor(
    @Inject(ConversationSearchRepository)
    private readonly rows: ConversationSearchRepository,
  ) {}

  /** A malformed cursor → 400 `INVALID_CURSOR`; the owner is always the session's (KD-4). */
  async search(
    ownerId: string,
    { q, cursor }: ConversationSearchQuery,
  ): Promise<ConversationSearchResponse> {
    const position =
      cursor === undefined ? undefined : decodeThreadCursor(cursor);
    const rows = await this.rows.search({
      ownerId,
      query: q,
      after: position && { at: new Date(position.u), key: position.i },
      limit: SEARCH_PAGE_SIZE,
    });
    const page = rows.slice(0, SEARCH_PAGE_SIZE);
    const last = page.at(-1);
    return {
      matches: page.map(toMatch),
      nextCursor:
        rows.length > SEARCH_PAGE_SIZE && last
          ? encodeThreadCursor({ updatedAt: new Date(last.at), id: last.key })
          : null,
    };
  }
}
