import type { RecordHeader, ResolvedRecord } from '@agent-os/contracts';

/**
 * The library of agents and workflows as the runtime sees it (design-runtime.md, «Порт `RecordLibrary`»;
 * ADR-0016, ADR-0017). Every read is made on behalf of the employee who starts the run, so the record's
 * author does not decide the start. A record the viewer may not see, a deleted and an unknown one all
 * answer `null`. `apps/api` implements it with `LibraryService`; the tests use `createLibraryDouble`.
 */
export interface RecordLibrary {
  /** The record to start by its id. */
  resolve(viewerId: string, recordId: string): Promise<ResolvedRecord | null>;
  /** The built-in record with this key, such as `chat`. */
  resolveBuiltin(viewerId: string, builtinKey: string): Promise<ResolvedRecord | null>;
  /** Headers of every record the viewer sees. */
  listVisible(viewerId: string): Promise<RecordHeader[]>;
}
