import type { InCommitAgentTool } from '@agent-os/agents';
import type { Logger } from '@agent-os/common';
import {
  CreateRecordBodySchema,
  RecordKindSchema,
  type RecordBody,
  type ToolRefusalReason,
} from '@agent-os/contracts';
import { z } from 'zod';
import type { LibraryService } from '../library/library.service.js';
import { insertDraft } from './drafts.repository.js';

const DRAFT_RECORD_TOOL = 'draft_record';

/** The registration of `draft_record` in `ChatModule`: a marker provider whose factory does the work. */
export const DRAFT_RECORD_REGISTRATION = Symbol('DRAFT_RECORD_REGISTRATION');

/**
 * Arguments of `draft_record` (design-runtime.md, «Инструменты модели»). `content` is checked by the
 * schema of its kind in `prepare`, so a wrong one is the call's `invalid_arguments`.
 */
const DraftRecordArgsSchema = z.object({
  recordId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The id of your own record to change; omit it to propose a new record',
    ),
  kind: RecordKindSchema.describe('agent or workflow'),
  name: z.string().min(1).describe('The record name'),
  description: z
    .string()
    .min(1)
    .describe('When to use the record, one or two sentences'),
  content: z
    .record(z.string(), z.unknown())
    .describe(
      'The full definition of the record, in the form of its kind (see the tool description)',
    ),
});
export type DraftRecordArgs = z.infer<typeof DraftRecordArgsSchema>;

type DraftRefusalReason = Extract<
  ToolRefusalReason,
  'invalid_arguments' | 'record_unavailable' | 'read_only' | 'shared'
>;

/** What `prepare` hands `execute`: the checked proposal, or why the call is refused. */
export type PreparedDraft =
  | { readonly kind: 'refused'; readonly reason: DraftRefusalReason }
  | {
      readonly kind: 'ready';
      readonly target: { readonly id: string; readonly version: number } | null;
      readonly name: string;
      readonly description: string;
      readonly body: RecordBody;
    };

const DESCRIPTION = [
  'Propose a library record (an agent or a workflow) to the employee as a draft card. Nothing is saved',
  'until the employee presses «Сохранить» on the card; a newer draft replaces a waiting one. To change',
  'one of the employee’s own records, pass its id in recordId and the whole new definition.',
  'content of an agent: { prompt, servers (MCP server names or "*"), model, maxTurns, agents (ids of',
  'agent records it may start), tools (any of start_agent, message_agent, list_agents, stop_agent) }.',
  'content of a workflow: { coordinator: { rules, model, maxTurns }, executors: [{ name, role, prompt,',
  'servers, model, maxTurns, maxRuns, tools, source: null }], finalExecutor (an executor name or null) }.',
  'The call cannot change who sees a record: sharing is done with the record’s «Поделиться» button.',
].join('\n');

export interface DraftRecordToolOptions {
  readonly library: Pick<LibraryService, 'resolve'>;
  readonly logger: Logger;
}

/**
 * `draft_record` (design-runtime.md, KD-6, Flow 3): a root-only tool without a decision. `prepare`
 * checks the content by its kind and, for an edit, the record through `resolve` on behalf of the
 * caller — a system or another's record is `read_only`, a record with holders is `shared` — before the
 * commit; `execute` writes the draft in the step's transaction into the root's conversation, which
 * supersedes the waiting one, and answers with the draft's id. A refused call writes no draft; no
 * library record is created here, only by the employee's save (`DraftsService`).
 */
export function createDraftRecordTool(
  options: DraftRecordToolOptions,
): InCommitAgentTool<DraftRecordArgs, PreparedDraft> {
  const { library } = options;
  const logger = options.logger.child({ service: 'chat.drafts' });

  async function prepare(
    args: DraftRecordArgs,
    ownerId: string,
  ): Promise<PreparedDraft> {
    const parsed = CreateRecordBodySchema.safeParse({
      kind: args.kind,
      name: args.name,
      description: args.description,
      content: args.content,
    });
    if (!parsed.success)
      return { kind: 'refused', reason: 'invalid_arguments' };
    const { data } = parsed;
    const body: RecordBody =
      data.kind === 'agent'
        ? { kind: 'agent', content: data.content }
        : { kind: 'workflow', content: data.content };
    let target: { id: string; version: number } | null = null;
    if (args.recordId !== undefined) {
      const record = await library.resolve(ownerId, args.recordId);
      if (record === null)
        return { kind: 'refused', reason: 'record_unavailable' };
      if (!record.mine) return { kind: 'refused', reason: 'read_only' };
      if (record.shared) return { kind: 'refused', reason: 'shared' };
      // A record never changes kind.
      if (record.kind !== body.kind)
        return { kind: 'refused', reason: 'invalid_arguments' };
      target = { id: record.id, version: record.version };
    }
    return {
      kind: 'ready',
      target,
      name: data.name,
      description: data.description,
      body,
    };
  }

  return {
    name: DRAFT_RECORD_TOOL,
    title: 'Черновик записи',
    argLabels: {
      recordId: 'Запись',
      kind: 'Вид',
      name: 'Имя',
      description: 'Описание',
    },
    description: DESCRIPTION,
    argsSchema: DraftRecordArgsSchema,
    mode: 'in_commit',
    rootOnly: true,
    // The record's content holds its prompt: only what names the draft goes to the log.
    loggedArgs: ({ recordId, kind, name }) => ({ recordId, kind, name }),
    prepare: ({ args, caller }) => prepare(args, caller.ownerId),
    async execute({ args, caller, callId, tx, prepared }) {
      if (prepared === undefined) {
        throw new Error(
          `draft_record of agent ${caller.agentId} runs without its prepare`,
        );
      }
      const fields = {
        ownerId: caller.ownerId,
        agentId: caller.agentId,
        callId,
        recordId: args.recordId ?? null,
        action: 'draft',
      };
      if (prepared.kind === 'refused') {
        logger.info('record draft refused', {
          ...fields,
          outcome: prepared.reason,
        });
        return { kind: 'refused', reason: prepared.reason };
      }
      const draft = await insertDraft(tx, {
        rootId: caller.rootId,
        ownerId: caller.ownerId,
        callId,
        target: prepared.target,
        name: prepared.name,
        description: prepared.description,
        body: prepared.body,
      });
      if (draft === undefined) {
        throw new Error(
          `Root ${caller.rootId} of draft_record has no conversation of its owner`,
        );
      }
      logger.info('record draft written', {
        ...fields,
        threadId: draft.conversationId,
        draftId: draft.id,
        outcome: 'drafted',
      });
      return {
        kind: 'done',
        outcome: 'success',
        text: `Draft ${draft.id} of the ${draft.body.kind} "${draft.name}" is shown to the employee as a card. The record is saved only when the employee presses «Сохранить»; until then nothing in the library changes.`,
      };
    },
  };
}
