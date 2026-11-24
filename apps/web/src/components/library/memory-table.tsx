'use client';

import { useState, type ReactNode } from 'react';
import { BrainIcon } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type { MemoryRecordView } from '@agent-os/contracts';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { DataTable, resourceTableState } from '@/components/admin/data-table';
import type { Resource } from '@/hooks/use-resource';
import { formatDay } from '@/i18n/formats';
import { describeApiError, isApiRequestError } from '@/lib/api/api-request';
import { deleteFailed } from '@/lib/library/library-errors';
import { logger } from '@/lib/logger';

const DELETE_EVENT = 'memory: record delete';

export type MemoryTableProps = {
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
 * React text only. ME-03: «Удалить» in the row menu confirms, then the re-read takes the row away and `DataTable`
 * moves focus to the next row's menu; a refusal stays under the row (MC-6). Logs carry ids only, never a record's
 * description or text.
 */
export function MemoryTable({
  caption,
  memory,
  empty,
  remove,
}: MemoryTableProps) {
  const t = useTranslations('library');
  const tErrors = useTranslations('errors');
  const format = useFormatter();
  // Kept while the dialog closes, so its content does not change during the exit animation.
  const [deleting, setDeleting] = useState<MemoryRecordView | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [errors, setErrors] = useState<Record<string, ReactNode>>({});

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
        <span
          key="record"
          className="block truncate"
          title={record.description}
        >
          {record.description}
        </span>,
        formatDay(format, record.updatedAt),
      ],
      text: record.text,
      actions: [
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
          { header: t('memory.columns.record') },
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
    </>
  );
}
