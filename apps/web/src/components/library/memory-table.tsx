'use client';

import { useState, type ReactNode } from 'react';
import { BrainIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type { MemoryRecordView } from '@agent-os/contracts';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { DataTable, resourceTableState } from '@/components/admin/data-table';
import { StateBadge } from '@/components/state-badge';
import { Button } from '@/components/ui/button';
import type { Resource } from '@/hooks/use-resource';
import { formatDay } from '@/i18n/formats';
import { describeApiError, isApiRequestError } from '@/lib/api/api-request';
import { deleteFailed } from '@/lib/library/library-errors';
import { logger } from '@/lib/logger';
import { cn } from '@/lib/utils';
import {
  MemoryHistoryDialog,
  type MemoryHistoryFunctions,
} from './memory-history-dialog';

const DELETE_EVENT = 'memory: record delete';

export type MemoryTableProps = MemoryHistoryFunctions & {
  /** The hidden caption and Loading's `status` text. */
  caption: string;
  memory: Resource<{ records: MemoryRecordView[] }>;
  /** MC-5 of the screen. */
  empty: { title: string; description?: string };
  /** One `DELETE` of the record; it answers 204 also when the record is gone. */
  remove: (memoryId: string) => Promise<void>;
};

/**
 * UXRD ME-01 / ME-02: memory records in the server's order (newest change first) as expandable rows; the text is
 * React text only. MH-01: a record the agent deleted stays, muted and marked «Удалена»; expanded it says so and
 * opens its history (MH-02). MH-04: «Удалить» in the row menu confirms, then the re-read takes the row away and
 * `DataTable` moves focus to the next row's menu; a refusal stays under the row (MC-6). Logs carry ids only, never a
 * record's description or text.
 */
export function MemoryTable({
  caption,
  memory,
  empty,
  remove,
  history,
  revert,
  author,
}: MemoryTableProps) {
  const t = useTranslations('library');
  const tErrors = useTranslations('errors');
  const format = useFormatter();
  // Kept while the dialog closes, so its content does not change during the exit animation.
  const [deleting, setDeleting] = useState<MemoryRecordView | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [errors, setErrors] = useState<Record<string, ReactNode>>({});
  // Kept while the dialog closes, like `deleting`.
  const [historyOf, setHistoryOf] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  const openHistory = (memoryId: string): void => {
    setHistoryOf(memoryId);
    setHistoryOpen(true);
  };

  async function confirmDelete(record: MemoryRecordView): Promise<void> {
    const started = performance.now();
    const fields = () => ({
      memoryId: record.id,
      durationMs: Math.round(performance.now() - started),
    });
    try {
      await remove(record.id);
      logger.info(DELETE_EVENT, { ...fields(), outcome: 'ok' });
      toast.success(t('memory.deleted'));
      memory.reload();
    } catch (error) {
      if (isApiRequestError(error))
        logger.warn(`${DELETE_EVENT}: refused`, {
          ...fields(),
          ...describeApiError(error),
        });
      else logger.error(`${DELETE_EVENT}: failed`, { ...fields(), error });
      setErrors((current) => ({
        ...current,
        [record.id]: deleteFailed(tErrors, error),
      }));
    }
  }

  const state = resourceTableState(memory, t('memory.loadFailed'), (data) => ({
    rows: data.records.map((record) => ({
      key: record.id,
      name: record.description,
      cells: [
        // Below 640 px the badge goes under the description, which then keeps the cell's whole width.
        <span
          key="record"
          className="flex min-w-0 items-center gap-x-2 gap-y-0.5 max-sm:flex-wrap"
        >
          <span
            className={cn(
              'block truncate',
              record.deleted && 'text-muted-foreground',
            )}
            title={record.description}
          >
            {record.description}
          </span>
          {record.deleted && (
            <StateBadge state="off">{t('memory.deletedBadge')}</StateBadge>
          )}
        </span>,
        formatDay(format, record.updatedAt),
      ],
      text: record.deleted ? (
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-muted-foreground">
          {t('memory.deletedText')}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="pointer-coarse:h-11"
            onClick={() => openHistory(record.id)}
          >
            {t('memory.history')}
          </Button>
        </span>
      ) : (
        record.text
      ),
      actions: [
        {
          label: t('memory.history'),
          onSelect: () => openHistory(record.id),
        },
        {
          label: t('memory.delete'),
          onSelect: () => {
            setErrors((current) => ({ ...current, [record.id]: undefined }));
            setDeleting(record);
            setDialogOpen(true);
          },
        },
      ],
      error: errors[record.id],
    })),
    empty: { Icon: BrainIcon, ...empty },
  }));

  return (
    <>
      <DataTable
        caption={caption}
        columns={[
          // 160 px leaves a 360 px screen no room for the date and the «⋯» beside the record.
          { header: t('memory.columns.record'), narrow: true },
          { header: t('memory.columns.changed') },
        ]}
        state={state}
        actionsAs="menu"
      />
      {deleting !== null && (
        <ConfirmDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          title={t('memory.deleteDialog.title')}
          body={t('memory.deleteDialog.body', {
            description: deleting.description,
          })}
          confirmLabel={t('memory.delete')}
          onConfirm={() => confirmDelete(deleting)}
          // `confirmDelete` never rejects: its refusal stays under the row.
          refusalText={(cause) => deleteFailed(tErrors, cause)}
        />
      )}
      {historyOf !== null && (
        <MemoryHistoryDialog
          key={historyOf}
          memoryId={historyOf}
          open={historyOpen}
          onOpenChange={setHistoryOpen}
          history={history}
          revert={revert}
          author={author}
          onReverted={memory.reload}
          finalFocus={() => rowMenu(historyOf)}
        />
      )}
    </>
  );
}

/** The «⋯» button of a record's row: focus returns there when its history closes (UXRD Accessibility). */
function rowMenu(memoryId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    `tr[data-row-key="${CSS.escape(memoryId)}"] [aria-haspopup="menu"]`,
  );
}
