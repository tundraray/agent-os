import { z } from 'zod';
import type { LogDataset } from '../dataset.js';

/** Outcome of one tool call: a JSON result, or a rejection the server turns into an `isError` result. */
export type ToolCallOutcome = { ok: true; result: Record<string, unknown> } | { ok: false; error: string };

/** A read-only fixture tool as the server lists and calls it. */
export interface FixtureTool {
  name: string;
  description: string;
  /** JSON Schema of the arguments, generated from the zod schema. */
  inputSchema: { type: 'object'; [keyword: string]: unknown };
  call(args: unknown, dataset: LogDataset): ToolCallOutcome;
}

interface ToolDefinition<Schema extends z.ZodType> {
  name: string;
  description: string;
  argsSchema: Schema;
  /** Returns an error string for a rejection that depends on the data (an invalid cursor). */
  run(args: z.output<Schema>, dataset: LogDataset): Record<string, unknown> | string;
}

/** Binds a zod argument schema to its handler; arguments outside the schema are rejected before the handler runs. */
export function defineTool<Schema extends z.ZodObject>(definition: ToolDefinition<Schema>): FixtureTool {
  return {
    name: definition.name,
    description: definition.description,
    // `argsSchema` is a zod object, so the JSON Schema root is an object.
    inputSchema: { ...z.toJSONSchema(definition.argsSchema, { io: 'input' }), type: 'object' },
    call(args, dataset) {
      const parsed = definition.argsSchema.safeParse(args ?? {});
      if (!parsed.success) {
        return { ok: false, error: `invalid arguments for ${definition.name}: ${z.prettifyError(parsed.error)}` };
      }
      const result = definition.run(parsed.data, dataset);
      return typeof result === 'string' ? { ok: false, error: result } : { ok: true, result };
    },
  };
}
