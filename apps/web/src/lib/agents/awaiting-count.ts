'use client';

import { useEffect, useState } from 'react';
import { useShellServices } from '@/components/shell/shell-actions';
import { createCoalescedRunner } from '@/lib/live/coalesced-runner';
import { logger } from '@/lib/logger';
import { describeThreadsError } from '@/lib/threads/threads-api-error';

/** design-web.md, «Сайдбар»: the counter re-reads by `tree` notes no more than once a second. */
const REREAD_INTERVAL_MS = 1000;

/**
 * NV-01: open decision requests in all the employee's conversations. Read on mount, on every `ready`
 * and on any `tree` note; a failed read keeps the previous number.
 */
export function useAwaitingCount(): number {
  const { apiClient, live } = useShellServices();
  const [count, setCount] = useState(0);

  useEffect(() => {
    let mounted = true;
    // Resolves in every case, so the runner never hands a rejection to `request()` callers.
    const runner = createCoalescedRunner(
      async () => {
        try {
          const awaiting = await apiClient.getAwaitingCount();
          if (mounted) setCount(awaiting.count);
        } catch (error) {
          logger.warn('awaiting count read failed', describeThreadsError(error));
        }
      },
      { minIntervalMs: REREAD_INTERVAL_MS },
    );
    const read = (): void => {
      void runner.request();
    };
    const unsubscribers = [live.onTree(read), live.onReady(read)];
    read();
    return () => {
      mounted = false;
      for (const unsubscribe of unsubscribers) unsubscribe();
      runner.cancel();
    };
  }, [apiClient, live]);

  return count;
}
