import {
  MyMemoryViewSchema,
  MyModelsSchema,
  type MyMemoryView,
  type MyModels,
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

/** 204 also when the record is gone or is not the employee's. */
function deleteMemory(memoryId: string): Promise<void> {
  return apiRequest({
    path: `/api/memory/${encodeURIComponent(memoryId)}`,
    method: 'DELETE',
  });
}

export const accessApi = { models, modelsForFeed, memory, deleteMemory };
