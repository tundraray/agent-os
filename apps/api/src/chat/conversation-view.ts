import type {
  AgentConfirmation,
  AgentHistoryEntry,
  AgentView as AgentsAgentView,
} from '@agent-os/agents';
import {
  AgentMessageKindSchema,
  CHILD_FINISHED_KIND,
  ConfirmationKindSchema,
  HISTORY_PAGE_SIZE,
  type AgentNode,
  type AgentView,
  type Confirmation,
  type HistoryEntry,
  type PendingMessage,
} from '@agent-os/contracts';
import type { StepMessage } from '@agent-os/runtime';
import type { Workflows } from '@agent-os/workflows';
import { z } from 'zod';

/**
 * The views of `agents` and `runtime` as the chat API returns them (design-chat.md, ConversationView,
 * AgentNode, Confirmation): every `Date` becomes an ISO string, and each result is a value of the
 * `contracts` schema's type without a cast. Pure functions; `ConversationsService` and the agent
 * routes share them.
 */

/** Workflow template titles by template name: a coordinator's definition name is its template's name. */
export type TemplateTitles = ReadonlyMap<string, string>;

/** One read of the template catalog per answer: it decides `template` of coordinators. */
export function templateTitles(workflows: Workflows): TemplateTitles {
  return new Map(workflows.templates.list().map((template) => [template.name, template.title]));
}

const iso = (date: Date): string => date.toISOString();
const isoOrNull = (date: Date | null): string | null => (date === null ? null : iso(date));

/** An agent; a workflow coordinator also carries its template's `name` and `title` (design v1.2, A-1). */
export function toAgentView(view: AgentsAgentView, templates: TemplateTitles): AgentView {
  const title = templates.get(view.definition);
  return {
    agentId: view.agentId,
    parentId: view.parentId,
    rootId: view.rootId,
    depth: view.depth,
    definition: view.definition,
    description: view.description,
    model: view.model,
    status: view.status,
    failureReason: view.failureReason,
    forkedFrom: view.forkedFrom === null ? null : { ...view.forkedFrom },
    createdAt: iso(view.createdAt),
    finishedAt: isoOrNull(view.finishedAt),
    ...(title === undefined ? {} : { template: { name: view.definition, title } }),
  };
}

/**
 * The subtree under `parentId` (that agent itself not included): its children with their subtrees,
 * each level in the order of `agents`, which the agents' `list` returns in creation order.
 */
export function toAgentTree(
  agents: readonly AgentsAgentView[],
  templates: TemplateTitles,
  parentId: string,
): AgentNode[] {
  const byParent = new Map<string, AgentView[]>();
  for (const view of agents.map((agent) => toAgentView(agent, templates))) {
    if (view.parentId === null) continue;
    const siblings = byParent.get(view.parentId) ?? [];
    siblings.push(view);
    byParent.set(view.parentId, siblings);
  }
  const nodesOf = (id: string): AgentNode[] =>
    (byParent.get(id) ?? []).map((view) => ({ ...view, children: nodesOf(view.agentId) }));
  return nodesOf(parentId);
}

/** A history entry as stored (KD-4); a `model_answer` keeps its tool calls. */
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

/** A decision request in any status. */
export function toConfirmation(confirmation: AgentConfirmation): Confirmation {
  return {
    decisionId: confirmation.decisionId,
    agentId: confirmation.agentId,
    description: confirmation.description,
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

/** Payloads of the queue messages of an agent (the agents package, `step/deliver.ts`). */
const TextPayloadSchema = z.object({ text: z.string() });
const InterruptPayloadSchema = z.object({ text: z.string().optional() });
const ChildFinishedPayloadSchema = z.object({
  taskId: z.string(),
  status: z.enum(['completed', 'failed', 'stopped']),
});

const { user_message: userMessage, agent_message: agentMessage, interrupt } =
  AgentMessageKindSchema.enum;

/**
 * Undelivered messages of an agent in queue order: the employee's message (an interrupt with
 * `interrupt: true`, its text empty when it has none), the parent's message, and a child's end as a
 * report with the child's description and status. Any other kind throws: an agent's queue holds only
 * these four.
 */
export function toPending(
  messages: readonly StepMessage[],
  views: readonly Pick<AgentsAgentView, 'agentId' | 'description'>[],
): PendingMessage[] {
  const descriptions = new Map(views.map((view) => [view.agentId, view.description]));
  return [...messages]
    .sort((left, right) => left.seq - right.seq)
    .map((message): PendingMessage => {
      const base = { messageId: message.messageId, createdAt: iso(message.createdAt) };
      switch (message.kind) {
        case userMessage:
        case agentMessage:
          return {
            ...base,
            source: message.kind === userMessage ? 'user' : 'parent',
            interrupt: false,
            text: TextPayloadSchema.parse(message.payload).text,
          };
        case interrupt:
          return {
            ...base,
            source: 'user',
            interrupt: true,
            text: InterruptPayloadSchema.parse(message.payload).text ?? '',
          };
        case CHILD_FINISHED_KIND: {
          const notice = ChildFinishedPayloadSchema.parse(message.payload);
          return {
            ...base,
            source: 'report',
            interrupt: false,
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
