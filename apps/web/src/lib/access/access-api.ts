import { MyModelsSchema, type MyModels } from "@agent-os/contracts";
import { apiRequest } from "@/lib/api/api-request";

/** The models allowed to the employee now, with this month's spend, quota and remaining, by name. */
async function models(): Promise<MyModels> {
  return apiRequest({ path: "/api/access/models", schema: MyModelsSchema });
}

export const accessApi = { models };
