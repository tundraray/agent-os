/** Agents settings (`AgentsConfig`), given by the factory of `AgentsModule.forRootAsync`. */
export const AGENTS_CONFIG = Symbol('AGENTS_CONFIG');
/** The package's logger with `component: 'agents'`; each service adds its own name. */
export const AGENTS_LOGGER = Symbol('AGENTS_LOGGER');
/** The logger's redaction by value over the process's secret memory (`(text: string) => string`). */
export const MASK_SECRETS = Symbol('MASK_SECRETS');

// Ports the composition root implements: the modules it lists in `imports` export them.

/** Rights, quotas and the model catalogue (`AccessGate`; design-access.md KD-1, ADR-0015). */
export const ACCESS_GATE = Symbol('ACCESS_GATE');
/** Writes the `access_denied` record of every refused tool or model call (`AccessAudit`; KD-6). */
export const ACCESS_AUDIT = Symbol('ACCESS_AUDIT');
/** The library of agents and deep agents (`RecordLibrary`): every start asks it for the record. */
export const RECORD_LIBRARY = Symbol('RECORD_LIBRARY');
/** Gets every text part of an agent's answer (`OnTextDelta`; KD-3). Optional: none when not provided. */
export const ON_TEXT_DELTA = Symbol('ON_TEXT_DELTA');

// Seams with a default of the package: a test overrides the provider with a double of `./testing`.

/** The seam of the model (`AgentTurnModelClient`): Mastra over the providers' SDKs by default. */
export const AGENT_TURN_CLIENT = Symbol('AGENT_TURN_CLIENT');
/** The seam of the embeddings provider (`EmbeddingClient`): the AI SDK client by default. */
export const EMBEDDING_CLIENT = Symbol('EMBEDDING_CLIENT');
/** The seam of the code executor (`CodeRunner`): `createCodeRunner` with `CODE_RUN_MAX_CONCURRENT` by default. */
export const CODE_RUNNER = Symbol('CODE_RUNNER');
