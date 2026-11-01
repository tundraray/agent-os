// The package entry `.`; the engine components are exported here as they land.
export type { ModelCatalog, ModelCatalogEntry } from './config/model-catalog.js';
export type { SourceMode } from './config/source-check.js';
export { createEngine, type CreateEngineOptions } from './create-engine.js';
export type { Engine, RecordSignalInput, RecordSignalResult } from './engine.js';
export {
  loadProcessConfig,
  type LoadProcessConfigResult,
  type ProcessConfig,
  type ProcessConfigRejection,
} from './config/load-process-config.js';
export {
  AnthropicTokenCounter,
  type AnthropicTokenCounterOptions,
} from './model/anthropic-token-counter.js';
export type {
  RoleMessage,
  TokenCounter,
  TokenCountRequest,
  TokenCountResult,
} from './model/token-counter.js';
export type { EngineLogFields, EngineLogger, ResolveModel, RoleModel } from './ports.js';
export { deepResearchProcessV1 } from './processes/shipped-processes.js';
export type { SignalKind, SignalPayloadSchema } from './signals/signal-registry.js';
export type {
  EngineRuntimePorts,
  StartInvestigationInput,
  StartInvestigationResult,
} from './runs/start-investigation.js';
export type {
  InvestigationView,
  InvestigationViewStatus,
  ReadInvestigationResult,
} from './view/investigation-view.js';
