import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { LOGGER, type Logger } from '@agent-os/common';
import {
  ConversationSearchQuerySchema,
  type ConversationSearchQuery,
  type ConversationSearchResponse,
} from '@agent-os/contracts';
import { loggedRoute } from '../common/logged-route';
import { ZodValidationPipe } from '../common/zod-validation.pipe';
import type { AuthedRequest } from '../identity/auth-user';
import { chatRoute } from './chat.errors';
import { ConversationSearchService } from './conversation-search.service';

/**
 * GET /api/search (conversation-search design, «Маршрут»): the matches of the employee of the session.
 * Its own controller: under `threads` the path would fall into `:threadId`. The log record carries the
 * query's length and word count, never its text (§Security Considerations).
 */
@Controller('search')
export class SearchController {
  private readonly logger: Logger;

  constructor(
    private readonly conversationSearch: ConversationSearchService,
    @Inject(LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'chat.search' });
  }

  @Get()
  search(
    @Query(new ZodValidationPipe(ConversationSearchQuerySchema))
    query: ConversationSearchQuery,
    @Req() req: AuthedRequest,
  ): Promise<ConversationSearchResponse> {
    const ownerId = req.user.id;
    return loggedRoute(
      this.logger,
      {
        route: 'GET /search',
        fields: {
          ownerId,
          queryLength: query.q.length,
          wordCount: query.q.split(/\s+/).length,
          hasCursor: query.cursor !== undefined,
        },
        work: () => this.conversationSearch.search(ownerId, query),
        outcomeOf: (page) => ({
          count: page.matches.length,
          hasNextPage: page.nextCursor !== null,
        }),
      },
      chatRoute(),
    );
  }
}
