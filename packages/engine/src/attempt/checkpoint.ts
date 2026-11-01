import type { TaskContext } from '@agent-os/runtime';
import { z } from 'zod';

/**
 * The model answer an attempt saved before the guarded writes it causes (invariant 3). `call` names the call it answers,
 * so the next attempt reuses it only for the same call and asks the model again for any other.
 */
const ModelAnswerCheckpointSchema = z.object({
  call: z.string().min(1),
  output: z.unknown(),
});

/** The saved answer of `call`, or `undefined` when the checkpoint holds none or another call's. */
export function checkpointedAnswer(ctx: Pick<TaskContext, 'checkpoint'>, call: string): { readonly output: unknown } | undefined {
  const parsed = ModelAnswerCheckpointSchema.safeParse(ctx.checkpoint);
  if (!parsed.success || parsed.data.call !== call) {
    return undefined;
  }
  return { output: parsed.data.output };
}

/** The `checkpointAnswer` hook of `ModelGateway` for `call`: the answer is saved before any write it causes. */
export function answerSaver(ctx: Pick<TaskContext, 'saveCheckpoint'>, call: string): (output: unknown) => Promise<void> {
  return (output) => ctx.saveCheckpoint({ call, output });
}
