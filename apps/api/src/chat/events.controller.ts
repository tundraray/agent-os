import {
  Controller,
  Inject,
  Query,
  Req,
  Sse,
  UseGuards,
  type MessageEvent,
} from '@nestjs/common';
import type { Logger } from '@agent-os/common';
import { EventsQuerySchema, type EventsQuery } from '@agent-os/contracts';
import { defer, finalize, map, type Observable } from 'rxjs';
import type { AuthedRequest } from '../auth/auth.types.js';
import { SessionGuard } from '../auth/session.guard.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { APP_LOGGER } from '../logging/app-logger.js';
import { parseWatch } from './live-filter.js';
import { LiveHub } from './live-hub.js';

/** The reconnection hint of the stream (`retry`), sent with its first event. */
const RETRY_MS = 2000;

/**
 * `GET /events?watch` (design-chat.md, Contract «Поток»): the owner's SSE stream of `ready`, `tree`,
 * `delta` and `ping` events (`LiveEventSchema`). An unknown or foreign `watch` is not an error — the
 * stream just carries no parts. Connecting and disconnecting are logged with `ownerId` and `watch`.
 */
@Controller('events')
@UseGuards(SessionGuard)
export class EventsController {
  private readonly logger: Logger;

  constructor(
    private readonly hub: LiveHub,
    @Inject(APP_LOGGER) logger: Logger,
  ) {
    this.logger = logger.child({ service: 'chat.events' });
  }

  @Sse()
  events(
    @Query(new ZodValidationPipe(EventsQuerySchema)) query: EventsQuery,
    @Req() req: AuthedRequest,
  ): Observable<MessageEvent> {
    const fields = { ownerId: req.user.id, watch: query.watch ?? null };
    return defer(() => {
      this.logger.info('live stream connected', fields);
      return this.hub.register(fields.ownerId, parseWatch(query.watch));
    }).pipe(
      map((event, index) => (index === 0 ? { ...event, retry: RETRY_MS } : event)),
      finalize(() => this.logger.info('live stream disconnected', fields)),
    );
  }
}
