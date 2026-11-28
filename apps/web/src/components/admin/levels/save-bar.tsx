'use client';

import {
  useEffect,
  useState,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import { LoaderCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useShellServices } from '@/components/shell/shell-actions';
import { Button } from '@/components/ui/button';
import { isApiRequestError } from '@/lib/api/api-request';
import { cn } from '@/lib/utils';
import { CAPTION, CONTROL_SIZE, FormError } from '../admin-form';
import { ChangedDot } from './level-select';
import type { DraftStatus } from './use-level-draft';

/** «Сохранено» stays this long, then «Изменений нет» (access-level-editor, States). */
const SAVED_SHOWN_MS = 4000;
/** The number of changes is announced this long after the last change, not on every press. */
const ANNOUNCE_DELAY_MS = 1000;

/** Ctrl+S / Cmd+S saves while the focus is inside the editor (access-level-editor, Accessibility). */
export function saveOnShortcut(
  event: KeyboardEvent,
  save: () => Promise<void>,
): void {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    void save();
  }
}

/** A button that stays in the Tab order while unavailable (`aria-disabled`). */
const unavailable = (
  event: MouseEvent<HTMLButtonElement>,
  off: boolean,
): boolean => {
  if (off) event.preventDefault();
  return off;
};

type SaveBarProps = {
  /** What a changed row is: «Изменено серверов» or «Изменено ролей». */
  unit: 'servers' | 'roles';
  changedCount: number;
  status: DraftStatus;
  /** The refused save; its form error stands above the bar and takes the focus. */
  error: unknown;
  onDiscard: () => void;
  onSave: () => Promise<void>;
};

/**
 * Part 11 of access-level-editor (UXRD LV-03): sticks to the bottom edge of the main area and keeps its height. On the
 * left the state, on the right «Отменить» and «Сохранить»; a refused save shows MC-37 above it.
 */
export function SaveBar({
  unit,
  changedCount,
  status,
  error,
  onDiscard,
  onSave,
}: SaveBarProps) {
  const t = useTranslations('admin.levels');
  const tCommon = useTranslations('common');
  const savedShown = useSavedShown(status);
  useAnnouncedCount(changedCount, status);
  const saving = status === 'saving';
  const idle = changedCount === 0 || saving;

  return (
    // The panel's scroller has 24 px padding (`AdminGate`, `p-6`) and a sticky box stops at the padding edge:
    // `-bottom-6` puts the bar on the scroller's bottom edge, so no row shows through under it. The bar stays in
    // the flow, so the last row is still reached above it.
    <div className="sticky -bottom-6 flex flex-col gap-2 bg-background">
      {status === 'failed' && error !== null && (
        <FormError>
          {t('saveFailed', {
            reason:
              isApiRequestError(error) && error.kind === 'network'
                ? t('saveFailedReason.network')
                : t('saveFailedReason.other'),
          })}
        </FormError>
      )}
      <div
        role="region"
        aria-label={t('bar.region')}
        className="flex min-h-12 items-center justify-between gap-2 border-t border-border py-2"
      >
        <p
          className={cn(
            CAPTION,
            'flex min-w-0 items-center gap-2 text-muted-foreground',
          )}
        >
          {saving ? (
            <>
              <LoaderCircle
                aria-hidden
                className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none"
              />
              {tCommon('saving')}
            </>
          ) : changedCount > 0 ? (
            <>
              <ChangedDot />
              <span className="max-md:hidden">
                {t(`bar.${unit}`, { count: changedCount })}
              </span>
              <span className="md:hidden">
                {t('bar.short', { count: changedCount })}
              </span>
            </>
          ) : savedShown ? (
            tCommon('saved')
          ) : (
            t('bar.none')
          )}
        </p>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn(CONTROL_SIZE, 'aria-disabled:opacity-50')}
            aria-disabled={idle}
            onClick={(event) => {
              if (!unavailable(event, idle)) onDiscard();
            }}
          >
            {t('bar.discard')}
          </Button>
          <Button
            type="button"
            size="sm"
            className={cn(CONTROL_SIZE, 'aria-disabled:opacity-50')}
            aria-disabled={idle}
            onClick={(event) => {
              if (!unavailable(event, idle)) void onSave();
            }}
          >
            {t('bar.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}

/** `true` for four seconds after the bar reaches «Сохранено». */
function useSavedShown(status: DraftStatus): boolean {
  const [expired, setExpired] = useState(false);
  useEffect(() => {
    if (status !== 'saved') return;
    const timer = setTimeout(() => setExpired(true), SAVED_SHOWN_MS);
    return () => {
      clearTimeout(timer);
      setExpired(false);
    };
  }, [status]);
  return status === 'saved' && !expired;
}

/** «Изменений: {N}» politely, a second after the last change; «Сохранено» politely once the save passed. */
function useAnnouncedCount(changedCount: number, status: DraftStatus): void {
  const { announcer } = useShellServices();
  useEffect(() => {
    if (changedCount === 0) return;
    const timer = setTimeout(
      () =>
        announcer
          .getState()
          .announce('admin.levels.bar.announce', { count: changedCount }),
      ANNOUNCE_DELAY_MS,
    );
    return () => clearTimeout(timer);
  }, [announcer, changedCount]);
  useEffect(() => {
    if (status === 'saved') announcer.getState().announce('common.saved');
  }, [announcer, status]);
}
