export type {
  CallOutcome,
  ClassificationRow,
  NormalizedPage,
  PageOutcome,
  SourceAdapter,
  SourceCall,
  SourceDescriptor,
  SourceSchema,
  SourceToolDescriptor,
  ToolErrorOutcome,
  TotalRelation,
  TransportFailure,
  TransportFailureCode,
} from './source-adapter.js';
export {
  MCP_STDIO_MAX_BUFFER_BYTES,
  McpSourceClient,
  type McpRequestOptions,
  type McpSourceClientLogger,
  type McpSourceClientOptions,
  type McpToolRequest,
  type McpToolResponse,
} from './mcp/mcp-source-client.js';
export { classifyMcpError } from './mcp/mcp-error-classifier.js';
export { McpStartupError } from './mcp/mcp-startup-error.js';
export { createSources, type CreateSourcesOptions, type Sources } from './create-sources.js';
export type { SourcesLogger } from './sources-logger.js';
export {
  createSourceRegistry,
  type ResolvedSourceTool,
  type SourceRegistry,
  type SourceToolRequest,
} from './source-registry.js';
export {
  SOURCE_DESCRIPTION_MAX_CHARS,
  SOURCE_FETCH_WORKFLOW,
  TOOL_DESCRIPTION_MAX_CHARS,
  type DeclaredSource,
  type DeclaredTool,
  type SourceDeclaration,
} from './source-declaration.js';
export { parseSourcesSettings, type FixtureSettings, type SourcesEnv, type SourcesSettings } from './sources.settings.js';
export { FIXTURE_SOURCE_ID, FixtureSourceAdapter, type FixtureSourceAdapterOptions } from './fixture/fixture-source.adapter.js';
export { BACKOFFICE_SOURCE_ID, BackofficeSourceAdapter } from './backoffice/backoffice-source.adapter.js';
