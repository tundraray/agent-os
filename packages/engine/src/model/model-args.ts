import { z } from 'zod';

/**
 * Tool arguments as a role model returns them: a JSON object written as a string. The provider's native `json_schema`
 * output accepts an object only with `additionalProperties: false`, so a free-form argument object cannot be part of
 * the output schema; code parses the string with {@link parseModelArgs} and checks it against the tool's descriptor.
 */
export const ModelArgsSchema = z
  .string()
  .describe('The tool arguments as one JSON object written as a string, e.g. {"service":"payments","pageSize":50}');

/** The arguments object a model wrote as JSON text, or null when the text is not a JSON object. */
export function parseModelArgs(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
}

/**
 * {@link ModelArgsSchema} for an output whose arguments the gateway itself must refuse: text that is not a JSON object
 * makes the whole output invalid (one retry, then `invalid_model_output`) — the verifier's requests. The JSON schema sent
 * to the provider is the same string; only the check after the answer differs.
 */
export const ModelArgsObjectSchema = ModelArgsSchema.refine((text) => parseModelArgs(text) !== null, {
  message: 'args is not a JSON object',
});
