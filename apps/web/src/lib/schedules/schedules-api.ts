import {
  ScheduleListResponseSchema,
  ScheduleNextRunResponseSchema,
  ScheduleRunsPageSchema,
  ScheduleRunViewSchema,
  ScheduleViewSchema,
  type ScheduleBody,
  type ScheduleListResponse,
  type ScheduleNextRunRequest,
  type ScheduleNextRunResponse,
  type ScheduleRunsPage,
  type ScheduleRunView,
  type ScheduleView,
} from '@agent-os/contracts';
import { apiRequest } from '@/lib/api/api-request';

/**
 * The employee's schedules client (design-schedules.md, Contract Definitions «Маршруты»): one function per
 * route, each one `apiRequest` parsed by the contract schema. The owner is never sent: the server takes them
 * from the session.
 */

const scheduleRoute = (id: string): string =>
  `/api/schedules/${encodeURIComponent(id)}`;

export const schedulesApi = {
  /** Active by the next run, then paused, then completed. */
  list: (): Promise<ScheduleListResponse> =>
    apiRequest({ path: '/api/schedules', schema: ScheduleListResponseSchema }),
  create: (body: ScheduleBody): Promise<ScheduleView> =>
    apiRequest({
      path: '/api/schedules',
      method: 'POST',
      body,
      schema: ScheduleViewSchema,
    }),
  /** The nearest run of a rule from now; writes nothing. */
  nextRun: (body: ScheduleNextRunRequest): Promise<ScheduleNextRunResponse> =>
    apiRequest({
      path: '/api/schedules/next-run',
      method: 'POST',
      body,
      schema: ScheduleNextRunResponseSchema,
    }),
  get: (id: string): Promise<ScheduleView> =>
    apiRequest({ path: scheduleRoute(id), schema: ScheduleViewSchema }),
  /** `body.conversationId` stays the conversation the schedule was created in. */
  update: (id: string, body: ScheduleBody): Promise<ScheduleView> =>
    apiRequest({
      path: scheduleRoute(id),
      method: 'PUT',
      body,
      schema: ScheduleViewSchema,
    }),
  pause: (id: string): Promise<ScheduleView> =>
    apiRequest({
      path: `${scheduleRoute(id)}/pause`,
      method: 'POST',
      schema: ScheduleViewSchema,
    }),
  resume: (id: string): Promise<ScheduleView> =>
    apiRequest({
      path: `${scheduleRoute(id)}/resume`,
      method: 'POST',
      schema: ScheduleViewSchema,
    }),
  remove: (id: string): Promise<void> =>
    apiRequest({ path: scheduleRoute(id), method: 'DELETE' }),
  /** Latest runs first; `cursor` — `nextCursor` of the previous page. */
  runs: (id: string, cursor: string | null): Promise<ScheduleRunsPage> =>
    apiRequest({
      path:
        cursor === null
          ? `${scheduleRoute(id)}/runs`
          : `${scheduleRoute(id)}/runs?cursor=${encodeURIComponent(cursor)}`,
      schema: ScheduleRunsPageSchema,
    }),
  /** «Запустить сейчас»: started or skipped with its reason. */
  run: (id: string): Promise<ScheduleRunView> =>
    apiRequest({
      path: `${scheduleRoute(id)}/run`,
      method: 'POST',
      schema: ScheduleRunViewSchema,
    }),
};
