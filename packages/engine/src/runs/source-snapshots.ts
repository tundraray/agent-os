import type { Clock } from '@agent-os/runtime';
import type { SourceRegistry } from '@agent-os/sources';
import type { ProcessConfig } from '../config/process-config.schema.js';
import type { EngineLogger } from '../ports.js';

/**
 * Deadline of reading one source's slice at the start of an investigation. A constant, not a setting, and separate
 * from the tool call timeout `SOURCE_CALL_TIMEOUT_MS`: a hanging source delays the start by at most this much
 * (design-self-check.md, Contract Definitions: `Engine.startInvestigation`; KD-7).
 */
const SNAPSHOT_READ_DEADLINE_MS = 2_000;

/** The slice of each source of the configuration by `sourceId`; `null` when it was not read in time or failed. */
export type SourceSnapshots = Readonly<Record<string, string | null>>;

export interface SourceSnapshotDeps {
  readonly sources: Pick<SourceRegistry, 'currentSnapshot'>;
  readonly clock: Clock;
  readonly logger: EngineLogger;
}

/**
 * Reads the current slice of every source of the configuration at the same time, each read with its own deadline on
 * the engine clock that aborts it. Never rejects: a read that fails or misses the deadline gives an empty slice, and
 * the collection later ends `source_unavailable` as it does today (KD-7).
 */
export async function readSourceSnapshots(
  deps: SourceSnapshotDeps,
  config: Pick<ProcessConfig, 'sources'>,
): Promise<SourceSnapshots> {
  const sourceIds = [...new Set(config.sources.map((source) => source.sourceId))];
  const slices = await Promise.all(sourceIds.map((sourceId) => readOne(deps, sourceId)));
  return Object.fromEntries(sourceIds.map((sourceId, index) => [sourceId, slices[index] ?? null]));
}

/** What the deadline gives in the race with the read; a symbol, so that no slice text can be mistaken for it. */
const DEADLINE = Symbol('deadline');

async function readOne(deps: SourceSnapshotDeps, sourceId: string): Promise<string | null> {
  const controller = new AbortController();
  // The deadline settles the read even when the source ignores its signal.
  let cancelDeadline: () => void = () => undefined;
  const deadline = new Promise<typeof DEADLINE>((resolve) => {
    cancelDeadline = deps.clock.setTimer(SNAPSHOT_READ_DEADLINE_MS, () => {
      controller.abort();
      resolve(DEADLINE);
    });
  });
  try {
    const read = await Promise.race([deps.sources.currentSnapshot(sourceId, controller.signal), deadline]);
    if (read !== DEADLINE) return read;
    // KD-10: the source and the outcome only, never the request or a prompt.
    deps.logger.warn('source snapshot not read at start within the deadline: recorded empty', {
      sourceId,
      outcome: 'deadline',
    });
    return null;
  } catch (error) {
    deps.logger.warn('source snapshot could not be read at start: recorded empty', {
      sourceId,
      errorClass: error instanceof Error ? error.name : typeof error,
      outcome: 'source_unavailable',
    });
    return null;
  } finally {
    cancelDeadline();
  }
}
