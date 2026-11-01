import type { FailureClass } from '@agent-os/contracts';

/**
 * Failure codes of the engine tasks and their `FailureReason` class (design-engine.md, Error
 * handling): budget refusals are `budget_exhausted`, a provider that still errs after two
 * retries is `transport_protocol` (DC-12), a task that reached `notAfter` is `deadline` (DC-3).
 */
export const ENGINE_FAILURE_CLASSES = {
  task_tokens_exhausted: 'budget_exhausted',
  investigation_tokens_exhausted: 'budget_exhausted',
  model_unavailable: 'transport_protocol',
  deadline: 'deadline',
} as const satisfies Record<string, FailureClass>;

export type EngineFailureCode = keyof typeof ENGINE_FAILURE_CLASSES;

/**
 * Warning of a task that succeeds without claims: the model output failed the role schema, or
 * the model refused, after one retry. Not a failure.
 */
export type EngineWarningCode = 'invalid_model_output';
