import type { z } from 'zod';

export type FinishCheck = { readonly valid: true; readonly result: unknown } | { readonly valid: false };

/**
 * `finish` (`finish`): the run's result in the form of its definition. The executor checks it here — alone in its turn
 * (DC-17) and through the form's schema; a result off the schema is the remark `invalid_result`. The handler writes an
 * accepted result together with the call's outcome and the form's closure (KD-8).
 */
export function checkFinish(args: unknown, resultSchema: z.ZodType<unknown>): FinishCheck {
  const parsed = resultSchema.safeParse(args);
  return parsed.success ? { valid: true, result: parsed.data } : { valid: false };
}
