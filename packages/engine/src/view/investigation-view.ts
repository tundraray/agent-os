import { type InvestigationAnswer, InvestigationAnswerSchema } from '../answer/code-answer.js';
import type { SourceMode } from '../config/source-check.js';
import type { EngineRunStatus } from '../runs/engine-runs.repository.js';

export type InvestigationViewStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/**
 * An investigation as the engine shows it (design-engine.md, InvestigationView). `processId`, `version` and
 * `sourceMode` are the ones recorded at the start, never the engine's current ones (DC-15, DC-16).
 */
export interface InvestigationView {
  readonly investigationId: string;
  readonly status: InvestigationViewStatus;
  /** Null only between the engine row and the controller task of a start that has not finished yet. */
  readonly controllerTaskId: string | null;
  readonly processId: string;
  readonly version: number;
  readonly sourceMode: SourceMode;
  /**
   * Null until the investigation is answered; then its `outcome`, `stopReason` (null, or why the engine stopped it), the
   * sections and the removed claims.
   */
  readonly answer: InvestigationAnswer | null;
}

export type ReadInvestigationResult =
  | { readonly outcome: 'found'; readonly view: InvestigationView }
  | { readonly outcome: 'rejected'; readonly code: 'investigation_not_found' };

const TERMINAL_CONTROLLER_STATUSES: Readonly<Record<string, InvestigationViewStatus>> = {
  succeeded: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};

/**
 * The final status of the controller task decides; until it ends, a cancelled or deleted investigation is
 * `cancelled` (its controller is being stopped) and any other is `running`.
 */
function viewStatus(investigationStatus: string, controllerTaskStatus: string | null): InvestigationViewStatus {
  const final = controllerTaskStatus === null ? undefined : TERMINAL_CONTROLLER_STATUSES[controllerTaskStatus];
  if (final !== undefined) {
    return final;
  }
  return investigationStatus === 'active' ? 'running' : 'cancelled';
}

export function toInvestigationView({ run, investigationStatus, controllerTaskStatus }: EngineRunStatus): InvestigationView {
  return {
    investigationId: run.investigationId,
    status: viewStatus(investigationStatus, controllerTaskStatus),
    controllerTaskId: run.controllerTaskId,
    processId: run.processId,
    version: run.processVersion,
    sourceMode: recordedSourceMode(run.sourceMode),
    answer: run.answer === null ? null : InvestigationAnswerSchema.parse(run.answer),
  };
}

/** The column's CHECK allows only the two modes; anything else is a defect, not a mode to guess. */
function recordedSourceMode(value: string): SourceMode {
  if (value === 'sources' || value === 'model_knowledge') {
    return value;
  }
  throw new Error(`research_engine_runs.source_mode holds an unknown mode ${value}`);
}
