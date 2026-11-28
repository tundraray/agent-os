import { z } from 'zod';
import { UpdateModelDefaultsBodySchema } from './access';
import { UpdateSignInSettingsBodySchema } from './identity';
import {
  INSTRUCTIONS_MAX_LENGTH,
  UpdateLibrarySettingsBodySchema,
} from './library';
import { UpdateSelfLearningSettingsBodySchema } from './memory';
import { UpdateToolResultSettingsBodySchema } from './tool-results';

/**
 * The keys of the `settings` table (data-model design-schema.md KD-3): one group of settings an administrator
 * changes with one form. A key is also the `objectType` of the group's `admin_change` audit record.
 */
export const SettingsKeySchema = z.enum([
  'sign_in_settings',
  'library_settings',
  'tool_result_settings',
  'model_defaults',
  'self_learning_settings',
  'organisation_instructions',
]);
export type SettingsKey = z.infer<typeof SettingsKeySchema>;

/**
 * Body of PUT /api/admin/instructions and the value of `organisation_instructions` (agent-guidance
 * design-server.md, «Инструкции»): an empty text clears the instruction.
 */
export const UpdateOrganisationInstructionsBodySchema = z.object({
  text: z.string().max(INSTRUCTIONS_MAX_LENGTH),
});
export type UpdateOrganisationInstructionsBody = z.infer<
  typeof UpdateOrganisationInstructionsBodySchema
>;

/** The schema of each key's value; a new key comes with its schema here and its default row in the migration. */
export const SETTINGS_VALUE_SCHEMAS = {
  sign_in_settings: UpdateSignInSettingsBodySchema,
  library_settings: UpdateLibrarySettingsBodySchema,
  tool_result_settings: UpdateToolResultSettingsBodySchema,
  model_defaults: UpdateModelDefaultsBodySchema,
  self_learning_settings: UpdateSelfLearningSettingsBodySchema,
  organisation_instructions: UpdateOrganisationInstructionsBodySchema,
} satisfies Record<SettingsKey, z.ZodType>;

/** The value of a key as its schema gives it. */
export type SettingsValue<K extends SettingsKey> = z.infer<
  (typeof SETTINGS_VALUE_SCHEMAS)[K]
>;

/** The stored value of the key, parsed by its schema; throws on a value outside it — never a default. */
export function parseSettingsValue<K extends SettingsKey>(
  key: K,
  value: unknown,
): SettingsValue<K> {
  const parsed = SETTINGS_VALUE_SCHEMAS[key].safeParse(value);
  if (!parsed.success)
    throw new Error(
      `settings value of ${key} fails its schema: ${parsed.error.message}`,
    );
  return parsed.data as SettingsValue<K>;
}
