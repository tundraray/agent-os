import type { LiveTaskIdentity } from '@agent-os/runtime';

import { type CallState, foldCalls } from '../history/call-state';
import type { HistoryEntry } from '../history/history';
import type { ForkPrefix } from '../model/provider-messages';
import type { Session, SessionInput } from '../store/sessions';
import type { AgentDeps } from './agent-deps';

/** What an agent object is made for: its task and the task's parsed input. Never changes. */
export interface AgentRun {
  readonly task: LiveTaskIdentity;
  readonly input: SessionInput;
}

/** The history the model sees: the fork prefix and the own entries. */
export interface SessionHistory {
  /** The parent's part of a fork's history, until the fork's first compaction: a summary covers it too (KD-7). */
  readonly forkPrefix?: ForkPrefix;
  /** The own entries from the last compaction on, in `seq` order. */
  readonly entries: readonly HistoryEntry[];
  /** `seq` of the last own entry; 0 for an empty history. */
  readonly lastSeq: number;
}

/**
 * What an agent object keeps of its session between steps: the session row, the history the model sees and
 * the calls of its entries (`foldCalls`). Bounded by the last compaction; a fork's prefix goes at its first
 * one. A value: a new one replaces it after each committed step (`BaseAgent.absorb`), nothing edits it.
 */
export interface AgentState extends SessionHistory {
  readonly session: Session;
  readonly calls: readonly CallState[];
}

type StateDeps = Pick<AgentDeps, 'sessions' | 'history'>;

function stateOf(
  session: Session,
  forkPrefix: ForkPrefix | undefined,
  entries: readonly HistoryEntry[],
  lastSeq: number,
): AgentState {
  return {
    session,
    ...(forkPrefix === undefined ? {} : { forkPrefix }),
    entries,
    lastSeq,
    calls: foldCalls(entries),
  };
}

/**
 * The state of the agent as the database holds it: its session, its entries from the last compaction on
 * (`history.visible`) and, for a fork that has not compacted yet, the parent's entries through the fork point.
 * `undefined` — the agent has no session yet.
 */
export async function loadState(
  deps: StateDeps,
  taskId: string,
): Promise<AgentState | undefined> {
  const session = await deps.sessions.get(taskId);
  if (session === undefined) return undefined;
  const entries = await deps.history.visible(taskId);
  const compacted = entries.some((entry) => entry.kind === 'compaction');
  const forkPrefix: ForkPrefix | undefined =
    compacted || session.forkedFromTaskId === null || session.forkedThroughSeq === null
      ? undefined
      : {
          throughSeq: session.forkedThroughSeq,
          entries: await deps.history.through(session.forkedFromTaskId, session.forkedThroughSeq),
        };
  return stateOf(session, forkPrefix, entries, entries.at(-1)?.seq ?? 0);
}

/**
 * The state after the entries appended since it was taken, exactly what `loadState` would read now: a
 * `compaction` among them drops every entry before the last one and the fork prefix, as `history.visible`
 * does; otherwise they follow the kept ones. Pure.
 */
function withDelta(state: AgentState, session: Session, delta: readonly HistoryEntry[]): AgentState {
  const lastSeq = delta.at(-1)?.seq ?? state.lastSeq;
  const compaction = delta.findLastIndex((entry) => entry.kind === 'compaction');
  return compaction === -1
    ? stateOf(session, state.forkPrefix, [...state.entries, ...delta], lastSeq)
    : stateOf(session, undefined, delta.slice(compaction), lastSeq);
}

/** The state brought up to the database: the session row read again and the entries after `lastSeq`. */
export async function absorbState(deps: StateDeps, state: AgentState): Promise<AgentState> {
  const { taskId } = state.session;
  const session = await deps.sessions.get(taskId);
  if (session === undefined) throw new Error(`Session of agent ${taskId} is gone`);
  return withDelta(state, session, await deps.history.after(taskId, state.lastSeq));
}
