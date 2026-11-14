import {
  WORKFLOWS_BRIEF_CONFIRMATION,
  type AgentNode,
  type AgentPageView,
  type AgentStatus,
  type AnswerToolCall,
  type ChatStatus,
  type Confirmation,
  type ConversationView,
  type HistoryEntry,
  type PendingMessage,
  type ToolCallState,
  type ToolOutcome,
  type ToolRefusalReason,
} from "@agent-os/contracts";
import type { ThreadMessageLike } from "@assistant-ui/react";

/**
 * The feed rule (design-web.md, KD-3, KD-4, «Что сотрудник видит»): pure functions from what the
 * FeedStore holds to assistant-ui messages, the tray and the controls. Nothing here reads a store.
 */

// ---------------------------------------------------------------------------------------------------
// Inputs

/** A conversation or an agent page with every history entry read so far. */
export type FeedView =
  | {
      kind: "thread";
      chat: ConversationView["chat"];
      entries: readonly HistoryEntry[];
      pending: readonly PendingMessage[];
      decisions: readonly Confirmation[];
      /** Direct children of the root. */
      children: readonly AgentNode[];
    }
  | {
      kind: "agent";
      agent: AgentPageView["agent"];
      entries: readonly HistoryEntry[];
      pending: readonly PendingMessage[];
      decisions: readonly Confirmation[];
      children: readonly AgentNode[];
    };

/** The view of one page read, with that page's entries. */
export function feedViewOf(page: ConversationView | AgentPageView): FeedView {
  if ("chat" in page) {
    return {
      kind: "thread",
      chat: page.chat,
      entries: page.entries,
      pending: page.pending,
      decisions: page.decisions,
      children: page.agents,
    };
  }
  return {
    kind: "agent",
    agent: page.agent,
    entries: page.entries,
    pending: page.pending,
    decisions: page.decisions,
    children: page.children,
  };
}

/** A message the server accepted (202) and the next re-read has not shown yet (KD-4). */
export type OptimisticEntry = {
  localId: string;
  text: string;
  /** The tray for a busy agent; the end of the feed for an idle one and for «Прервать и отправить». */
  place: "tray" | "feed";
  /** From the 202; null for a conversation's first message and for an interrupt that interrupted. */
  messageId: string | null;
  /** The conversation's first message: leaves when the `task` entry appears. */
  first: boolean;
  /** Sent by «Прервать и отправить» and the agent was interrupted: the queue holds it as an interrupt. */
  interrupt: boolean;
  createdAt: string;
};

/** A text part of `delta`: `offset` is the length of the text before it. */
export type DraftPart = { offset: number; text: string };

/**
 * `offset` 0 starts the draft anew, an `offset` equal to its length appends, any other part is
 * dropped — a part delivered twice or after a gap neither doubles nor loses text.
 */
export function applyDraftPart(draft: string | null, part: DraftPart): string | null {
  if (part.offset === 0) return part.text;
  const current = draft ?? "";
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
  const status: ChatStatus | AgentStatus = view.kind === "thread" ? view.chat.status : view.agent.status;
  return status !== "working" && draft === draftAtStart ? null : draft;
}

// ---------------------------------------------------------------------------------------------------
// Data parts: what the feed components (RunCard, DecisionCard, AgentReport, EventLine) receive

/** Names of the `data-*` parts; a component is picked by `MessagePrimitive.Parts` `data.by_name`. */
export const FEED_PART = {
  runCard: "run-card",
  decision: "decision",
  report: "report",
  event: "event",
} as const;

/** The workflow card also shows the question of the brief that started it (agent-run-card.md, part 4). */
export type RunCardPartData = AgentNode & { briefQuestion?: string };
export type DecisionPartData = {
  confirmation: Confirmation;
  /** The conversation's root asks: «Чат хочет выполнить:» (MC-19). */
  byChat: boolean;
};
export type ReportPartData = Extract<HistoryEntry, { kind: "child_report" }>["content"] & {
  createdAt: string;
};
export type EventPartData = Extract<HistoryEntry, { kind: "event" }>["content"] & {
  createdAt: string;
};

/** `artifact` of a `tool-call` part: what tool-call.md shows besides arguments and result. */
export type ToolCallArtifact = {
  state: ToolCallState;
  outcome: ToolOutcome | null;
  server: string | null;
  /** The tool's human title and the labels of its arguments; absent when the tool gives none. */
  toolTitle?: AnswerToolCall["toolTitle"];
  argLabels?: AnswerToolCall["argLabels"];
  refusalReason: ToolRefusalReason | null;
  startedAt: string | null;
  finishedAt: string | null;
};

/** `metadata.custom` of a feed message: the source label (MC-9, MC-10, AV-04) and the draft mark. */
export type FeedMessageMeta =
  | { kind: "task" }
  | { kind: "user" }
  | { kind: "parent"; fromConversation: boolean; senderDescription: string | null }
  | { kind: "answer"; report: boolean }
  | { kind: "draft" }
  | { kind: "part" };

type LikePart = Exclude<ThreadMessageLike["content"], string>[number];
type ToolCallLikePart = Extract<LikePart, { type: "tool-call" }>;
type JsonObject = NonNullable<ToolCallLikePart["args"]>;

const STARTS = new Set(["start_agent", "start_workflow"]);
/** A start the run card or the brief card already shows (MC-23): only other outcomes draw a block. */
const START_HIDDEN_OUTCOMES = new Set<ToolOutcome>(["success", "rejected"]);
const ERROR_OUTCOMES = new Set<ToolOutcome>([
  "tool_error",
  "transport_failure",
  "refused",
  "rejected",
  "interrupted",
  "unknown",
]);

// ---------------------------------------------------------------------------------------------------
// toFeed

type ToolResult = Extract<HistoryEntry, { kind: "tool_result" }>["content"];

const time = (iso: string): number => Date.parse(iso);

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function meta(custom: FeedMessageMeta): ThreadMessageLike["metadata"] {
  return { custom };
}

function toolCallPart(call: AnswerToolCall, result: ToolResult | undefined): ToolCallLikePart {
  const outcome = result?.outcome ?? null;
  const artifact: ToolCallArtifact = {
    state: result === undefined ? call.state : "done",
    outcome,
    server: call.server,
    toolTitle: call.toolTitle,
    argLabels: call.argLabels,
    refusalReason: result?.refusalReason ?? null,
    startedAt: result?.startedAt ?? null,
    finishedAt: result?.finishedAt ?? null,
  };
  return {
    type: "tool-call",
    toolCallId: call.callId,
    toolName: call.tool,
    args: isJsonObject(call.args) ? call.args : {},
    argsText: JSON.stringify(call.args ?? null),
    result: result?.text ?? undefined,
    isError: outcome !== null && ERROR_OUTCOMES.has(outcome),
    artifact,
  };
}

function isDrawnCall(call: AnswerToolCall, result: ToolResult | undefined): boolean {
  if (!STARTS.has(call.tool)) return true;
  return result !== undefined && !START_HIDDEN_OUTCOMES.has(result.outcome);
}

function dataMessage(id: string, createdAt: string, name: string, data: unknown): ThreadMessageLike {
  return {
    id,
    role: "assistant",
    createdAt: new Date(createdAt),
    content: [{ type: `data-${name}`, data }],
    metadata: meta({ kind: "part" }),
  };
}

function entryMessage(
  view: FeedView,
  entry: HistoryEntry,
  results: ReadonlyMap<string, ToolResult>,
): ThreadMessageLike | null {
  const id = `seq-${entry.seq}`;
  const createdAt = new Date(entry.createdAt);
  switch (entry.kind) {
    case "task":
      return { id, role: "user", createdAt, content: entry.content.text, metadata: meta({ kind: "task" }) };
    case "user_message":
      return { id, role: "user", createdAt, content: entry.content.text, metadata: meta({ kind: "user" }) };
    case "agent_message": {
      const sender = entry.content.agentId;
      const rootId = view.kind === "thread" ? view.chat.rootAgentId : view.agent.rootId;
      const senderDescription =
        view.kind === "agent" && sender === view.agent.parentId
          ? (view.agent.parentDescription ?? null)
          : null;
      return {
        id,
        role: "user",
        createdAt,
        content: entry.content.text,
        metadata: meta({ kind: "parent", fromConversation: sender === rootId, senderDescription }),
      };
    }
    case "model_answer": {
      const parts: LikePart[] = [];
      if (entry.content.text !== "") parts.push({ type: "text", text: entry.content.text });
      for (const call of entry.content.toolCalls) {
        const result = results.get(call.callId);
        if (isDrawnCall(call, result)) parts.push(toolCallPart(call, result));
      }
      if (parts.length === 0) return null;
      // AV-04: on an agent page the answer that ends a turn without calls is the agent's report.
      const report = view.kind === "agent" && entry.content.toolCalls.length === 0;
      return { id, role: "assistant", createdAt, content: parts, metadata: meta({ kind: "answer", report }) };
    }
    case "child_report": {
      const data: ReportPartData = { ...entry.content, createdAt: entry.createdAt };
      return dataMessage(id, entry.createdAt, FEED_PART.report, data);
    }
    case "event": {
      const { event, reason } = entry.content;
      // TH-08: a model failure of the conversation's root is the answer's error block.
      if (view.kind === "thread" && event === "failed" && reason === "model_error") {
        return {
          id,
          role: "assistant",
          createdAt,
          content: [],
          status: { type: "incomplete", reason: "error", error: reason },
          metadata: meta({ kind: "answer", report: false }),
        };
      }
      const data: EventPartData = { event, reason, createdAt: entry.createdAt };
      return dataMessage(id, entry.createdAt, FEED_PART.event, data);
    }
    case "tool_result":
    case "notice":
    case "compaction":
      // A result is a part of its call; notices and compaction summaries are for the model only.
      return null;
  }
}

type Floating = { createdAt: string; message: ThreadMessageLike };

/** A string field of an unknown value. */
function stringField(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field: unknown = Reflect.get(value, key);
  return typeof field === "string" && field !== "" ? field : undefined;
}

/**
 * The question of the confirmed brief that started a workflow: the last approved brief of the
 * coordinator's template created not later than it (the run card stands right under that brief).
 * The built `AgentNode` carries no brief, so the feed's own decisions are the source.
 */
function briefQuestionOf(decisions: readonly Confirmation[], node: AgentNode): string | undefined {
  if (node.template === undefined) return undefined;
  const brief = decisions
    .filter(
      (c) =>
        c.kind === WORKFLOWS_BRIEF_CONFIRMATION &&
        c.resolution?.approve === true &&
        stringField(c.args, "template") === node.definition &&
        time(c.createdAt) <= time(node.createdAt),
    )
    .sort((a, b) => time(b.createdAt) - time(a.createdAt))[0];
  if (brief?.resolution == null) return undefined;
  return stringField(brief.resolution.args, "question") ?? stringField(brief.content, "question");
}

/** Decisions and direct children, by creation time; equal times keep the API's list order. */
function floatingItems(view: FeedView): Floating[] {
  const byChatRoot = (c: Confirmation): boolean =>
    view.kind === "thread" && c.agentId === view.chat.rootAgentId;
  const decisions = view.decisions.map((confirmation) => {
    const data: DecisionPartData = { confirmation, byChat: byChatRoot(confirmation) };
    return {
      createdAt: confirmation.createdAt,
      message: dataMessage(`decision-${confirmation.decisionId}`, confirmation.createdAt, FEED_PART.decision, data),
    };
  });
  const children = view.children.map((node) => {
    const data: RunCardPartData = { ...node, briefQuestion: briefQuestionOf(view.decisions, node) };
    return {
      createdAt: node.createdAt,
      message: dataMessage(`agent-${node.agentId}`, node.createdAt, FEED_PART.runCard, data),
    };
  });
  // Array.prototype.sort is stable: ties keep decisions, then children, each in API order.
  return [...decisions, ...children].sort((a, b) => time(a.createdAt) - time(b.createdAt));
}

function optimisticMessage(entry: OptimisticEntry): ThreadMessageLike {
  return {
    id: `local-${entry.localId}`,
    role: "user",
    createdAt: new Date(entry.createdAt),
    content: entry.text,
    metadata: meta({ kind: "user" }),
  };
}

/**
 * The draft is complete for assistant-ui on purpose: a `running` last message makes the library
 * derive `isRunning` and disable «Отправить» (spike S-1, b2), while FR-16 keeps sending open.
 */
function draftMessage(draft: string): ThreadMessageLike {
  return {
    id: "draft",
    role: "assistant",
    content: [{ type: "text", text: draft }],
    status: { type: "complete", reason: "unknown" },
    metadata: meta({ kind: "draft" }),
  };
}

/**
 * Feed messages with stable ids (`seq-*`, `decision-*`, `agent-*`, `local-*`, `draft`): entries by
 * `seq`; each decision and direct child after the last entry created not later than it (KD-3);
 * optimistic feed entries, then the draft, last.
 */
export function toFeed(
  view: FeedView,
  draft: string | null,
  optimistic: readonly OptimisticEntry[],
): ThreadMessageLike[] {
  const entries = [...view.entries].sort((a, b) => a.seq - b.seq);
  const results = new Map<string, ToolResult>();
  for (const entry of entries) {
    if (entry.kind === "tool_result") results.set(entry.content.callId, entry.content);
  }

  // Anchor −1 places an item before every entry.
  const anchored = new Map<number, ThreadMessageLike[]>();
  for (const item of floatingItems(view)) {
    const at = time(item.createdAt);
    let anchor = -1;
    entries.forEach((entry, index) => {
      if (time(entry.createdAt) <= at) anchor = index;
    });
    anchored.set(anchor, [...(anchored.get(anchor) ?? []), item.message]);
  }

  const messages: ThreadMessageLike[] = [...(anchored.get(-1) ?? [])];
  entries.forEach((entry, index) => {
    const message = entryMessage(view, entry, results);
    if (message !== null) messages.push(message);
    messages.push(...(anchored.get(index) ?? []));
  });
  for (const entry of optimistic) {
    if (entry.place === "feed") messages.push(optimisticMessage(entry));
  }
  if (draft !== null && draft !== "") messages.push(draftMessage(draft));
  return messages;
}

// ---------------------------------------------------------------------------------------------------
// Selectors

/** Whether a queued message is the one an optimistic feed entry already draws (KD-4). */
export function drawsPending(entry: OptimisticEntry, pending: PendingMessage): boolean {
  if (entry.place !== "feed" || pending.source !== "user") return false;
  if (entry.messageId !== null) return pending.messageId === entry.messageId;
  return entry.interrupt && pending.interrupt && pending.text === entry.text;
}

/** The agent works or waits for a decision: a new message goes to the tray (KD-4). */
export function isBusy(view: FeedView | null): boolean {
  if (view === null) return false;
  const status: ChatStatus | AgentStatus = view.kind === "thread" ? view.chat.status : view.agent.status;
  return status === "working" || status === "awaiting_confirmation";
}

export type FeedControls = {
  /** The header button of an agent page (UXRD Screen 3); a conversation has none. */
  header: "stop" | "restart" | null;
  /** «Прервать» / «Прервать и отправить» next to «Отправить». */
  interrupt: boolean;
  /** The tray's hint «Ждём вашего решения…» with «К запросу». */
  awaitingDecision: boolean;
  /** «Отправить» puts the message in the tray. */
  queues: boolean;
};

/**
 * Controls by status: a conversation by `chat.status` (design-web.md, State Transitions), an agent by
 * UXRD Screen 3, «Управление по статусу».
 */
export function controls(view: FeedView | null): FeedControls {
  const queues = isBusy(view);
  if (view === null) return { header: null, interrupt: false, awaitingDecision: false, queues };
  const status: ChatStatus | AgentStatus = view.kind === "thread" ? view.chat.status : view.agent.status;
  const header =
    view.kind === "thread"
      ? null
      : status === "completed" || status === "failed" || status === "stopped"
        ? "restart"
        : "stop";
  return {
    header,
    interrupt: status === "working",
    awaitingDecision: status === "awaiting_confirmation",
    queues,
  };
}

export type TrayEntry = {
  /** `messageId` of a queued message or `local-*` of an optimistic one. */
  id: string;
  /** MC-21: «Вы», «Агент», «Отчёт». */
  source: "user" | "parent" | "report";
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
export function trayEntries(view: FeedView | null, optimistic: readonly OptimisticEntry[]): Tray {
  const inTray = optimistic.filter((entry) => entry.place === "tray");
  const local: TrayEntry[] = inTray.map((entry) => ({
    id: `local-${entry.localId}`,
    source: "user",
    text: entry.text,
  }));
  if (view === null) return { entries: local, blocked: false, decisionId: null };

  // A queued copy of an optimistic tray entry (a re-read started before its 202) is not drawn twice.
  const localIds = new Set(inTray.map((entry) => entry.messageId));
  const queued: TrayEntry[] = view.pending
    .filter((p) => !localIds.has(p.messageId) && !optimistic.some((entry) => drawsPending(entry, p)))
    .map((p) =>
      p.source === "report"
        ? { id: p.messageId, source: "report", text: p.agentDescription }
        : { id: p.messageId, source: p.source, text: p.text },
    );
  const ownerId = view.kind === "thread" ? view.chat.rootAgentId : view.agent.agentId;
  const open = view.decisions.find((d) => d.status === "open" && d.agentId === ownerId);
  return {
    entries: [...queued, ...local],
    blocked: controls(view).awaitingDecision,
    decisionId: open?.decisionId ?? null,
  };
}
