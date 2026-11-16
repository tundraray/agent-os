import type { ArgumentMetadata, PipeTransform } from '@nestjs/common';
import type { ZodType, z } from 'zod';
import { apiError } from './api-error.js';

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
    throw apiError(
      400,
      'VALIDATION_FAILED',
      result.error.issues.map(
        (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
      ),
    );
  }
}
