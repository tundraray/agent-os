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

/**
 * `Engine.checkCalibration` refused the server start: no group table has the pair of fingerprints of the checker agent
 * of a process's highest loaded version (design-research-flow.md, KD-4, DC-10). The `calibrate` command builds that table.
 */
export class AgentCalibrationMissingError extends Error {
  override readonly name = 'AgentCalibrationMissingError';
  readonly code = 'calibration_missing';
  readonly processId: string;
  readonly version: number;
  readonly agentFingerprint: string;
  readonly definitionMemoryFingerprint: string;

  constructor(missing: { processId: string; version: number; agentFingerprint: string; definitionMemoryFingerprint: string }) {
    super(
      `no group table for process ${missing.processId} version ${missing.version}: agent fingerprint ${missing.agentFingerprint}, ` +
        `definition memory fingerprint ${missing.definitionMemoryFingerprint}; build one with the calibrate command`,
    );
    this.processId = missing.processId;
    this.version = missing.version;
    this.agentFingerprint = missing.agentFingerprint;
    this.definitionMemoryFingerprint = missing.definitionMemoryFingerprint;
  }
}
