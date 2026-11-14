import { z } from 'zod';

import {
  AGENTS_TOOL_CONFIRMATION,
  AgentStatusSchema,
  HistoryEventSchema,
  ToolCallStateSchema,
  ToolOutcomeSchema,
  ToolRefusalReasonSchema,
} from './agents.js';
import { DecisionStatusSchema } from './runtime.js';
import { ThreadListQuerySchema, ThreadSummarySchema } from './threads.js';

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

/** Body of POST /threads/:threadId/messages and POST /agents/:agentId/messages. */
export const SendMessageRequestSchema = z.object({ text: ChatTextSchema });
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

/** Body of POST /threads/:threadId/interrupt and POST /agents/:agentId/interrupt. */
export const InterruptRequestSchema = z.object({ text: ChatTextSchema.optional() });
export type InterruptRequest = z.infer<typeof InterruptRequestSchema>;

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

/** 200 of an interrupt; `messageId` is set when `not_active` sent the text as a message. */
export const InterruptResponseSchema = z.object({
  outcome: z.enum(['interrupted', 'not_active']),
  messageId: z.string().min(1).optional(),
});
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

/** The template of a workflow coordinator: its definition name equals the template name. */
export const AgentTemplateSchema = z.object({ name: z.string().min(1), title: z.string().min(1) });
export type AgentTemplate = z.infer<typeof AgentTemplateSchema>;

/**
 * An agent (design-agents.md, AgentView) as the API returns it; `template` only for a workflow
 * coordinator — the field is absent for other agents.
 */
export const AgentViewSchema = z.object({
  agentId: z.string().min(1),
  parentId: z.string().min(1).nullable(),
  rootId: z.string().min(1),
  depth: z.number().int().nonnegative(),
  definition: z.string().min(1),
  description: z.string(),
  model: z.string().min(1),
  status: AgentStatusSchema,
  failureReason: z.string().nullable(),
  forkedFrom: z.object({ agentId: z.string().min(1), throughSeq: SeqSchema }).nullable(),
  createdAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  template: AgentTemplateSchema.optional(),
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

/**
 * One entry of an agent's history (design-agents.md, HistoryEntry) as the agents' `history` returns it:
 * a `model_answer` carries its tool calls.
 */
export const HistoryEntrySchema = z.discriminatedUnion('kind', [
  entry('task', z.object({ text: z.string() })),
  entry('user_message', z.object({ text: z.string() })),
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
      text: z.string().nullable(),
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
    /** «Прервать и отправить». */
    interrupt: z.boolean(),
    text: z.string(),
    createdAt: z.iso.datetime(),
  }),
  z.object({
    messageId: z.string().min(1),
    source: z.literal('report'),
    interrupt: z.boolean(),
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

/** A decision request in any status; `templateTitle` only for a brief. */
export const ConfirmationSchema = z.object({
  decisionId: z.string().min(1),
  agentId: z.string().min(1),
  /** The agent's description. */
  description: z.string(),
  kind: ConfirmationKindSchema,
  tool: z.string().min(1),
  server: z.string().nullable(),
  /** The arguments the model requested. */
  args: z.unknown(),
  /** The card content: the tool's confirmation content (for a brief: `title` and its three fields). */
  content: z.unknown(),
  status: DecisionStatusSchema,
  /** Set when `resolved`: the decision and the arguments the call ran with. */
  resolution: z.object({ approve: z.boolean(), args: z.unknown() }).nullable(),
  createdAt: z.iso.datetime(),
  resolvedAt: z.iso.datetime().nullable(),
  templateTitle: z.string().min(1).optional(),
  ...ToolDisplayShape,
});
export type Confirmation = z.infer<typeof ConfirmationSchema>;

// ---------------------------------------------------------------------------------------------------
// Views

/** Chat status for the composer (design-chat.md, State Transitions). */
export const ChatStatusSchema = z.enum([
  'new',
  'idle',
  'working',
  'awaiting_confirmation',
  'interrupted',
  'failed',
]);
export type ChatStatus = z.infer<typeof ChatStatusSchema>;

/** Next `afterSeq` to read from, or null when everything is read. */
const NextAfterSeqSchema = SeqSchema.nullable();

/** GET /threads/:threadId/history. */
export const ConversationViewSchema = z.object({
  thread: ThreadSummarySchema,
  chat: z.object({
    status: ChatStatusSchema,
    /** Set when `failed`. */
    failureReason: z.string().nullable(),
    rootAgentId: z.string().min(1).nullable(),
    /** The root's model; null while the conversation has no root. */
    model: z.string().min(1).nullable(),
  }),
  entries: z.array(HistoryEntrySchema).max(HISTORY_PAGE_SIZE),
  nextAfterSeq: NextAfterSeqSchema,
  pending: z.array(PendingMessageSchema),
  decisions: z.array(ConfirmationSchema),
  agents: z.array(AgentNodeSchema),
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

/** GET /agents/:agentId/run (design-workflows.md, WorkflowRunView). */
export const WorkflowRunViewSchema = z.object({
  agentId: z.string().min(1),
  template: AgentTemplateSchema,
  brief: z.object({ question: z.string().min(1), boundaries: z.string(), result: z.string() }),
  coordinator: AgentViewSchema,
  steps: z.array(AgentViewSchema),
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
