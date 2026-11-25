import {
  AGENTS_BRIEF_CONFIRMATION,
  ChatRecordToolSchema,
  CREATE_RECORD_TOOL,
  DELETE_RECORD_TOOL,
  EDIT_RECORD_TOOL,
  LIBRARY_RECORD_CONFIRMATION,
  LibraryRecordCardSchema,
  START_AGENT_TOOL,
  START_DEEP_AGENT_TOOL,
  type AgentNode,
  type AgentPageView,
  type AgentStatus,
  type AgentView,
  type AnswerToolCall,
  type ChatRecordTool,
  type ChatStatus,
  type ChipRecord,
  type Confirmation,
  type ConversationView,
  type HistoryEntry,
  type LibraryRecordCard,
  type PendingMessage,
  type ScheduleMark,
  type TestRunSummary,
  type ToolCallState,
  type ToolOutcome,
  type ToolRefusalReason,
} from '@agent-os/contracts';
import type { ThreadMessageLike } from '@assistant-ui/react';
import {
  isChatFailureReason,
  type ChatFailureReason,
} from '@/lib/access/access-texts';

/**
 * The feed rule (design-web.md, KD-3, KD-4, «Что сотрудник видит»): pure functions from what the
 * FeedStore holds to assistant-ui messages, the tray and the controls. Nothing here reads a store.
 */

// ---------------------------------------------------------------------------------------------------
// Inputs

/** A conversation or an agent page with every history entry read so far. */
export type FeedView =
  | {
      kind: 'thread';
      threadId: string;
      /** The conversation's summary: the fork's source and boundary (create-and-test KD-9). */
      thread: ConversationView['thread'];
      chat: ConversationView['chat'];
      entries: readonly HistoryEntry[];
      pending: readonly PendingMessage[];
      decisions: readonly Confirmation[];
      /** Direct children of the root. */
      children: readonly AgentNode[];
      /** The record the conversation last touched (KD-6); null while it has touched none. */
      focus: ConversationView['focus'];
      /** The training this conversation belongs to (self-learning KD-3); null outside a training tree. */
      training: ConversationView['training'];
    }
  | {
      kind: 'agent';
      agent: AgentPageView['agent'];
      entries: readonly HistoryEntry[];
      pending: readonly PendingMessage[];
      decisions: readonly Confirmation[];
      children: readonly AgentNode[];
      training: AgentPageView['training'];
    };

/** A deep agent's run: started from a deep agent record and not as one of its subagents. */
export function isDeepAgentRun(agent: Pick<AgentView, 'origin'>): boolean {
  return agent.origin?.kind === 'deep_agent' && agent.origin.subagent === null;
}

/** The view of one page read, with that page's entries. */
export function feedViewOf(page: ConversationView | AgentPageView): FeedView {
  if ('chat' in page) {
    return {
      kind: 'thread',
      threadId: page.thread.id,
      thread: page.thread,
      chat: page.chat,
      entries: page.entries,
      pending: page.pending,
      decisions: page.decisions,
      children: page.agents,
      focus: page.focus,
      training: page.training,
    };
  }
  return {
    kind: 'agent',
    agent: page.agent,
    entries: page.entries,
    pending: page.pending,
    decisions: page.decisions,
    children: page.children,
    training: page.training,
  };
}

/** A message the server accepted (202) and the next re-read has not shown yet (KD-4). */
export type OptimisticEntry = {
  localId: string;
  text: string;
  /** The tray for a busy agent; the end of the feed for an idle one. */
  place: 'tray' | 'feed';
  /** From the 202; null for a conversation's first message. */
  messageId: string | null;
  /** The conversation's first message: leaves when the `task` entry appears. */
  first: boolean;
  /** The record chip the message was sent with (KD-5); absent for a message without one. */
  record?: ChipRecord | null;
  createdAt: string;
};

/** A text part of `delta`: `offset` is the length of the text before it. */
export type DraftPart = { offset: number; text: string };

/**
 * `offset` 0 starts the draft anew, an `offset` equal to its length appends, any other part is
 * dropped — a part delivered twice or after a gap neither doubles nor loses text.
 */
export function applyDraftPart(
  draft: string | null,
  part: DraftPart,
): string | null {
  if (part.offset === 0) return part.text;
  const current = draft ?? '';
  return part.offset === current.length ? current + part.text : draft;
}

/**
 * The draft after a successful read: new entries replace it, and a view whose agent is not `working`
 * says no model step is in flight, so a draft the read found (a `delta` that came after its stored
 * answer) is a leftover. A draft that changed while the read was on the way belongs to a step that
 * started after the server built the view, and stays.
 */
export function draftAfterRead({
  draftAtStart,
  draft,
  added,
  view,
}: {
  draftAtStart: string | null;
  draft: string | null;
  added: number;
  view: FeedView;
}): string | null {
  if (added > 0) return null;
  const status: ChatStatus | AgentStatus =
    view.kind === 'thread' ? view.chat.status : view.agent.status;
  return status !== 'working' && draft === draftAtStart ? null : draft;
}

// ---------------------------------------------------------------------------------------------------
// Data parts: what the feed components (RunCard, DecisionCard, AgentReport, EventLine) receive

/** Names of the `data-*` parts; a component is picked by `MessagePrimitive.Parts` `data.by_name`. */
export const FEED_PART = {
  runCard: 'run-card',
  decision: 'decision',
  report: 'report',
  event: 'event',
  answerRefused: 'answer-refused',
  offer: 'offer',
  plan: 'plan',
  testRunCard: 'test-run-card',
} as const;

/** The deep agent card also shows the question of the brief that started it (agent-run-card.md, part 4). */
export type RunCardPartData = AgentNode & { briefQuestion?: string };
export type DecisionPartData = {
  confirmation: Confirmation;
  /** The conversation's root asks: «Чат хочет выполнить:» (MC-19). */
  byChat: boolean;
  /** How the call of an approved record card ended (DA-11); null before its result and for any other decision. */
  saved: RecordSave | null;
};

/** The end of a record card's call: a success, or a refusal with the platform's text (KD-4). */
export type RecordSave = { outcome: ToolOutcome; text: string | null };

/** The record tools that change a record: their refusal reads «Не сохранено:» and the platform's text (KD-4). */
export const RECORD_CHANGE_TOOLS: ReadonlySet<string> = new Set<ChatRecordTool>(
  [CREATE_RECORD_TOOL, EDIT_RECORD_TOOL, DELETE_RECORD_TOOL],
);

/** One of the chat's record tools (deep-agents design-agent-types.md, «Инструменты записей»). */
export function isRecordTool(toolName: string): toolName is ChatRecordTool {
  return ChatRecordToolSchema.safeParse(toolName).success;
}

/** The content of a `library.record` card; null for any other decision and for content outside the contract. */
export function recordCardOf(
  confirmation: Confirmation,
): LibraryRecordCard | null {
  if (confirmation.kind !== LIBRARY_RECORD_CONFIRMATION) return null;
  const card = LibraryRecordCardSchema.safeParse(confirmation.content);
  return card.success ? card.data : null;
}
export type ReportPartData = Extract<
  HistoryEntry,
  { kind: 'child_report' }
>['content'] & {
  createdAt: string;
  /** Copied into a fork: its agent's conversation and document stay with the source (KD-9). */
  inherited: boolean;
};

/** The trainer's «Похожий агент» card (create-and-test KD-4): the state from the summary, the time of the call. */
export type OfferPartData = {
  offer: NonNullable<TestRunSummary['offer']>;
  createdAt: string;
};

/** The trainer's «План» card: the state from the summary, the plan from the call's arguments. */
export type PlanPartData = {
  plan: TestRunSummary['plans'][number];
  createdAt: string;
  name: string;
  description: string;
  servers: readonly string[];
  tests: readonly { task: string; expected: string }[];
};

/** A test run card (KD-5): its rounds, numbered from 1; `last` shows the run's status and step. */
export type TestRunCardPartData = {
  createdAt: string;
  first: boolean;
  last: boolean;
  rounds: readonly (TestRunSummary['rounds'][number] & { number: number })[];
};
export type EventPartData = Extract<
  HistoryEntry,
  { kind: 'event' }
>['content'] & {
  createdAt: string;
  /** The model of the agent whose feed this is (the conversation's root or the page's agent); QS-01 names it. */
  model: string;
};

/**
 * An agent's refused answer (uxrd.md MC-15), from the `notice` entry: the numbers of the tasks left open,
 * or the final subagent whose completed report is lacking.
 */
export type AnswerRefusedPartData = { createdAt: string } & (
  { openTasks: readonly number[] } | { missingReport: string }
);

/** `error` of the reply error block TH-08: the root's failure reason and model (MC-11). */
export type ReplyErrorData = { reason: ChatFailureReason; model: string };

/** `artifact` of a `tool-call` part: what tool-call.md shows besides arguments and result. */
export type ToolCallArtifact = {
  state: ToolCallState;
  outcome: ToolOutcome | null;
  server: string | null;
  /** The tool's human title and the labels of its arguments; absent when the tool gives none. */
  toolTitle?: AnswerToolCall['toolTitle'];
  argLabels?: AnswerToolCall['argLabels'];
  /** The code of a saved script, on a call of that script. */
  scriptCode?: AnswerToolCall['scriptCode'];
  refusalReason: ToolRefusalReason | null;
  /** The refused model of a refusal by model (MC-16); absent or null otherwise. */
  refusalDetail?: ToolResult['refusalDetail'];
  /** What a code run's script printed; null for other tools and for a failed run. */
  output: string | null;
  /** The tools a `try_script` run recorded and did not send (MC-10); absent for other tools. */
  recorded?: ToolResult['recorded'];
  /** The record a record tool's call names (MC-23); absent or null for other tools and when the feed does not know it. */
  recordName?: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

/**
 * `metadata.custom` of a feed message: the source label (MC-9, MC-10, AV-04), the draft mark, the
 * record chip an employee's message was sent with (KD-5) and the schedule that sent it (schedules SH-07).
 */
export type FeedMessageMeta =
  | {
      kind: 'task';
      record: ChipRecord | null;
      schedule: ScheduleMark | null;
      testRun?: true;
    }
  | {
      kind: 'user';
      record: ChipRecord | null;
      schedule: ScheduleMark | null;
      testRun?: true;
    }
  | {
      kind: 'parent';
      fromConversation: boolean;
      senderDescription: string | null;
    }
  | { kind: 'answer'; report: boolean }
  | { kind: 'draft' }
  | { kind: 'part' };

type LikePart = Exclude<ThreadMessageLike['content'], string>[number];
type ToolCallLikePart = Extract<LikePart, { type: 'tool-call' }>;
type JsonObject = NonNullable<ToolCallLikePart['args']>;

/** Calls another feed piece already shows: a start — the run card or the brief card (MC-23). Only other outcomes draw a block. */
const SHOWN_ELSEWHERE = new Set<string>([
  START_AGENT_TOOL,
  START_DEEP_AGENT_TOOL,
]);
const HIDDEN_OUTCOMES = new Set<ToolOutcome>(['success', 'rejected']);
const ERROR_OUTCOMES = new Set<ToolOutcome>([
  'tool_error',
  'transport_failure',
  'auth_required',
  'refused',
  'rejected',
  'interrupted',
  'unknown',
]);

// ---------------------------------------------------------------------------------------------------
// toFeed

type ToolResult = Extract<HistoryEntry, { kind: 'tool_result' }>['content'];
type NoticeContent = Extract<HistoryEntry, { kind: 'notice' }>['content'];

const time = (iso: string): number => Date.parse(iso);

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function meta(custom: FeedMessageMeta): ThreadMessageLike['metadata'] {
  return { custom };
}

/**
 * The name a record tool's call reads by: the `name` it writes, or the name its record has on the feed's latest
 * record card (a delete or a read names only the id; a deleted record is in no library list).
 */
function recordNameOf(
  call: AnswerToolCall,
  cards: readonly LibraryRecordCard[],
): string | null {
  if (!isRecordTool(call.tool)) return null;
  const written = stringField(call.args, 'name');
  if (written !== undefined) return written;
  const recordId = stringField(call.args, 'recordId');
  const card =
    recordId === undefined
      ? undefined
      : cards.findLast((c) => c.recordId === recordId);
  return (card?.next ?? card?.previous)?.name ?? null;
}

function toolCallPart(
  call: AnswerToolCall,
  result: ToolResult | undefined,
  recordName: string | null,
): ToolCallLikePart {
  const outcome = result?.outcome ?? null;
  const artifact: ToolCallArtifact = {
    state: result === undefined ? call.state : 'done',
    outcome,
    server: call.server,
    toolTitle: call.toolTitle,
    argLabels: call.argLabels,
    scriptCode: call.scriptCode,
    refusalReason: result?.refusalReason ?? null,
    refusalDetail: result?.refusalDetail ?? null,
    output: result?.output ?? null,
    recorded: result?.recorded,
    recordName,
    startedAt: result?.startedAt ?? null,
    finishedAt: result?.finishedAt ?? null,
  };
  return {
    type: 'tool-call',
    toolCallId: call.callId,
    toolName: call.tool,
    args: isJsonObject(call.args) ? call.args : {},
    argsText: JSON.stringify(call.args ?? null),
    result: result?.text ?? undefined,
    isError: outcome !== null && ERROR_OUTCOMES.has(outcome),
    artifact,
  };
}

function isDrawnCall(
  call: AnswerToolCall,
  result: ToolResult | undefined,
  cardCalls: ReadonlySet<string>,
): boolean {
  // A trainer's offer or plan is its card instead of the call block (KD-4).
  if (cardCalls.has(call.callId)) return false;
  if (!SHOWN_ELSEWHERE.has(call.tool)) return true;
  return result !== undefined && !HIDDEN_OUTCOMES.has(result.outcome);
}

function dataMessage(
  id: string,
  createdAt: string,
  name: string,
  data: unknown,
): ThreadMessageLike {
  return {
    id,
    role: 'assistant',
    createdAt: new Date(createdAt),
    content: [{ type: `data-${name}`, data }],
    metadata: meta({ kind: 'part' }),
  };
}

/** The feed line of a deep agent's refused answer; null for a notice meant for the model only. */
function answerRefusedOf(
  content: NoticeContent,
  createdAt: string,
): AnswerRefusedPartData | null {
  const { openTasks, missingReport } = content;
  if (openTasks !== undefined && openTasks.length > 0)
    return { openTasks, createdAt };
  if (missingReport !== undefined) return { missingReport, createdAt };
  return null;
}

/** What `entryMessage` needs besides the entry, computed once per feed. */
type EntryContext = {
  results: ReadonlyMap<string, ToolResult>;
  cards: readonly LibraryRecordCard[];
  /** Calls drawn as the trainer's cards. */
  cardCalls: ReadonlySet<string>;
  /** Entries up to this `seq` are a fork's copy; 0 — none. */
  inheritedThrough: number;
  /** The test run's description: its message carries the action chip; null — none. */
  descriptionSeq: number | null;
};

function entryMessage(
  view: FeedView,
  entry: HistoryEntry,
  { results, cards, cardCalls, inheritedThrough, descriptionSeq }: EntryContext,
): ThreadMessageLike | null {
  const id = `seq-${entry.seq}`;
  const testRun =
    entry.seq === descriptionSeq ? { testRun: true as const } : {};
  const createdAt = new Date(entry.createdAt);
  switch (entry.kind) {
    case 'task': {
      // A task carries a chip only at the conversation's root, whose task is the conversation's first message.
      const atRoot =
        view.kind === 'thread' || view.agent.agentId === view.agent.rootId;
      const record = atRoot ? entry.content.record : null;
      const schedule = atRoot ? entry.content.schedule : null;
      return {
        id,
        role: 'user',
        createdAt,
        content: entry.content.text,
        metadata: meta({ kind: 'task', record, schedule, ...testRun }),
      };
    }
    case 'user_message': {
      const { record, schedule } = entry.content;
      return {
        id,
        role: 'user',
        createdAt,
        content: entry.content.text,
        metadata: meta({ kind: 'user', record, schedule, ...testRun }),
      };
    }
    case 'agent_message': {
      const sender = entry.content.agentId;
      const rootId =
        view.kind === 'thread' ? view.chat.rootAgentId : view.agent.rootId;
      const senderDescription =
        view.kind === 'agent' && sender === view.agent.parentId
          ? (view.agent.parentDescription ?? null)
          : null;
      return {
        id,
        role: 'user',
        createdAt,
        content: entry.content.text,
        metadata: meta({
          kind: 'parent',
          fromConversation: sender === rootId,
          senderDescription,
        }),
      };
    }
    case 'model_answer': {
      const parts: LikePart[] = [];
      if (entry.content.text !== '')
        parts.push({ type: 'text', text: entry.content.text });
      for (const call of entry.content.toolCalls) {
        const result = results.get(call.callId);
        if (isDrawnCall(call, result, cardCalls))
          parts.push(toolCallPart(call, result, recordNameOf(call, cards)));
      }
      if (parts.length === 0) return null;
      // AV-04: on an agent page the answer that ends a turn without calls is the agent's report.
      const report =
        view.kind === 'agent' && entry.content.toolCalls.length === 0;
      return {
        id,
        role: 'assistant',
        createdAt,
        content: parts,
        metadata: meta({ kind: 'answer', report }),
      };
    }
    case 'child_report': {
      const data: ReportPartData = {
        ...entry.content,
        createdAt: entry.createdAt,
        inherited: entry.seq <= inheritedThrough,
      };
      return dataMessage(id, entry.createdAt, FEED_PART.report, data);
    }
    case 'event': {
      const { event, reason } = entry.content;
      // A copied `forked` marks the source's own fork: only this conversation's boundary is a divider (KD-9).
      if (event === 'forked' && entry.seq <= inheritedThrough) return null;
      // TH-08: a model failure of the conversation's root, or its model refused by access (MC-11), is the
      // answer's error block; a spent quota and a disabled owner stay event lines (QS-01, MC-14).
      if (
        view.kind === 'thread' &&
        event === 'failed' &&
        isChatFailureReason(reason)
      ) {
        const error: ReplyErrorData = { reason, model: view.chat.model };
        return {
          id,
          role: 'assistant',
          createdAt,
          content: [],
          status: { type: 'incomplete', reason: 'error', error },
          metadata: meta({ kind: 'answer', report: false }),
        };
      }
      const model = view.kind === 'thread' ? view.chat.model : view.agent.model;
      const data: EventPartData = {
        event,
        reason,
        createdAt: entry.createdAt,
        model,
      };
      return dataMessage(id, entry.createdAt, FEED_PART.event, data);
    }
    case 'notice': {
      // MC-15: a refusal over open tasks or a lacking final report is a feed line built from the entry's fields;
      // other notices are for the model only.
      const data = answerRefusedOf(entry.content, entry.createdAt);
      return data === null
        ? null
        : dataMessage(id, entry.createdAt, FEED_PART.answerRefused, data);
    }
    case 'tool_result':
    case 'compaction':
      // A result is a part of its call; compaction summaries are for the model only.
      return null;
  }
}

type Floating = { createdAt: string; message: ThreadMessageLike };

/** A string field of an unknown value. */
function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const field: unknown = Reflect.get(value, key);
  return typeof field === 'string' && field !== '' ? field : undefined;
}

/**
 * The question of the confirmed brief that started a deep agent: the last approved brief created not later than
 * it whose confirmed deep agent name is the run's, without case (data-model design-agents.md, KD-5: a temporary
 * deep agent has no record, only its name). The run card stands right under that brief. The built `AgentNode`
 * carries no brief, so the feed's own decisions are the source.
 */
function briefQuestionOf(
  decisions: readonly Confirmation[],
  node: AgentNode,
): string | undefined {
  if (!isDeepAgentRun(node)) return undefined;
  const brief = decisions
    .filter(
      (c) =>
        c.kind === AGENTS_BRIEF_CONFIRMATION &&
        c.resolution?.approve === true &&
        stringField(c.resolution.args, 'deepAgent')?.toLowerCase() ===
          node.name.toLowerCase() &&
        time(c.createdAt) <= time(node.createdAt),
    )
    .sort((a, b) => time(b.createdAt) - time(a.createdAt))[0];
  if (brief?.resolution == null) return undefined;
  return (
    stringField(brief.resolution.args, 'question') ??
    stringField(brief.content, 'question')
  );
}

/** An array field of an unknown value; empty when it is not an array. */
function arrayField(value: unknown, key: string): readonly unknown[] {
  if (typeof value !== 'object' || value === null) return [];
  const field: unknown = Reflect.get(value, key);
  return Array.isArray(field) ? field : [];
}

/** The plan card's content from the `propose_plan` call's arguments (plan Notes 3.5: read by field, no schema). */
function planPart(
  plan: PlanPartData['plan'],
  call: AnswerToolCall,
  createdAt: string,
): PlanPartData {
  return {
    plan,
    createdAt,
    name: stringField(call.args, 'name') ?? '',
    description: stringField(call.args, 'description') ?? '',
    servers: arrayField(call.args, 'servers').filter(
      (server) => typeof server === 'string',
    ),
    tests: arrayField(call.args, 'tests').map((test) => ({
      task: stringField(test, 'task') ?? '',
      expected: stringField(test, 'expected') ?? '',
    })),
  };
}

/**
 * The test run's cards of the calls in one trainer's answer (KD-4, KD-5, Invariant 3): the offer and each plan in
 * place of the call; the first test run card at the call that started round 1 (`create_agent`) with the rounds not
 * asked for; a card of its own at the call that started each round asked for after the summary.
 */
function runParts(
  run: TestRunSummary,
  entry: HistoryEntry,
): ThreadMessageLike[] {
  if (entry.kind !== 'model_answer') return [];
  const rounds = run.rounds.map((round, index) => ({
    ...round,
    number: index + 1,
  }));
  const asked = rounds.filter((round) => round.requested);
  const at = entry.createdAt;
  const card = (
    id: string,
    first: boolean,
    cardRounds: TestRunCardPartData['rounds'],
    last: boolean,
  ): ThreadMessageLike =>
    dataMessage(`test-run-${id}`, at, FEED_PART.testRunCard, {
      createdAt: at,
      first,
      last,
      rounds: cardRounds,
    } satisfies TestRunCardPartData);
  const parts: ThreadMessageLike[] = [];
  for (const call of entry.content.toolCalls) {
    if (run.offer?.callId === call.callId) {
      const data: OfferPartData = { offer: run.offer, createdAt: at };
      parts.push(
        dataMessage(`offer-${call.callId}`, at, FEED_PART.offer, data),
      );
    }
    const plan = run.plans.find((p) => p.callId === call.callId);
    if (plan !== undefined) {
      parts.push(
        dataMessage(
          `plan-${call.callId}`,
          at,
          FEED_PART.plan,
          planPart(plan, call, at),
        ),
      );
    }
    if (rounds[0]?.startCallId === call.callId) {
      const first = rounds.filter((round) => !round.requested);
      parts.push(card('first', true, first, asked.length === 0));
    }
    const round = asked.find((r) => r.startCallId === call.callId);
    if (round !== undefined)
      parts.push(
        card(
          `${round.number}`,
          false,
          [round],
          round === asked[asked.length - 1],
        ),
      );
  }
  return parts;
}

/**
 * The test run's description (KD-4 table): the first `user_message` right after the fork's `forked` event, or the
 * `task` of a test run without a fork. `empty` — the event is followed by something else: the chip stands alone.
 */
function descriptionOf(
  entries: readonly HistoryEntry[],
): { seq: number } | { emptyAfter: number } | null {
  const forked = entries.findLastIndex(
    (entry) => entry.kind === 'event' && entry.content.event === 'forked',
  );
  if (forked === -1) {
    const task = entries.find((entry) => entry.kind === 'task');
    return task === undefined ? null : { seq: task.seq };
  }
  const next = entries[forked + 1];
  return next?.kind === 'user_message'
    ? { seq: next.seq }
    : { emptyAfter: entries[forked].seq };
}

/** A finished call of the feed's own agent, in `seq` order: its tool, its result and when the result was written. */
type FinishedCall = { tool: string; result: ToolResult; at: number };

/**
 * How the call of an approved record card ended. The confirmation names no call, so the result is the first
 * one of the same tool the feed's agent wrote after the decision: the conversation's root runs one call at a
 * time, and the call's result is written only once the employee has decided (design-agent-types.md, Flow 1).
 */
function recordSaveOf(
  view: FeedView,
  confirmation: Confirmation,
  calls: readonly FinishedCall[],
): RecordSave | null {
  if (
    confirmation.kind !== LIBRARY_RECORD_CONFIRMATION ||
    confirmation.resolution?.approve !== true
  )
    return null;
  const ownerId =
    view.kind === 'thread' ? view.chat.rootAgentId : view.agent.agentId;
  if (confirmation.agentId !== ownerId) return null;
  const decidedAt = time(confirmation.resolvedAt ?? confirmation.createdAt);
  const call = calls.find(
    (c) => c.tool === confirmation.tool && c.at >= decidedAt,
  );
  return call === undefined
    ? null
    : { outcome: call.result.outcome, text: call.result.text ?? null };
}

/** Decisions and direct children, by creation time; equal times keep the API's list order. */
function floatingItems(
  view: FeedView,
  calls: readonly FinishedCall[],
): Floating[] {
  const byChatRoot = (c: Confirmation): boolean =>
    view.kind === 'thread' && c.agentId === view.chat.rootAgentId;
  const decisions = view.decisions.map((confirmation) => {
    const data: DecisionPartData = {
      confirmation,
      byChat: byChatRoot(confirmation),
      saved: recordSaveOf(view, confirmation, calls),
    };
    return {
      createdAt: confirmation.createdAt,
      message: dataMessage(
        `decision-${confirmation.decisionId}`,
        confirmation.createdAt,
        FEED_PART.decision,
        data,
      ),
    };
  });
  const children = view.children.map((node) => {
    const data: RunCardPartData = {
      ...node,
      briefQuestion: briefQuestionOf(view.decisions, node),
    };
    return {
      createdAt: node.createdAt,
      message: dataMessage(
        `agent-${node.agentId}`,
        node.createdAt,
        FEED_PART.runCard,
        data,
      ),
    };
  });
  // Array.prototype.sort is stable: ties keep decisions, then children, each in API order.
  return [...decisions, ...children].sort(
    (a, b) => time(a.createdAt) - time(b.createdAt),
  );
}

function optimisticMessage(entry: OptimisticEntry): ThreadMessageLike {
  return {
    id: `local-${entry.localId}`,
    role: 'user',
    createdAt: new Date(entry.createdAt),
    content: entry.text,
    metadata: meta({
      kind: 'user',
      record: entry.record ?? null,
      schedule: null,
    }),
  };
}

/**
 * The draft is complete for assistant-ui on purpose: a `running` last message makes the library
 * derive `isRunning` and disable «Отправить» (spike S-1, b2), while FR-16 keeps sending open.
 */
function draftMessage(draft: string): ThreadMessageLike {
  return {
    id: 'draft',
    role: 'assistant',
    content: [{ type: 'text', text: draft }],
    status: { type: 'complete', reason: 'unknown' },
    metadata: meta({ kind: 'draft' }),
  };
}

/** Entries that end the trainer's turn: what the person or a parent says next. */
const OPENS_TURN = new Set<HistoryEntry['kind']>([
  'task',
  'user_message',
  'agent_message',
]);

/**
 * Feed messages with stable ids (`seq-*`, `decision-*`, `agent-*`, `local-*`, `draft`): entries
 * by `seq`; each decision and direct child after the last entry created not later than it (KD-3); a test run's
 * cards at the end of the trainer's turn that made their calls; optimistic feed entries, then the draft, last.
 */
export function toFeed(
  view: FeedView,
  draft: string | null,
  optimistic: readonly OptimisticEntry[],
): ThreadMessageLike[] {
  const entries = [...view.entries].sort((a, b) => a.seq - b.seq);
  const results = new Map<string, ToolResult>();
  const toolOf = new Map<string, string>();
  const calls: FinishedCall[] = [];
  for (const entry of entries) {
    if (entry.kind === 'model_answer') {
      for (const call of entry.content.toolCalls)
        toolOf.set(call.callId, call.tool);
    }
    if (entry.kind === 'tool_result') {
      results.set(entry.content.callId, entry.content);
      const tool = toolOf.get(entry.content.callId);
      if (tool !== undefined)
        calls.push({ tool, result: entry.content, at: time(entry.createdAt) });
    }
  }
  const run = view.kind === 'thread' ? (view.training?.run ?? null) : null;
  const description = run === null ? null : descriptionOf(entries);
  const context: EntryContext = {
    results,
    cards: view.decisions.flatMap(
      (confirmation) => recordCardOf(confirmation) ?? [],
    ),
    cardCalls: new Set(
      run === null
        ? []
        : [
            ...(run.offer === null ? [] : [run.offer.callId]),
            ...run.plans.map((plan) => plan.callId),
          ],
    ),
    inheritedThrough:
      view.kind === 'thread' ? (view.thread.forkedFrom?.throughSeq ?? 0) : 0,
    descriptionSeq:
      description !== null && 'seq' in description ? description.seq : null,
  };

  // Anchor −1 places an item before every entry.
  const anchored = new Map<number, ThreadMessageLike[]>();
  for (const item of floatingItems(view, calls)) {
    const at = time(item.createdAt);
    let anchor = -1;
    entries.forEach((entry, index) => {
      if (time(entry.createdAt) <= at) anchor = index;
    });
    anchored.set(anchor, [...(anchored.get(anchor) ?? []), item.message]);
  }

  const messages: ThreadMessageLike[] = [...(anchored.get(-1) ?? [])];
  // The trainer's cards wait for the end of its turn: its text, often in a later answer, explains them first.
  let turnCards: ThreadMessageLike[] = [];
  entries.forEach((entry, index) => {
    if (OPENS_TURN.has(entry.kind)) {
      messages.push(...turnCards);
      turnCards = [];
    }
    const message = entryMessage(view, entry, context);
    if (message !== null) messages.push(message);
    if (
      description !== null &&
      'emptyAfter' in description &&
      description.emptyAfter === entry.seq
    )
      messages.push({
        id: 'test-run-description',
        role: 'user',
        createdAt: new Date(entry.createdAt),
        content: '',
        metadata: meta({
          kind: 'user',
          record: null,
          schedule: null,
          testRun: true,
        }),
      });
    if (run !== null) turnCards.push(...runParts(run, entry));
    messages.push(...(anchored.get(index) ?? []));
  });
  messages.push(...turnCards);
  for (const entry of optimistic) {
    if (entry.place === 'feed') messages.push(optimisticMessage(entry));
  }
  if (draft !== null && draft !== '') messages.push(draftMessage(draft));
  return messages;
}

// ---------------------------------------------------------------------------------------------------
// Selectors

/** Whether a queued message is the one an optimistic feed entry already draws (KD-4). */
export function drawsPending(
  entry: OptimisticEntry,
  pending: PendingMessage,
): boolean {
  return (
    entry.place === 'feed' &&
    pending.source === 'user' &&
    pending.messageId === entry.messageId
  );
}

/** The agent of an agent page's view; null for a conversation and before the first read. */
export const selectAgent = (view: FeedView | null) =>
  view?.kind === 'agent' ? view.agent : null;

/** The status the controls follow: a conversation's `chat.status`, an agent's own; null before the first read. */
const statusOf = (view: FeedView | null): ChatStatus | AgentStatus | null =>
  view === null
    ? null
    : view.kind === 'thread'
      ? view.chat.status
      : view.agent.status;

/** «Прервать» next to «Отправить»: the agent works. */
export const canInterrupt = (view: FeedView | null): boolean =>
  statusOf(view) === 'working';

/** The tray's hint «Ждём вашего решения…» with «К запросу». */
const awaitsDecision = (view: FeedView | null): boolean =>
  statusOf(view) === 'awaiting_confirmation';

/** The agent works or waits for a decision: a new message goes to the tray (KD-4). */
export const isBusy = (view: FeedView | null): boolean =>
  canInterrupt(view) || awaitsDecision(view);

export type TrayEntry = {
  /** `messageId` of a queued message or `local-*` of an optimistic one. */
  id: string;
  /** MC-21: «Вы», «Агент», «Отчёт». */
  source: 'user' | 'parent' | 'report';
  /** The message text; for a report — the description of the agent that reported. */
  text: string;
};

export type Tray = {
  entries: TrayEntry[];
  /** Blocked by a decision: the hint with «К запросу». */
  blocked: boolean;
  /** The open decision of this agent (of the root in a conversation): the target of «К запросу». */
  decisionId: string | null;
};

/** Queued messages the feed does not draw, then optimistic tray entries. */
export function trayEntries(
  view: FeedView | null,
  optimistic: readonly OptimisticEntry[],
): Tray {
  const inTray = optimistic.filter((entry) => entry.place === 'tray');
  const local: TrayEntry[] = inTray.map((entry) => ({
    id: `local-${entry.localId}`,
    source: 'user',
    text: entry.text,
  }));
  if (view === null)
    return { entries: local, blocked: false, decisionId: null };

  // A queued copy of an optimistic tray entry (a re-read started before its 202) is not drawn twice.
  const localIds = new Set(inTray.map((entry) => entry.messageId));
  const queued: TrayEntry[] = view.pending
    .filter(
      (p) =>
        !localIds.has(p.messageId) &&
        !optimistic.some((entry) => drawsPending(entry, p)),
    )
    .map((p) =>
      p.source === 'report'
        ? { id: p.messageId, source: 'report', text: p.agentDescription }
        : { id: p.messageId, source: p.source, text: p.text },
    );
  const ownerId =
    view.kind === 'thread' ? view.chat.rootAgentId : view.agent.agentId;
  const open = view.decisions.find(
    (d) => d.status === 'open' && d.agentId === ownerId,
  );
  return {
    entries: [...queued, ...local],
    blocked: awaitsDecision(view),
    decisionId: open?.decisionId ?? null,
  };
}
