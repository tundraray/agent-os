import { type InvestigationAnswer, InvestigationAnswerSchema } from '../answer/code-answer.js';
import { type ProcessConfig, ProcessConfigSchema } from '../config/process-config.schema.js';
import type { SourceMode } from '../config/source-check.js';
import type { EngineRunStatus } from '../runs/engine-runs.repository.js';

export type InvestigationViewStatus = 'running' | 'completed' | 'failed' | 'cancelled';

type AnswerSection = ProcessConfig['answer']['sections'][number];

/**
 * The answer as the view shows it: `outcome` and `stopReason`, then the sections the investigation's configuration
 * names, in its order (ProcessConfig `answer`); a section the configuration leaves out is absent.
 */
type InvestigationAnswerView = Pick<InvestigationAnswer, 'answerId' | 'outcome' | 'stopReason'> &
  Partial<Pick<InvestigationAnswer, AnswerSection>>;

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
   * Null until the investigation is answered; then its `outcome`, `stopReason` (null, or why the engine stopped it) and
   * the sections of its configuration in their order.
   */
  readonly answer: InvestigationAnswerView | null;
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
    answer: run.answer === null ? null : answerView(InvestigationAnswerSchema.parse(run.answer), run.processConfig),
  };
}

/** The stored answer (a `jsonb` keeps no key order) laid out in the sections of the recorded configuration (DC-15). */
function answerView(answer: InvestigationAnswer, processConfig: unknown): InvestigationAnswerView {
  const sections: Partial<Pick<InvestigationAnswer, AnswerSection>> = {};
  const copy = <Section extends AnswerSection>(section: Section): void => {
    sections[section] = answer[section];
  };
  ProcessConfigSchema.parse(processConfig).answer.sections.forEach(copy);
  return { answerId: answer.answerId, outcome: answer.outcome, stopReason: answer.stopReason, ...sections };
}

/** The column's CHECK allows only the two modes; anything else is a defect, not a mode to guess. */
function recordedSourceMode(value: string): SourceMode {
  if (value === 'sources' || value === 'model_knowledge') {
    return value;
  }
  throw new Error(`research_engine_runs.source_mode holds an unknown mode ${value}`);
}
