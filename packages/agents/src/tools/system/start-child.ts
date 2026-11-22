import type { Logger } from '@agent-os/common';
import type { Transaction } from '@agent-os/db';
import type { LiveTask, LiveTaskIdentity } from '@agent-os/runtime';

import { AgentsError } from '../../errors';
import type { StartResolution, StartSource } from '../../start/resolve-start';
import type { RunSnapshot } from '../../start/snapshot';
import type { SessionInput } from '../../store/sessions';
import type { StartChild } from '../tool';
import type { StartChildScope } from '../tool-runner';

export interface StartChildDeps {
  /** `AGENT_MAX_DEPTH`. */
  readonly maxDepth: number;
  /** The task type the child's snapshot runs as (`childTypeOf`). */
  readonly childType: (snapshot: RunSnapshot) => string;
  /** Makes the child's object with its session inside the commit (`AgentFactory.createIn`). */
  readonly createIn: (
    tx: Transaction,
    type: string,
    task: Omit<LiveTaskIdentity, 'type' | 'input'>,
    input: SessionInput,
  ) => Promise<LiveTask>;
}

/**
 * The only start of a child agent inside a step's commit transaction (design-runtime.md, «Операции
 * `agents`»): the child is not deeper than `AGENT_MAX_DEPTH` (`DEPTH_LIMIT`), then `effects.spawn` of a
 * task of the child's type (`childType`) with the snapshot in its input, then the child's object with its session and
 * `task` entry in the same transaction (plan Notes 11), handed to the runtime with `effects.adopt`: it keeps the
 * object once the commit succeeds, and the child's first step runs on it. The caller gets the `agentId` at once.
 * Owner and parent are the caller's. Bound to one call's scope by the tool runner (`startChildFor`).
 */
export function createStartChild(deps: StartChildDeps): (scope: StartChildScope) => StartChild {
  return ({ tx, effects, caller }) =>
    async ({ snapshot, prompt, description, forkedFrom }) => {
      if (caller.depth + 1 > deps.maxDepth) {
        throw new AgentsError(
          'DEPTH_LIMIT',
          `A child of an agent at depth ${caller.depth} is deeper than AGENT_MAX_DEPTH ${deps.maxDepth}`,
        );
      }
      const input: SessionInput = {
        snapshot,
        prompt,
        description,
        ...(forkedFrom === undefined ? {} : { forkedFrom }),
      };
      const type = deps.childType(snapshot);
      const agentId = await effects.spawn({ type, input });
      const child = await deps.createIn(
        tx,
        type,
        {
          taskId: agentId,
          ownerId: caller.ownerId,
          parentId: caller.agentId,
          rootId: caller.rootId,
          depth: caller.depth + 1,
        },
        input,
      );
      effects.adopt(agentId, child);
      return { agentId };
    };
}

/** One start as the log gets it (design-runtime.md, «Логирование»): no prompt and no record content. */
export interface StartLogEntry {
  readonly ownerId: string;
  readonly rootId: string | null;
  readonly parentId: string | null;
  /** The started agent; `null` when the start was refused. */
  readonly agentId: string | null;
  /** The kind of the snapshot's source; `null` when nothing was resolved. */
  readonly source: StartSource['kind'] | null;
  /** The record the call named, when it named one by id. */
  readonly recordId?: string;
  /** What the start procedure answered; `null` when the gate refused before it. */
  readonly resolution: StartResolution | null;
  /** The refusal of the start, when it was refused. */
  readonly refusal: string | null;
  readonly startedAt: number;
}

/** Logs a start or its refusal with the record, its version and the subagent (design-runtime.md, «Логирование»). */
export function logStart(logger: Logger, entry: StartLogEntry): void {
  const origin = entry.resolution?.kind === 'snapshot' ? entry.resolution.snapshot.origin : null;
  logger.info(entry.refusal === null ? 'agents start done' : 'agents start refused', {
    ownerId: entry.ownerId,
    rootId: entry.rootId,
    parentId: entry.parentId,
    agentId: entry.agentId,
    source: entry.source,
    recordId: origin?.recordId ?? entry.recordId ?? null,
    version: origin?.version ?? null,
    subagent: origin?.subagent ?? null,
    outcome: entry.refusal ?? 'started',
    refusedModel: entry.resolution?.kind === 'refused' ? entry.resolution.model : null,
    durationMs: Date.now() - entry.startedAt,
  });
}
