import type { ScriptedToolCall } from '@agent-os/agents/testing';
import {
  LIBRARY_RECORD_CONFIRMATION,
  LibraryRecordCardSchema,
  type Confirmation,
  type ConversationView,
  type CreateRecordBody,
  type HistoryEntry,
  type LibraryRecordCard,
  type RecordBody,
  type RecordDetail,
} from '@agent-os/contracts';

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

/** The content as the chat sends it: the whole record of its kind without `selfLearning`. */
function chatContent(body: RecordBody): Record<string, unknown> {
  if (body.kind === 'agent') return { ...body.content };
  const { selfLearning: _selfLearning, ...content } = body.content;
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
