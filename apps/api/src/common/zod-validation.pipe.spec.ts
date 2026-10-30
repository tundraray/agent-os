import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { ZodValidationPipe } from './zod-validation.pipe.js';

const metadata = { type: 'body' } as const;

const captureBadRequest = (run: () => unknown): BadRequestException => {
  try {
    run();
  } catch (error) {
    if (error instanceof BadRequestException) {
      return error;
    }
    throw error;
  }
  throw new Error('Expected the pipe to throw');
};

describe('ZodValidationPipe', () => {
  it('returns the parsed data, not the original value', () => {
    const pipe = new ZodValidationPipe(
      z.object({ title: z.string().trim().min(1) }),
    );

    const result: unknown = pipe.transform(
      { title: '  Trip plan  ' },
      metadata,
    );

    expect(result).toEqual({ title: 'Trip plan' });
  });

  it('strips keys the schema does not declare', () => {
    const pipe = new ZodValidationPipe(z.object({ title: z.string() }));

    const result: unknown = pipe.transform({ title: 'x', extra: 1 }, metadata);

    expect(result).toEqual({ title: 'x' });
  });

  it('throws 400 VALIDATION_FAILED with field paths on a schema error', () => {
    const pipe = new ZodValidationPipe(
      z.object({
        title: z.string().trim().min(1, 'Too short'),
        meta: z.object({ tag: z.string({ error: 'Expected tag' }) }),
      }),
    );

    const error = captureBadRequest(() =>
      pipe.transform({ title: '   ', meta: {} }, metadata),
    );

    expect(error.getStatus()).toBe(400);
    expect(error.getResponse()).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      errorCode: 'VALIDATION_FAILED',
      message: ['title: Too short', 'meta.tag: Expected tag'],
    });
  });

  it('labels a root-level error as (root)', () => {
    const pipe = new ZodValidationPipe(
      z.string({ error: 'Expected a string' }),
    );

    const error = captureBadRequest(() => pipe.transform(42, metadata));

    expect(error.getResponse()).toEqual({
      statusCode: 400,
      error: 'Bad Request',
      errorCode: 'VALIDATION_FAILED',
      message: ['(root): Expected a string'],
    });
  });
});
