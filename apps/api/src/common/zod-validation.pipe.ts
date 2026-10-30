import {
  BadRequestException,
  type ArgumentMetadata,
  type PipeTransform,
} from '@nestjs/common';
import type { ZodType, z } from 'zod';

/**
 * Validates a route argument against a zod schema from `@agent-os/contracts`.
 * Returns the parsed (transformed) data; on failure throws 400 with
 * `errorCode: 'VALIDATION_FAILED'` and one `'<path>: <message>'` per issue.
 */
export class ZodValidationPipe<T extends ZodType> implements PipeTransform<
  unknown,
  z.output<T>
> {
  constructor(private readonly schema: T) {}

  transform(value: unknown, _metadata: ArgumentMetadata): z.output<T> {
    const result = this.schema.safeParse(value);
    if (result.success) {
      return result.data;
    }
    throw new BadRequestException({
      statusCode: 400,
      error: 'Bad Request',
      errorCode: 'VALIDATION_FAILED',
      message: result.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      ),
    });
  }
}
