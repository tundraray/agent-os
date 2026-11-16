import { z } from "zod";
import { McpConnectionSchema, type McpConnection } from "@agent-os/contracts";
import { apiRequest } from "@/lib/api/api-request";
import { apiBaseUrl } from "@/lib/config";

const McpConnectionListSchema = z.array(McpConnectionSchema);

/** Enabled personal-OAuth servers the employee may use, by name, with his account status. */
async function connections(): Promise<McpConnection[]> {
  return apiRequest({ path: "/api/mcp/connections", schema: McpConnectionListSchema });
}

/** 204, also when the employee has no account on the server. */
async function disconnect(server: string): Promise<void> {
  await apiRequest({ path: `/api/mcp/connections/${encodeURIComponent(server)}`, method: "DELETE" });
}

/** The connect route answers 302 to the authorization server, so the tab goes to this address instead of a request. */
function connectUrl(server: string): string {
  return `${apiBaseUrl}/api/mcp/connections/${encodeURIComponent(server)}/connect`;
}

export const mcpApi = { connections, disconnect, connectUrl };
