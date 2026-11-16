import {
  AGENTS_TOOL_CONFIRMATION,
  AdminUserDetailSchema,
  AdminUserPageSchema,
  AdminUserSummarySchema,
  AgentListPageSchema,
  AgentNodeSchema,
  AgentPageViewSchema,
  AgentViewSchema,
  ConfirmationSchema,
  ConversationViewSchema,
  CreateCatalogModelBodySchema,
  CurrentUserSchema,
  GrantSchema,
  HistoryEntrySchema,
  McpServerSummarySchema,
  McpServerViewSchema,
  PendingMessageSchema,
  ProviderSummarySchema,
  ProviderViewSchema,
  RoleDetailSchema,
  RoleSummarySchema,
  SignInSettingsSchema,
  ThreadListResponseSchema,
  ThreadSummarySchema,
  type AdminUserDetail,
  type AdminUserPage,
  type AdminUserSummary,
  type AgentListNode,
  type AgentListPage,
  type AgentNode,
  type AgentPageView,
  type AgentView,
  type CatalogModel,
  type Confirmation,
  type ConversationView,
  type CurrentUser,
  type Grant,
  type HistoryEntry,
  type McpServerSummary,
  type McpServerView,
  type McpToolView,
  type PendingMessage,
  type ProviderOptionsView,
  type ProviderSummary,
  type ProviderView,
  type RoleDetail,
  type RoleSummary,
  type SignInSettings,
  type ThreadListResponse,
  type ThreadSummary,
} from '@agent-os/contracts';

const FIXTURE_TIME = '2026-10-28T10:00:00.000Z';

/** A thread as GET /api/threads returns it; validated by ThreadSummarySchema. */
export function threadSummary(overrides: Partial<ThreadSummary> & Pick<ThreadSummary, 'id'>): ThreadSummary {
  return ThreadSummarySchema.parse({
    title: 'Беседа',
    createdAt: FIXTURE_TIME,
    updatedAt: FIXTURE_TIME,
    ...overrides,
  });
}

/** Body of GET /api/threads; validated by ThreadListResponseSchema. */
export function threadList(threads: ThreadSummary[], nextCursor: string | null = null): ThreadListResponse {
  return ThreadListResponseSchema.parse({ threads, nextCursor });
}

/** Body of GET /api/auth/me: an employee with a local password, not an administrator. */
export function currentUser(overrides: Partial<CurrentUser> = {}): CurrentUser {
  return CurrentUserSchema.parse({
    id: fixtureId(1),
    email: 'anya@corp.example',
    name: 'Аня Смирнова',
    isAdmin: false,
    hasPassword: true,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------------------------------
// Chat contract fixtures: each one passes its `@agent-os/contracts` schema; times derive from FIXTURE_TIME.

/** FIXTURE_TIME shifted by `seconds`: ISO strings that keep the order of the entries they stamp. */
export function fixtureTime(seconds: number): string {
  return new Date(Date.parse(FIXTURE_TIME) + seconds * 1000).toISOString();
}

const FIXTURE_MODEL = 'claude-haiku-4-5';

/** An agent as the API returns it: a working child of the root `root` in thread `t1`. */
function agentView(overrides: Partial<AgentView> & Pick<AgentView, 'agentId'>): AgentView {
  return AgentViewSchema.parse({
    parentId: 'root',
    rootId: 'root',
    depth: 1,
    definition: 'researcher',
    description: 'Агент',
    model: FIXTURE_MODEL,
    status: 'working',
    failureReason: null,
    forkedFrom: null,
    createdAt: FIXTURE_TIME,
    finishedAt: null,
    ...overrides,
  });
}

/** An agent with its subtree; no children by default. */
export function agentNode(overrides: Partial<AgentNode> & Pick<AgentNode, 'agentId'>): AgentNode {
  const { children = [], ...view } = overrides;
  return AgentNodeSchema.parse({ ...agentView(view), children });
}

type FixtureEntryKind =
  | 'task'
  | 'user_message'
  | 'agent_message'
  | 'child_report'
  | 'model_answer'
  | 'tool_result'
  | 'event';
type EntryContent<K extends FixtureEntryKind> = Extract<HistoryEntry, { kind: K }>['content'];

const ENTRY_CONTENT: { [K in FixtureEntryKind]: EntryContent<K> } = {
  task: { text: 'Задача' },
  user_message: { text: 'Сообщение' },
  agent_message: { text: 'Сообщение агента', agentId: 'a1' },
  child_report: {
    agentId: 'a1',
    description: 'Агент',
    status: 'completed',
    reason: null,
    text: 'Отчёт',
    toolCalls: 0,
    durationMs: 1000,
  },
  model_answer: { text: 'Ответ', toolCalls: [] },
  tool_result: {
    callId: 'c1',
    tool: 'search',
    server: 'logs',
    args: { query: 'ошибки' },
    outcome: 'success',
    refusalReason: null,
    text: 'Результат',
    startedAt: FIXTURE_TIME,
    finishedAt: fixtureTime(1),
  },
  event: { event: 'interrupted', reason: null },
};

/** A history entry of `kind` at `seq`, stamped `seq` seconds after FIXTURE_TIME; `content` overrides the defaults. */
export function historyEntry<K extends FixtureEntryKind>({
  kind,
  seq,
  content,
}: {
  kind: K;
  seq: number;
  content?: Partial<EntryContent<K>>;
}): HistoryEntry {
  return HistoryEntrySchema.parse({
    seq,
    kind,
    createdAt: fixtureTime(seq),
    content: { ...ENTRY_CONTENT[kind], ...content },
  });
}

/** A queued message: from the user, without interrupt, by default. */
export function pendingMessage(overrides: Partial<PendingMessage> & Pick<PendingMessage, 'messageId'>): PendingMessage {
  return PendingMessageSchema.parse({
    source: 'user',
    interrupt: false,
    text: 'Сообщение в очереди',
    createdAt: FIXTURE_TIME,
    ...overrides,
  });
}

/** An open tool confirmation of agent `a1`. */
export function confirmation(overrides: Partial<Confirmation> & Pick<Confirmation, 'decisionId'>): Confirmation {
  return ConfirmationSchema.parse({
    agentId: 'a1',
    description: 'Агент',
    kind: AGENTS_TOOL_CONFIRMATION,
    tool: 'create_ticket',
    server: 'backoffice',
    args: { title: 'Заявка' },
    content: { title: 'Заявка' },
    status: 'open',
    resolution: null,
    createdAt: FIXTURE_TIME,
    resolvedAt: null,
    ...overrides,
  });
}

/** GET /threads/:id/history of an idle conversation `t1` with root `root` and nothing read yet. */
export function conversationView(overrides: Partial<ConversationView> = {}): ConversationView {
  return ConversationViewSchema.parse({
    thread: threadSummary({ id: 't1' }),
    chat: { status: 'idle', failureReason: null, rootAgentId: 'root', model: FIXTURE_MODEL },
    entries: [],
    nextAfterSeq: null,
    pending: [],
    decisions: [],
    agents: [],
    ...overrides,
  });
}

/**
 * GET /threads/:id/history of an idle conversation whose turns alternate from the employee: the first
 * text is the task, then the root's answer, then a message, and so on (seq 1, 2, …).
 */
export function conversationWithTurns(thread: ThreadSummary, texts: readonly string[]): ConversationView {
  return conversationView({
    thread,
    entries: texts.map((text, index) =>
      historyEntry({
        kind: index === 0 ? 'task' : index % 2 === 1 ? 'model_answer' : 'user_message',
        seq: index + 1,
        content: { text },
      }),
    ),
  });
}

/** GET /agents/:id/history of agent `a1` (a child of the root) in conversation `t1`. */
export function agentPageView(
  overrides: Partial<Omit<AgentPageView, 'agent'>> & { agent?: Partial<AgentPageView['agent']> } = {},
): AgentPageView {
  const { agent, ...rest } = overrides;
  return AgentPageViewSchema.parse({
    agent: { ...agentView({ agentId: 'a1' }), threadId: 't1', threadTitle: 'Беседа', ...agent },
    entries: [],
    nextAfterSeq: null,
    pending: [],
    decisions: [],
    children: [],
    ...rest,
  });
}

/** GET /agents page: each top agent defaults to conversation `t1` «Беседа» without children. */
export function agentListPage(
  agents: ReadonlyArray<Partial<AgentListNode> & Pick<AgentListNode, 'agentId'>>,
  nextCursor: string | null = null,
): AgentListPage {
  return AgentListPageSchema.parse({
    agents: agents.map(({ children = [], threadId = 't1', threadTitle = 'Беседа', ...view }) => ({
      ...agentView(view),
      children,
      threadId,
      threadTitle,
    })),
    nextCursor,
  });
}

// ---------------------------------------------------------------------------------------------------
// Admin panel fixtures: each one passes its `@agent-os/contracts` schema.

/** A UUID the contracts accept, distinct per `n`: `fixtureId(2)` = '00000000-0000-4000-8000-000000000002'. */
export function fixtureId(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

/** Public address of the API in the panel fixtures (sign-in settings, provider return addresses). */
const FIXTURE_PUBLIC_URL = 'https://agent-os.corp.example';

/** Row of GET /api/admin/users: an active provider-only account without roles. */
export function adminUserSummary(
  overrides: Partial<AdminUserSummary> & Pick<AdminUserSummary, 'id'>,
): AdminUserSummary {
  return AdminUserSummarySchema.parse({
    email: 'anya@corp.example',
    name: 'Аня Смирнова',
    login: null,
    status: 'active',
    lastSignInAt: FIXTURE_TIME,
    roles: [],
    ...overrides,
  });
}

/** Body of GET /api/admin/users. */
export function adminUserPage(users: AdminUserSummary[], nextCursor: string | null = null): AdminUserPage {
  return AdminUserPageSchema.parse({ users, nextCursor });
}

/** GET /api/admin/users/:id: no admin right by default. */
export function adminUserDetail(
  overrides: Partial<AdminUserDetail> & Pick<AdminUserDetail, 'id'>,
): AdminUserDetail {
  const { adminRight = { personal: false, roles: [] }, ...summary } = overrides;
  return AdminUserDetailSchema.parse({ ...adminUserSummary(summary), adminRight });
}

/** Row of GET /api/admin/roles: an ordinary role «SRE» without members. */
export function roleSummary(overrides: Partial<RoleSummary> & Pick<RoleSummary, 'id'>): RoleSummary {
  return RoleSummarySchema.parse({ name: 'SRE', memberCount: 0, isAdmin: false, builtin: false, ...overrides });
}

/** GET /api/admin/roles/:id; `memberCount` follows `members` unless given. */
export function roleDetail(overrides: Partial<RoleDetail> & Pick<RoleDetail, 'id'>): RoleDetail {
  const { members = [], ...summary } = overrides;
  return RoleDetailSchema.parse({ ...roleSummary({ memberCount: members.length, ...summary }), members });
}

/** Row of GET /api/admin/grants: role «SRE» (`fixtureId(100)`) may call `sentry` / `list_issues`, no quota. */
export function grant(overrides: Partial<Grant> & Pick<Grant, 'id'>): Grant {
  return GrantSchema.parse({
    holder: { kind: 'role', id: fixtureId(100), name: 'SRE' },
    effect: 'allow',
    target: { kind: 'tool', server: 'sentry', tool: 'list_issues' },
    quotaUsd: null,
    createdAt: FIXTURE_TIME,
    ...overrides,
  });
}

/** Row of GET /api/admin/providers: a disabled OIDC provider «Okta». */
export function providerSummary(overrides: Partial<ProviderSummary> & Pick<ProviderSummary, 'id'>): ProviderSummary {
  return ProviderSummarySchema.parse({ type: 'oidc', name: 'Okta', enabled: false, ...overrides });
}

/**
 * GET /api/admin/providers/:id: nothing filled in yet; `options` overrides merge into the empty settings, the return
 * address is built from the provider id as the API builds it.
 */
export function providerView(
  overrides: Partial<Omit<ProviderView, 'options'>> & Pick<ProviderView, 'id'> & { options?: Partial<ProviderOptionsView> },
): ProviderView {
  const { options, complete = false, providerData, ...summary } = overrides;
  return ProviderViewSchema.parse({
    ...providerSummary(summary),
    complete,
    options: { clientId: null, issuer: null, clientSecretSet: false, ...options },
    providerData: providerData ?? {
      redirectUri: `${FIXTURE_PUBLIC_URL}/api/auth/oauth/${summary.id}/callback`,
      scopes: 'openid email profile',
    },
  });
}

/** GET /api/admin/settings/sign-in: the saved address and the default limits (8 h idle, 24 h total). */
export function signInSettings(overrides: Partial<SignInSettings> = {}): SignInSettings {
  return SignInSettingsSchema.parse({
    publicUrl: FIXTURE_PUBLIC_URL,
    idleMinutes: 480,
    absoluteMinutes: 1440,
    updatedAt: null,
    ...overrides,
  });
}

/** Row of GET /api/admin/mcp-servers: an enabled personal-OAuth server without tools. */
export function mcpServerSummary(
  overrides: Partial<McpServerSummary> & Pick<McpServerSummary, 'name'>,
): McpServerSummary {
  return McpServerSummarySchema.parse({
    url: `https://${overrides.name}.example/mcp`,
    mode: 'oauth',
    status: 'enabled',
    toolCount: 0,
    ...overrides,
  });
}

/** Tools of a server view by default: one that reads and one that changes. */
const FIXTURE_TOOLS: McpToolView[] = [
  { name: 'list_issues', title: 'List issues', description: 'Список задач', readOnly: true },
  { name: 'update_issue', title: 'Update issue', description: 'Изменяет задачу', readOnly: false },
];

/** GET /api/admin/mcp-servers/:name: `list_issues` (reads) and `update_issue` (changes); `toolCount` follows `tools`. */
export function mcpServerView(overrides: Partial<McpServerView> & Pick<McpServerView, 'name'>): McpServerView {
  const { tools = FIXTURE_TOOLS, sharedTokenSet = false, ...summary } = overrides;
  return McpServerViewSchema.parse({
    ...mcpServerSummary({ toolCount: tools.length, ...summary }),
    sharedTokenSet,
    tools,
  });
}

/** Row of GET /api/admin/models (the create body's fields): one price, no long-context rates. */
export function catalogModel(overrides: Partial<CatalogModel> & Pick<CatalogModel, 'id'>): CatalogModel {
  return CreateCatalogModelBodySchema.parse({
    name: 'Claude Sonnet 4.5',
    prices: { inputUsdPerMTok: 3, outputUsdPerMTok: 15, cacheWriteUsdPerMTok: 3.75, cacheReadUsdPerMTok: 0.3 },
    longContext: null,
    ...overrides,
  });
}

export type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

/** A promise settled from the outside: an MSW handler awaits `promise` to hold its response until the test releases it. */
export function deferred<T = void>(): Deferred<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  return { promise, resolve, reject };
}
