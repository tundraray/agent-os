import {
  AGENTS_TOOL_CONFIRMATION,
  AgentListPageSchema,
  AgentNodeSchema,
  AgentPageViewSchema,
  AgentViewSchema,
  ConfirmationSchema,
  ConversationViewSchema,
  HistoryEntrySchema,
  PendingMessageSchema,
  ThreadListResponseSchema,
  ThreadSummarySchema,
  type AgentListNode,
  type AgentListPage,
  type AgentNode,
  type AgentPageView,
  type AgentView,
  type Confirmation,
  type ConversationView,
  type HistoryEntry,
  type PendingMessage,
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
