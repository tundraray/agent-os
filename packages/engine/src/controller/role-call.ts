import type { TaskContext } from '@agent-os/runtime';
import type { z } from 'zod';
import { answerSaver, checkpointedAnswer } from '../attempt/checkpoint.js';
import type { ProcessConfig } from '../config/process-config.schema.js';
import type { ModelRole } from '../model/ledger.js';
import type { ModelGateway } from '../model/model-gateway.js';
import type { RoleMessage } from '../model/token-counter.js';
import { type ControllerCallOutcome, controllerCallOutcome } from './stop-rules.js';

/** One model call of the controller task, named by `call` in the checkpoint. */
export interface ControllerRoleCall<T> {
  readonly ctx: TaskContext;
  readonly role: Extract<ModelRole, 'plan' | 'controller'>;
  readonly roleConfig: ProcessConfig['roles']['plan'];
  readonly call: string;
  readonly instructions: string;
  readonly messages: readonly RoleMessage[];
  readonly outputSchema: z.ZodType<T>;
  readonly notAfter: Date;
}

/**
 * Invariant 3: an answer saved by an earlier attempt for this very call is taken from the checkpoint without a model
 * call; otherwise `ModelGateway` calls the model and saves the answer before anything is written from it.
 */
export async function callOrReplay<T>(gateway: ModelGateway, request: ControllerRoleCall<T>): Promise<ControllerCallOutcome<T>> {
  const saved = checkpointedAnswer(request.ctx, request.call);
  if (saved !== undefined) {
    return { outcome: 'answered', output: request.outputSchema.parse(saved.output) };
  }
  const result = await gateway.call({
    ctx: request.ctx,
    role: request.role,
    roleConfig: request.roleConfig,
    instructions: request.instructions,
    messages: request.messages,
    outputSchema: request.outputSchema,
    notAfter: request.notAfter,
    checkpointAnswer: answerSaver(request.ctx, request.call),
  });
  return controllerCallOutcome(result);
}
