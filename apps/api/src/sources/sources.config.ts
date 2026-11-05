import { FIXTURE_SOURCE_ID, type SourceAllowlist } from '@agent-os/sources';

/**
 * Tools each workflow type may call (design-mcp-source.md, SourceDescriptor и allowlist). `createSources` checks
 * every pair against the adapter's descriptor at startup: a tool that is not read-only stops the start (FR-11).
 * `aggregate_logs` and `get_trace` are the gather tools of `deep-research` (design-engine.md, C2, DC-14).
 */
export const SOURCES_ALLOWLIST: SourceAllowlist = {
  'source.fetch': [
    { sourceId: FIXTURE_SOURCE_ID, toolName: 'search_logs' },
    { sourceId: FIXTURE_SOURCE_ID, toolName: 'aggregate_logs' },
    { sourceId: FIXTURE_SOURCE_ID, toolName: 'get_trace' },
  ],
};

/** Variables of Sources Settings (design-mcp-source.md, Settings) that `SourcesModule` hands to `parseSourcesSettings`. */
const SOURCES_SETTINGS_VARIABLES = [
  'SOURCE_CALL_TIMEOUT_MS',
  'SOURCE_RETRY_BASE_MS',
  'SOURCE_RETRY_CAP_MS',
  'SOURCE_MAX_PAGES',
  'FIXTURE_DATASET',
  'FIXTURE_FAULTS',
  'FIXTURE_CALL_LOG',
] as const;

/** The Sources Settings variables as `read` (the assembly point's environment) sees them. */
export function sourcesSettingsVariables(
  read: (name: string) => string | undefined,
): Record<string, string | undefined> {
  return Object.fromEntries(
    SOURCES_SETTINGS_VARIABLES.map((name) => [name, read(name)]),
  );
}
