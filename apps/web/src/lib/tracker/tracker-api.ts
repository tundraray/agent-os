import {
  TrackerDelegationResponseSchema,
  TrackerTaskListResponseSchema,
  TrackerTaskViewSchema,
  type TrackerCommentBody,
  type TrackerDelegationBody,
  type TrackerDelegationResponse,
  type TrackerTaskCreateBody,
  type TrackerTaskListResponse,
  type TrackerTaskPatchBody,
  type TrackerTaskStatus,
  type TrackerTaskView,
} from '@agent-os/contracts';
import { apiRequest } from '@/lib/api/api-request';

/**
 * The employee's tracker client (task-tracker design-server.md, Contract Definitions «Маршруты»): one function per
 * route, each one `apiRequest` parsed by the contract schema. The owner is never sent: the server takes them from
 * the session.
 */

const TASKS_ROUTE = '/api/tracker/tasks';

const taskRoute = (id: string): string =>
  `${TASKS_ROUTE}/${encodeURIComponent(id)}`;

export const trackerApi = {
  /** Without `status` — the open tasks; recently changed first. */
  list: (status: TrackerTaskStatus | null): Promise<TrackerTaskListResponse> =>
    apiRequest({
      path:
        status === null
          ? TASKS_ROUTE
          : `${TASKS_ROUTE}?status=${encodeURIComponent(status)}`,
      schema: TrackerTaskListResponseSchema,
    }),
  create: (body: TrackerTaskCreateBody): Promise<TrackerTaskView> =>
    apiRequest({
      path: TASKS_ROUTE,
      method: 'POST',
      body,
      schema: TrackerTaskViewSchema,
    }),
  get: (id: string): Promise<TrackerTaskView> =>
    apiRequest({ path: taskRoute(id), schema: TrackerTaskViewSchema }),
  update: (id: string, body: TrackerTaskPatchBody): Promise<TrackerTaskView> =>
    apiRequest({
      path: taskRoute(id),
      method: 'PATCH',
      body,
      schema: TrackerTaskViewSchema,
    }),
  remove: (id: string): Promise<void> =>
    apiRequest({ path: taskRoute(id), method: 'DELETE' }),
  comment: (id: string, body: TrackerCommentBody): Promise<TrackerTaskView> =>
    apiRequest({
      path: `${taskRoute(id)}/comments`,
      method: 'POST',
      body,
      schema: TrackerTaskViewSchema,
    }),
  delegate: (
    id: string,
    body: TrackerDelegationBody,
  ): Promise<TrackerDelegationResponse> =>
    apiRequest({
      path: `${taskRoute(id)}/delegations`,
      method: 'POST',
      body,
      schema: TrackerDelegationResponseSchema,
    }),
};
