'use client';

import { useEffect, useState } from 'react';
import type { SpendResponse } from '@agent-os/contracts';
import { logger } from '@/lib/logger';
import { threadsApiClient } from '@/lib/threads/threads-api-client';
import { describeApiError } from '@/lib/api/api-request';

/** SP-01 as the user block reads it; the block words it (design-web.md, KD-5). */
export type SpendState =
  | { kind: 'loading' }
  | { kind: 'ready'; spend: SpendResponse }
  | { kind: 'error' };

// The figure is read once per page load (design-web.md, FR-29): the drawer and the icon strip remount
// the user block, so the read lives at module level, not in the component. A failure stays until reload.
let spendRead: Promise<SpendState> | null = null;
let spendSettled: SpendState | null = null;

function readSpendOnce(): Promise<SpendState> {
  if (spendRead !== null) return spendRead;
  spendRead = threadsApiClient.getSpend().then(
    (spend): SpendState => ({ kind: 'ready', spend }),
    (error: unknown): SpendState => {
      logger.warn('spend read failed', describeApiError(error));
      return { kind: 'error' };
    },
  );
  void spendRead.then((state) => {
    spendSettled = state;
  });
  return spendRead;
}

/** SP-01: the month's spend, read the first time the shell's user block mounts. */
export function useSpend(): SpendState {
  const [state, setState] = useState<SpendState>(
    () => spendSettled ?? { kind: 'loading' },
  );

  useEffect(() => {
    let mounted = true;
    void readSpendOnce().then((next) => {
      if (mounted) setState(next);
    });
    return () => {
      mounted = false;
    };
  }, []);

  return state;
}
