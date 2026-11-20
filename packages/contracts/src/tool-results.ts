import { z } from 'zod';

/**
 * Settings of large tool results (tool-result-reading plan, R-5): the row `agent_tool_result_settings`.
 * Characters are JavaScript string characters; tokens are the platform's estimate of UTF-8 bytes.
 */

/** An MCP result longer than this many characters reaches the model as a wrapper with a preview. */
export const TOOL_RESULT_STORE_FROM_CHARS_MIN = 1_000;
export const TOOL_RESULT_STORE_FROM_CHARS_MAX = 1_000_000;
export const TOOL_RESULT_STORE_FROM_CHARS_DEFAULT = 50_000;

/** Characters of the preview in the wrapper. */
export const TOOL_RESULT_PREVIEW_CHARS_MIN = 200;
export const TOOL_RESULT_PREVIEW_CHARS_MAX = 20_000;
export const TOOL_RESULT_PREVIEW_CHARS_DEFAULT = 2_000;

/** Tokens of one page or one search answer; the minimum holds one line of 2 000 characters. */
export const TOOL_RESULT_READ_MAX_TOKENS_MIN = 2_000;
export const TOOL_RESULT_READ_MAX_TOKENS_MAX = 100_000;
export const TOOL_RESULT_READ_MAX_TOKENS_DEFAULT = 25_000;

const toolResultSettingsFields = {
  storeFromChars: z
    .number()
    .int()
    .min(TOOL_RESULT_STORE_FROM_CHARS_MIN)
    .max(TOOL_RESULT_STORE_FROM_CHARS_MAX),
  previewChars: z
    .number()
    .int()
    .min(TOOL_RESULT_PREVIEW_CHARS_MIN)
    .max(TOOL_RESULT_PREVIEW_CHARS_MAX),
  readMaxTokens: z
    .number()
    .int()
    .min(TOOL_RESULT_READ_MAX_TOKENS_MIN)
    .max(TOOL_RESULT_READ_MAX_TOKENS_MAX),
};

/** Body of PUT /api/admin/tool-results/settings: the preview is shorter than the threshold. */
export const UpdateToolResultSettingsBodySchema = z
  .strictObject(toolResultSettingsFields)
  .refine((body) => body.previewChars < body.storeFromChars, {
    path: ['previewChars'],
    message: 'previewChars must be less than storeFromChars',
  });
export type UpdateToolResultSettingsBody = z.infer<typeof UpdateToolResultSettingsBodySchema>;

/** Response of GET/PUT /api/admin/tool-results/settings. `updatedAt: null` while the defaults stand. */
export const ToolResultSettingsSchema = z.object({
  ...toolResultSettingsFields,
  updatedAt: z.iso.datetime().nullable(),
});
export type ToolResultSettings = z.infer<typeof ToolResultSettingsSchema>;
