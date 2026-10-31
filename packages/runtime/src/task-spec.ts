import {
  type ProposeResult,
  TaskSpecSchema,
  type TaskSpec,
} from '@agent-os/contracts';
import type { z } from 'zod';
import type { HandlerRegistry, TaskHandler } from './handler.registry.js';

/** A refused proposal: a value, never an exception. */
export type ProposeRejection = Extract<ProposeResult, { outcome: 'rejected' }>;

export type TaskSpecCheck =
  | { ok: true; spec: TaskSpec; handler: TaskHandler }
  | { ok: false; rejection: ProposeRejection };

export const rejection = (
  reason: ProposeRejection['reason'],
  details: ProposeRejection['details'],
): ProposeRejection => ({ outcome: 'rejected', reason, details });

/** `invalid_spec` naming the first offending field, e.g. `inputRefs.0.snapshot`. */
function invalidSpec(error: z.ZodError, prefix: readonly PropertyKey[]) {
  const [issue] = error.issues;
  const path = [...prefix, ...issue.path].map(String).join('.');
  return rejection('invalid_spec', { path, message: issue.message });
}

/**
 * Admission checks that need no database (Data Contract, TaskScheduler.propose): `TaskSpecSchema`,
 * then a registered handler of the type and version, then the handler's `inputSchema` over
 * `input`. The spec is returned as parsed, so unknown fields never reach storage.
 */
export function checkTaskSpec(
  raw: unknown,
  handlers: Pick<HandlerRegistry, 'get'>,
): TaskSpecCheck {
  const parsed = TaskSpecSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, rejection: invalidSpec(parsed.error, []) };
  }
  const spec = parsed.data;

  const handler = handlers.get(spec.workflowType, spec.workflowVersion);
  if (!handler) {
    return {
      ok: false,
      rejection: rejection('unknown_workflow', {
        workflowType: spec.workflowType,
        workflowVersion: spec.workflowVersion,
      }),
    };
  }

  const input = handler.inputSchema.safeParse(spec.input);
  if (!input.success) {
    return { ok: false, rejection: invalidSpec(input.error, ['input']) };
  }
  return { ok: true, spec, handler };
}
