/**
 * Logger port of the sources package (design-mcp-source.md, Logging and Monitoring), given by the assembly point
 * (in `apps/api` — an adapter over the Nest `Logger`). Levels: `warn` — a retry, a process restart,
 * `snapshot_changed`, `stopped`; `error` — K-3, K-9, K-13; `debug` — a late answer and the fixture's stderr. Fields
 * carry `taskId`, `attempt`, `sourceId`, `toolName`, `callIndex`, class, code and duration — never arguments,
 * records or the text of `isError`.
 *
 * The interface is declared next to its first consumer, `ToolExecutor`; this module is the port's public name.
 */
export type { SourcesLogger } from './tool-executor.js';
