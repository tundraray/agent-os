import type { RecordHeader, RecordKind, ToolRefusalReason } from '@agent-os/contracts';

import { inRootLaunchSet } from '../chat-listing';

type Refused<Reason extends ToolRefusalReason> = { readonly kind: 'refused'; readonly reason: Reason };

/**
 * Whom the caller may start (design-runtime.md, Terms «Набор запуска»): the root — the records the chat
 * may offer, of the kind the tool starts; an agent — the records of its snapshot's `agents`; a
 * coordinator — its team, each executor at most `maxRuns` times.
 */
export type LaunchSet =
  | {
      readonly kind: 'root';
      /** The starter's `listVisible`. */
      readonly headers: readonly RecordHeader[];
      /** The kind the tool starts: an agent for `start_agent`, a workflow for `start_workflow`. */
      readonly tool: RecordKind;
    }
  | { readonly kind: 'agents'; readonly ids: readonly string[] }
  | { readonly kind: 'team'; readonly executors: readonly { readonly name: string; readonly maxRuns: number }[] };

/** What the call names. */
export type StartTarget =
  | { readonly kind: 'fork' }
  | { readonly kind: 'record'; readonly recordId: string }
  /** An executor by its name; `startedCount` — its successful starts by the caller so far. */
  | { readonly kind: 'executor'; readonly name: string; readonly startedCount: number };

export interface StartGateInput {
  readonly launchSet: LaunchSet;
  readonly target: StartTarget;
  /** The caller's depth (the root's is 0). */
  readonly depth: number;
  /** `AGENT_MAX_DEPTH`. */
  readonly maxDepth: number;
}

export type StartGate =
  | { readonly kind: 'allowed' }
  | Refused<'not_allowed' | 'run_limit' | 'depth_limit'>;

const ALLOWED: StartGate = { kind: 'allowed' };
const NOT_ALLOWED: StartGate = { kind: 'refused', reason: 'not_allowed' };

/**
 * Whether the caller may start the target (KD-5; UC-E4, AC-16.6, AC-15.2; pure-decision.md): the target
 * is in the caller's launch set — a fork everywhere but at a coordinator — an executor is under its
 * `maxRuns` (`run_limit` past it, distinct from `not_allowed` outside the team), and the child is not
 * deeper than `maxDepth`. A record the starter may not see is refused before this, as
 * `record_unavailable`; the model is checked after it (plan Notes 2).
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
      return launchSet.kind === 'team' ? NOT_ALLOWED : ALLOWED;
    case 'record':
      return recordAllowed(launchSet, target.recordId) ? ALLOWED : NOT_ALLOWED;
    case 'executor': {
      if (launchSet.kind !== 'team') return NOT_ALLOWED;
      const executor = launchSet.executors.find((candidate) => candidate.name === target.name);
      if (executor === undefined) return NOT_ALLOWED;
      return target.startedCount < executor.maxRuns ? ALLOWED : { kind: 'refused', reason: 'run_limit' };
    }
  }
}

/**
 * Whether the root may start the record with a tool of this kind (KD-4, AC-15.2): it is among the
 * starter's `listVisible` headers, of the tool's kind, and the chat may offer it. `start_agent` decides
 * through it in `gateStart`, `start_workflow` through `Agents.rootMayStart`.
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
  switch (launchSet.kind) {
    case 'root':
      return rootMayStartRecord(launchSet.headers, launchSet.tool, recordId);
    case 'agents':
      return launchSet.ids.includes(recordId);
    case 'team':
      return false;
  }
}
