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

/** The `TokenCounter` the engine counts every role packet with (KD-4); tests replace it with a double. */
export const ENGINE_TOKEN_COUNTER = Symbol('ENGINE_TOKEN_COUNTER');
