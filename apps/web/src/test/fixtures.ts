import {
  AGENTS_TOOL_CONFIRMATION,
  AdminUserDetailSchema,
  AdminUserPageSchema,
  AdminUserSummarySchema,
  AgentListPageSchema,
  AgentContentSchema,
  AgentNodeSchema,
  AgentPageViewSchema,
  AgentViewSchema,
  ConfirmationSchema,
  ConversationViewSchema,
  CopyResultSchema,
  CatalogModelSchema,
  CurrentUserSchema,
  DeepAgentContentSchema,
  DeepAgentRunViewSchema,
  GrantSchema,
  HistoryEntrySchema,
  KNOWLEDGE_LIMIT_TOKENS_DEFAULT,
  KnowledgeItemSchema,
  KnowledgeSettingsSchema,
  KnowledgeViewSchema,
  LIBRARY_RECORD_CONFIRMATION,
  LibraryRecordCardSchema,
  McpServerSummarySchema,
  McpServerViewSchema,
  ModelDefaultsSchema,
  ModelProviderViewSchema,
  PendingMessageSchema,
  RunOriginSchema,
  ProviderSummarySchema,
  ProviderViewSchema,
  RecordDetailSchema,
  RecordSummarySchema,
  RoleDetailSchema,
  RoleSummarySchema,
  SignInSettingsSchema,
  ThreadListResponseSchema,
  ThreadSummarySchema,
  TOOL_RESULT_PREVIEW_CHARS_DEFAULT,
  TOOL_RESULT_READ_MAX_TOKENS_DEFAULT,
  TOOL_RESULT_STORE_FROM_CHARS_DEFAULT,
  ToolResultSettingsSchema,
  modelProvider,
  type AdminUserDetail,
  type AdminUserPage,
  type AdminUserSummary,
  type AgentListNode,
  type AgentContent,
  type AgentListPage,
  type AgentNode,
  type AgentPageView,
  type AgentView,
  type CatalogModel,
  type Confirmation,
  type ConversationView,
  type CopyResult,
  type CurrentUser,
  type DeepAgentContent,
  type DeepAgentRunView,
  type Grant,
  type HistoryEntry,
  type KnowledgeItem,
  type KnowledgeSettings,
  type KnowledgeView,
  type LibraryRecordCard,
  type McpServerSummary,
  type McpServerView,
  type McpToolView,
  type ModelDefaults,
  type ModelProviderView,
  type PendingMessage,
  type ProviderOptionsView,
  type ProviderSummary,
  type ProviderView,
  type RecordDetail,
  type RecordSummary,
  type RoleDetail,
  type RoleSummary,
  type RunOrigin,
  type RunTaskView,
  type SignInSettings,
  type ThreadListResponse,
  type ThreadSummary,
  type ToolResultSettings,
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
    language: null,
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
    name: 'researcher',
    origin: null,
    firstRun: false,
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

/** The id of the deep agent record `research` «Исследование» the deep agent fixtures start from. */
export const DEEP_AGENT_RECORD_ID = '0b9a4b8e-6c1e-4f43-9a52-3f0d1c2e5a71';

/** The origin of a deep agent's run: the system deep agent «Исследование», version 1. */
export function deepAgentOrigin(): RunOrigin {
  return RunOriginSchema.parse({
    recordId: DEEP_AGENT_RECORD_ID,
    kind: 'deep_agent',
    version: 1,
    name: 'Исследование',
    author: null,
    builtinKey: 'research',
    subagent: null,
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
  task: { text: 'Задача', record: null },
  user_message: { text: 'Сообщение', record: null },
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
    refusalDetail: null,
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

/** A queued message: from the user by default. */
export function pendingMessage(overrides: Partial<PendingMessage> & Pick<PendingMessage, 'messageId'>): PendingMessage {
  return PendingMessageSchema.parse({
    source: 'user',
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
    origin: null,
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

/**
 * An open record card of the chat (`library.record`, deep-agents DA-11): the conversation's root `root` asks to
 * `{action}_record`; the arguments are the record's id and the definition after the change, as the model wrote them.
 */
export function recordConfirmation(
  card: LibraryRecordCard,
  overrides: Partial<Confirmation> & Pick<Confirmation, 'decisionId'>,
): Confirmation {
  const content = LibraryRecordCardSchema.parse(card);
  const recordId = content.action === 'create' ? {} : { recordId: content.recordId };
  return confirmation({
    agentId: 'root',
    description: 'Чат',
    kind: LIBRARY_RECORD_CONFIRMATION,
    tool: `${content.action}_record`,
    server: null,
    args: { ...recordId, ...(content.next === null ? {} : { kind: content.kind, ...content.next }) },
    content,
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
    focus: null,
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

/** Row of GET /api/admin/models: a chat model with one price, no long-context rates. */
export function catalogModel(overrides: Partial<CatalogModel> & Pick<CatalogModel, 'id'>): CatalogModel {
  return CatalogModelSchema.parse({
    name: 'Claude Sonnet 4.5',
    purpose: 'chat',
    provider: modelProvider(overrides.id),
    prices: { inputUsdPerMTok: 3, outputUsdPerMTok: 15, cacheWriteUsdPerMTok: 3.75, cacheReadUsdPerMTok: 0.3 },
    longContext: null,
    ...overrides,
  });
}

/** Row of GET /api/admin/model-providers: `anthropic`, enabled, key set, ready, no catalogue models. */
export function modelProviderView(overrides: Partial<ModelProviderView> = {}): ModelProviderView {
  return ModelProviderViewSchema.parse({
    servesEmbeddings: (overrides.kind ?? 'anthropic') !== 'anthropic',
    name: 'anthropic',
    kind: 'anthropic',
    baseUrl: null,
    effectiveBaseUrl: 'https://api.anthropic.com',
    enabled: true,
    apiKeySet: true,
    apiKeyLast4: 'x7Qa',
    keyRequired: true,
    state: 'ready',
    catalogModels: 0,
    ...overrides,
  });
}

/** GET /api/admin/model-defaults: neither model chosen, never set. */
export function modelDefaults(overrides: Partial<ModelDefaults> = {}): ModelDefaults {
  return ModelDefaultsSchema.parse({
    chatModel: null,
    embeddingModel: null,
    updatedAt: null,
    updatedBy: null,
    ...overrides,
  });
}

/** GET /api/admin/knowledge/settings: the defaults, never set. */
export function knowledgeSettings(overrides: Partial<KnowledgeSettings> = {}): KnowledgeSettings {
  return KnowledgeSettingsSchema.parse({
    limitTokens: KNOWLEDGE_LIMIT_TOKENS_DEFAULT,
    lessonsEnabled: true,
    updatedAt: null,
    ...overrides,
  });
}

/** GET /api/admin/tool-results/settings: the defaults, never set. */
export function toolResultSettings(overrides: Partial<ToolResultSettings> = {}): ToolResultSettings {
  return ToolResultSettingsSchema.parse({
    storeFromChars: TOOL_RESULT_STORE_FROM_CHARS_DEFAULT,
    previewChars: TOOL_RESULT_PREVIEW_CHARS_DEFAULT,
    readMaxTokens: TOOL_RESULT_READ_MAX_TOKENS_DEFAULT,
    updatedAt: null,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------------------------------
// Knowledge graph fixtures (self-learning): each one passes its `@agent-os/contracts` schema.

type KnowledgeEntity = Extract<KnowledgeItem, { type: 'entity' }>;
type KnowledgeFact = Extract<KnowledgeItem, { type: 'relation'; kind: 'fact' }>;
type KnowledgeLesson = Extract<KnowledgeItem, { kind: 'lesson' }>;
type KnowledgeSearchedNothing = Extract<KnowledgeItem, { kind: 'searched_nothing' }>;

/** What every record has by default: added once at FIXTURE_TIME, active, no placement mark. */
const KNOWLEDGE_ITEM = { confirmations: 1, date: FIXTURE_TIME, state: 'active', placement: null } as const;

/** An entity (always a fact): «billing-api», «Сервис списаний». */
export function knowledgeEntity(overrides: Partial<KnowledgeEntity> & Pick<KnowledgeEntity, 'id'>): KnowledgeItem {
  return KnowledgeItemSchema.parse({
    ...KNOWLEDGE_ITEM,
    name: 'billing-api',
    description: 'Сервис списаний',
    ...overrides,
    type: 'entity',
    kind: 'fact',
  });
}

/** A relation fact «{from} → владеет → {to}» between two entities. */
export function knowledgeFact(overrides: Partial<KnowledgeFact> & Pick<KnowledgeFact, 'id' | 'from' | 'to'>): KnowledgeItem {
  return KnowledgeItemSchema.parse({ ...KNOWLEDGE_ITEM, label: 'владеет', ...overrides, type: 'relation', kind: 'fact' });
}

/** A lesson of `logs.search` on «ошибки оплаты». */
export function knowledgeLesson(overrides: Partial<KnowledgeLesson> & Pick<KnowledgeLesson, 'id'>): KnowledgeItem {
  return KnowledgeItemSchema.parse({
    ...KNOWLEDGE_ITEM,
    server: 'logs',
    tool: 'search',
    question: 'ошибки оплаты',
    hint: 'Искать в логах billing-api',
    outcome: 'ошибки нашлись',
    ...overrides,
    type: 'relation',
    kind: 'lesson',
  });
}

/** «Искал — не нашёл» of `jira.search_issues` on «инциденты оплаты». */
export function knowledgeSearchedNothing(
  overrides: Partial<KnowledgeSearchedNothing> & Pick<KnowledgeSearchedNothing, 'id'>,
): KnowledgeItem {
  return KnowledgeItemSchema.parse({
    ...KNOWLEDGE_ITEM,
    server: 'jira',
    tool: 'search_issues',
    question: 'инциденты оплаты',
    ...overrides,
    type: 'relation',
    kind: 'searched_nothing',
  });
}

/**
 * GET /api/library/:id/knowledge: self-learning and lessons on, selection by meaning on, no records, zero counts,
 * no round yet. `counts` are the server's own numbers and never follow `items` here.
 */
export function knowledgeView(overrides: Partial<KnowledgeView> = {}): KnowledgeView {
  return KnowledgeViewSchema.parse({
    selfLearning: true,
    lessonsEnabled: true,
    selection: { state: 'on' },
    counts: { active: 0, always: 0, beyond: 0, outdated: 0, percent: 0 },
    items: [],
    lastExtraction: null,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------------------------------
// Library fixtures (custom-agents): each one passes its `@agent-os/contracts` schema; ids are UUIDs.

/** A model id as record content holds it (`ModelIdSchema`). */
const FIXTURE_RECORD_MODEL = 'anthropic/claude-haiku-4-5';

/** Content of an agent record: one system, no agents to start, no tools. */
export function agentContent(overrides: Partial<AgentContent> = {}): AgentContent {
  return AgentContentSchema.parse({
    prompt: 'Найди в логах причины ошибок и перечисли их.',
    servers: ['logs'],
    model: FIXTURE_RECORD_MODEL,
    maxTurns: 20,
    agents: [],
    tools: [],
    ...overrides,
  });
}

/** Content of a deep agent record: one subagent «Аналитик»; the deep agent writes the answer itself. */
export function deepAgentContent(overrides: Partial<DeepAgentContent> = {}): DeepAgentContent {
  return DeepAgentContentSchema.parse({
    prompt: 'Разбери ошибки командой и напиши сводку.',
    servers: [],
    model: FIXTURE_RECORD_MODEL,
    maxTurns: 30,
    subagents: [
      {
        name: 'Аналитик',
        description: 'Ищет причины ошибок',
        prompt: 'Найди причины ошибок.',
        servers: ['logs'],
        model: FIXTURE_RECORD_MODEL,
        maxTurns: 20,
        maxRuns: 3,
      },
    ],
    finalSubagent: null,
    ...overrides,
  });
}

/** Row of GET /api/library: the viewer's own personal agent «Разбор логов», version 1, every action allowed. */
export function recordSummary(overrides: Partial<RecordSummary> & Pick<RecordSummary, 'id'>): RecordSummary {
  return RecordSummarySchema.parse({
    kind: 'agent',
    name: 'Разбор логов',
    description: 'Ищет причины ошибок в логах',
    version: 1,
    updatedAt: FIXTURE_TIME,
    offerInChat: false,
    builtinKey: null,
    mine: true,
    author: { id: fixtureId(1), name: 'Аня Смирнова', disabled: false },
    audience: { roles: [] },
    ban: null,
    missingRights: [],
    canEdit: true,
    canShare: true,
    canDelete: true,
    ...overrides,
  });
}

/** GET /api/library/:id: the summary fields of `recordSummary` with the content of its kind. */
export function recordDetail(
  overrides: Partial<RecordSummary> &
    Pick<RecordSummary, 'id'> & { content?: AgentContent | DeepAgentContent },
): RecordDetail {
  const { content, ...summary } = overrides;
  const row = recordSummary(summary);
  return RecordDetailSchema.parse({
    ...row,
    content: content ?? (row.kind === 'deep_agent' ? deepAgentContent() : agentContent()),
  });
}

/** POST /api/library/:id/copy: a copy `fixtureId(201)` with nothing dropped or replaced. */
export function copyResult(overrides: Partial<CopyResult> = {}): CopyResult {
  return CopyResultSchema.parse({
    record: recordDetail({ id: fixtureId(201) }),
    removedServers: [],
    replacedModels: [],
    removedAgents: [],
    ...overrides,
  });
}

/** GET /agents/:id/run of the deep agent `deep` «Исследование»: one subagent «Аналитик», nothing called yet. */
/** One item of a deep agent's task list (`GET /api/agents/:agentId/tasks`). */
export function runTask(overrides: Partial<RunTaskView> & Pick<RunTaskView, 'number' | 'text'>): RunTaskView {
  return { status: 'waiting', createdAt: fixtureTime(10), updatedAt: fixtureTime(10), ...overrides };
}

export function deepAgentRunView(overrides: Partial<DeepAgentRunView> = {}): DeepAgentRunView {
  return DeepAgentRunViewSchema.parse({
    origin: deepAgentOrigin(),
    brief: { question: 'Почему падают платежи?', boundaries: '', result: '' },
    deepAgent: agentView({ agentId: 'deep', name: 'Исследование', origin: deepAgentOrigin() }),
    team: [{ name: 'Аналитик', maxRuns: 3, final: false }],
    steps: [],
    limitRefusals: [],
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
