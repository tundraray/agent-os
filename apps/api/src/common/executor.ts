import type { Database } from '@agent-os/db';
import type { RuntimeTx } from '@agent-os/runtime';

/**
 * What a repository function runs its queries on (repository-over-transaction.md): the caller's
 * transaction or the plain client; it is always the function's first parameter.
 */
export type Executor = Database | RuntimeTx;
