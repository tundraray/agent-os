
import type { HistoryEntry } from '../history/history';
import type { Session } from '../store/sessions';
import type { AgentDeps } from './agent-deps';
import { absorbState, loadState } from './agent-state';

// Live task objects: an agent kept in memory takes each committed step in as the entries appended since
// (`absorbState`), and must then hold exactly what a restore from the same rows gives (`loadState`) — a compaction
// among them drops what precedes it and a fork's prefix, as `history.visible` does.
const AGENT = 'agent-1';
const PARENT = 'parent-1';
const AT = new Date(0);

const SESSION = { taskId: AGENT, forkedFromTaskId: PARENT, forkedThroughSeq: 1, turns: 0 } as Session;

const PARENT_ENTRIES: HistoryEntry[] = [
  { seq: 1, kind: 'task', createdAt: AT, content: { text: 'Parent task', record: null } },
];

const CALL = { callId: 'call-1', tool: 'lookup', server: null, args: {} };

const ENTRIES: HistoryEntry[] = [
  { seq: 1, kind: 'task', createdAt: AT, content: { text: 'Look it up', record: null } },
  { seq: 2, kind: 'model_answer', createdAt: AT, content: { text: '', toolCalls: [CALL] } },
  {
    seq: 3,
    kind: 'tool_result',
    createdAt: AT,
    content: {
      ...CALL,
      outcome: 'success',
      refusalReason: null,
      refusalDetail: null,
      text: 'found',
      startedAt: null,
      finishedAt: null,
    },
  },
  { seq: 4, kind: 'model_answer', createdAt: AT, content: { text: 'Done.', toolCalls: [] } },
  { seq: 5, kind: 'compaction', createdAt: AT, content: { summary: 'Looked it up.', throughSeq: 4 } },
  { seq: 6, kind: 'event', createdAt: AT, content: { event: 'compacted', reason: null } },
  { seq: 7, kind: 'user_message', createdAt: AT, content: { text: 'And now?', record: null } },
];

/** The stores over the first `written` entries of the agent, with the queries of `AgentMessagesRepository`. */
function storesAt(written: number, turns: number): Pick<AgentDeps, 'sessions' | 'history'> {
  const own = ENTRIES.slice(0, written);
  const fromCompaction = own.findLastIndex((entry) => entry.kind === 'compaction');
  return {
    sessions: { get: async () => ({ ...SESSION, turns }) },
    history: {
      visible: async () => own.slice(Math.max(fromCompaction, 0)),
      after: async (_taskId: string, seq: number) => own.filter((entry) => entry.seq > seq),
      through: async (taskId: string, seq: number) =>
        taskId === PARENT ? PARENT_ENTRIES.filter((entry) => entry.seq <= seq) : [],
    },
  } as unknown as Pick<AgentDeps, 'sessions' | 'history'>;
}

describe('an agent kept in memory takes a committed step in and holds what a restore would read', () => {
  it.each<[string, number, number, { seqs: number[]; openCalls: number; forkPrefix: boolean }]>([
    ['entries without a compaction follow the kept ones', 2, 4, { seqs: [1, 2, 3, 4], openCalls: 0, forkPrefix: true }],
    ['a compaction drops what precedes it and the fork prefix', 4, 7, { seqs: [5, 6, 7], openCalls: 0, forkPrefix: false }],
  ])('%s', async (_, before, after, expected) => {
    const kept = await loadState(storesAt(before, 0), AGENT);
    if (kept === undefined) throw new Error('the agent has a session');

    const absorbed = await absorbState(storesAt(after, 1), kept);

    expect({
      seqs: absorbed.entries.map((entry) => entry.seq),
      openCalls: absorbed.calls.filter((call) => call.state !== 'done').length,
      forkPrefix: absorbed.forkPrefix !== undefined,
    }).toEqual(expected);
    expect([absorbed.lastSeq, absorbed.session.turns]).toEqual([after, 1]);
    expect(absorbed).toEqual(await loadState(storesAt(after, 1), AGENT));
  });

  it('holds the open call of the last answer until its result is appended', async () => {
    const kept = await loadState(storesAt(2, 0), AGENT);

    expect(kept?.calls.map((call) => [call.callId, call.state])).toEqual([['call-1', 'requested']]);
    expect(kept?.forkPrefix).toEqual({ throughSeq: 1, entries: PARENT_ENTRIES });
  });
});
