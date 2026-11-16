import { z } from 'zod';
import {
  AdminUserDetailSchema,
  AdminUserPageSchema,
  AdminUserSummarySchema,
  CreateCatalogModelBodySchema,
  GrantSchema,
  McpServerSummarySchema,
  McpServerViewSchema,
  ProviderListSchema,
  ProviderViewSchema,
  RefreshMcpToolsResponseSchema,
  RoleDetailSchema,
  RoleListSchema,
  RoleSummarySchema,
  SignInSettingsSchema,
  type AdminUserDetail,
  type AdminUserPage,
  type AdminUserSummary,
  type CatalogModel,
  type CreateCatalogModelBody,
  type CreateGrantBody,
  type CreateLocalUserBody,
  type CreateProviderBody,
  type CreateRoleBody,
  type Grant,
  type McpServerSummary,
  type McpServerView,
  type ProviderList,
  type ProviderView,
  type RefreshMcpToolsResponse,
  type RegisterMcpServerBody,
  type RoleDetail,
  type RoleList,
  type RoleSummary,
  type SignInSettings,
  type UpdateCatalogModelBody,
  type UpdateMcpServerBody,
  type UpdateProviderBody,
  type UpdateRoleBody,
  type UpdateSignInSettingsBody,
} from '@agent-os/contracts';
import { apiRequest } from '@/lib/api/api-request';
import { apiBaseUrl } from '@/lib/config';

/**
 * The admin panel's API client (design-admin.md, KD-3, Contract «`adminApi`»): one function per operation,
 * each one `apiRequest` whose answer is parsed by the contract schema.
 */

/** `/api/admin/…` from path segments; data segments (server name, model id `anthropic/…`) are encoded. */
const apiPath = (...segments: string[]): string =>
  `/api/admin/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`;

const GrantListSchema = z.array(GrantSchema);
const McpServerListSchema = z.array(McpServerSummarySchema);
/** The catalogue row is declared as the create body's type; the contracts have no schema of their own for it. */
const CatalogModelListSchema = z.array(CreateCatalogModelBodySchema);

const users = {
  /** A page by name; an empty `query` and the first page's `null` cursor are not sent. */
  list({ query, cursor }: { query: string; cursor: string | null }): Promise<AdminUserPage> {
    const params = new URLSearchParams();
    if (query !== '') params.set('query', query);
    if (cursor !== null) params.set('cursor', cursor);
    const search = params.toString();
    return apiRequest({ path: `${apiPath('users')}${search === '' ? '' : `?${search}`}`, schema: AdminUserPageSchema });
  },
  get: (id: string): Promise<AdminUserDetail> => apiRequest({ path: apiPath('users', id), schema: AdminUserDetailSchema }),
  create: (body: CreateLocalUserBody): Promise<AdminUserSummary> =>
    apiRequest({ path: apiPath('users'), method: 'POST', body, schema: AdminUserSummarySchema }),
  resetPassword: (id: string, password: string): Promise<void> =>
    apiRequest({ path: apiPath('users', id, 'password'), method: 'PUT', body: { password } }),
  block: (id: string): Promise<AdminUserSummary> =>
    apiRequest({ path: apiPath('users', id, 'block'), method: 'POST', schema: AdminUserSummarySchema }),
  unblock: (id: string): Promise<AdminUserSummary> =>
    apiRequest({ path: apiPath('users', id, 'unblock'), method: 'POST', schema: AdminUserSummarySchema }),
  setPersonalAdmin: (id: string, enabled: boolean): Promise<AdminUserDetail> =>
    apiRequest({ path: apiPath('users', id, 'admin'), method: 'PUT', body: { enabled }, schema: AdminUserDetailSchema }),
  assignRole: (id: string, roleId: string): Promise<AdminUserDetail> =>
    apiRequest({ path: apiPath('users', id, 'roles', roleId), method: 'PUT', schema: AdminUserDetailSchema }),
  removeRole: (id: string, roleId: string): Promise<AdminUserDetail> =>
    apiRequest({ path: apiPath('users', id, 'roles', roleId), method: 'DELETE', schema: AdminUserDetailSchema }),
};

const roles = {
  list: (): Promise<RoleList> => apiRequest({ path: apiPath('roles'), schema: RoleListSchema }),
  get: (id: string): Promise<RoleDetail> => apiRequest({ path: apiPath('roles', id), schema: RoleDetailSchema }),
  create: (body: CreateRoleBody): Promise<RoleSummary> =>
    apiRequest({ path: apiPath('roles'), method: 'POST', body, schema: RoleSummarySchema }),
  update: (id: string, body: UpdateRoleBody): Promise<RoleDetail> =>
    apiRequest({ path: apiPath('roles', id), method: 'PATCH', body, schema: RoleDetailSchema }),
  remove: (id: string): Promise<void> => apiRequest({ path: apiPath('roles', id), method: 'DELETE' }),
};

const grants = {
  /** The holder's grants by creation time. */
  list(holder: { roleId: string } | { userId: string }): Promise<Grant[]> {
    const params = new URLSearchParams('roleId' in holder ? [['roleId', holder.roleId]] : [['userId', holder.userId]]);
    return apiRequest({ path: `${apiPath('grants')}?${params.toString()}`, schema: GrantListSchema });
  },
  create: (body: CreateGrantBody): Promise<Grant> =>
    apiRequest({ path: apiPath('grants'), method: 'POST', body, schema: GrantSchema }),
  /** The quota of a model allow in dollars; `null` removes it. */
  updateQuota: (id: string, quotaUsd: number | null): Promise<Grant> =>
    apiRequest({ path: apiPath('grants', id), method: 'PATCH', body: { quotaUsd }, schema: GrantSchema }),
  remove: (id: string): Promise<void> => apiRequest({ path: apiPath('grants', id), method: 'DELETE' }),
};

const providers = {
  list: (): Promise<ProviderList> => apiRequest({ path: apiPath('providers'), schema: ProviderListSchema }),
  get: (id: string): Promise<ProviderView> => apiRequest({ path: apiPath('providers', id), schema: ProviderViewSchema }),
  create: (body: CreateProviderBody): Promise<ProviderView> =>
    apiRequest({ path: apiPath('providers'), method: 'POST', body, schema: ProviderViewSchema }),
  update: (id: string, body: UpdateProviderBody): Promise<ProviderView> =>
    apiRequest({ path: apiPath('providers', id), method: 'PATCH', body, schema: ProviderViewSchema }),
};

const signInSettings = {
  get: (): Promise<SignInSettings> => apiRequest({ path: apiPath('settings', 'sign-in'), schema: SignInSettingsSchema }),
  update: (body: UpdateSignInSettingsBody): Promise<SignInSettings> =>
    apiRequest({ path: apiPath('settings', 'sign-in'), method: 'PUT', body, schema: SignInSettingsSchema }),
};

const servers = {
  list: (): Promise<McpServerSummary[]> => apiRequest({ path: apiPath('mcp-servers'), schema: McpServerListSchema }),
  get: (name: string): Promise<McpServerView> =>
    apiRequest({ path: apiPath('mcp-servers', name), schema: McpServerViewSchema }),
  register: (body: RegisterMcpServerBody): Promise<McpServerView> =>
    apiRequest({ path: apiPath('mcp-servers'), method: 'POST', body, schema: McpServerViewSchema }),
  update: (name: string, body: UpdateMcpServerBody): Promise<McpServerView> =>
    apiRequest({ path: apiPath('mcp-servers', name), method: 'PATCH', body, schema: McpServerViewSchema }),
  refreshTools: (name: string): Promise<RefreshMcpToolsResponse> =>
    apiRequest({
      path: apiPath('mcp-servers', name, 'tools', 'refresh'),
      method: 'POST',
      schema: RefreshMcpToolsResponseSchema,
    }),
  remove: (name: string): Promise<void> => apiRequest({ path: apiPath('mcp-servers', name), method: 'DELETE' }),
  /** The connect route answers 302 to the authorization server, so the tab goes to this address instead of a request. */
  connectUrl: (name: string): string => `${apiBaseUrl}${apiPath('mcp-servers', name, 'connect')}`,
};

const models = {
  list: (): Promise<CatalogModel[]> => apiRequest({ path: apiPath('models'), schema: CatalogModelListSchema }),
  create: (body: CreateCatalogModelBody): Promise<CatalogModel> =>
    apiRequest({ path: apiPath('models'), method: 'POST', body, schema: CreateCatalogModelBodySchema }),
  update: (id: string, body: UpdateCatalogModelBody): Promise<CatalogModel> =>
    apiRequest({ path: apiPath('models', id), method: 'PATCH', body, schema: CreateCatalogModelBodySchema }),
  remove: (id: string): Promise<void> => apiRequest({ path: apiPath('models', id), method: 'DELETE' }),
};

export const adminApi = { users, roles, grants, providers, signInSettings, servers, models };
