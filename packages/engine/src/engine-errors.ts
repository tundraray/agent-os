import type { FailureClass } from '@agent-os/contracts';

/**
 * Failure codes of the engine tasks and their `FailureReason` class (design-engine.md, Error
 * handling): budget refusals are `budget_exhausted`, a provider that still errs after two
 * retries is `transport_protocol` (DC-12), a task that reached `notAfter` is `deadline` (DC-3).
 * An agent run (design-agent-core.md, Error Handling) fails its share with `run_tokens_exhausted`, a last turn that
 * did not end the run with `turn_limit`, its own deadline with `not_after`, and its form's prologue with
 * `prologue_oversize` or `prologue_refused`, and a turn whose counted input does not fit its window even at stage 4 of
 * the window rule with `context_overflow` (DC-30).
 */
export const ENGINE_FAILURE_CLASSES = {
  task_tokens_exhausted: 'budget_exhausted',
  investigation_tokens_exhausted: 'budget_exhausted',
  model_unavailable: 'transport_protocol',
  deadline: 'deadline',
  run_tokens_exhausted: 'budget_exhausted',
  turn_limit: 'validation_rejected',
  not_after: 'deadline',
  prologue_oversize: 'validation_rejected',
  prologue_refused: 'validation_rejected',
  context_overflow: 'validation_rejected',
} as const satisfies Record<string, FailureClass>;

export type EngineFailureCode = keyof typeof ENGINE_FAILURE_CLASSES;

/**
 * Warning of a task that succeeds without claims: the model output failed the role schema, or
 * the model refused, after one retry. Not a failure.
 */
export type EngineWarningCode = 'invalid_model_output';

/**
 * Creation refused under `requireCalibration` (the server start): a loaded configuration with the `verify` capability has
 * no group table for its `verifier` model and prompt version (DC-2). The `calibrate` command builds that table.
 */
export class CalibrationMissingError extends Error {
  override readonly name = 'CalibrationMissingError';
  readonly code = 'calibration_missing';
  readonly processId: string;
  readonly version: number;
  readonly model: string;
  readonly promptVersion: string;

  constructor(missing: { processId: string; version: number; model: string; promptVersion: string }) {
    super(
      `no group table for process ${missing.processId} version ${missing.version}: verifier model ${missing.model}, ` +
        `prompt version ${missing.promptVersion}; build one with the calibrate command`,
    );
    this.processId = missing.processId;
    this.version = missing.version;
    this.model = missing.model;
    this.promptVersion = missing.promptVersion;
  }
}
