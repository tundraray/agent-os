'use client';

import { useEffect, useState } from 'react';
import type { SpendResponse } from '@agent-os/contracts';
import { logger } from '@/lib/logger';
import { threadsApiClient } from '@/lib/threads/threads-api-client';
import { describeThreadsError } from '@/lib/threads/threads-api-error';

/** SP-01 as the user block shows it. */
export type SpendState = { kind: 'loading' } | { kind: 'ready'; text: string } | { kind: 'error' };

/** MC-2. */
export const SPEND_LOADING_TEXT = 'Загружаем расход…';
export const SPEND_ERROR_TEXT = 'Расход недоступен';

const MONTH_NAMES = [
  'январь',
  'февраль',
  'март',
  'апрель',
  'май',
  'июнь',
  'июль',
  'август',
  'сентябрь',
  'октябрь',
  'ноябрь',
  'декабрь',
] as const;

/** U+202F, the digit-group separator MC-2 asks for. */
const NARROW_NO_BREAK_SPACE = ' ';

/**
 * MC-2: «Расход за {месяц}: {сумма}». `2026-11` reads «ноябрь»; the sum has two decimals after a comma,
 * digit groups split by U+202F, then « $» — zero reads «0,00 $».
 */
function formatSpend({ month, costUsd }: SpendResponse): string {
  const monthName = MONTH_NAMES[Number(month.slice(5, 7)) - 1] ?? month;
  const [whole = '0', cents = '00'] = costUsd.toFixed(2).split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, NARROW_NO_BREAK_SPACE);
  return `Расход за ${monthName}: ${grouped},${cents} $`;
}

// The figure is read once per page load (design-web.md, FR-29): the drawer and the icon strip remount
// the user block, so the read lives at module level, not in the component. A failure stays until reload.
let spendRead: Promise<SpendState> | null = null;
let spendSettled: SpendState | null = null;

function readSpendOnce(): Promise<SpendState> {
  if (spendRead !== null) return spendRead;
  spendRead = threadsApiClient.getSpend().then(
    (spend): SpendState => ({ kind: 'ready', text: formatSpend(spend) }),
    (error: unknown): SpendState => {
      logger.warn('spend read failed', describeThreadsError(error));
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
  const [state, setState] = useState<SpendState>(() => spendSettled ?? { kind: 'loading' });

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
