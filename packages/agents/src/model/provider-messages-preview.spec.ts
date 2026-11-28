// design-steps.md KD-5, AC-02.2 (rule). Pure: the message assembly of the compaction step with the overflow mark set. Real `cutText`; no database.
import { describe, expect, it } from 'vitest';

import type { AnswerCall, HistoryEntry } from '../history/history';
import { wrapperText } from '../tools/large-result';
import type { AgentTurnMessage } from './mastra-turn';
import { buildProviderMessages, envelope } from './provider-messages';

const AT = new Date('2026-11-28T10:00:00.000Z');
const PREVIEW_CHARS = 10;

const call = (
  callId: string,
  tool: string,
  server: string | null,
): AnswerCall => ({
  callId,
  tool,
  server,
  args: {},
});
const answer = (seq: number, calls: AnswerCall[]): HistoryEntry => ({
  seq,
  kind: 'model_answer',
  createdAt: AT,
  content: { text: '', toolCalls: calls },
});
const result = (seq: number, made: AnswerCall, text: string): HistoryEntry => ({
  seq,
  kind: 'tool_result',
  createdAt: AT,
  content: {
    callId: made.callId,
    tool: made.tool,
    server: made.server,
    args: {},
    outcome: 'success',
    refusalReason: null,
    refusalDetail: null,
    text,
    startedAt: null,
    finishedAt: null,
  },
});
const userMessage = (seq: number, text: string): HistoryEntry => ({
  seq,
  kind: 'user_message',
  createdAt: AT,
  content: { text, record: null, schedule: null },
});
const agentMessage = (seq: number, text: string): HistoryEntry => ({
  seq,
  kind: 'agent_message',
  createdAt: AT,
  content: { text, agentId: 'parent-1' },
});
const compaction = (seq: number, summary: string): HistoryEntry => ({
  seq,
  kind: 'compaction',
  createdAt: AT,
  content: { summary, throughSeq: 0 },
});

const mcp = call('c1', 'search_logs', 'logs');
const page = call('c2', 'read_tool_result', null);
const mcpName = 'mcp__logs__search_logs';
/** Two results of one answer; the model message they make, with the data each result shows. */
const twoResults = (mcpText: string, pageText: string): HistoryEntry[] => [
  answer(1, [mcp, page]),
  result(2, mcp, mcpText),
  result(3, page, pageText),
];
const toolMessages = (
  mcpData: string,
  pageData: string,
): AgentTurnMessage[] => [
  {
    role: 'assistant',
    content: '',
    toolCalls: [
      { toolCallId: 'c1', toolName: mcpName, args: {} },
      { toolCallId: 'c2', toolName: 'read_tool_result', args: {} },
    ],
  },
  {
    role: 'tool',
    results: [
      {
        toolCallId: 'c1',
        toolName: mcpName,
        output: envelope('tool search_logs', 'logs', mcpData),
      },
      {
        toolCallId: 'c2',
        toolName: 'read_tool_result',
        output: envelope('tool read_tool_result', 'agents', pageData),
      },
    ],
  },
];

const long = 'abcdefghijklmno';
const wrapped = wrapperText({
  callId: 'c0',
  text: 'x'.repeat(50),
  previewChars: PREVIEW_CHARS,
});

describe('with the overflow mark set, the compaction step shows tool results by their start', () => {
  // Catches: the cut applied to every record or to the stored history; the boundary at `previewChars` off by one; the cut when the mark is clear, which would shorten every ordinary summary input.
  it.each<{
    readonly row: string;
    readonly previewChars: number | undefined;
    readonly entries: HistoryEntry[];
    readonly expected: AgentTurnMessage[];
  }>([
    {
      row: 'mark set: an MCP result and a read_tool_result page longer than previewChars are cut with the count',
      previewChars: PREVIEW_CHARS,
      entries: twoResults(long, `${long}xy`),
      expected: toolMessages(
        'abcdefghij\nresult cut by 5 characters',
        'abcdefghij\nresult cut by 7 characters',
      ),
    },
    {
      row: 'mark set: a result of exactly previewChars and a shorter one stay whole',
      previewChars: PREVIEW_CHARS,
      entries: twoResults('abcdefghij', 'abcdefghi'),
      expected: toolMessages('abcdefghij', 'abcdefghi'),
    },
    {
      row: 'mark set: a stored result wrapper is not cut again',
      previewChars: PREVIEW_CHARS,
      entries: twoResults(wrapped, 'short'),
      expected: toolMessages(wrapped, 'short'),
    },
    {
      row: 'mark set: a long user message, agent message and summary stay whole',
      previewChars: PREVIEW_CHARS,
      entries: [
        compaction(4, long),
        userMessage(5, long),
        agentMessage(6, long),
      ],
      expected: [
        {
          role: 'user',
          content: envelope('summary of the earlier history', 'agents', long),
        },
        { role: 'user', content: long },
        {
          role: 'user',
          content: envelope('parent agent message', 'parent-1', long),
        },
      ],
    },
    {
      row: 'mark clear: the same long results stay whole',
      previewChars: undefined,
      entries: twoResults(long, `${long}xy`),
      expected: toolMessages(long, `${long}xy`),
    },
  ])('$row', ({ previewChars, entries, expected }) => {
    const before = structuredClone(entries);

    const messages = buildProviderMessages({
      entries,
      ...(previewChars === undefined
        ? {}
        : { toolResultPreviewChars: previewChars }),
    });

    expect(messages).toEqual(expected);
    // The history the employee reads is not changed by the cut.
    expect(entries).toEqual(before);
  });
});
