import { parseSettingsValue, type SettingsValue } from '@agent-os/contracts';
import type { SettingsRepository } from '@agent-os/db';

/**
 * The key `tool_result_settings` of `settings`, parsed by its schema (data-model KD-3). Read anew on every MCP
 * call and every reading, so a change takes effect on the next one without a restart.
 */
export async function readToolResultSettings(
  settingsRows: Pick<SettingsRepository, 'read'>,
): Promise<SettingsValue<'tool_result_settings'>> {
  const row = await settingsRows.read('tool_result_settings');
  return parseSettingsValue('tool_result_settings', row.value);
}
