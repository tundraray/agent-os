import { setupServer } from 'msw/node';

/**
 * Shared MSW server for every test. It starts with no handlers: each test declares the API
 * responses it relies on with `server.use(...)`, and any request without a handler fails the test
 * (`onUnhandledRequest: 'error'` in setup.ts).
 */
export const server = setupServer();
