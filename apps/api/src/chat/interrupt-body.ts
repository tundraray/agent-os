import { InterruptRequestSchema } from '@agent-os/contracts';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';

const interruptBody = new ZodValidationPipe(InterruptRequestSchema);

/** The text of an interrupt request; the body may be absent: no text is the same as `{}`. */
export const interruptTextOf = (body: unknown): string | undefined =>
  interruptBody.transform(body ?? {}, { type: 'body' }).text;
