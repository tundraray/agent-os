// Vitest global setup of the package's Postgres suites: migrations once, before any test file builds a runtime.
export { migrate as default } from '@agent-os/db/testing';
