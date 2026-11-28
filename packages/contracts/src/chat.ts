import { z } from 'zod';

import {
  AGENTS_TOOL_CONFIRMATION,
  AgentStatusSchema,
  HistoryEventSchema,
  ToolCallStateSchema,
  ToolOutcomeSchema,
  ToolRefusalReasonSchema,
} from './agents';
import { DocumentRefSchema } from './notepad';
import {
  AgentContentSchema,
  ChipRecordSchema,
  DeepAgentContentSchema,
  IdSchema,
  RecordKindSchema,
  VersionSchema,
} from './library';
import { SessionTaskStatusSchema } from './runtime';
import { ThreadListQuerySchema, ThreadSummarySchema } from './threads';
import { TestRunSummarySchema } from './training';

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

/** Decision kind of a deep agent's brief (deep-agents design-agent-types.md, «`start_deep_agent`»). */
export const AGENTS_BRIEF_CONFIRMATION = 'agents.brief';
/** Decision kind of a record tool's card: create, edit or delete a library record (KD-3). */
export const LIBRARY_RECORD_CONFIRMATION = 'library.record';

/** The text of a chat message: also a schedule's instruction, which is sent as one. */
export const ChatTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(CHAT_MESSAGE_MAX_LENGTH);
const SeqSchema = z.number().int().nonnegative();

// ---------------------------------------------------------------------------------------------------
// Requests

/**
 * Body of POST /threads/:threadId/messages and POST /agents/:agentId/messages. `recordId` is the
 * record chip; it is not checked as a UUID here: the service answers any id it cannot start with the
 * same 404 as an invisible record. `sendKey` is the send's key (runtime-fixes design-send.md, KD-5): one
 * key is one send of the employee, a repeat of it creates nothing.
 */
export const SendMessageRequestSchema = z.object({
  text: ChatTextSchema,
  recordId: z.string().min(1).optional(),
  sendKey: z.uuid(),
});
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;

/**
 * Body of POST /threads/:threadId/fork (improvements design-server.md, KD-6), optional: at most one of `throughSeq` —
 * the message the fork inherits the history through — and `edit` — the employee's message `seq` replaced by `text`
 * (with its chip, as a send). Neither forks the whole conversation.
 */
export const ForkRequestSchema = z
  .object({
    throughSeq: z.number().int().min(1).optional(),
    edit: SendMessageRequestSchema.omit({ sendKey: true })
      .extend({
        seq: z.number().int().min(1),
      })
      .optional(),
  })
  .refine((body) => body.throughSeq === undefined || body.edit === undefined, {
    message: 'At most one of throughSeq and edit',
  })
  .default({});
export type ForkRequest = z.infer<typeof ForkRequestSchema>;

/** Query of the history routes: entries with a greater `seq`; 0 by default. */
export const HistoryQuerySchema = z.object({
  afterSeq: z.coerce.number().int().nonnegative().default(0),
});
export type HistoryQuery = z.infer<typeof HistoryQuerySchema>;

/** Query of GET /agents: the cursor is opaque, as in the thread list. */
export const AgentListQuerySchema = ThreadListQuerySchema;
export type AgentListQuery = z.infer<typeof AgentListQuerySchema>;

/**
 * Body of POST /decisions/:decisionId: `args` are the tool's full arguments when edited. `allowInConversation`
 * («allow in this conversation») also allows the card's MCP pair to the conversation; only with `approve: true`.
 */
export const DecisionRequestSchema = z
  .object({
    approve: z.boolean(),
    args: z.record(z.string(), z.unknown()).optional(),
    allowInConversation: z.literal(true).optional(),
  })
  .refine((body) => body.approve || body.allowInConversation === undefined, {
    message: 'allowInConversation needs approve: true',
    path: ['allowInConversation'],
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
export const SendMessageResponseSchema = z.object({
  messageId: z.string().min(1).nullable(),
});
export type SendMessageResponse = z.infer<typeof SendMessageResponseSchema>;

/** 200 of POST /threads/:threadId/interrupt and POST /agents/:agentId/interrupt; the request has no body. */
export const InterruptResponseSchema = z.object({
  outcome: z.enum(['interrupted', 'not_active']),
});
export type InterruptResponse = z.infer<typeof InterruptResponseSchema>;

/** 200 of POST /agents/:agentId/stop: the ids of the stopped agents. */
export const StopResponseSchema = z.object({
  stopped: z.array(z.string().min(1)),
});
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
export const AwaitingCountSchema = z.object({
  count: z.number().int().nonnegative(),
});
export type AwaitingCount = z.infer<typeof AwaitingCountSchema>;

// ---------------------------------------------------------------------------------------------------
// Agents

/**
 * The record a run started from, as it was at the start (design-runtime.md, «Данные для `web`»):
 * `author` is `null` for a system record, `subagent` is the subagent's name for a run of a subagent.
 * The record's live state the web reads from GET /api/library by `recordId`.
 */
export const RunOriginSchema = z.object({
  recordId: IdSchema,
  kind: RecordKindSchema,
  version: VersionSchema,
  name: z.string().min(1),
  author: z.object({ id: IdSchema, name: z.string() }).nullable(),
  builtinKey: z.string().min(1).nullable(),
  subagent: z.string().min(1).nullable(),
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
  forkedFrom: z
    .object({ agentId: z.string().min(1), throughSeq: SeqSchema })
    .nullable(),
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
const ChildEndSchema = AgentStatusSchema.extract([
  'completed',
  'failed',
  'stopped',
]);

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
  /** The code of a saved script, on a call of that script. */
  scriptCode: z.string().optional(),
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
 * The mark of a message a schedule sent (schedules KD-5): the schedule, its name at the time of sending and
 * whether the run was manual. The model never sees it.
 */
export const ScheduleMarkSchema = z.object({
  scheduleId: z.string().min(1),
  name: z.string(),
  manual: z.boolean(),
});
export type ScheduleMark = z.infer<typeof ScheduleMarkSchema>;

/**
 * One entry of an agent's history (design-agents.md, HistoryEntry) as the agents' `history` returns it:
 * a `model_answer` carries its tool calls. A `task` carries a chip only at a conversation's root: its
 * first message becomes the root's task. `schedule` marks a message a schedule sent; `null` for one typed
 * by hand.
 */
export const HistoryEntrySchema = z.discriminatedUnion('kind', [
  entry(
    'task',
    z.object({
      text: z.string(),
      record: ChipRecordSchema.nullable(),
      schedule: ScheduleMarkSchema.nullable(),
    }),
  ),
  entry(
    'user_message',
    z.object({
      text: z.string(),
      record: ChipRecordSchema.nullable(),
      schedule: ScheduleMarkSchema.nullable(),
    }),
  ),
  entry('agent_message', z.object({ text: z.string(), agentId: z.string() })),
  entry(
    'child_report',
    z.object({
      agentId: z.string(),
      description: z.string(),
      status: ChildEndSchema,
      reason: z.string().nullable(),
      text: z.string().nullable(),
      document: DocumentRefSchema.nullable(),
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
      /** A `try_script` call: the tools whose calls were recorded and not sent, in call order; absent for other tools. */
      recorded: z.array(z.string()).optional(),
      startedAt: z.iso.datetime().nullable(),
      finishedAt: z.iso.datetime().nullable(),
    }),
  ),
  entry(
    'notice',
    z.object({
      text: z.string(),
      /** The numbers of the open tasks an agent's refused answer left (MC-15); absent for other notices. */
      openTasks: z.array(z.number().int().positive()).optional(),
      /** The final subagent whose completed report a deep agent's refused answer lacked (MC-15); absent for other notices. */
      missingReport: z.string().min(1).optional(),
    }),
  ),
  entry(
    'event',
    z.object({ event: HistoryEventSchema, reason: z.string().nullable() }),
  ),
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
  AGENTS_BRIEF_CONFIRMATION,
  LIBRARY_RECORD_CONFIRMATION,
]);
export type ConfirmationKind = z.infer<typeof ConfirmationKindSchema>;

/** What a record tool's card does to the record. */
export const LibraryRecordActionSchema = z.enum(['create', 'edit', 'delete']);
export type LibraryRecordAction = z.infer<typeof LibraryRecordActionSchema>;

/** The card of one record kind: `next` and `previous` hold the content of that kind. */
function libraryRecordCardOf<K extends string, C extends z.ZodType>(
  kind: K,
  content: C,
) {
  const text = { name: z.string(), description: z.string(), content };
  return z.object({
    action: LibraryRecordActionSchema,
    /** The record; on `create` the id `review` chose for it. */
    recordId: IdSchema,
    kind: z.literal(kind),
    system: z.boolean(),
    /** The record after the change; `null` on `delete`. */
    next: z.object(text).nullable(),
    /** The saved record and the version the employee saw; `null` on `create`. */
    previous: z.object({ ...text, version: VersionSchema }).nullable(),
  });
}

/** Content of a `library.record` card (deep-agents design-agent-types.md, KD-3). */
export const LibraryRecordCardSchema = z.discriminatedUnion('kind', [
  libraryRecordCardOf(RecordKindSchema.enum.agent, AgentContentSchema),
  libraryRecordCardOf(RecordKindSchema.enum.deep_agent, DeepAgentContentSchema),
]);
export type LibraryRecordCard = z.infer<typeof LibraryRecordCardSchema>;

/**
 * Status of a confirmation: `open` while its question waits, `resolved` once answered, `cancelled`
 * once a stop ended it.
 */
export const ConfirmationStatusSchema = z.enum([
  'open',
  'resolved',
  'cancelled',
]);
export type ConfirmationStatus = z.infer<typeof ConfirmationStatusSchema>;

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
  /** The card content: the tool's confirmation content (for a brief: the deep agent and its three fields). */
  content: z.unknown(),
  status: ConfirmationStatusSchema,
  /**
   * Set when `resolved`: the decision and the arguments the call ran with; `allowInConversation` only when the
   * answer was «allow in this conversation».
   */
  resolution: z
    .object({
      approve: z.boolean(),
      args: z.unknown(),
      allowInConversation: z.literal(true).optional(),
    })
    .nullable(),
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

/** What the conversation last did to the record in focus (KD-6). */
export const RecordFocusActionSchema = z.enum([
  'read',
  'created',
  'changed',
  'deleted',
  'started',
]);
export type RecordFocusAction = z.infer<typeof RecordFocusActionSchema>;

/** The record in focus: the conversation's last successful record action. */
export const RecordFocusSchema = z.object({
  recordId: IdSchema,
  action: RecordFocusActionSchema,
  at: z.iso.datetime(),
});
export type RecordFocus = z.infer<typeof RecordFocusSchema>;

/**
 * The training an agent of a training tree belongs to (self-learning design-training.md, «Беседа обучения и
 * беседы повторов»): the trained agent, the training — the id of the tree's root — and whether this is the
 * trainer's own conversation rather than a replay. `null` outside a training tree. In a test run
 * (`testRun`) `agentId` is `null` until the agent is created and after it is deleted.
 */
export const ConversationTrainingSchema = z
  .object({
    agentId: IdSchema.nullable(),
    trainingId: IdSchema,
    isRoot: z.boolean(),
    testRun: z.boolean(),
    /** The test run's summary in its own conversation's view (create-and-test design-trainer-dialog.md, KD-9); otherwise `null`. */
    run: TestRunSummarySchema.nullable(),
  })
  .nullable();
export type ConversationTraining = z.infer<typeof ConversationTrainingSchema>;

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
  /** `null` while the chat has not touched a record. */
  focus: RecordFocusSchema.nullable(),
  training: ConversationTrainingSchema,
  /** The root's «seen through» mark at the moment of reading: the web puts the unread divider after it. */
  seenThroughSeq: SeqSchema,
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
  training: ConversationTrainingSchema,
});
export type AgentPageView = z.infer<typeof AgentPageViewSchema>;

/** GET /agents/:agentId/inherited: the fork parent's entries through `throughSeq`. */
export const InheritedHistorySchema = z.object({
  entries: z.array(HistoryEntrySchema).max(HISTORY_PAGE_SIZE),
  nextAfterSeq: NextAfterSeqSchema,
});
export type InheritedHistory = z.infer<typeof InheritedHistorySchema>;

/**
 * GET /agents/:agentId/run (deep-agents design-agent-types.md, «Маршруты»): the deep agent record the
 * run started from, its brief, the deep agent and the team of its snapshot. `steps` are the deep agent's
 * children in creation order, each with `origin.subagent`; subagents of `team` outside `steps` were not
 * called. `limitRefusals` — every `run_limit` refusal.
 */
export const DeepAgentRunViewSchema = z.object({
  origin: RunOriginSchema,
  brief: z.object({
    question: z.string().min(1),
    boundaries: z.string(),
    result: z.string(),
  }),
  deepAgent: AgentViewSchema,
  team: z.array(
    z.object({
      name: z.string().min(1),
      maxRuns: z.number().int().positive(),
      /** The subagent whose report becomes the answer. */
      final: z.boolean(),
    }),
  ),
  steps: z.array(AgentViewSchema),
  limitRefusals: z.array(
    z.object({ subagent: z.string().min(1), at: z.iso.datetime() }),
  ),
});
export type DeepAgentRunView = z.infer<typeof DeepAgentRunViewSchema>;

/**
 * One task of a session's list (Contract «`GET /api/agents/:agentId/tasks`»): its number in the session counts
 * from 1 and is never reused; `blockedBy` — the numbers of the tasks that must be completed first.
 */
export const SessionTaskViewSchema = z.object({
  id: z.number().int().positive(),
  subject: z.string().min(1),
  description: z.string().min(1),
  activeForm: z.string().min(1).nullable(),
  status: SessionTaskStatusSchema,
  owner: z.string().min(1).nullable(),
  blockedBy: z.array(z.number().int().positive()),
});
export type SessionTaskView = z.infer<typeof SessionTaskViewSchema>;

/**
 * Status of a delegation (deep-agents design-task.md, «Запись и маршрут»), not of a task of the list: `running` —
 * the subagent's runtime task is queued, running or waiting; `cancelled` — it was stopped.
 */
export const DelegationStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'cancelled',
]);
export type DelegationStatus = z.infer<typeof DelegationStatusSchema>;

/** Limits of a delegation row: the item and the answer are cut, the full ones stay in the subagent's history. */
export const DELEGATION_ITEM_MAX_CHARS = 200;
export const DELEGATION_ANSWER_MAX_CHARS = 300;

/**
 * One subagent of the agent's `task` calls: the subagent's session, its assignment (the description or the item), the
 * task of the list the `task` call named, and how it ended.
 */
export const DelegationViewSchema = z.object({
  agentId: z.string().min(1),
  subagent: z.string().min(1),
  item: z.string().max(DELEGATION_ITEM_MAX_CHARS),
  taskId: z.number().int().positive().nullable(),
  status: DelegationStatusSchema,
  answer: z.string().max(DELEGATION_ANSWER_MAX_CHARS).nullable(),
  reason: z.string().nullable(),
});
export type DelegationView = z.infer<typeof DelegationViewSchema>;

/**
 * GET /agents/:agentId/tasks: the session's tasks by number, empty for a session without a list, and the subagents
 * of its `task` calls in call order, empty for an agent that delegated nothing.
 */
export const AgentTasksViewSchema = z.object({
  tasks: z.array(SessionTaskViewSchema),
  delegations: z.array(DelegationViewSchema),
});
export type AgentTasksView = z.infer<typeof AgentTasksViewSchema>;

// ---------------------------------------------------------------------------------------------------
// Live stream

/** An event of GET /events: `type` is the SSE event name, `data` its JSON body. */
export const LiveEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready'), data: z.object({}) }),
  z.object({
    type: z.literal('tree'),
    data: z.object({ threadId: z.string().min(1) }),
  }),
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
