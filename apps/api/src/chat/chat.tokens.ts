/** Providers of `ChatModule` other than its classes. */

/**
 * The page size of `GET /agents`: `AGENT_PAGE_SIZE` of `@agent-os/contracts`; a test overrides this
 * provider to walk the cursor over a few agents.
 */
export const AGENT_LIST_PAGE_SIZE = Symbol('AGENT_LIST_PAGE_SIZE');
