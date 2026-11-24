import type { ScriptedModel, ScriptedToolCall } from '@agent-os/agents/testing';
import {
  AGENTS_BRIEF_CONFIRMATION,
  LIBRARY_RECORD_CONFIRMATION,
  LibraryRecordCardSchema,
  type AgentNode,
  type Confirmation,
  type ConversationView,
  type CreateRecordBody,
  type HistoryEntry,
  type LibraryRecordCard,
  type RecordBody,
  type RecordDetail,
} from '@agent-os/contracts';
import { waitFor } from '@agent-os/db/testing';
import type { ChatApi } from './api';

/**
 * The record tools of the main chat as the tests script and read them (deep-agents design-agent-types.md,
 * «Инструменты записей»): the scripted call of a tool, the arguments of a create or an edit built from a
 * record body, the open `library.record` request of a conversation and the results of the root's calls.
 */

export type RecordTool =
  | 'list_records'
  | 'read_record'
  | 'create_record'
  | 'edit_record'
  | 'delete_record';

/** A scripted call of a record tool. */
export function recordToolCall(
  tool: RecordTool,
  args: Readonly<Record<string, unknown>> = {},
): ScriptedToolCall {
  return { tool, args };
}

/** The content as the chat sends it: the whole record of its kind without `selfLearning` and `scripts`. */
function chatContent(body: RecordBody): Record<string, unknown> {
  if (body.kind === 'agent') return { ...body.content };
  const {
    selfLearning: _selfLearning,
    scripts: _scripts,
    ...content
  } = body.content;
  return content;
}

/** The arguments of `create_record` for a record body; `system` only when given. */
export function createArgs(
  body: CreateRecordBody,
  system?: boolean,
): Record<string, unknown> {
  return {
    kind: body.kind,
    name: body.name,
    description: body.description,
    content: chatContent(body),
    ...(system === undefined ? {} : { system }),
  };
}

/** The arguments of `edit_record` that send `record` back whole, with `prompt` of the record itself changed when given. */
export function editArgs(
  record: RecordDetail,
  change: { readonly prompt?: string } = {},
): Record<string, unknown> {
  const content = chatContent(record);
  return {
    recordId: record.id,
    kind: record.kind,
    name: record.name,
    description: record.description,
    content:
      change.prompt === undefined
        ? content
        : { ...content, prompt: change.prompt },
  };
}

/** The open `library.record` request of the conversation with its card, or `undefined`. */
export function pendingCardOf(
  view: ConversationView,
):
  | { readonly decision: Confirmation; readonly card: LibraryRecordCard }
  | undefined {
  const decision = view.decisions.find(
    (candidate) =>
      candidate.kind === LIBRARY_RECORD_CONFIRMATION &&
      candidate.status === 'open',
  );
  return decision === undefined
    ? undefined
    : { decision, card: LibraryRecordCardSchema.parse(decision.content) };
}

/** The `library.record` requests of the conversation in any status. */
export function recordCardsOf(view: ConversationView): Confirmation[] {
  return view.decisions.filter(
    (decision) => decision.kind === LIBRARY_RECORD_CONFIRMATION,
  );
}

export type ToolResult = Extract<
  HistoryEntry,
  { kind: 'tool_result' }
>['content'];

/** The results of the root's calls of `tool`, in order. */
export function toolResultsOf(
  view: ConversationView,
  tool: string,
): ToolResult[] {
  return view.entries.flatMap((entry) =>
    entry.kind === 'tool_result' && entry.content.tool === tool
      ? [entry.content]
      : [],
  );
}

/** Every agent of a conversation's tree, the tree flattened. */
export function treeOf(nodes: readonly AgentNode[]): AgentNode[] {
  return nodes.flatMap((node) => [node, ...treeOf(node.children)]);
}

/** The brief as `start_deep_agent` writes it into the deep agent's first task: the key of its script. */
export function briefTask(question: string): string {
  return JSON.stringify({ question, boundaries: '', result: '' });
}

/**
 * Runs the deep agent `record` from a new conversation of `api`: its chat, scripted by `chatTask`, calls
 * `start_deep_agent` with `question` and then answers «Принято.»; the brief is approved. Returns the
 * conversation and the deep agent once it exists; the deep agent's own script is the test's.
 */
export async function startDeepAgentInChat(
  model: ScriptedModel,
  api: ChatApi,
  run: {
    readonly record: { readonly id: string; readonly name: string };
    readonly question: string;
    readonly chatTask: string;
  },
): Promise<{ readonly threadId: string; readonly deepAgentId: string }> {
  model.script(
    { task: run.chatTask },
    [
      {
        calls: [
          {
            tool: 'start_deep_agent',
            args: {
              deepAgent: run.record.name,
              question: run.question,
              boundaries: '',
              result: '',
            },
          },
        ],
      },
    ],
    { thereafter: { text: 'Принято.' } },
  );
  const { id: threadId } = await api.createThread();
  await api.send(threadId, run.chatTask);
  const waiting = await waitFor(
    () => api.history(threadId),
    (view) =>
      view.decisions.some(
        (decision) =>
          decision.kind === AGENTS_BRIEF_CONFIRMATION &&
          decision.status === 'open',
      ),
    `the brief of ${run.record.name}`,
  );
  const brief = waiting.decisions.find(
    (decision) => decision.kind === AGENTS_BRIEF_CONFIRMATION,
  );
  if (brief === undefined) throw new Error('no brief');
  await api.decide(brief.decisionId, { approve: true });
  const running = await waitFor(
    () => api.history(threadId),
    (view) =>
      treeOf(view.agents).some(
        (agent) => agent.origin?.recordId === run.record.id,
      ),
    `the deep agent ${run.record.name}`,
  );
  const deepAgent = treeOf(running.agents).find(
    (agent) =>
      agent.origin?.recordId === run.record.id &&
      agent.origin.subagent === null,
  );
  if (deepAgent === undefined) throw new Error('no deep agent');
  return { threadId, deepAgentId: deepAgent.agentId };
}

/** Waits until the agent of the conversation has `status` and returns the conversation. */
export function untilAgentStatus(
  api: ChatApi,
  threadId: string,
  agentId: string,
  status: AgentNode['status'],
): Promise<ConversationView> {
  return waitFor(
    () => api.history(threadId),
    (view) =>
      treeOf(view.agents).some(
        (agent) => agent.agentId === agentId && agent.status === status,
      ),
    `agent ${agentId} to be ${status}`,
  );
}
