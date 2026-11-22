import type {
  AgentConfirmation,
  AgentHistoryEntry,
  AgentView as AgentsAgentView,
  DeepAgentRun,
} from '@agent-os/agents';
import {
  AGENTS_BRIEF_CONFIRMATION,
  AgentMessageKindSchema,
  CHILD_FINISHED_KIND,
  ConfirmationKindSchema,
  HISTORY_PAGE_SIZE,
  IdSchema,
  LIBRARY_RECORD_CONFIRMATION,
  type AgentNode,
  type AgentView,
  type Confirmation,
  type DeepAgentRunView,
  type HistoryEntry,
  type PendingMessage,
  type RecordFocus,
  type RecordFocusAction,
  type RunOrigin,
} from '@agent-os/contracts';
import type { StepMessage } from '@agent-os/runtime';
import { z } from 'zod';
import {
  CREATE_RECORD_TOOL,
  DELETE_RECORD_TOOL,
  EDIT_RECORD_TOOL,
  READ_RECORD_TOOL,
} from '../library/record-tools';

/**
 * The views of `agents` and `runtime` as the chat API returns them (design-chat.md,
 * ConversationView, AgentNode, Confirmation; design-runtime.md, «Данные для `web`»): every `Date`
 * becomes an ISO string, and each result is a value of the `contracts` schema's type without a cast.
 * Pure functions; `ConversationsService` and the agent routes share them.
 */

const iso = (date: Date): string => date.toISOString();
const isoOrNull = (date: Date | null): string | null => (date === null ? null : iso(date));

/**
 * The record a run started from, field by field: an origin read from a snapshot may carry more than
 * the contract (such as the author's `disabled`), and none of it reaches the web.
 */
function toRunOrigin(origin: RunOrigin): RunOrigin {
  return {
    recordId: origin.recordId,
    kind: origin.kind,
    version: origin.version,
    name: origin.name,
    author: origin.author === null ? null : { id: origin.author.id, name: origin.author.name },
    builtinKey: origin.builtinKey,
    subagent: origin.subagent,
  };
}

/** An agent with the run's name, the record it started from (`null` at a root) and its first-run mark. */
export function toAgentView(view: AgentsAgentView): AgentView {
  return {
    agentId: view.agentId,
    parentId: view.parentId,
    rootId: view.rootId,
    depth: view.depth,
    name: view.name,
    origin: view.origin === null ? null : toRunOrigin(view.origin),
    firstRun: view.firstRun,
    description: view.description,
    model: view.model,
    status: view.status,
    failureReason: view.failureReason,
    forkedFrom: view.forkedFrom === null ? null : { ...view.forkedFrom },
    createdAt: iso(view.createdAt),
    finishedAt: isoOrNull(view.finishedAt),
  };
}

/**
 * The subtree under `parentId` (that agent itself not included): its children with their subtrees,
 * each level in the order of `agents`, which the agents' `list` returns in creation order.
 */
export function toAgentTree(agents: readonly AgentsAgentView[], parentId: string): AgentNode[] {
  const byParent = new Map<string, AgentView[]>();
  for (const view of agents.map(toAgentView)) {
    if (view.parentId === null) continue;
    const siblings = byParent.get(view.parentId) ?? [];
    siblings.push(view);
    byParent.set(view.parentId, siblings);
  }
  const nodesOf = (id: string): AgentNode[] =>
    (byParent.get(id) ?? []).map((view) => ({ ...view, children: nodesOf(view.agentId) }));
  return nodesOf(parentId);
}

/**
 * A history entry as stored (KD-4); a `model_answer` keeps its tool calls. The chip of a `task` or a
 * `user_message` and the `refusalDetail` of a `tool_result` pass as stored.
 */
export function toHistoryEntry(entry: AgentHistoryEntry): HistoryEntry {
  const createdAt = iso(entry.createdAt);
  switch (entry.kind) {
    case 'model_answer':
      return {
        seq: entry.seq,
        kind: entry.kind,
        createdAt,
        content: {
          text: entry.content.text,
          toolCalls: entry.content.toolCalls.map((call) => ({ ...call })),
        },
      };
    default:
      return { ...entry, createdAt };
  }
}

/** The next `afterSeq` of a history page: the last seq of a full page, `null` when everything is read. */
export const nextAfterSeqOf = (entries: readonly AgentHistoryEntry[]): number | null =>
  entries.length === HISTORY_PAGE_SIZE ? (entries.at(-1)?.seq ?? null) : null;

/**
 * A decision request in any status, with the record the asking agent started from: `views` are the
 * agents of its tree; the root, and an agent not among them, has none.
 */
export function toConfirmation(
  confirmation: AgentConfirmation,
  views: readonly Pick<AgentsAgentView, 'agentId' | 'origin'>[],
): Confirmation {
  const origin = views.find((view) => view.agentId === confirmation.agentId)?.origin ?? null;
  return {
    decisionId: confirmation.decisionId,
    agentId: confirmation.agentId,
    description: confirmation.description,
    origin: origin === null ? null : toRunOrigin(origin),
    kind: ConfirmationKindSchema.parse(confirmation.kind),
    tool: confirmation.tool,
    server: confirmation.server,
    args: confirmation.args,
    content: confirmation.content,
    status: confirmation.status,
    resolution:
      confirmation.resolution === null
        ? null
        : { approve: confirmation.resolution.approve, args: confirmation.resolution.args },
    createdAt: iso(confirmation.createdAt),
    resolvedAt: isoOrNull(confirmation.resolvedAt),
    ...(confirmation.toolTitle === undefined ? {} : { toolTitle: confirmation.toolTitle }),
    ...(confirmation.argLabels === undefined ? {} : { argLabels: confirmation.argLabels }),
  };
}

/**
 * A deep agent run (`GET /agents/:agentId/run`): the deep agent and the steps as agents, every date ISO.
 */
export function toDeepAgentRunView(run: DeepAgentRun): DeepAgentRunView {
  return {
    origin: toRunOrigin(run.origin),
    brief: { question: run.brief.question, boundaries: run.brief.boundaries, result: run.brief.result },
    deepAgent: toAgentView(run.deepAgent),
    team: run.team.map((member) => ({
      name: member.name,
      maxRuns: member.maxRuns,
      final: member.final,
    })),
    steps: run.steps.map(toAgentView),
    limitRefusals: run.limitRefusals.map(({ subagent, at }) => ({ subagent, at: iso(at) })),
  };
}

/** The focus action of a record tool that names its record in `recordId`. */
const RECORD_ID_ACTIONS: Readonly<Record<string, RecordFocusAction>> = {
  [READ_RECORD_TOOL]: 'read',
  [EDIT_RECORD_TOOL]: 'changed',
  [DELETE_RECORD_TOOL]: 'deleted',
};

const RecordIdArgsSchema = z.object({ recordId: IdSchema });
const DeepAgentArgsSchema = z.object({ deepAgent: IdSchema });

type ToolResultEntry = Extract<HistoryEntry, { kind: 'tool_result' }>;

/**
 * The record of a successful root call and what the call did to it: a record tool names it in its
 * arguments; a create in the card the employee approved (the id `review` chose, KD-3) — the root runs
 * one call at a time, so it is the last approved `create_record` request resolved before the result; a
 * brief start in `deepAgent`, the tool being the one of the root's `agents.brief` requests. `undefined` —
 * the call is not about a record.
 */
function focusTargetOf(
  result: ToolResultEntry,
  confirmations: readonly Confirmation[],
): { readonly recordId: string; readonly action: RecordFocusAction } | undefined {
  const { tool, args: callArgs } = result.content;
  const byId = RECORD_ID_ACTIONS[tool];
  if (byId !== undefined) {
    const args = RecordIdArgsSchema.safeParse(callArgs);
    return args.success ? { recordId: args.data.recordId, action: byId } : undefined;
  }
  if (tool === CREATE_RECORD_TOOL) {
    const card = confirmations.findLast(
      (confirmation) =>
        confirmation.kind === LIBRARY_RECORD_CONFIRMATION &&
        confirmation.tool === CREATE_RECORD_TOOL &&
        confirmation.resolution?.approve === true &&
        confirmation.resolvedAt !== null &&
        confirmation.resolvedAt <= result.createdAt,
    );
    const content = RecordIdArgsSchema.safeParse(card?.content);
    return content.success ? { recordId: content.data.recordId, action: 'created' } : undefined;
  }
  const startsDeepAgent = confirmations.some(
    (confirmation) => confirmation.kind === AGENTS_BRIEF_CONFIRMATION && confirmation.tool === tool,
  );
  if (!startsDeepAgent) return undefined;
  const args = DeepAgentArgsSchema.safeParse(callArgs);
  return args.success ? { recordId: args.data.deepAgent, action: 'started' } : undefined;
}

/**
 * The record in focus of a conversation (deep-agents KD-6): the last successful call of the root about a
 * record — read, created, changed, deleted, or started by a brief — with the time it finished; `null`
 * while the chat has not touched a record. `entries` are the root's whole history, `confirmations` its
 * decision requests.
 */
export function focusOf(
  entries: readonly HistoryEntry[],
  confirmations: readonly Confirmation[],
): RecordFocus | null {
  for (const entry of [...entries].reverse()) {
    if (entry.kind !== 'tool_result' || entry.content.outcome !== 'success') continue;
    const target = focusTargetOf(entry, confirmations);
    if (target !== undefined)
      return { ...target, at: entry.content.finishedAt ?? entry.createdAt };
  }
  return null;
}

/** Payloads of the queue messages of an agent (the agents package, `agent/deliver.ts`). */
const TextPayloadSchema = z.object({ text: z.string() });
const ChildFinishedPayloadSchema = z.object({
  taskId: z.string(),
  status: z.enum(['completed', 'failed', 'stopped']),
});

const { user_message: userMessage, agent_message: agentMessage, interrupt } =
  AgentMessageKindSchema.enum;

/**
 * Undelivered messages of an agent in queue order: the employee's message, the parent's message, and
 * a child's end as a report with the child's description and status. An `interrupt` is left out: it
 * carries nothing to show, the agent's status already reads «Прерван». Any other kind throws: an
 * agent's queue holds only these four.
 */
export function toPending(
  messages: readonly StepMessage[],
  views: readonly Pick<AgentsAgentView, 'agentId' | 'description'>[],
): PendingMessage[] {
  const descriptions = new Map(views.map((view) => [view.agentId, view.description]));
  return messages
    .filter((message) => message.kind !== interrupt)
    .sort((left, right) => left.seq - right.seq)
    .map((message): PendingMessage => {
      const base = { messageId: message.messageId, createdAt: iso(message.createdAt) };
      switch (message.kind) {
        case userMessage:
        case agentMessage:
          return {
            ...base,
            source: message.kind === userMessage ? 'user' : 'parent',
            text: TextPayloadSchema.parse(message.payload).text,
          };
        case CHILD_FINISHED_KIND: {
          const notice = ChildFinishedPayloadSchema.parse(message.payload);
          return {
            ...base,
            source: 'report',
            // A child may end before its session is written: the report has no description then.
            agentDescription: descriptions.get(notice.taskId) ?? '',
            status: notice.status,
          };
        }
        default:
          throw new Error(`Unknown message kind "${message.kind}" in the queue of an agent`);
      }
    });
}
