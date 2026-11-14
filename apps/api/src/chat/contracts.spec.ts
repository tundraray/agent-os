import {
  DecisionRequestSchema,
  HistoryQuerySchema,
  InterruptRequestSchema,
  RenameThreadRequestSchema,
  SendMessageRequestSchema,
  ThreadListQuerySchema,
} from '@agent-os/contracts';
import type { ZodType } from 'zod';

type Row = {
  name: string;
  schema: ZodType;
  input: unknown;
  /** The parsed value, or `null` when the schema must refuse the input (400 VALIDATION_FAILED). */
  expected: unknown;
};

const repeat = (length: number): string => 'a'.repeat(length);

// AC-14.3 (the input rules of the chat API), VALIDATION_FAILED: what the routes' ZodValidationPipe accepts.
describe('chat API schemas', () => {
  it.each<Row>([
    { name: 'message: empty text', schema: SendMessageRequestSchema, input: { text: '' }, expected: null },
    { name: 'message: whitespace-only text', schema: SendMessageRequestSchema, input: { text: ' \n\t ' }, expected: null },
    { name: 'message: 20001 characters', schema: SendMessageRequestSchema, input: { text: repeat(20001) }, expected: null },
    {
      name: 'message: 20000 characters after trim',
      schema: SendMessageRequestSchema,
      input: { text: `  ${repeat(20000)}  ` },
      expected: { text: repeat(20000) },
    },
    { name: 'interrupt: no text', schema: InterruptRequestSchema, input: {}, expected: {} },
    { name: 'interrupt: whitespace-only text', schema: InterruptRequestSchema, input: { text: '  ' }, expected: null },
    { name: 'rename: whitespace-only title', schema: RenameThreadRequestSchema, input: { title: '  ' }, expected: null },
    { name: 'rename: title is trimmed', schema: RenameThreadRequestSchema, input: { title: ' Отчёт ' }, expected: { title: 'Отчёт' } },
    { name: 'rename: 201 characters', schema: RenameThreadRequestSchema, input: { title: repeat(201) }, expected: null },
    { name: 'history: afterSeq -1', schema: HistoryQuerySchema, input: { afterSeq: '-1' }, expected: null },
    { name: 'history: afterSeq "x"', schema: HistoryQuerySchema, input: { afterSeq: 'x' }, expected: null },
    { name: 'history: afterSeq absent', schema: HistoryQuerySchema, input: {}, expected: { afterSeq: 0 } },
    { name: 'list: cursor of 513 characters', schema: ThreadListQuerySchema, input: { cursor: repeat(513) }, expected: null },
    { name: 'decision: no approve', schema: DecisionRequestSchema, input: { args: { question: 'q' } }, expected: null },
  ])('chat API schemas accept the documented inputs and refuse the rest: $name', ({ schema, input, expected }) => {
    const parsed = schema.safeParse(input);

    if (expected === null) {
      expect(parsed.success).toBe(false);
    } else {
      expect(parsed).toEqual({ success: true, data: expected });
    }
  });
});
