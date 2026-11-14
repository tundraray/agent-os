/** Providers of `RuntimeModule`, the composition root of the runtime in `apps/api` (design-runtime.md, C2 `api`). */

/** The application's single pool and its Drizzle client (`DatabaseConnection`). */
export const RUNTIME_DATABASE = Symbol('RUNTIME_DATABASE');

/** The system clock (`Clock` of `@agent-os/runtime`): current time, randomness and one-shot timers. */
export const RUNTIME_CLOCK = Symbol('RUNTIME_CLOCK');

/** Runtime settings (`RuntimeConfig`) read from the environment by `readRuntimeSettings`. */
export const RUNTIME_SETTINGS = Symbol('RUNTIME_SETTINGS');

/**
 * The assembled runtime (`Runtime` of `@agent-os/runtime`). Upper modules register their handlers and
 * event consumers on it in their `onModuleInit`, before `RuntimeModule` starts it.
 */
export const RUNTIME = Symbol('RUNTIME');
