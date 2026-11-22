import type { RecordHeader, RecordKind, ToolRefusalReason } from '@agent-os/contracts';

import { inRootLaunchSet } from '../chat-listing';

type Refused<Reason extends ToolRefusalReason> = {
  readonly kind: 'refused';
  readonly reason: Reason;
  /** What the model reads after the reason (deep-agents KD-4); absent — the reason says it all. */
  readonly text?: string;
};

/**
 * Whom the caller may start (design-runtime.md, Terms «Набор запуска»): the root — the records the chat
 * may offer, of the kind the tool starts; an agent — the records of its snapshot's `agents`. A deep agent
 * has no `start_agent`: it calls its subagents with `task` (deep-agents/design-task.md KD-6).
 */
export type LaunchSet =
  | {
      readonly kind: 'root';
      /** The starter's `listVisible`. */
      readonly headers: readonly RecordHeader[];
      /** The kind the tool starts: an agent for `start_agent`, a deep agent for `start_deep_agent`. */
      readonly tool: RecordKind;
    }
  | { readonly kind: 'agents'; readonly ids: readonly string[] };

/** What the call names. */
export type StartTarget =
  | { readonly kind: 'fork' }
  /** A record by its id; `recordKind` — its kind as the caller's starter sees it, `null` — unknown. */
  | { readonly kind: 'record'; readonly recordId: string; readonly recordKind: RecordKind | null };

export interface StartGateInput {
  readonly launchSet: LaunchSet;
  readonly target: StartTarget;
  /** The caller's depth (the root's is 0). */
  readonly depth: number;
  /** `AGENT_MAX_DEPTH`. */
  readonly maxDepth: number;
}

export type StartGate = { readonly kind: 'allowed' } | Refused<'not_allowed' | 'depth_limit'>;

const ALLOWED: StartGate = { kind: 'allowed' };
const NOT_ALLOWED: StartGate = { kind: 'refused', reason: 'not_allowed' };

/** DC-3: a deep agent is started only by `start_deep_agent` of the root, never by `start_agent`. */
const DEEP_AGENT_REFUSAL: StartGate = {
  kind: 'refused',
  reason: 'not_allowed',
  text: 'This record is a deep agent: only the main chat starts a deep agent, after the employee approves its brief.',
};

/**
 * Whether the caller may start the target (KD-5; UC-E4, AC-16.6, AC-15.2; deep-agents DC-3;
 * pure-decision.md): the target is in the caller's launch set — a fork always, a deep agent's record
 * never — and the child is not deeper than `maxDepth`. A record the starter may not see is refused before
 * this, as `record_unavailable`; the model is checked after it (plan Notes 2).
 */
export function gateStart({ launchSet, target, depth, maxDepth }: StartGateInput): StartGate {
  const inSet = inLaunchSet(launchSet, target);
  if (inSet.kind === 'refused') return inSet;
  if (depth + 1 > maxDepth) return { kind: 'refused', reason: 'depth_limit' };
  return ALLOWED;
}

function inLaunchSet(launchSet: LaunchSet, target: StartTarget): StartGate {
  switch (target.kind) {
    case 'fork':
      return ALLOWED;
    case 'record':
      if (target.recordKind === 'deep_agent') return DEEP_AGENT_REFUSAL;
      return recordAllowed(launchSet, target.recordId) ? ALLOWED : NOT_ALLOWED;
  }
}

/**
 * Whether the root may start the record with a tool of this kind (KD-4, AC-15.2): it is among the
 * starter's `listVisible` headers, of the tool's kind, and the chat may offer it. `start_agent` decides
 * through it in `gateStart`, `start_deep_agent` through its `rootMayStart`.
 */
export function rootMayStartRecord(
  headers: readonly RecordHeader[],
  tool: RecordKind,
  recordId: string,
): boolean {
  const header = headers.find((candidate) => candidate.id === recordId);
  return header !== undefined && header.kind === tool && inRootLaunchSet(header);
}

function recordAllowed(launchSet: LaunchSet, recordId: string): boolean {
  return launchSet.kind === 'root'
    ? rootMayStartRecord(launchSet.headers, launchSet.tool, recordId)
    : launchSet.ids.includes(recordId);
}
