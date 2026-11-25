import { HistoryEventSchema } from '@agent-os/contracts';

import type { SessionHistory } from '../agent/agent-state';
import type { HistoryEntry } from '../history/history';

const RESULT_MAX_CHARS = 2000;
const TRANSCRIPT_MAX_CHARS = 40000;
const CUT_MARK = '[the older part of the history is cut]\n';

function cut(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** One inherited entry as transcript lines: the employee's messages, the agent's answers and calls, the results. */
function linesOf(entry: HistoryEntry): string[] {
  switch (entry.kind) {
    case 'task':
    case 'user_message':
      return [`Employee: ${entry.content.text}`];
    case 'model_answer':
      return [
        ...(entry.content.text === '' ? [] : [`Agent: ${entry.content.text}`]),
        ...entry.content.toolCalls.map((call) => `Agent called ${call.tool}.`),
      ];
    case 'tool_result':
      return [
        `Result of ${entry.content.tool} (${entry.content.outcome}): ${cut(entry.content.text ?? '', RESULT_MAX_CHARS)}`,
      ];
    default:
      return [];
  }
}

/**
 * The history the trainer of a forked test run hands its model (create-and-test design-trainer-dialog.md, KD-6):
 * the inherited entries — everything before the `forked` event — replaced by one `compaction` entry with their
 * transcript, so the message builder puts it in the data envelope. Unchanged when the view holds no `forked`
 * event: no fork, or a compaction already covers it.
 */
export function withInheritedTranscript(view: SessionHistory): SessionHistory {
  const forked = view.entries.findIndex(
    (entry) =>
      entry.kind === 'event' &&
      entry.content.event === HistoryEventSchema.enum.forked,
  );
  if (forked <= 0) return view;
  const inherited = view.entries.slice(0, forked);
  const full = inherited.flatMap(linesOf).join('\n');
  const summary =
    full.length <= TRANSCRIPT_MAX_CHARS
      ? full
      : CUT_MARK +
        full.slice(full.length - TRANSCRIPT_MAX_CHARS + CUT_MARK.length);
  const last = inherited.at(-1)!;
  return {
    ...view,
    entries: [
      {
        seq: last.seq,
        kind: 'compaction',
        createdAt: last.createdAt,
        content: { summary, throughSeq: last.seq },
      },
      ...view.entries.slice(forked),
    ],
  };
}
