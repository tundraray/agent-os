'use client';

import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { LoaderCircleIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  LibraryErrorCode,
  type MemoryHistoryView,
  type MemoryVersionView,
  type RevertMemoryBody,
} from '@agent-os/contracts';
import { FormWarning } from '@/components/admin/admin-form';
import { LoadError } from '@/components/admin/data-table';
import { StateBadge } from '@/components/state-badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { useResource } from '@/hooks/use-resource';
import { failedText } from '@/i18n/server-text';
import { describeApiError, isApiRequestError } from '@/lib/api/api-request';
import { logger } from '@/lib/logger';
import { startTimer } from '@/lib/timer';
import { cn } from '@/lib/utils';

const REVERT_EVENT = 'memory: record revert';

/** Who changed a person's versions on this screen: their name on an agent's memory, «вы» in «Моя память». */
export type MemoryAuthorLabel = 'name' | 'you';

export type MemoryHistoryFunctions = {
  history: (memoryId: string) => Promise<MemoryHistoryView>;
  revert: (
    memoryId: string,
    body: RevertMemoryBody,
  ) => Promise<MemoryHistoryView>;
  author: MemoryAuthorLabel;
};

export type MemoryHistoryDialogProps = MemoryHistoryFunctions & {
  memoryId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** A version came back: the table under the dialog reads its rows again. */
  onReverted: () => void;
  /** Where focus goes when the dialog closes: the row's «⋯» button. */
  finalFocus: () => HTMLElement | null;
};

/**
 * UXRD MH-02, MH-03 on design-system version-history: a memory record's versions, newest first, read when the
 * dialog opens. The body mounts with the open dialog, so every open reads the history anew. Everyone who reaches
 * a memory screen may delete there (ME-04), so every version with text except the current one can be restored.
 */
export function MemoryHistoryDialog({
  open,
  onOpenChange,
  finalFocus,
  ...body
}: MemoryHistoryDialogProps) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  const tCommon = useTranslations('common');
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        initialFocus={titleRef}
        finalFocus={finalFocus}
        className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-160"
      >
        <HistoryBody {...body} titleRef={titleRef} />
        <DialogFooter>
          <DialogClose
            render={
              <Button
                type="button"
                variant="outline"
                className="pointer-coarse:h-11"
              />
            }
          >
            {tCommon('close')}
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

type HistoryBodyProps = MemoryHistoryFunctions & {
  memoryId: string;
  onReverted: () => void;
  titleRef: RefObject<HTMLHeadingElement | null>;
};

/** The answer of a revert, shown until the next read of the history replaces what it was given over. */
type Reverted = {
  over: MemoryHistoryView | undefined;
  view: MemoryHistoryView;
};

type RevertFailure = { version: number; text: ReactNode };

function HistoryBody({
  memoryId,
  history,
  revert,
  author,
  onReverted,
  titleRef,
}: HistoryBodyProps) {
  const t = useTranslations('library.memory.historyDialog');
  const tErrors = useTranslations('errors');
  const format = useFormatter();
  const resource = useResource(
    () => history(memoryId),
    `memory-history:${memoryId}`,
    'library',
  );
  const [reverted, setReverted] = useState<Reverted | null>(null);
  const [reverting, setReverting] = useState<number | null>(null);
  const [failure, setFailure] = useState<RevertFailure | null>(null);
  const [conflict, setConflict] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  /** After a revert or a conflict the top version takes focus once a history other than `from` is drawn. */
  const focusAfter = useRef<MemoryHistoryView | null>(null);
  const [appeared, setAppeared] = useState<number | null>(null);
  const listRef = useRef<HTMLOListElement>(null);

  const shown =
    reverted !== null && reverted.over === resource.data
      ? reverted.view
      : resource.data;

  useEffect(() => {
    const from = focusAfter.current;
    if (from === null || shown === undefined || shown === from) return;
    focusAfter.current = null;
    listRef.current?.querySelector<HTMLElement>('h3')?.focus();
  }, [shown]);

  const at = (version: MemoryVersionView): string =>
    format.dateTime(new Date(version.changedAt), 'dayTime');
  const who = (version: MemoryVersionView): string => {
    if (version.changedBy === null) return t('byAgent');
    return author === 'you' ? t('byYou') : version.changedBy;
  };

  async function restore(
    source: MemoryVersionView,
    current: MemoryHistoryView,
  ): Promise<void> {
    const expectedVersion = current.versions[0]?.version;
    if (expectedVersion === undefined) return;
    const durationMs = startTimer();
    const fields = () => ({
      memoryId,
      version: source.version,
      expectedVersion,
      durationMs: durationMs(),
    });
    setReverting(source.version);
    setFailure(null);
    setConflict(false);
    try {
      const view = await revert(memoryId, {
        version: source.version,
        expectedVersion,
      });
      logger.info(REVERT_EVENT, { ...fields(), outcome: 'ok' });
      const text = t('reverted', { at: at(source) });
      setReverted({ over: resource.data, view });
      setAppeared(view.versions[0]?.version ?? null);
      setAnnouncement(text);
      focusAfter.current = current;
      toast.success(text);
      onReverted();
    } catch (error) {
      if (isApiRequestError(error)) {
        logger.warn(`${REVERT_EVENT}: refused`, {
          ...fields(),
          ...describeApiError(error),
        });
      } else logger.error(`${REVERT_EVENT}: failed`, { ...fields(), error });
      if (
        isApiRequestError(error) &&
        error.code === LibraryErrorCode.RECORD_VERSION_CONFLICT
      ) {
        setConflict(true);
        setAnnouncement(t('conflict'));
        focusAfter.current = current;
        resource.reload();
      } else {
        setFailure({
          version: source.version,
          text: failedText(tErrors, 'restore', error),
        });
      }
    } finally {
      setReverting(null);
    }
  }

  return (
    <>
      <DialogHeader className="pr-8">
        <DialogTitle
          ref={titleRef}
          tabIndex={-1}
          className="text-base leading-6 font-semibold outline-none"
        >
          {t('title')}
        </DialogTitle>
        {shown !== undefined && (
          <p className="text-sm leading-5 wrap-break-word text-muted-foreground">
            {shown.description}
          </p>
        )}
      </DialogHeader>
      <span role="status" className="sr-only">
        {announcement}
      </span>
      {conflict && <FormWarning>{t('conflict')}</FormWarning>}
      <div className="-mx-4 min-h-0 overflow-y-auto px-4">
        {resource.status === 'error' ? (
          <LoadError message={t('loadFailed')} onRetry={resource.reload} />
        ) : shown === undefined ? (
          <HistorySkeleton label={t('title')} />
        ) : (
          <ol ref={listRef} className="flex flex-col divide-y divide-border">
            {shown.versions.map((version, index) => (
              <VersionItem
                key={version.version}
                version={version}
                current={index === 0}
                kindText={t(`kind.${version.kind}`)}
                who={who(version)}
                at={at(version)}
                appeared={appeared === version.version}
                currentText={t('current')}
                action={
                  index === 0 || version.text === null
                    ? null
                    : {
                        label: t('revert'),
                        accessibleName: t('revertLabel', { at: at(version) }),
                        pending: reverting === version.version,
                        disabled: reverting !== null,
                        onClick: () => void restore(version, shown),
                      }
                }
                error={
                  failure?.version === version.version ? failure.text : null
                }
              />
            ))}
          </ol>
        )}
      </div>
    </>
  );
}

type VersionAction = {
  label: string;
  accessibleName: string;
  pending: boolean;
  disabled: boolean;
  onClick: () => void;
};

/** One version: the Caption line with the kind, who and when, «Текущая» on top, the text and «Вернуть эту версию». */
function VersionItem({
  version,
  current,
  kindText,
  who,
  at,
  appeared,
  currentText,
  action,
  error,
}: {
  version: MemoryVersionView;
  current: boolean;
  kindText: string;
  who: string;
  at: string;
  appeared: boolean;
  currentText: string;
  action: VersionAction | null;
  error: ReactNode;
}) {
  const headingId = useId();
  return (
    <li
      aria-labelledby={headingId}
      className={cn(
        'flex flex-col gap-1.5 py-3',
        appeared &&
          'duration-150 animate-in fade-in-0 slide-in-from-top-1 motion-reduce:animate-none',
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <h3
          id={headingId}
          tabIndex={-1}
          className="rounded-sm text-xs leading-4 font-normal outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="font-medium text-foreground">{kindText}</span>
          <span className="text-muted-foreground">
            {' · '}
            {who}
            {' · '}
            {at}
          </span>
        </h3>
        {current && <StateBadge variant="source">{currentText}</StateBadge>}
      </div>
      {version.text !== null && (
        <p className="text-sm leading-5 wrap-break-word whitespace-pre-wrap text-foreground">
          {version.text}
        </p>
      )}
      {action !== null && (
        <div className="flex justify-end">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="pointer-coarse:h-11"
            aria-label={action.accessibleName}
            disabled={action.disabled}
            onClick={action.onClick}
          >
            {action.pending && (
              <LoaderCircleIcon
                aria-hidden
                className="animate-spin motion-reduce:animate-none"
              />
            )}
            {action.label}
          </Button>
        </div>
      )}
      {error !== null && (
        <p
          role="alert"
          className="text-xs leading-4 font-medium text-destructive"
        >
          {error}
        </p>
      )}
    </li>
  );
}

/** Loading: three version skeletons; screen readers hear the dialog's title. */
function HistorySkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} className="flex flex-col">
      {['w-3/4', 'w-1/2', 'w-2/3'].map((width) => (
        <div key={width} className="flex flex-col gap-2 py-3">
          <Skeleton className="h-3 w-40 motion-reduce:animate-none" />
          <Skeleton className={cn('h-4 motion-reduce:animate-none', width)} />
        </div>
      ))}
    </div>
  );
}
