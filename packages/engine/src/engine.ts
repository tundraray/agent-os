import type { Database } from '@agent-os/db';
import { z } from 'zod';
import type { ProcessSet } from './config/process-set.js';
import type { SourceMode } from './config/source-check.js';
import type { RoleModel } from './ports.js';
import type { SignalRegistry } from './signals/signal-registry.js';
import { signalsRepository as signals } from './signals/signals.repository.js';
import { engineRunsRepository as runs } from './runs/engine-runs.repository.js';
import {
  type EngineRuntimePorts,
  startInvestigation,
  type StartInvestigationInput,
  type StartInvestigationResult,
} from './runs/start-investigation.js';
import { type ReadInvestigationResult, toInvestigationView } from './view/investigation-view.js';

export interface RecordSignalInput {
  readonly investigationId: string;
  readonly resourceId: string;
  readonly kind: string;
  readonly payload: unknown;
}

/** A refusal writes no row (DC-5). */
export type RecordSignalResult =
  | { readonly outcome: 'recorded'; readonly signalId: string }
  | {
      readonly outcome: 'rejected';
      readonly code: 'investigation_not_found' | 'signal_kind_unknown' | 'signal_payload_invalid';
    };

/** The research engine (design-engine.md, Contract Definitions). */
export interface Engine {
  /**
   * The mode every new investigation of this engine starts in (KD-8): set by `connectedSources` at creation and
   * unchanged for the engine's lifetime, whatever the connected sources answer.
   */
  readonly sourceMode: SourceMode;
  startInvestigation(input: StartInvestigationInput): Promise<StartInvestigationResult>;
  /**
   * Records an external signal of the owner's investigation; the controller's next decision reads it (AC-04.1). Refused
   * with `investigation_not_found` for another owner's or an unknown investigation, `signal_kind_unknown` for a kind
   * outside the engine's options and `signal_payload_invalid` for a payload off its kind's schema or over 4 KiB.
   */
  recordSignal(input: RecordSignalInput): Promise<RecordSignalResult>;
  /** The owner's investigation; `investigation_not_found` for another owner's or an unknown one. */
  readInvestigation(input: { investigationId: string; resourceId: string }): Promise<ReadInvestigationResult>;
}

/** What a created engine runs on, after `createEngine` has checked it. */
export interface EngineDeps {
  readonly database: Database;
  readonly runtime: EngineRuntimePorts;
  readonly processes: ProcessSet;
  readonly sourceMode: SourceMode;
  /** Role model instances by catalog id, resolved through `resolveModel` at creation (for the role agents). */
  readonly models: ReadonlyMap<string, RoleModel>;
  readonly signalKinds: SignalRegistry;
}

const NOT_FOUND = { outcome: 'rejected', code: 'investigation_not_found' } as const;

export function buildEngine(deps: EngineDeps): Engine {
  const { database, sourceMode } = deps;
  return {
    sourceMode,
    startInvestigation: startInvestigation({ database, sourceMode, processes: deps.processes, ...deps.runtime }),
    async recordSignal({ investigationId, resourceId, kind, payload }) {
      if (!z.uuid().safeParse(investigationId).success) {
        return NOT_FOUND;
      }
      const checked = deps.signalKinds.check(kind, payload);
      if (checked.outcome === 'rejected') {
        return checked;
      }
      const signalId = await signals.record(database, { investigationId, resourceId, kind, payload: checked.payload });
      return signalId === undefined ? NOT_FOUND : { outcome: 'recorded', signalId };
    },
    async readInvestigation({ investigationId, resourceId }) {
      if (!z.uuid().safeParse(investigationId).success) {
        return NOT_FOUND;
      }
      const status = await runs.readStatus(database, investigationId, resourceId);
      return status === undefined ? NOT_FOUND : { outcome: 'found', view: toInvestigationView(status) };
    },
  };
}
