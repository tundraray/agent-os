import type { AgentToolResultsRepository } from '@agent-os/db';
import { z } from 'zod';

import { pageOf, RESULT_NOT_FOUND, searchOf } from '../large-result';
import type { OutsideAgentTool, ToolCaller, ToolRunResult } from '../tool';

const ReadToolResultArgsSchema = z.object({
  callId: z.string().min(1).describe('The callId the stored result names.'),
  offset: z
    .number()
    .int()
    .min(1)
    .default(1)
    .describe('The first line to read: a whole number, 1 = the first line. A page names the offset of the next one.'),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('At most this many lines: a whole number from 1. Without it, as many lines as one page holds.'),
});
type ReadToolResultArgs = z.infer<typeof ReadToolResultArgsSchema>;

/** The longest text `search_tool_result` looks for. */
const PATTERN_MAX_CHARS = 200;

const SearchToolResultArgsSchema = z.object({
  callId: z.string().min(1).describe('The callId the stored result names.'),
  pattern: z
    .string()
    .min(1)
    .max(PATTERN_MAX_CHARS)
    .describe(`The text to find: 1 to ${PATTERN_MAX_CHARS} characters, case-insensitive, not a regular expression.`),
});
type SearchToolResultArgs = z.infer<typeof SearchToolResultArgsSchema>;

const READ_DESCRIPTION =
  'Reads a part of a stored tool result by its callId: lines from offset (1 = first), at most limit lines and at most ' +
  'one page of a bounded size. The answer starts with a line that says which lines you got and where the next page ' +
  'starts. Use it when a tool result came to you as a stored result; for a summary or an analysis read every page, ' +
  'or say which lines you read.';

const SEARCH_DESCRIPTION =
  'Finds the lines of a stored tool result that contain a text (case-insensitive) and returns them with their line ' +
  'numbers; read around a line with read_tool_result. Use it when a tool result came to you as a stored result.';

function notFound(): ToolRunResult {
  return { kind: 'done', outcome: 'tool_error', text: RESULT_NOT_FOUND };
}

export interface ToolResultToolsDeps {
  /** The stored results and the settings row are read from it on every call. */
  readonly toolResultRows: AgentToolResultsRepository;
}

/**
 * `read_tool_result` and `search_tool_result` (tool-result-reading R-2): in every session, without a grant.
 * Both read only through `AgentToolResultsRepository.findForRun` with the caller's session and owner, so a result of another
 * session or owner answers exactly as a missing one. Their own answers are never stored: only the direct MCP
 * path of the runner stores a result.
 */
export function createToolResultTools(
  deps: ToolResultToolsDeps,
): [OutsideAgentTool<ReadToolResultArgs>, OutsideAgentTool<SearchToolResultArgs>] {
  const { toolResultRows } = deps;

  /** The stored text of the caller's own call, and the settings, read now. */
  async function storedOf(callId: string, caller: ToolCaller) {
    const found = await toolResultRows.findForRun({
      callId,
      taskId: caller.agentId,
      ownerId: caller.ownerId,
    });
    return found === undefined ? undefined : { text: found.text, settings: await toolResultRows.readSettings() };
  }

  const read: OutsideAgentTool<ReadToolResultArgs> = {
    name: 'read_tool_result',
    description: READ_DESCRIPTION,
    argsSchema: ReadToolResultArgsSchema,
    mode: 'outside',
    everySession: true,
    async execute({ args, caller, callId, logger }) {
      const startedAt = Date.now();
      const stored = await storedOf(args.callId, caller);
      if (stored === undefined) {
        logger.info('stored result read', {
          callId: args.callId,
          readerCallId: callId,
          found: false,
          offset: args.offset,
          durationMs: Date.now() - startedAt,
        });
        return notFound();
      }
      const page = pageOf(stored.text, {
        offset: args.offset,
        ...(args.limit === undefined ? {} : { limit: args.limit }),
        maxTokens: stored.settings.readMaxTokens,
      });
      logger.info('stored result read', {
        callId: args.callId,
        readerCallId: callId,
        found: true,
        offset: args.offset,
        lastLine: page.kind === 'page' ? page.lastLine : null,
        totalLines: page.kind === 'page' ? page.totalLines : page.total,
        durationMs: Date.now() - startedAt,
      });
      return page.kind === 'page'
        ? { kind: 'done', outcome: 'success', text: page.text }
        : {
            kind: 'done',
            outcome: 'tool_error',
            text: `offset ${args.offset} is past the last line ${page.total}`,
          };
    },
  };

  const search: OutsideAgentTool<SearchToolResultArgs> = {
    name: 'search_tool_result',
    description: SEARCH_DESCRIPTION,
    argsSchema: SearchToolResultArgsSchema,
    mode: 'outside',
    everySession: true,
    // The pattern is a piece of the result's content: the log keeps only which result was searched.
    loggedArgs: (args) => ({ callId: args.callId }),
    async execute({ args, caller, callId, logger }) {
      const startedAt = Date.now();
      const stored = await storedOf(args.callId, caller);
      const found =
        stored === undefined
          ? undefined
          : searchOf(stored.text, args.pattern, { maxTokens: stored.settings.readMaxTokens });
      logger.info('stored result searched', {
        callId: args.callId,
        readerCallId: callId,
        found: stored !== undefined,
        matches: found?.kind === 'found' ? found.total : 0,
        shown: found?.kind === 'found' ? found.shown : 0,
        durationMs: Date.now() - startedAt,
      });
      if (found === undefined) return notFound();
      return found.kind === 'found'
        ? { kind: 'done', outcome: 'success', text: found.text }
        : { kind: 'done', outcome: 'empty', text: `no line matches "${args.pattern}"` };
    },
  };

  return [read, search];
}
