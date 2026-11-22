import { MyModelsSchema, type MyModels } from '@agent-os/contracts';
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

export const accessApi = { models, modelsForFeed };
