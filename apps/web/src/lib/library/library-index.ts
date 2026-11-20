import type { RecordSummary } from '@agent-os/contracts';
import { createStore, type StoreApi } from 'zustand/vanilla';
import { describeApiError } from '@/lib/api/api-request';
import { createCoalescedRunner } from '@/lib/live/coalesced-runner';
import type { logger as appLogger } from '@/lib/logger';

export type LibraryIndexStatus = 'idle' | 'loading' | 'ready' | 'error';

export type LibraryIndexState = {
  /** `idle` before the first read; `error` — the last read failed, `records` keeps the list before it. */
  status: LibraryIndexStatus;
  /** The records the viewer sees, by id; `null` until a read succeeds. */
  records: ReadonlyMap<string, RecordSummary> | null;
};

/**
 * The live data of library records for every screen (design-web.md, KD-2): one `GET /api/library`
 * shared by the library, the run labels, the cards and the editors.
 */
export type LibraryIndex = StoreApi<LibraryIndexState> & {
  /**
   * Reads the list. Asked while a read is in flight, it gets one more read after that one (shared by every
   * request made meanwhile), so the list it settles with is read after the caller's own change. Never rejects.
   */
  refresh: () => Promise<void>;
  /** The row of `recordId`; `null` — the list is read and the record is not in it; `undefined` — not read yet. */
  summaryOf: (recordId: string) => RecordSummary | null | undefined;
};

export type CreateLibraryIndexInput = {
  read: () => Promise<RecordSummary[]>;
  logger: Pick<typeof appLogger, 'warn'>;
};

export function createLibraryIndex({ read, logger }: CreateLibraryIndexInput): LibraryIndex {
  const store = createStore<LibraryIndexState>()(() => ({ status: 'idle', records: null }));

  async function readList(): Promise<void> {
    store.setState({ status: 'loading' });
    try {
      const rows = await read();
      store.setState({ status: 'ready', records: new Map(rows.map((row) => [row.id, row])) });
    } catch (error) {
      // The list before the failure stays: a label keeps its last known state (Flow 3, Failure handling).
      logger.warn('library: list read failed', describeApiError(error));
      store.setState({ status: 'error' });
    }
  }

  // `readList` never rejects, so neither does a request of the runner.
  const reads = createCoalescedRunner(readList, { minIntervalMs: 0 });

  return Object.assign(store, {
    refresh: (): Promise<void> => reads.request(),
    summaryOf: (recordId: string): RecordSummary | null | undefined => {
      const { records } = store.getState();
      return records === null ? undefined : (records.get(recordId) ?? null);
    },
  });
}
