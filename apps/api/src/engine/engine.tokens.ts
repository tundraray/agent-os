/**
 * Providers of `EngineModule`, the assembly point of `@agent-os/engine` in `apps/api` (design-engine.md, C2; ADR-0004).
 */

/**
 * The `Engine` built by `createEngine`; `chat-entry` injects it. It resolves before the engine is created and is
 * bound in `EngineModule.onModuleInit`, so it must not be used before the application has initialised.
 */
export const RESEARCH_ENGINE = Symbol('RESEARCH_ENGINE');

/** The `resolveModel` port the engine's role agents take their models from (KD-7); tests replace it with a double. */
export const ENGINE_RESOLVE_MODEL = Symbol('ENGINE_RESOLVE_MODEL');

/** The `TokenCounter` the engine counts every agent turn with (DC-30); tests replace it with a double. */
export const ENGINE_TOKEN_COUNTER = Symbol('ENGINE_TOKEN_COUNTER');

/**
 * The process configurations `createEngine` loads, `[deepResearchProcessV3]` by default; tests replace them with
 * `overrideProvider`. Not an environment setting (design-engine.md: no new settings).
 */
export const ENGINE_PROCESSES = Symbol('ENGINE_PROCESSES');

/**
 * The group tables `createEngine` loads, the shipped ones by default. The server start requires the table of each
 * process's checker agent (`Engine.checkCalibration`, DC-10); tests replace it with a table for the loaded configuration.
 */
export const ENGINE_GROUP_TABLES = Symbol('ENGINE_GROUP_TABLES');

/**
 * The rights port of agent tool calls `createEngine` takes (design-catalog-planning.md, KD-6): the `SourceAccessTable`
 * of `SOURCE_ACCESS_TABLE` by default; tests that run investigations on sources without checking rights replace it with
 * the allow-all double of `test/support/accessDoubles.ts`.
 */
export const SOURCE_ACCESS_POLICY = Symbol('SOURCE_ACCESS_POLICY');
