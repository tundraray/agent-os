'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import type { RecordDetail, RecordSummary } from '@agent-os/contracts';
import { CONTROL_SIZE } from '@/components/admin/admin-form';
import { useAdminTitles } from '@/components/admin/admin-header';
import { ConfirmDialog } from '@/components/admin/confirm-dialog';
import { DefinitionView } from '@/components/library/definition-view';
import { KnowledgeButton } from '@/components/library/editor-header';
import { RecordLabel } from '@/components/library/record-label';
import { PageHeader } from '@/components/shell/page-header';
import { useShellServices } from '@/components/shell/shell-actions';
import { Button } from '@/components/ui/button';
import { adminApi } from '@/lib/admin/admin-api';
import { builtinName, builtinRoleName } from '@/i18n/builtin-name';
import type { Locale } from '@/i18n/pick-locale';
import { describeLibraryError } from '@/lib/library/library-errors';
import { recordAction } from '@/lib/library/record-action';
import { adminLibraryTabPath, adminRecordPath } from '@/lib/shell-route';

const EMPTY_VALUE = '—';

/** The panel's own address of a record: links in the panel never lead to the employee's library. */
export const panelRecordHref = (id: string): string =>
  adminRecordPath('library', id);

/** An employee's record whose access the administrator closes: a row of «Открытые ролям» or AL-03. */
export type ClosableRecord = Pick<
  RecordSummary,
  'id' | 'kind' | 'name' | 'audience'
> & {
  author: NonNullable<RecordSummary['author']>;
};

/** The roles a record is open to, in the page's language (KD-6). */
const rolesOf = (
  record: Pick<RecordSummary, 'audience'>,
  locale: Locale,
): string =>
  record.audience.roles
    .map((role) => builtinRoleName(role.name, locale))
    .join(', ');

type CloseAccessDialogProps = {
  record: ClosableRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** After the confirmed close: the row leaves, the page returns to its tab. */
  onClosed: () => void;
};

/**
 * MC-18 `alert-dialog` of «Закрыть доступ» (AL-03): nothing is sent before the confirmation, then exactly one
 * `close` through `recordAction`, and `libraryIndex` is re-read (KD-2). A refusal stays in the dialog with its
 * text; «Отмена» and Esc send nothing.
 */
export function CloseAccessDialog({
  record,
  open,
  onOpenChange,
  onClosed,
}: CloseAccessDialogProps) {
  const t = useTranslations('errors');
  const tLibrary = useTranslations('admin.library');
  const locale = useLocale();
  const { libraryIndex } = useShellServices();

  async function close(): Promise<void> {
    await recordAction(
      {
        recordId: record.id,
        kind: record.kind,
        action: 'close',
        version: null,
      },
      () => adminApi.library.close(record.id),
    );
    void libraryIndex.refresh();
    toast.success(tLibrary('closed'));
    onClosed();
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={tLibrary('closeTitle', { name: record.name })}
      body={tLibrary('closeBody', {
        kind: record.kind,
        author: record.author.name,
        roleCount: record.audience.roles.length,
        roles: rolesOf(record, locale),
      })}
      confirmLabel={tLibrary('close')}
      onConfirm={close}
      // `recordAction` has logged the refusal.
      refusalText={(cause) =>
        describeLibraryError(t, cause, { where: 'panel', kind: record.kind })
          .text
      }
    />
  );
}

type EmployeeRecordPageProps = { record: RecordDetail };

/**
 * UXRD AL-03: an employee's record in the panel, read only — the record label with its author, the roles it is
 * open to and its definition «На странице»; «Что узнал глубокий агент» (MC-7, a deep agent only) and «Закрыть доступ» in
 * the header. The administrator never edits it.
 * Other employees' text is rendered as text only. A company record (no author) has nothing to close.
 */
export function EmployeeRecordPage({ record }: EmployeeRecordPageProps) {
  const t = useTranslations('admin.library');
  const locale = useLocale();
  const titles = useAdminTitles();
  const router = useRouter();
  const [closing, setClosing] = useState(false);
  const roles = rolesOf(record, locale);
  const author = record.author;

  return (
    <>
      <PageHeader
        area={titles.panel}
        title={builtinName(record, locale)}
        parent={titles.parent('library')}
      >
        <KnowledgeButton record={record} />
        {author !== null && (
          <Button
            variant="outline"
            size="sm"
            className={CONTROL_SIZE}
            onClick={() => setClosing(true)}
          >
            {t('close')}
          </Button>
        )}
      </PageHeader>
      <div className="flex max-w-240 flex-col gap-4">
        <div className="flex flex-col gap-1">
          <RecordLabel
            variant="under"
            summary={record}
            href={panelRecordHref(record.id)}
          />
          <p className="text-data text-foreground">
            {t.rich('rolesLine', {
              roles: roles === '' ? EMPTY_VALUE : roles,
              label: (chunks) => (
                <span className="text-muted-foreground">{chunks}</span>
              ),
            })}
          </p>
        </div>
        <DefinitionView
          definition={record}
          missingRights={record.missingRights}
          variant="page"
          recordHref={panelRecordHref}
        />
      </div>
      {author !== null && (
        <CloseAccessDialog
          record={{ ...record, author }}
          open={closing}
          onOpenChange={setClosing}
          onClosed={() => router.push(adminLibraryTabPath('shared'))}
        />
      )}
    </>
  );
}
