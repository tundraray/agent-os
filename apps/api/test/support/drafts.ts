import type { INestApplication } from '@nestjs/common';
import {
  ApiErrorSchema,
  DraftViewSchema,
  type ApiError,
  type DraftActionRequest,
  type DraftView,
} from '@agent-os/contracts';
import type { App } from 'supertest/types.js';
import { apiRequest, type Session } from './session';

/**
 * The answer of a draft action (design-runtime.md, «Маршрут черновиков»): 200 with the draft, a refused
 * `saveOwn` included, or an error with its status and `ApiErrorSchema` body.
 */
export type DraftActionAnswer =
  | { readonly ok: true; readonly draft: DraftView }
  | { readonly ok: false; readonly status: number; readonly error: ApiError };

/** `POST /api/threads/:threadId/drafts/:draftId` as `session`. */
export async function postDraftAction(
  app: INestApplication<App>,
  session: Session,
  threadId: string,
  draftId: string,
  action: DraftActionRequest,
): Promise<DraftActionAnswer> {
  const response = await apiRequest(
    app,
    session,
    'post',
    `/threads/${threadId}/drafts/${draftId}`,
    action,
  );
  return response.status === 200
    ? { ok: true, draft: DraftViewSchema.parse(response.body) }
    : {
        ok: false,
        status: response.status,
        error: ApiErrorSchema.parse(response.body),
      };
}
