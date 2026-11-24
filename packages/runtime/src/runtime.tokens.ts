/** Runtime settings (`RuntimeConfig`), given by the factory of `RuntimeModule.forRootAsync`. */
export const RUNTIME_CONFIG = Symbol('RUNTIME_CONFIG');
/** The runtime's `Clock`: the system clock unless a test overrides the provider. */
export const CLOCK = Symbol('CLOCK');
/** The application logger with `component: 'runtime'`; each service adds its own name. */
export const RUNTIME_LOGGER = Symbol('RUNTIME_LOGGER');
