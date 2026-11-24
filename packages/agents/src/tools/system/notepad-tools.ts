import type { Logger } from '@agent-os/common';
import {
  DocumentRefSchema,
  NOTEPAD_APPEND_TOOL,
  NOTEPAD_CREATE_TOOL,
  NOTEPAD_LIST_TOOL,
  NOTEPAD_PAST_TOOL,
  NOTEPAD_READ_TOOL,
  NOTEPAD_REPLACE_TOOL,
} from '@agent-os/contracts';
import type { DocumentsRepository, SettingsRepository } from '@agent-os/db';
import { z } from 'zod';

import { descriptionLine } from '../../chat-listing';
import { linesOf, pageOf } from '../large-result';
import type { InCommitAgentTool, ToolCaller, ToolRunResult } from '../tool';
import { readToolResultSettings } from '../tool-result-settings';
import { type DocumentEdit, editDocument } from './notepad-rules';

/** The most past documents `notepad_past` lists (KD-6). */
const PAST_DOCUMENTS_MAX = 30;

const documentNumber = DocumentRefSchema.shape.id.describe(
  'The number of the document',
);

const CreateArgsSchema = z.object({
  title: z
    .string()
    .overwrite(descriptionLine)
    .min(1)
    .max(200)
    .describe('A short title of the document'),
  description: z
    .string()
    .overwrite(descriptionLine)
    .min(1)
    .max(300)
    .describe('One line saying what the document holds, shown in lists'),
  text: z
    .string()
    .describe('The first part of the text, Markdown; may be empty'),
  report: z
    .boolean()
    .default(false)
    .describe('true — the document is the full result for the employee'),
});
type CreateArgs = z.infer<typeof CreateArgsSchema>;

const AppendArgsSchema = z.object({
  document: documentNumber,
  text: z.string().describe('The text to add to the end of the document'),
});
type AppendArgs = z.infer<typeof AppendArgsSchema>;

const ReplaceArgsSchema = z.object({
  document: documentNumber,
  old: z
    .string()
    .min(1)
    .describe(
      'A fragment copied exactly from the document; it must occur exactly once',
    ),
  new: z.string().describe('The text that replaces the fragment; may be empty'),
});
type ReplaceArgs = z.infer<typeof ReplaceArgsSchema>;

const ReadArgsSchema = z.object({
  document: documentNumber,
  offset: z
    .number()
    .int()
    .min(1)
    .default(1)
    .describe(
      'The first line to read, 1 = the first line. A page names the offset of the next one.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      'At most this many lines. Without it, as many lines as one page holds.',
    ),
});
type ReadArgs = z.infer<typeof ReadArgsSchema>;

const NoArgsSchema = z.object({});
type NoArgs = z.infer<typeof NoArgsSchema>;

const CREATE_DESCRIPTION = [
  'Create a document in the notepad of this run, which you share with the deep agent and its subagents.',
  'One answer cannot hold a long text: write a large document in parts, notepad_create with the first part, then notepad_append.',
  'The full result for the employee is a document with report true.',
  'The answer gives the number and the size of the document, never its text.',
].join(' ');

const APPEND_DESCRIPTION =
  'Add text to the end of a document of this run by its number. The answer gives the new size, never the text.';

const REPLACE_DESCRIPTION =
  'Replace a fragment of a document of this run by its number: old is copied exactly from the document and occurs ' +
  'exactly once, new replaces it. The answer gives the new size, never the text.';

const READ_DESCRIPTION =
  'Read a page of a document by its number: lines from offset (1 = first), at most limit lines and one page of a ' +
  'bounded size. Reads the documents of this run and the past documents notepad_past lists.';

const LIST_DESCRIPTION =
  'List the documents of this run in the order of creation: number, title, description, report mark, who wrote ' +
  'last and size.';

const PAST_DESCRIPTION = `List up to ${PAST_DOCUMENTS_MAX} documents of your earlier runs for this employee, most recently changed first; read one with notepad_read.`;

/**
 * The run whose notepad the caller works in (KD-3): the deep agent itself, or the deep agent that started the
 * subagent. Only from the caller, never from the arguments.
 */
function runOf(caller: ToolCaller): string {
  if (caller.run.subagent === null) return caller.agentId;
  if (caller.parentId === null)
    throw new Error(
      `Subagent ${caller.agentId} has no parent deep agent to keep a notepad`,
    );
  return caller.parentId;
}

/** The log fields of a call's arguments, as the model wrote them: the number, the title and lengths, never texts. */
function loggedNotepadArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const lengthOf = (value: unknown) =>
    typeof value === 'string' ? value.length : null;
  return {
    document: typeof args.document === 'number' ? args.document : null,
    title: typeof args.title === 'string' ? args.title : null,
    textLength: lengthOf(args.text),
    oldLength: lengthOf(args.old),
    newLength: lengthOf(args.new),
  };
}

function refused(text: string): ToolRunResult {
  return { kind: 'refused', reason: 'invalid_arguments', text };
}

function notFound(document: number): ToolRunResult {
  return refused(`There is no document ${document}.`);
}

/** The answer of a tool of one document: its number and title first (the web reads the title from it). */
function documentHeader(document: { id: number; title: string }): string {
  return `Document ${document.id}: ${document.title}`;
}

function written(
  document: { id: number; title: string },
  text: string,
): ToolRunResult {
  return {
    kind: 'done',
    outcome: 'success',
    text: `${documentHeader(document)}\nSize: ${text.length} characters, ${linesOf(text).length} lines`,
  };
}

/**
 * The six notepad tools (design-notepad.md KD-2, KD-3, KD-5, KD-6; Contract «Инструменты блокнота»). Each runs
 * in the step's commit, so a document changes with the call's `tool_result` or not at all. The run comes from
 * the caller; a document number of the arguments is looked up only in that run's notepad or under the KD-6 rule
 * of past documents. A write lands only when the document is unchanged since the tool read it.
 */
export function createNotepadTools(deps: {
  readonly documentRows: DocumentsRepository;
  readonly settingsRows: Pick<SettingsRepository, 'read'>;
  readonly logger: Logger;
}): [
  InCommitAgentTool<CreateArgs>,
  InCommitAgentTool<AppendArgs>,
  InCommitAgentTool<ReplaceArgs>,
  InCommitAgentTool<ReadArgs>,
  InCommitAgentTool<NoArgs>,
  InCommitAgentTool<NoArgs>,
] {
  const logger = deps.logger.child({ service: 'agents.notepad' });
  const { documentRows, settingsRows } = deps;

  /** A notepad tool: its call runs on the caller's run and is logged with its ids, arguments and outcome. */
  function notepadTool<Args extends Record<string, unknown>>(tool: {
    readonly name: string;
    readonly description: string;
    readonly argsSchema: z.ZodType<Args>;
    run(args: Args, runId: string, caller: ToolCaller): Promise<ToolRunResult>;
  }): InCommitAgentTool<Args> {
    return {
      name: tool.name,
      description: tool.description,
      argsSchema: tool.argsSchema,
      mode: 'in_commit',
      loggedArgs: loggedNotepadArgs,
      async execute({ args, caller, callId }) {
        const runId = runOf(caller);
        const result = await tool.run(args, runId, caller);
        logger.info('notepad call', {
          tool: tool.name,
          runId,
          taskId: caller.agentId,
          rootId: caller.rootId,
          ownerId: caller.ownerId,
          callId,
          ...loggedNotepadArgs(args),
          outcome: result.kind === 'done' ? result.outcome : result.reason,
        });
        return result;
      },
    };
  }

  /** Reads the run's document, applies the edit and writes it over the version it read. */
  async function edit(
    document: number,
    change: DocumentEdit,
    runId: string,
    caller: ToolCaller,
  ): Promise<ToolRunResult> {
    const row = await documentRows.findInRun(runId, document);
    if (row === undefined) return notFound(document);
    const decision = editDocument(row.text, change);
    if (decision.kind === 'refused') return refused(decision.text);
    const updated = await documentRows.updateText(
      row.id,
      row.updatedAt,
      decision.text,
      caller.agentId,
    );
    if (!updated)
      return refused(
        `Document ${document} changed in a parallel step since it was read; repeat the change.`,
      );
    return written(row, decision.text);
  }

  const create = notepadTool({
    name: NOTEPAD_CREATE_TOOL,
    description: CREATE_DESCRIPTION,
    argsSchema: CreateArgsSchema,
    async run(args, runId, caller) {
      const decision = editDocument('', { kind: 'append', text: args.text });
      if (decision.kind === 'refused') return refused(decision.text);
      const row = await documentRows.create({
        conversationId: runId,
        title: args.title,
        description: args.description,
        text: decision.text,
        report: args.report,
        updatedBy: caller.agentId,
      });
      return written(row, row.text);
    },
  });

  const append = notepadTool({
    name: NOTEPAD_APPEND_TOOL,
    description: APPEND_DESCRIPTION,
    argsSchema: AppendArgsSchema,
    run: (args, runId, caller) =>
      edit(args.document, { kind: 'append', text: args.text }, runId, caller),
  });

  const replace = notepadTool({
    name: NOTEPAD_REPLACE_TOOL,
    description: REPLACE_DESCRIPTION,
    argsSchema: ReplaceArgsSchema,
    run: (args, runId, caller) =>
      edit(
        args.document,
        { kind: 'replace', old: args.old, new: args.new },
        runId,
        caller,
      ),
  });

  const read = notepadTool({
    name: NOTEPAD_READ_TOOL,
    description: READ_DESCRIPTION,
    argsSchema: ReadArgsSchema,
    async run(args, runId, caller) {
      // Past documents are the deep agent's only (KD-3).
      const row =
        (await documentRows.findInRun(runId, args.document)) ??
        (caller.run.subagent === null
          ? await documentRows.findPast(
              { runId, ownerId: caller.ownerId },
              args.document,
            )
          : undefined);
      if (row === undefined) return notFound(args.document);
      const settings = await readToolResultSettings(settingsRows);
      const page = pageOf(row.text, {
        offset: args.offset,
        ...(args.limit === undefined ? {} : { limit: args.limit }),
        maxTokens: settings.readMaxTokens,
      });
      if (page.kind === 'past_end')
        return refused(
          `Offset ${args.offset} is past the last line ${page.total} of document ${args.document}.`,
        );
      return {
        kind: 'done',
        outcome: 'success',
        text: `${documentHeader(row)}\n${page.text}`,
      };
    },
  });

  const list = notepadTool({
    name: NOTEPAD_LIST_TOOL,
    description: LIST_DESCRIPTION,
    argsSchema: NoArgsSchema,
    async run(_args, runId) {
      const rows = await documentRows.listRun(runId);
      if (rows.length === 0)
        return { kind: 'done', outcome: 'empty', text: 'The notepad is empty' };
      const text = rows
        .map(
          (row) =>
            `${row.id}. ${row.title}${row.report ? ' [report]' : ''} — ${row.description} (last written by ${row.writer}, ${row.chars} characters)`,
        )
        .join('\n');
      return { kind: 'done', outcome: 'success', text };
    },
  });

  const past = notepadTool({
    name: NOTEPAD_PAST_TOOL,
    description: PAST_DESCRIPTION,
    argsSchema: NoArgsSchema,
    async run(_args, runId, caller) {
      const rows = await documentRows.past(
        { runId, ownerId: caller.ownerId },
        PAST_DOCUMENTS_MAX,
      );
      if (rows.length === 0)
        return {
          kind: 'done',
          outcome: 'empty',
          text: 'There are no past documents; a temporary deep agent never has any.',
        };
      const text = rows
        .map(
          (row) =>
            `${row.id}. ${row.title} — ${row.description} (changed ${row.updatedAt.toISOString()})`,
        )
        .join('\n');
      return { kind: 'done', outcome: 'success', text };
    },
  });

  return [create, append, replace, read, list, past];
}
