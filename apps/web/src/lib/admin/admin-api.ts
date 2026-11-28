import { z } from 'zod';
import {
  AdminUserDetailSchema,
  AdminUserPageSchema,
  AdminUserSummarySchema,
  BannedRecordSchema,
  CatalogModelSchema,
  GrantSchema,
  LibrarySettingsSchema,
  McpCallbackUrlSchema,
  McpServerSummarySchema,
  McpServerViewSchema,
  McpToolViewSchema,
  ModelDefaultsSchema,
  ModelProviderCheckSchema,
  ModelProviderViewSchema,
  OrganisationInstructionsSchema,
  ProviderListSchema,
  ProviderViewSchema,
  RecordDetailSchema,
  RecordSummarySchema,
  RefreshMcpToolsResponseSchema,
  RoleDetailSchema,
  RoleLevelsSchema,
  RoleListSchema,
  RoleSummarySchema,
  SelfLearningSettingsSchema,
  ServerAccessSchema,
  SignInSettingsSchema,
  ToolResultSettingsSchema,
  UserLevelsSchema,
  type AdminUserDetail,
  type AdminUserPage,
  type AdminUserSummary,
  type BannedRecord,
  type CatalogModel,
  type CreateCatalogModelBody,
  type CreateRecordBody,
  type CreateGrantBody,
  type CreateLocalUserBody,
  type CreateModelProviderBody,
  type CreateProviderBody,
  type CreateRoleBody,
  type Grant,
  type LibrarySettings,
  type McpCallbackUrl,
  type McpServerSummary,
  type McpServerView,
  type McpToolView,
  type ModelDefaults,
  type ModelProviderCheck,
  type ModelProviderView,
  type OrganisationInstructions,
  type ProviderList,
  type ProviderView,
  type RecordDetail,
  type RecordSummary,
  type RefreshMcpToolsResponse,
  type RegisterMcpServerBody,
  type RoleDetail,
  type RoleLevels,
  type RoleList,
  type RoleSummary,
  type SaveRoleLevelsBody,
  type SaveServerAccessBody,
  type SaveUserLevelsBody,
  type SelfLearningSettings,
  type ServerAccess,
  type SignInSettings,
  type SystemRecordAudienceBody,
  type ToolResultSettings,
  type UpdateCatalogModelBody,
  type UpdateLibrarySettingsBody,
  type UpdateMcpServerBody,
  type UpdateMcpToolBody,
  type UpdateModelDefaultsBody,
  type UpdateModelProviderBody,
  type UpdateOrganisationInstructionsBody,
  type UpdateProviderBody,
  type UpdateRecordBody,
  type UpdateRoleBody,
  type UpdateSelfLearningSettingsBody,
  type UpdateSignInSettingsBody,
  type UpdateToolResultSettingsBody,
  type UserLevels,
} from '@agent-os/contracts';
import { apiRequest } from '@/lib/api/api-request';

/**
 * The admin panel's API client (design-admin.md, KD-3, Contract «`adminApi`»): one function per operation,
 * each one `apiRequest` whose answer is parsed by the contract schema.
 */

/** `/api/admin/…` from path segments; data segments (server name, model id `anthropic/…`) are encoded. */
const apiPath = (...segments: string[]): string =>
  `/api/admin/${segments.map((segment) => encodeURIComponent(segment)).join('/')}`;

const GrantListSchema = z.array(GrantSchema);
const McpServerListSchema = z.array(McpServerSummarySchema);

const users = {
  /** A page by name; an empty `query` and the first page's `null` cursor are not sent. */
  list({
    query,
    cursor,
  }: {
    query: string;
    cursor: string | null;
  }): Promise<AdminUserPage> {
    const params = new URLSearchParams();
    if (query !== '') params.set('query', query);
    if (cursor !== null) params.set('cursor', cursor);
    const search = params.toString();
    return apiRequest({
      path: `${apiPath('users')}${search === '' ? '' : `?${search}`}`,
      schema: AdminUserPageSchema,
    });
  },
  get: (id: string): Promise<AdminUserDetail> =>
    apiRequest({ path: apiPath('users', id), schema: AdminUserDetailSchema }),
  create: (body: CreateLocalUserBody): Promise<AdminUserSummary> =>
    apiRequest({
      path: apiPath('users'),
      method: 'POST',
      body,
      schema: AdminUserSummarySchema,
    }),
  resetPassword: (id: string, password: string): Promise<void> =>
    apiRequest({
      path: apiPath('users', id, 'password'),
      method: 'PUT',
      body: { password },
    }),
  block: (id: string): Promise<AdminUserSummary> =>
    apiRequest({
      path: apiPath('users', id, 'block'),
      method: 'POST',
      schema: AdminUserSummarySchema,
    }),
  unblock: (id: string): Promise<AdminUserSummary> =>
    apiRequest({
      path: apiPath('users', id, 'unblock'),
      method: 'POST',
      schema: AdminUserSummarySchema,
    }),
  setPersonalAdmin: (id: string, enabled: boolean): Promise<AdminUserDetail> =>
    apiRequest({
      path: apiPath('users', id, 'admin'),
      method: 'PUT',
      body: { enabled },
      schema: AdminUserDetailSchema,
    }),
  assignRole: (id: string, roleId: string): Promise<AdminUserDetail> =>
    apiRequest({
      path: apiPath('users', id, 'roles', roleId),
      method: 'PUT',
      schema: AdminUserDetailSchema,
    }),
  removeRole: (id: string, roleId: string): Promise<AdminUserDetail> =>
    apiRequest({
      path: apiPath('users', id, 'roles', roleId),
      method: 'DELETE',
      schema: AdminUserDetailSchema,
    }),
  levels: (id: string): Promise<UserLevels> =>
    apiRequest({
      path: apiPath('users', id, 'levels'),
      schema: UserLevelsSchema,
    }),
  /** Only the changed servers; the answer is the employee's levels after the save. */
  saveLevels: (id: string, body: SaveUserLevelsBody): Promise<UserLevels> =>
    apiRequest({
      path: apiPath('users', id, 'levels'),
      method: 'PUT',
      body,
      schema: UserLevelsSchema,
    }),
};

const roles = {
  list: (): Promise<RoleList> =>
    apiRequest({ path: apiPath('roles'), schema: RoleListSchema }),
  get: (id: string): Promise<RoleDetail> =>
    apiRequest({ path: apiPath('roles', id), schema: RoleDetailSchema }),
  /** `copyFrom` copies the sample role's levels and model grants (AC-37.8). */
  create: (body: CreateRoleBody): Promise<RoleSummary> =>
    apiRequest({
      path: apiPath('roles'),
      method: 'POST',
      body,
      schema: RoleSummarySchema,
    }),
  update: (id: string, body: UpdateRoleBody): Promise<RoleDetail> =>
    apiRequest({
      path: apiPath('roles', id),
      method: 'PATCH',
      body,
      schema: RoleDetailSchema,
    }),
  remove: (id: string): Promise<void> =>
    apiRequest({ path: apiPath('roles', id), method: 'DELETE' }),
  levels: (id: string): Promise<RoleLevels> =>
    apiRequest({
      path: apiPath('roles', id, 'levels'),
      schema: RoleLevelsSchema,
    }),
  /** Only the changed servers; the answer is the role's levels after the save. */
  saveLevels: (id: string, body: SaveRoleLevelsBody): Promise<RoleLevels> =>
    apiRequest({
      path: apiPath('roles', id, 'levels'),
      method: 'PUT',
      body,
      schema: RoleLevelsSchema,
    }),
};

const grants = {
  /** The holder's grants by creation time. */
  list(holder: { roleId: string } | { userId: string }): Promise<Grant[]> {
    const params = new URLSearchParams(
      'roleId' in holder
        ? [['roleId', holder.roleId]]
        : [['userId', holder.userId]],
    );
    return apiRequest({
      path: `${apiPath('grants')}?${params.toString()}`,
      schema: GrantListSchema,
    });
  },
  create: (body: CreateGrantBody): Promise<Grant> =>
    apiRequest({
      path: apiPath('grants'),
      method: 'POST',
      body,
      schema: GrantSchema,
    }),
  /** The quota of a model allow in dollars; `null` removes it. */
  updateQuota: (id: string, quotaUsd: number | null): Promise<Grant> =>
    apiRequest({
      path: apiPath('grants', id),
      method: 'PATCH',
      body: { quotaUsd },
      schema: GrantSchema,
    }),
  remove: (id: string): Promise<void> =>
    apiRequest({ path: apiPath('grants', id), method: 'DELETE' }),
};

const providers = {
  list: (): Promise<ProviderList> =>
    apiRequest({ path: apiPath('providers'), schema: ProviderListSchema }),
  get: (id: string): Promise<ProviderView> =>
    apiRequest({ path: apiPath('providers', id), schema: ProviderViewSchema }),
  create: (body: CreateProviderBody): Promise<ProviderView> =>
    apiRequest({
      path: apiPath('providers'),
      method: 'POST',
      body,
      schema: ProviderViewSchema,
    }),
  update: (id: string, body: UpdateProviderBody): Promise<ProviderView> =>
    apiRequest({
      path: apiPath('providers', id),
      method: 'PATCH',
      body,
      schema: ProviderViewSchema,
    }),
};

const signInSettings = {
  get: (): Promise<SignInSettings> =>
    apiRequest({
      path: apiPath('settings', 'sign-in'),
      schema: SignInSettingsSchema,
    }),
  update: (body: UpdateSignInSettingsBody): Promise<SignInSettings> =>
    apiRequest({
      path: apiPath('settings', 'sign-in'),
      method: 'PUT',
      body,
      schema: SignInSettingsSchema,
    }),
};

const servers = {
  list: (): Promise<McpServerSummary[]> =>
    apiRequest({ path: apiPath('mcp-servers'), schema: McpServerListSchema }),
  get: (name: string): Promise<McpServerView> =>
    apiRequest({
      path: apiPath('mcp-servers', name),
      schema: McpServerViewSchema,
    }),
  register: (body: RegisterMcpServerBody): Promise<McpServerView> =>
    apiRequest({
      path: apiPath('mcp-servers'),
      method: 'POST',
      body,
      schema: McpServerViewSchema,
    }),
  update: (name: string, body: UpdateMcpServerBody): Promise<McpServerView> =>
    apiRequest({
      path: apiPath('mcp-servers', name),
      method: 'PATCH',
      body,
      schema: McpServerViewSchema,
    }),
  refreshTools: (name: string): Promise<RefreshMcpToolsResponse> =>
    apiRequest({
      path: apiPath('mcp-servers', name, 'tools', 'refresh'),
      method: 'POST',
      schema: RefreshMcpToolsResponseSchema,
    }),
  remove: (name: string): Promise<void> =>
    apiRequest({ path: apiPath('mcp-servers', name), method: 'DELETE' }),
  access: (name: string): Promise<ServerAccess> =>
    apiRequest({
      path: apiPath('mcp-servers', name, 'access'),
      schema: ServerAccessSchema,
    }),
  /** Only the changed roles; the answer is the server's access after the save. */
  saveAccess: (
    name: string,
    body: SaveServerAccessBody,
  ): Promise<ServerAccess> =>
    apiRequest({
      path: apiPath('mcp-servers', name, 'access'),
      method: 'PUT',
      body,
      schema: ServerAccessSchema,
    }),
  /** `enabled` and/or the class of one tool; `readOnly: null` returns the class to the server's mark. */
  updateTool: (
    name: string,
    tool: string,
    body: UpdateMcpToolBody,
  ): Promise<McpToolView> =>
    apiRequest({
      path: apiPath('mcp-servers', name, 'tools', tool),
      method: 'PATCH',
      body,
      schema: McpToolViewSchema,
    }),
  /** «Отметить просмотренными»: clears the server's new marks; the answer is the server after it. */
  markToolsReviewed: (name: string): Promise<McpServerView> =>
    apiRequest({
      path: apiPath('mcp-servers', name, 'tools', 'reviewed'),
      method: 'POST',
      schema: McpServerViewSchema,
    }),
  /** The OAuth return address of a server of this name, registered or not yet (the registration form shows it). */
  callbackUrl: (name: string): Promise<McpCallbackUrl> =>
    apiRequest({
      path: apiPath('mcp-servers', name, 'callback-url'),
      schema: McpCallbackUrlSchema,
    }),
  /** The connect route answers 302 to the authorization server, so the tab goes to this address instead of a request. */
  connectUrl: (name: string): string => apiPath('mcp-servers', name, 'connect'),
};

const models = {
  list: (): Promise<CatalogModel[]> =>
    apiRequest({
      path: apiPath('models'),
      schema: z.array(CatalogModelSchema),
    }),
  create: (body: CreateCatalogModelBody): Promise<CatalogModel> =>
    apiRequest({
      path: apiPath('models'),
      method: 'POST',
      body,
      schema: CatalogModelSchema,
    }),
  update: (id: string, body: UpdateCatalogModelBody): Promise<CatalogModel> =>
    apiRequest({
      path: apiPath('models', id),
      method: 'PATCH',
      body,
      schema: CatalogModelSchema,
    }),
  remove: (id: string): Promise<void> =>
    apiRequest({ path: apiPath('models', id), method: 'DELETE' }),
};

const ModelProviderListSchema = z.array(ModelProviderViewSchema);

/** Model providers (model-providers design-web.md, KD-2); the sign-in providers are `providers`. */
const modelProviders = {
  list: (): Promise<ModelProviderView[]> =>
    apiRequest({
      path: apiPath('model-providers'),
      schema: ModelProviderListSchema,
    }),
  create: (body: CreateModelProviderBody): Promise<ModelProviderView> =>
    apiRequest({
      path: apiPath('model-providers'),
      method: 'POST',
      body,
      schema: ModelProviderViewSchema,
    }),
  update: (
    name: string,
    body: UpdateModelProviderBody,
  ): Promise<ModelProviderView> =>
    apiRequest({
      path: apiPath('model-providers', name),
      method: 'PATCH',
      body,
      schema: ModelProviderViewSchema,
    }),
  remove: (name: string): Promise<void> =>
    apiRequest({ path: apiPath('model-providers', name), method: 'DELETE' }),
  check: (name: string): Promise<ModelProviderCheck> =>
    apiRequest({
      path: apiPath('model-providers', name, 'check'),
      method: 'POST',
      schema: ModelProviderCheckSchema,
    }),
};

const modelDefaults = {
  get: (): Promise<ModelDefaults> =>
    apiRequest({
      path: apiPath('model-defaults'),
      schema: ModelDefaultsSchema,
    }),
  save: (body: UpdateModelDefaultsBody): Promise<ModelDefaults> =>
    apiRequest({
      path: apiPath('model-defaults'),
      method: 'PUT',
      body,
      schema: ModelDefaultsSchema,
    }),
};

const RecordSummaryListSchema = z.array(RecordSummarySchema);
const BannedRecordListSchema = z.array(BannedRecordSchema);

/** The panel's «Агенты и глубокие агенты» (design-library.md, admin routes). */
const library = {
  system: (): Promise<RecordSummary[]> =>
    apiRequest({
      path: apiPath('library', 'system'),
      schema: RecordSummaryListSchema,
    }),
  shared: (): Promise<RecordSummary[]> =>
    apiRequest({
      path: apiPath('library', 'shared'),
      schema: RecordSummaryListSchema,
    }),
  bans: (): Promise<BannedRecord[]> =>
    apiRequest({
      path: apiPath('library', 'bans'),
      schema: BannedRecordListSchema,
    }),
  get: (id: string): Promise<RecordDetail> =>
    apiRequest({ path: apiPath('library', id), schema: RecordDetailSchema }),
  create: (body: CreateRecordBody): Promise<RecordDetail> =>
    apiRequest({
      path: apiPath('library'),
      method: 'POST',
      body,
      schema: RecordDetailSchema,
    }),
  save: (id: string, body: UpdateRecordBody): Promise<RecordDetail> =>
    apiRequest({
      path: apiPath('library', id),
      method: 'PUT',
      body,
      schema: RecordDetailSchema,
    }),
  saveAudience: (
    id: string,
    body: SystemRecordAudienceBody,
  ): Promise<RecordDetail> =>
    apiRequest({
      path: apiPath('library', id, 'audience'),
      method: 'PUT',
      body,
      schema: RecordDetailSchema,
    }),
  remove: (id: string): Promise<void> =>
    apiRequest({ path: apiPath('library', id), method: 'DELETE' }),
  /** Removes the record's holders and bans sharing it (Flow 4). */
  close: (id: string): Promise<void> =>
    apiRequest({ path: apiPath('library', id, 'close'), method: 'POST' }),
  liftBan: (id: string): Promise<void> =>
    apiRequest({ path: apiPath('library', id, 'ban'), method: 'DELETE' }),
  /** «Лимит ходов для новой записи». */
  settings: (): Promise<LibrarySettings> =>
    apiRequest({
      path: apiPath('library', 'settings'),
      schema: LibrarySettingsSchema,
    }),
  saveSettings: (body: UpdateLibrarySettingsBody): Promise<LibrarySettings> =>
    apiRequest({
      path: apiPath('library', 'settings'),
      method: 'PUT',
      body,
      schema: LibrarySettingsSchema,
    }),
};

/** «Самообучение глубоких агентов» on «Системные»: the size of the memory index. */
const selfLearning = {
  settings: (): Promise<SelfLearningSettings> =>
    apiRequest({
      path: apiPath('self-learning', 'settings'),
      schema: SelfLearningSettingsSchema,
    }),
  saveSettings: (
    body: UpdateSelfLearningSettingsBody,
  ): Promise<SelfLearningSettings> =>
    apiRequest({
      path: apiPath('self-learning', 'settings'),
      method: 'PUT',
      body,
      schema: SelfLearningSettingsSchema,
    }),
};

/** «Большие результаты инструментов» under «MCP-серверы» (tool-result-reading R-5). */
const toolResults = {
  settings: (): Promise<ToolResultSettings> =>
    apiRequest({
      path: apiPath('tool-results', 'settings'),
      schema: ToolResultSettingsSchema,
    }),
  saveSettings: (
    body: UpdateToolResultSettingsBody,
  ): Promise<ToolResultSettings> =>
    apiRequest({
      path: apiPath('tool-results', 'settings'),
      method: 'PUT',
      body,
      schema: ToolResultSettingsSchema,
    }),
};

/** «Инструкция для агентов» (agent-guidance design-web.md, KD-4): the organisation's one text. */
const instructions = {
  get: (): Promise<OrganisationInstructions> =>
    apiRequest({
      path: apiPath('instructions'),
      schema: OrganisationInstructionsSchema,
    }),
  /** An empty text clears the instruction; the answer is the saved text. */
  save: (text: string): Promise<OrganisationInstructions> =>
    apiRequest({
      path: apiPath('instructions'),
      method: 'PUT',
      body: { text } satisfies UpdateOrganisationInstructionsBody,
      schema: OrganisationInstructionsSchema,
    }),
};

export const adminApi = {
  users,
  roles,
  grants,
  providers,
  signInSettings,
  servers,
  models,
  modelProviders,
  modelDefaults,
  library,
  selfLearning,
  toolResults,
  instructions,
};
