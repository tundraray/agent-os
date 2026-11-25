import {
  MemoryHistoryViewSchema,
  MyMemoryViewSchema,
  MyModelsSchema,
  type MemoryHistoryView,
  type MyMemoryView,
  type MyModels,
  type RevertMemoryBody,
} from '@agent-os/contracts';
import { apiRequest } from '@/lib/api/api-request';

/** The models allowed to the employee now, with this month's spend, quota and remaining, by name. */
async function models(): Promise<MyModels> {
  return apiRequest({ path: '/api/access/models', schema: MyModelsSchema });
}

let feedRead: Promise<MyModels> | null = null;

/**
 * `models` for the quota lines of a feed: the lines shown together share one read while it is in flight;
 * a line shown later reads again, so it never gets amounts older than itself.
 */
function modelsForFeed(): Promise<MyModels> {
  feedRead ??= models().finally(() => {
    feedRead = null;
  });
  return feedRead;
}

/** «Моя память»: the signed-in employee's records, most recently changed first. */
function memory(): Promise<MyMemoryView> {
  return apiRequest({ path: '/api/memory', schema: MyMemoryViewSchema });
}

const memoryRoute = (memoryId: string): string =>
  `/api/memory/${encodeURIComponent(memoryId)}`;

/** 204 also when the record is gone or is not the employee's. */
function deleteMemory(memoryId: string): Promise<void> {
  return apiRequest({ path: memoryRoute(memoryId), method: 'DELETE' });
}

/** The record's versions, newest (current) first; 404 for a record that is not the employee's. */
function memoryHistory(memoryId: string): Promise<MemoryHistoryView> {
  return apiRequest({
    path: `${memoryRoute(memoryId)}/history`,
    schema: MemoryHistoryViewSchema,
  });
}

/** 409 `RECORD_VERSION_CONFLICT` when `body.expectedVersion` is no longer the current one. */
function revertMemory(
  memoryId: string,
  body: RevertMemoryBody,
): Promise<MemoryHistoryView> {
  return apiRequest({
    path: `${memoryRoute(memoryId)}/revert`,
    method: 'POST',
    body,
    schema: MemoryHistoryViewSchema,
  });
}

export const accessApi = {
  models,
  modelsForFeed,
  memory,
  deleteMemory,
  memoryHistory,
  revertMemory,
};
