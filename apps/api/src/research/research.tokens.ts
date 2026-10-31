/**
 * Providers `ResearchModule` exports to other Nest modules (the composition root of the research
 * runtime, ADR-0004). A consumer module imports `ResearchModule` and registers its task handlers
 * in its own `onModuleInit`; the workers start later, in `onApplicationBootstrap`.
 */

/** The `Runtime` built by `createRuntime` (`@agent-os/runtime`). */
export const RESEARCH_RUNTIME = Symbol('RESEARCH_RUNTIME');

/** `runtime.handlers`: the `HandlerRegistry` task handlers are registered in. */
export const HANDLER_REGISTRY = Symbol('HANDLER_REGISTRY');

/** The system `Clock` the runtime was built with. */
export const RUNTIME_CLOCK = Symbol('RUNTIME_CLOCK');
