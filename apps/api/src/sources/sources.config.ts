import {
  BACKOFFICE_SOURCE_ID,
  FIXTURE_SOURCE_ID,
  type SourceDeclaration,
} from '@agent-os/sources';

/**
 * The project's sources and what each holds (design-catalog-planning.md, KD-2): the single place their descriptions
 * live, and the `source.fetch` allowlist. `createSources` checks it against the adapters at startup: a declared source
 * without an adapter, a missing or overlong description or a tool that is not read-only stops the start (AC-01.1,
 * FR-11). The texts are the project's own; what the MCP server reports about its tools is never read (AC-01.2).
 */
export const SOURCES_DECLARATION: SourceDeclaration = [
  {
    sourceId: FIXTURE_SOURCE_ID,
    description:
      'Payment logs: one record per log line of the checkout and payment services, with time, service, level, ' +
      'event, status, traceId, duration and message. Answers what failed, when, how often and in which service. ' +
      'Holds no order amounts or payment methods; order numbers appear only inside messages; times are UTC.',
    tools: [
      {
        name: 'search_logs',
        description:
          'Log records in a time window, filtered by service, level, event or status, oldest first and paged by ' +
          'cursor. Use it to read the failing lines themselves; for example records, gather it with completeness sample ' +
          'and pageSize 50 or less.',
      },
      {
        name: 'aggregate_logs',
        description:
          'Counts of log records in a time window per 15-minute or hourly bucket and per value of one field. ' +
          'Use it to see when a failure started, peaked and stopped, and to learn the values of a field before ' +
          'filtering by it.',
      },
      {
        name: 'get_trace',
        description:
          'All log records of one request, by its traceId, oldest first. Use it to follow one payment through ' +
          'every service.',
      },
    ],
  },
  {
    sourceId: BACKOFFICE_SOURCE_ID,
    description:
      'Back office: the orders of the shop with amount, status (paid or failed) and payment method, and every ' +
      'payment attempt with its outcome and failure reason. Answers which orders a failure hit, how much money ' +
      'was at stake and why a payment was declined. Holds no log lines; each payment names the traceId of its logs.',
    tools: [
      {
        name: 'search_orders',
        description:
          'Orders created in a time window, filtered by status or payment method, oldest first and paged by ' +
          'cursor. Use it to count and list the orders a failure affected.',
      },
      {
        name: 'get_order',
        description:
          'One order by its number (ord-…) with all its payment attempts, their outcomes, failure reasons and ' +
          'traceIds. Use it to explain what happened to a given order.',
      },
    ],
  },
];

/** Variables of Sources Settings (design-mcp-source.md, Settings) that `SourcesModule` hands to `parseSourcesSettings`. */
const SOURCES_SETTINGS_VARIABLES = [
  'SOURCE_CALL_TIMEOUT_MS',
  'SOURCE_RETRY_BASE_MS',
  'SOURCE_RETRY_CAP_MS',
  'SOURCE_MAX_PAGES',
  'FIXTURE_DATASET',
  'FIXTURE_SCENARIO',
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
