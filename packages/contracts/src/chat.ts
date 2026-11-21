import { z } from 'zod';

import {
  AGENTS_TOOL_CONFIRMATION,
  AgentStatusSchema,
  HistoryEventSchema,
  ToolCallStateSchema,
  ToolOutcomeSchema,
  ToolRefusalReasonSchema,
} from './agents';
import {
  IdSchema,
  RECORD_NAME_MAX_LENGTH,
  RecordKindSchema,
  SaveOwnRefusalSchema,
  VersionSchema,
  withContentByKind,
} from './library';
import { DecisionStatusSchema } from './runtime';
import { ThreadListQuerySchema, ThreadSummarySchema } from './threads';

/**
 * The chat API of the agent platform (design-chat.md, Contract Definitions): conversations, agents,
 * decisions, spend and the live stream. Every time field is an ISO string: bodies are JSON.
 */

/** Max length of a chat message after trimming. */
export const CHAT_MESSAGE_MAX_LENGTH = 20000;
/** Max number of history entries in one page (the limit of the agents' `history`). */
export const HISTORY_PAGE_SIZE = 500;
/** Page size of GET /api/agents. */
export const AGENT_PAGE_SIZE = 20;

/** Decision kind of a workflow brief (design-workflows.md, «Инструмент `start_workflow`»). */
export const WORKFLOWS_BRIEF_CONFIRMATION = 'workflows.brief';

const ChatTextSchema = z.string().trim().min(1).max(CHAT_MESSAGE_MAX_LENGTH);
const SeqSchema = z.number().int().nonnegative();

// ---------------------------------------------------------------------------------------------------
// Requests

/**
 * Body of POST /threads/:threadId/messages and POST /agents/:agentId/messages. `recordId` is the
 * record chip; it is not checked as a UUID here: the service answers any id it cannot start with the
 * same 404 as an invisible record.
 */
export const SendMessageRequestSchema = z.object({
  text: ChatTextSchema,
  recordId: z.string().min(1).optional(),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

/**
 * Body of POST /threads/:threadId/drafts/:draftId: save the draft (optionally under another name),
 * reject it, or mark it saved through the editor as the employee's own record `recordId`.
 */
export const DraftActionRequestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('save'),
    name: z.string().trim().min(1).max(RECORD_NAME_MAX_LENGTH).optional(),
  }),
  z.object({ action: z.literal('reject') }),
  z.object({ action: z.literal('saved_in_editor'), recordId: z.string().min(1) }),
]);
export type DraftActionRequest = z.infer<typeof DraftActionRequestSchema>;

/** Query of the history routes: entries with a greater `seq`; 0 by default. */
export const HistoryQuerySchema = z.object({
  afterSeq: z.coerce.number().int().nonnegative().default(0),
});
export type HistoryQuery = z.infer<typeof HistoryQuerySchema>;

/** Query of GET /agents: the cursor is opaque, as in the thread list. */
export const AgentListQuerySchema = ThreadListQuerySchema;
export type AgentListQuery = z.infer<typeof AgentListQuerySchema>;

/** Body of POST /decisions/:decisionId: `args` are the tool's full arguments when edited. */
export const DecisionRequestSchema = z.object({
  approve: z.boolean(),
  args: z.record(z.string(), z.unknown()).optional(),
});
export type DecisionRequest = z.infer<typeof DecisionRequestSchema>;

/** Query of GET /events: `thread:<threadId>` or `agent:<agentId>`; an unknown value is not an error. */
export const EventsQuerySchema = z.object({
  watch: z.string().max(512).optional(),
});
export type EventsQuery = z.infer<typeof EventsQuerySchema>;

// ---------------------------------------------------------------------------------------------------
// Command responses

/** 202 of a sent message; null for the first message of a conversation, which becomes the task. */
export const SendMessageResponseSchema = z.object({ messageId: z.string().min(1).nullable() });
export type SendMessageResponse = z.infer<typeof SendMessageResponseSchema>;

/** 200 of POST /threads/:threadId/interrupt and POST /agents/:agentId/interrupt; the request has no body. */
export const InterruptResponseSchema = z.object({ outcome: z.enum(['interrupted', 'not_active']) });
export type InterruptResponse = z.infer<typeof InterruptResponseSchema>;

/** 200 of POST /agents/:agentId/stop: the ids of the stopped agents. */
export const StopResponseSchema = z.object({ stopped: z.array(z.string().min(1)) });
export type StopResponse = z.infer<typeof StopResponseSchema>;

/** 201 of POST /agents/:agentId/restart: the new agent. */
export const RestartResponseSchema = z.object({ agentId: z.string().min(1) });
export type RestartResponse = z.infer<typeof RestartResponseSchema>;

/** 200 of POST /decisions/:decisionId. */
export const DecisionResponseSchema = z.object({
  outcome: z.enum(['resolved', 'already_resolved']),
});
export type DecisionResponse = z.infer<typeof DecisionResponseSchema>;

/** GET /spend: the current UTC month and the owner's cost in it. */
export const SpendResponseSchema = z.object({
  month: z.string().regex(/^\d{4}-\d{2}$/),
  costUsd: z.number().nonnegative(),
});
export type SpendResponse = z.infer<typeof SpendResponseSchema>;

/** GET /agents/awaiting: open decision requests in all the owner's conversations. */
export const AwaitingCountSchema = z.object({ count: z.number().int().nonnegative() });
export type AwaitingCount = z.infer<typeof AwaitingCountSchema>;

// ---------------------------------------------------------------------------------------------------
// Agents

/**
 * The record a run started from, as it was at the start (design-runtime.md, «Данные для `web`»):
 * `author` is `null` for a system record, `executor` is the executor's name for a workflow step.
 * The record's live state the web reads from GET /api/library by `recordId`.
 */
export const RunOriginSchema = z.object({
  recordId: IdSchema,
  kind: RecordKindSchema,
  version: VersionSchema,
  name: z.string().min(1),
  author: z.object({ id: IdSchema, name: z.string() }).nullable(),
  builtinKey: z.string().min(1).nullable(),
  executor: z.string().min(1).nullable(),
});
export type RunOrigin = z.infer<typeof RunOriginSchema>;

/**
 * An agent (design-agents.md, AgentView) as the API returns it. `name` is the run's name from its
 * snapshot; `origin` is `null` for a conversation's root; `firstRun` — the owner had no earlier
 * session with this record.
 */
export const AgentViewSchema = z.object({
  agentId: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  rootId: z.string().min(1),
  depth: z.number().int().nonnegative(),
  name: z.string().min(1),
  origin: RunOriginSchema.nullable(),
  firstRun: z.boolean(),
  description: z.string(),
  model: z.string().min(1),
  status: AgentStatusSchema,
  failureReason: z.string().nullable(),
  forkedFrom: z.object({ agentId: z.string().min(1), throughSeq: SeqSchema }).nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
});
export type AgentView = z.infer<typeof AgentViewSchema>;

/** An agent with its subtree. */
export type AgentNode = AgentView & { readonly children: AgentNode[] };
export const AgentNodeSchema: z.ZodType<AgentNode> = AgentViewSchema.extend({
  get children() {
    return z.array(AgentNodeSchema);
  },
});

/** A top node of GET /agents: a child of a conversation's root, with its conversation. */
export const AgentListNodeSchema = AgentViewSchema.extend({
  children: z.array(AgentNodeSchema),
  threadId: z.string().min(1),
  threadTitle: ThreadSummarySchema.shape.title,
});
export type AgentListNode = z.infer<typeof AgentListNodeSchema>;

/** Response of GET /agents: newest first, at most AGENT_PAGE_SIZE top agents. */
export const AgentListPageSchema = z.object({
  agents: z.array(AgentListNodeSchema).max(AGENT_PAGE_SIZE),
  nextCursor: z.string().min(1).nullable(),
});
export type AgentListPage = z.infer<typeof AgentListPageSchema>;

// ---------------------------------------------------------------------------------------------------
// History

/** How a child agent ended, as its parent learns it. */
const ChildEndSchema = AgentStatusSchema.extract(['completed', 'failed', 'stopped']);

function entry<K extends string, C extends z.ZodType>(kind: K, content: C) {
  return z.object({
    seq: SeqSchema,
    kind: z.literal(kind),
    createdAt: z.iso.datetime(),
    content,
  });
}

/**
 * How a tool call reads for the employee: the tool's human title and the labels of its arguments by
 * key. Absent when the tool, or an argument, has no title: the technical name and the key are shown.
 */
const ToolDisplayShape = {
  toolTitle: z.string().min(1).optional(),
  argLabels: z.record(z.string(), z.string()).optional(),
};

/** A tool call of a model answer; an open call carries its state. */
export const AnswerToolCallSchema = z.object({
  callId: z.string().min(1),
  tool: z.string().min(1),
  server: z.string().nullable(),
  args: z.unknown(),
  state: ToolCallStateSchema,
  ...ToolDisplayShape,
});
export type AnswerToolCall = z.infer<typeof AnswerToolCallSchema>;

/** The record chip of a message (custom-agents design-runtime.md, KD-4): shown next to its text. */
export const ChipRecordSchema = z.object({
  id: IdSchema,
  kind: RecordKindSchema,
  name: z.string().min(1),
});
export type ChipRecord = z.infer<typeof ChipRecordSchema>;

/**
 * One entry of an agent's history (design-agents.md, HistoryEntry) as the agents' `history` returns it:
 * a `model_answer` carries its tool calls. A `task` carries a chip only at a conversation's root: its
 * first message becomes the root's task.
 */
export const HistoryEntrySchema = z.discriminatedUnion('kind', [
  entry('task', z.object({ text: z.string(), record: ChipRecordSchema.nullable() })),
  entry('user_message', z.object({ text: z.string(), record: ChipRecordSchema.nullable() })),
  entry('agent_message', z.object({ text: z.string(), agentId: z.string() })),
  entry(
    'child_report',
    z.object({
      agentId: z.string(),
      description: z.string(),
      status: ChildEndSchema,
      reason: z.string().nullable(),
      text: z.string().nullable(),
      toolCalls: z.number().int().nonnegative(),
      durationMs: z.number().int().nonnegative(),
    }),
  ),
  entry(
    'model_answer',
    z.object({ text: z.string(), toolCalls: z.array(AnswerToolCallSchema) }),
  ),
  entry(
    'tool_result',
    z.object({
      callId: z.string(),
      tool: z.string(),
      server: z.string().nullable(),
      args: z.unknown(),
      outcome: ToolOutcomeSchema,
      refusalReason: ToolRefusalReasonSchema.nullable(),
      /** The refused model of a refusal by model, otherwise `null`. */
      refusalDetail: z.object({ model: z.string().min(1) }).nullable(),
      text: z.string().nullable(),
      /** Script output of a `run_code` call: `null` when the run failed, absent for other tools. */
      output: z.string().nullable().optional(),
      startedAt: z.iso.datetime().nullable(),
      finishedAt: z.iso.datetime().nullable(),
    }),
  ),
  entry('notice', z.object({ text: z.string() })),
  entry('event', z.object({ event: HistoryEventSchema, reason: z.string().nullable() })),
  entry('compaction', z.object({ summary: z.string(), throughSeq: SeqSchema })),
]);
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;

/** A message not yet delivered to the agent, in queue order. */
export const PendingMessageSchema = z.discriminatedUnion('source', [
  z.object({
    messageId: z.string().min(1),
    source: z.enum(['user', 'parent']),
    text: z.string(),
    createdAt: z.iso.datetime(),
  }),
  z.object({
    messageId: z.string().min(1),
    source: z.literal('report'),
    agentDescription: z.string(),
    status: ChildEndSchema,
    createdAt: z.iso.datetime(),
  }),
]);
export type PendingMessage = z.infer<typeof PendingMessageSchema>;

// ---------------------------------------------------------------------------------------------------
// Decisions

export const ConfirmationKindSchema = z.enum([
  AGENTS_TOOL_CONFIRMATION,
  WORKFLOWS_BRIEF_CONFIRMATION,
]);
export type ConfirmationKind = z.infer<typeof ConfirmationKindSchema>;

/** A decision request in any status. */
export const ConfirmationSchema = z.object({
  decisionId: z.string().min(1),
  agentId: z.string().min(1),
  /** The agent's description. */
  description: z.string(),
  /** The record the asking agent started from; `null` for a conversation's root. */
  origin: RunOriginSchema.nullable(),
  kind: ConfirmationKindSchema,
  tool: z.string().min(1),
  server: z.string().nullable(),
  /** The arguments the model requested. */
  args: z.unknown(),
  /** The card content: the tool's confirmation content (for a brief: `workflow` and its three fields). */
  content: z.unknown(),
  status: DecisionStatusSchema,
  /** Set when `resolved`: the decision and the arguments the call ran with. */
  resolution: z.object({ approve: z.boolean(), args: z.unknown() }).nullable(),
  createdAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
  ...ToolDisplayShape,
});
export type Confirmation = z.infer<typeof ConfirmationSchema>;

// ---------------------------------------------------------------------------------------------------
// Views

/** Chat status for the composer (design-chat.md, State Transitions). */
export const ChatStatusSchema = z.enum([
  'idle',
  'working',
  'awaiting_confirmation',
  'interrupted',
  'failed',
]);
export type ChatStatus = z.infer<typeof ChatStatusSchema>;

/** Next `afterSeq` to read from, or null when everything is read. */
const NextAfterSeqSchema = SeqSchema.nullable();

/** State of a record draft (design-runtime.md, State Transitions): only `pending` waits. */
export const DraftStateSchema = z.enum([
  'pending',
  'saved',
  'saved_in_editor',
  'rejected',
  'superseded',
]);
export type DraftState = z.infer<typeof DraftStateSchema>;

/**
 * A record draft of a conversation (design-runtime.md, «Данные для `web`»): `callId` is the
 * `draft_record` call its card stands at; `recordId` and `baseVersion` are the edited record or
 * `null` for a new one; `refusal` is the reason of the last refused `saveOwn`.
 */
export const DraftViewSchema = withContentByKind({
  draftId: z.string().min(1),
  callId: z.string().min(1),
  name: z.string(),
  description: z.string(),
  recordId: IdSchema.nullable(),
  baseVersion: VersionSchema.nullable(),
  state: DraftStateSchema,
  refusal: SaveOwnRefusalSchema.nullable(),
  savedRecordId: IdSchema.nullable(),
  createdAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
});
export type DraftView = z.infer<typeof DraftViewSchema>;

/** GET /threads/:threadId/history. */
export const ConversationViewSchema = z.object({
  thread: ThreadSummarySchema,
  chat: z.object({
    status: ChatStatusSchema,
    /** Set when `failed`. */
    failureReason: z.string().nullable(),
    /** The conversation's root: its id is the conversation's. */
    rootAgentId: z.string().min(1),
    /** The root's model. */
    model: z.string().min(1),
  }),
  entries: z.array(HistoryEntrySchema).max(HISTORY_PAGE_SIZE),
  nextAfterSeq: NextAfterSeqSchema,
  pending: z.array(PendingMessageSchema),
  decisions: z.array(ConfirmationSchema),
  agents: z.array(AgentNodeSchema),
  /** Every draft of the conversation. */
  drafts: z.array(DraftViewSchema),
});
export type ConversationView = z.infer<typeof ConversationViewSchema>;

/** GET /agents/:agentId/history. */
export const AgentPageViewSchema = z.object({
  agent: AgentViewSchema.extend({
    threadId: z.string().min(1),
    threadTitle: ThreadSummarySchema.shape.title,
    /** The parent agent's description; absent when the parent is the conversation's root. */
    parentDescription: z.string().optional(),
  }),
  entries: z.array(HistoryEntrySchema).max(HISTORY_PAGE_SIZE),
  nextAfterSeq: NextAfterSeqSchema,
  pending: z.array(PendingMessageSchema),
  decisions: z.array(ConfirmationSchema),
  children: z.array(AgentNodeSchema),
});
export type AgentPageView = z.infer<typeof AgentPageViewSchema>;

/** GET /agents/:agentId/inherited: the fork parent's entries through `throughSeq`. */
export const InheritedHistorySchema = z.object({
  entries: z.array(HistoryEntrySchema).max(HISTORY_PAGE_SIZE),
  nextAfterSeq: NextAfterSeqSchema,
});
export type InheritedHistory = z.infer<typeof InheritedHistorySchema>;

/**
 * GET /agents/:agentId/run (design-runtime.md, «Данные для `web`»): the workflow record the run
 * started from, its brief, the coordinator and the team of its snapshot. `steps` are the
 * coordinator's children in creation order, each with `origin.executor`; executors of `team` outside
 * `steps` were not called. `limitRefusals` — every `run_limit` refusal.
 */
export const WorkflowRunViewSchema = z.object({
  origin: RunOriginSchema,
  brief: z.object({ question: z.string().min(1), boundaries: z.string(), result: z.string() }),
  coordinator: AgentViewSchema,
  team: z.array(
    z.object({
      name: z.string().min(1),
      role: z.string().min(1),
      maxRuns: z.number().int().positive(),
      /** The executor whose report becomes the answer. */
      final: z.boolean(),
    }),
  ),
  steps: z.array(AgentViewSchema),
  limitRefusals: z.array(z.object({ executor: z.string().min(1), at: z.iso.datetime() })),
});
export type WorkflowRunView = z.infer<typeof WorkflowRunViewSchema>;

// ---------------------------------------------------------------------------------------------------
// Live stream

/** An event of GET /events: `type` is the SSE event name, `data` its JSON body. */
export const LiveEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), data: z.object({}) }),
  z.object({ type: z.literal('tree'), data: z.object({ threadId: z.string().min(1) }) }),
  z.object({
    type: z.literal('delta'),
    data: z.object({
      agentId: z.string().min(1),
      offset: z.number().int().nonnegative(),
      text: z.string(),
    }),
  }),
  z.object({ type: z.literal('ping'), data: z.object({}) }),
]);
export type LiveEvent = z.infer<typeof LiveEventSchema>;
